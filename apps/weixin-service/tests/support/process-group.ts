/**
 * Signals every process in a test's own process group, which may already be gone. Besides ESRCH for a
 * group with no members, Darwin reports EPERM for a group whose remaining members are all zombies that
 * have not been reaped yet, as when a service has exited but an App Server child is still being reaped.
 * A group with any live member is signaled normally.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || (code === "EPERM" && process.platform === "darwin")) return;
    throw error;
  }
}
