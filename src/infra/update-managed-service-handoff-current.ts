/** This line predates leased handoffs, so it can never grant their authority. */
export async function isCurrentManagedServiceUpdateHandoffProcess(
  _params: unknown,
): Promise<boolean> {
  return false;
}
