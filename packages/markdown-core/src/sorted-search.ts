/** First index outside a sorted prefix; the predicate must be monotonic. */
export function lowerBoundIndex(length: number, precedes: (index: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (precedes(middle)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
