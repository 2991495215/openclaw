import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import { getTelegramSequentialConstraints } from "./sequential-key.js";

export function createTelegramSequentializer() {
  const tails = new Map<string, Promise<void>>();
  return async (
    ctx: Parameters<typeof getTelegramSequentialConstraints>[0],
    next: () => Promise<void>,
  ): Promise<void> => {
    const constraints = getTelegramSequentialConstraints(ctx);
    const keys = Array.isArray(constraints) ? constraints : [constraints];
    await enqueueKeyedTask({ tails, keys, task: next });
  };
}
