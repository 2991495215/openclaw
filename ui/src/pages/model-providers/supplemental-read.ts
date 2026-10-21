import { createMemo } from "solid-js";
import type { ModelProvidersData } from "./load.ts";

/** Keep unrelated owner publications out of the usage and cost transitions. */
export function projectSupplementalRead<T, R>(
  revision: () => unknown,
  read: () => { pending: Promise<ModelProvidersData | null> | null; value: T },
  select: (data: ModelProvidersData | null) => T,
  collect: (value: T) => R,
): () => R {
  const source = createMemo(
    () => {
      revision();
      return read();
    },
    {
      equals: (previous, next) =>
        previous.pending === next.pending &&
        (next.pending !== null || previous.value === next.value),
    },
  );
  return createMemo(() => {
    const read = source();
    return read.pending ? read.pending.then((data) => collect(select(data))) : collect(read.value);
  });
}
