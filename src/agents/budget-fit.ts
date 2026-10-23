/** Search monotone budget trials in the caller's existing candidate order. */
export function findLastFittingValue<T, F>(
  maximum: number,
  candidateAt: (limit: number) => T,
  fits: (candidate: T) => boolean,
  fallback: F,
): T | F {
  let low = 0;
  let high = maximum;
  let best: T | F = fallback;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = candidateAt(middle);
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
