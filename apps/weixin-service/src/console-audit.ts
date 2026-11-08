import fs from "node:fs";
import path from "node:path";

/**
 * The local configuration audit (agent-console::REQ-004): one JSON Lines file in the state directory, owner-only,
 * appended to and read with standard command-line tools. Every writer — console login, MCP Catalog, later the team
 * and skill pages — appends through this class. Entries never carry a secret value.
 */
export const AUDIT_FILE = "console-audit.jsonl";

export class ConsoleAudit {
  private readonly directory?: string;
  private readonly now: () => number;

  constructor(options: { directory?: string; now?: () => number } = {}) {
    if (options.directory !== undefined) this.directory = options.directory;
    this.now = options.now ?? Date.now;
  }

  /** Appends one entry, stamped with the time, and syncs it to disk; throws when it cannot be written. */
  append(entry: Record<string, unknown>): void {
    if (this.directory === undefined) throw new Error("audit_without_directory");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, AUDIT_FILE);
    const line = `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`;
    const descriptor = fs.openSync(file, "a", 0o600);
    try {
      fs.writeFileSync(descriptor, line, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(file, 0o600);
  }

  /** Appends one entry; reports a failure on stderr and returns false instead of throwing. */
  tryAppend(entry: Record<string, unknown>): boolean {
    try {
      this.append(entry);
      return true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : String(error);
      process.stderr.write(`console_audit_write_failed: ${code}\n`);
      return false;
    }
  }
}
