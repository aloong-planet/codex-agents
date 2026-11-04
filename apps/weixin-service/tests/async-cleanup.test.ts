import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { settleCleanup } from "../src/async-cleanup.js";

it("waits for an asynchronous release and still releases later resources after a filesystem failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-"));
  const later = path.join(root, "later");
  await fs.writeFile(later, "resource");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cleaning = settleCleanup([() => fs.unlink(path.join(root, "missing")), () => gate, () => fs.unlink(later)]);
  const outcome = cleaning.catch((error: unknown) => error);
  try {
    expect(await fs.readFile(later, "utf8")).toBe("resource");
    release();
    expect(await outcome).toMatchObject({ message: "resource_cleanup_failed", errors: [expect.objectContaining({ code: "ENOENT" })] });
    await expect(fs.access(later)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release(); await outcome; await fs.rm(root, { recursive: true, force: true }); }
});
