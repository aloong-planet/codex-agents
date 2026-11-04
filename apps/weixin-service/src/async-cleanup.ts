/** Await every release even when an earlier release fails. Order is caller-owned. */
export async function settleCleanup(actions: Array<() => unknown | Promise<unknown>>): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "resource_cleanup_failed");
}
