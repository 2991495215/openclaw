/** Preserve a sole failure; aggregate independent failures without changing their order. */
export function throwCollectedErrors(
  errors: readonly unknown[],
  message: string,
  options?: ErrorOptions,
): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message, options);
  }
}
