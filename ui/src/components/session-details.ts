import { createMemo, createSignal, isPending, onCleanup } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import type {
  SessionCapability,
  SessionRowObservation,
} from "../lib/sessions/session-capability.ts";

type DetailScope = { sessions: Pick<SessionCapability, "observeRow" | "describe"> };
type DetailRow = Pick<GatewaySessionRow, "key" | "sessionId" | "rowMode" | "agentId">;
type DetailBinding = {
  matches: () => boolean;
  dispose: () => void;
  row: () => GatewaySessionRow | null;
};

/** The expanded view holds a descriptor; the session capability owns its row facts. */
export function createSessionDetails<Scope extends DetailScope>(options: {
  captureScope: () => Scope | null;
  isCurrent: (scope: Scope) => boolean;
  row: () => DetailRow | undefined;
  agentId: (row: DetailRow, scope: Scope) => string;
}) {
  const [request, setRequest] = createSignal<Promise<void>>();
  // The initial, idle read is synchronous; only admitted descriptor requests suspend.
  const read = createMemo(() => request());
  const [rowRevision, setRowRevision] = createSignal(0);
  const rowChanged = () => setRowRevision((value) => value + 1);
  let activeBinding: DetailBinding | undefined;

  const release = () => {
    activeBinding?.dispose();
    activeBinding = undefined;
  };
  const reset = () => {
    release();
    setRequest(undefined);
    rowChanged();
  };
  onCleanup(release);

  function synchronize() {
    if (activeBinding?.matches()) {
      return;
    }
    reset();
    const row = options.row();
    const scope = row && options.captureScope();
    if (!row || !scope) {
      return;
    }
    const { key, sessionId } = row;
    const agentId = options.agentId(row, scope);
    // Registration may notify before the observation handle is returned.
    let observation: SessionRowObservation | null = null;
    let reading = false;
    const binding = {
      matches: () => {
        const selected = options.row();
        return (
          options.isCurrent(scope) &&
          observation?.isCurrent() !== false &&
          selected?.key === key &&
          selected.sessionId === sessionId
        );
      },
      dispose: () => observation?.dispose(),
      row: () =>
        observation?.row && observation.row.sessionId === sessionId ? observation.row : null,
    };
    const current = () => activeBinding === binding && binding.matches();
    const refresh = () => {
      if (reading || !current()) {
        return;
      }
      reading = true;
      const completion = (async () => {
        try {
          if (observation?.isCurrent()) {
            const reconcile = observation.captureReconcile();
            const { session } = await scope.sessions.describe({ key, agentId });
            if (current()) {
              reconcile(session ?? undefined);
            }
          }
        } catch (failure) {
          if (current()) {
            throw failure;
          }
        } finally {
          reading = false;
        }
      })();
      void setRequest(() => completion);
    };
    activeBinding = binding;
    observation = scope.sessions.observeRow(
      { key, agentId },
      () => {
        if (current()) {
          rowChanged();
        }
      },
      { onInvalidate: refresh },
    );
    rowChanged();
    if (row.rowMode) {
      refresh();
    }
  }
  return {
    request,
    read,
    pending: () => isPending(read),
    reset,
    synchronize,
    row() {
      rowRevision();
      return activeBinding?.matches() ? activeBinding.row() : null;
    },
  };
}
