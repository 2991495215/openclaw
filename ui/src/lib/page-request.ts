/** One replaceable page read; callers own lifecycle and result policy. */
export function createPageRequest<Result, Args extends readonly unknown[] = []>(options: {
  task: (signal: AbortSignal, ...args: Args) => Promise<Result> | undefined;
  onComplete: (result: Result) => void;
  onError: (error: unknown) => void;
  notify?: () => void;
}) {
  let current: AbortController | null = null;
  const cancel = () => {
    current?.abort();
    current = null;
  };
  return {
    get pending() {
      return current !== null;
    },
    cancel,
    reset() {
      cancel();
      options.notify?.();
    },
    async run(...args: Args): Promise<void> {
      cancel();
      const controller = new AbortController();
      current = controller;
      options.notify?.();
      try {
        const result = await options.task(controller.signal, ...args);
        if (current === controller && result !== undefined) {
          options.onComplete(result);
        }
      } catch (error) {
        if (current === controller) {
          options.onError(error);
        }
      } finally {
        if (current === controller) {
          current = null;
          options.notify?.();
        }
      }
    },
  };
}
