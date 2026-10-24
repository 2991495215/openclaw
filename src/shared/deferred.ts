export type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const promiseWithResolvers = Promise as PromiseConstructor & {
  withResolvers<T>(): Deferred<T>;
};

export function createDeferredCore<T = void>(): Deferred<T> {
  return promiseWithResolvers.withResolvers<T>();
}
