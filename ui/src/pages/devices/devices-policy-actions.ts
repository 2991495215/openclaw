import { action, affects, refresh, type Accessor, type Refreshable } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DevicesPageDataState } from "../../lib/nodes/page-operations.ts";

type PolicyKind = "bindings" | "approvals";
type SavePresentation = {
  state: DevicesPageDataState;
  gateway: ApplicationContext["gateway"] | null;
  epoch: number;
  setConfigSaving: (value: boolean) => void;
  setApprovalsSaving: (value: boolean) => void;
};

export function createDevicePolicyActions(options: {
  presentation: Accessor<SavePresentation>;
  canSave(): boolean;
  isCurrent(view: SavePresentation): boolean;
  read(kind: PolicyKind): Refreshable<Accessor<unknown>>;
  run(kind: PolicyKind): Promise<unknown>;
  publish(): void;
}) {
  let lifetime = Promise.withResolvers<void>();
  const present = action(function* (
    view: SavePresentation,
    currentLifetime: typeof lifetime,
    pending: Promise<unknown>,
    kind: PolicyKind,
  ) {
    const isCurrent = () => currentLifetime === lifetime && options.isCurrent(view);
    const snapshot = options.read(kind);
    try {
      if (isCurrent()) {
        (kind === "bindings" ? view.setConfigSaving : view.setApprovalsSaving)(true);
        affects(snapshot);
      }
      // Retirement releases presentation; the plain owner still settles its write.
      yield Promise.race([pending, currentLifetime.promise]);
      if (isCurrent()) {
        yield refresh(snapshot);
      }
    } catch (error) {
      if (isCurrent()) {
        view.state.lastError = formatUiError(error);
        options.publish();
      }
    }
  });

  return {
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    async save(kind: PolicyKind) {
      if (!options.canSave()) {
        return;
      }
      const view = options.presentation();
      const currentLifetime = lifetime;
      const pending = options.run(kind);
      // Publish the owner's admitted operation before opening its presentation.
      await Promise.resolve();
      return present(view, currentLifetime, pending, kind);
    },
  };
}
