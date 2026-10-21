import { action, createMemo, createOptimisticStore } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { showToast } from "../../lib/toast.ts";

type ChannelMutation = "config" | "pairing";

/** Presents admitted work without changing its owner's write or settlement policy. */
export function createChannelMutations(deps: {
  readEpoch: () => number;
  currentEpoch: () => number;
  isActive: () => boolean;
}) {
  const epoch = createMemo(deps.readEpoch);
  const presentation = createMemo(() => {
    const currentEpoch = epoch();
    const [busy, setBusy] = createOptimisticStore({ config: false, pairing: false });
    return { epoch: currentEpoch, busy, setBusy };
  });
  const lifetimes = {
    config: Promise.withResolvers<void>(),
    pairing: Promise.withResolvers<void>(),
  };
  const isCurrent = (view: ReturnType<typeof presentation>) =>
    deps.isActive() && view.epoch === deps.currentEpoch();
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    kind: ChannelMutation,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    try {
      if (isCurrent(view)) {
        view.setBusy((busy) => {
          busy[kind] = true;
        });
      }
      // Leaving the presentation never cancels an already admitted write.
      yield Promise.race([pending, retired]);
    } catch (error) {
      if (isCurrent(view)) {
        showToast({ message: formatUiError(error) });
      }
    }
  });
  return {
    busy: () => presentation().busy,
    retire(kind?: ChannelMutation) {
      for (const key of kind ? [kind] : (["config", "pairing"] as const)) {
        lifetimes[key].resolve();
        lifetimes[key] = Promise.withResolvers<void>();
      }
    },
    async run(kind: ChannelMutation, pending: Promise<unknown>) {
      const view = presentation();
      const retired = lifetimes[kind].promise;
      // The owner's synchronous admission publication precedes the action.
      await Promise.resolve();
      return present(view, kind, pending, retired);
    },
  };
}
