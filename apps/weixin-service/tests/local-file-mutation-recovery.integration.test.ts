import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const serviceDirectory = fileURLToPath(new URL("..", import.meta.url));

// Child exits are real; EIO is injected only at the isolated host's OS fsync boundary.
// The worker's temporary-file sync precedes these host barriers. Actual power loss,
// device failures and unjournaled temporary-file windows require separate validation.
describe("local_file_mutation_process_recovery", () => {
  for (const kind of ["create", "overwrite", "edit"] as const) {
    for (const phase of ["prepared-rejected", "prepared-target-change"]) {
      it(`${kind}: preserves the target and cleans only its own temporary file after ${phase}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-mutation-recovery-"));
        const directory = path.join(root, "files");
        fs.mkdirSync(directory);
        const target = path.join(directory, "item.txt");
        if (kind !== "create") fs.writeFileSync(target, "before");
        try {
          const reply = await runChild(root, kind, phase);
          expect(reply, reply.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
          expect(JSON.parse(reply.stdout)).toEqual({ ok: false, error: phase === "prepared-rejected"
            ? "local_file_mutation_failed" : kind === "create" ? "local_file_file_exists" : "local_file_content_conflict" });
          if (phase === "prepared-target-change") expect(fs.readFileSync(target, "utf8")).toBe("user changed during preparation");
          else if (kind !== "create") expect(fs.readFileSync(target, "utf8")).toBe("before");
          else expect(fs.existsSync(target)).toBe(false);
          expect(fs.readdirSync(directory)).toEqual(kind === "create" && phase === "prepared-rejected" ? [] : ["item.txt"]);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
  for (const kind of ["create", "overwrite", "edit"] as const) {
    for (const change of ["none", "target", "temporary-content", "temporary-identity", "temporary-symlink", "temporary-missing"] as const) {
    it(`${kind}: recovers a prepared temporary file safely with ${change} after SIGKILL`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-mutation-recovery-"));
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const lookalike = ".item.txt.codex-aaaaaaaaaaaaaaaaaaaaaaaa.tmp";
    fs.writeFileSync(path.join(directory, lookalike), "user owned");
    const target = path.join(directory, "item.txt");
    if (kind !== "create") { fs.writeFileSync(target, "before"); fs.chmodSync(target, 0o640); }
    const initial = kind === "create" ? undefined : fs.statSync(target);
    try {
      const crashed = await runChild(root, kind, "prepared-crash");
      expect(crashed, crashed.stderr).toMatchObject({ code: null, signal: "SIGKILL", timedOut: false, stdout: "" });
      expect(crashed.stderr).toContain("PREPARED_CHECKPOINT");
      if (initial) {
        expect(fs.readFileSync(target, "utf8")).toBe("before");
        expect(fs.statSync(target).ino).toBe(initial.ino);
        expect(fs.statSync(target).mtimeMs).toBe(initial.mtimeMs);
      } else expect(fs.existsSync(target)).toBe(false);
      const remaining = fs.readdirSync(directory).filter((name) => name !== lookalike && name !== "item.txt");
      expect(remaining).toHaveLength(1);
      const temporary = path.join(directory, remaining[0]!);
      expect(fs.readFileSync(temporary, "utf8")).toBe("a".repeat(100_001));
      const outside = path.join(root, "outside.txt");
      fs.writeFileSync(outside, "external file must survive");
      if (change === "target") fs.writeFileSync(target, "user changed target");
      if (change === "temporary-content") fs.writeFileSync(temporary, "user changed temporary");
      if (change === "temporary-identity") {
        const replacement = path.join(root, "replacement.tmp");
        fs.writeFileSync(replacement, "a".repeat(100_001));
        fs.chmodSync(replacement, kind === "create" ? 0o600 : 0o640);
        fs.renameSync(replacement, temporary);
      }
      if (change === "temporary-symlink") { fs.unlinkSync(temporary); fs.symlinkSync(outside, temporary); }
      if (change === "temporary-missing") fs.unlinkSync(temporary);
      const modifiedArtifact = change.startsWith("temporary-") && change !== "temporary-missing";
      const artifactIdentity = modifiedArtifact ? fs.lstatSync(temporary) : undefined;
      const resumed = await runChild(root, kind, "retry-prepared");
      expect(resumed, resumed.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
      if (change === "none" || change === "temporary-missing") {
        expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, result: { sizeBytes: 100_001,
          ...(kind === "edit" ? { changed: true } : { created: kind === "create" }) } });
        expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
        expect(fs.statSync(target).mode & 0o777).toBe(kind === "create" ? 0o600 : 0o640);
        const committed = fs.statSync(target);
        const replay = await runChild(root, kind, "resume");
        expect(JSON.parse(replay.stdout)).toMatchObject({ ok: true });
        expect(fs.statSync(target).ino).toBe(committed.ino);
        expect(fs.statSync(target).mtimeMs).toBe(committed.mtimeMs);
      } else {
        expect(JSON.parse(resumed.stdout)).toEqual({ ok: false, error: "local_file_content_conflict" });
        if (change === "target") expect(fs.readFileSync(target, "utf8")).toBe("user changed target");
        else if (initial) expect(fs.readFileSync(target, "utf8")).toBe("before");
        else expect(fs.existsSync(target)).toBe(false);
      }
      if (artifactIdentity) {
        expect(fs.lstatSync(temporary).ino).toBe(artifactIdentity.ino);
        expect(fs.lstatSync(temporary).mtimeMs).toBe(artifactIdentity.mtimeMs);
        expect(fs.readFileSync(temporary, "utf8")).toBe(change === "temporary-content" ? "user changed temporary"
          : change === "temporary-symlink" ? "external file must survive" : "a".repeat(100_001));
      } else expect(fs.existsSync(temporary)).toBe(false);
      expect(fs.readFileSync(outside, "utf8")).toBe("external file must survive");
      expect(fs.readFileSync(path.join(directory, lookalike), "utf8")).toBe("user owned");
      expect(fs.readdirSync(directory).length).toBe(1 + (fs.existsSync(target) ? 1 : 0) + (modifiedArtifact ? 1 : 0));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
    }
  }
  for (const kind of ["create", "overwrite", "edit"] as const) {
    for (const phase of ["file-sync-failure", "directory-sync-failure", "before-file-sync-crash", "before-directory-sync-crash"]) {
      it(`${kind}: safely recovers after ${phase}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-mutation-recovery-"));
        const directory = path.join(root, "files");
        fs.mkdirSync(directory);
        const target = path.join(directory, "item.txt");
        if (kind !== "create") { fs.writeFileSync(target, "before"); fs.chmodSync(target, 0o640); }
        try {
          const failed = await runChild(root, kind, phase);
          expect(failed.stderr).toContain(`SYNC_CHECKPOINT:${phase.includes("directory") ? "directory" : "file"}`);
          if (phase.startsWith("before-")) {
            expect(failed, failed.stderr).toMatchObject({ code: null, signal: "SIGKILL", timedOut: false, stdout: "" });
          } else {
            expect(failed, failed.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
            expect(JSON.parse(failed.stdout)).toEqual({ ok: false, error: "local_file_mutation_failed", failedDescriptorClosed: true });
          }
          expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
          const before = fs.statSync(target);
          // A still-failing barrier must block recovery too; an early completed journal would bypass it.
          const failedAgain = await runChild(root, kind, "directory-sync-failure");
          expect(failedAgain, failedAgain.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
          expect(JSON.parse(failedAgain.stdout)).toEqual({ ok: false, error: "local_file_mutation_failed", failedDescriptorClosed: true });
          expect(failedAgain.stderr).toContain("SYNC_CHECKPOINT:directory");
          const resumed = await runChild(root, kind, "resume");
          expect(resumed, resumed.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
          expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, result: { sizeBytes: 100_001,
            ...(kind === "edit" ? { changed: true } : { created: kind === "create" }) } });
          expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
          expect(fs.statSync(target).ino).toBe(before.ino);
          expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
          expect(fs.statSync(target).mode & 0o777).toBe(kind === "create" ? 0o600 : 0o640);
          expect(fs.readdirSync(directory)).toEqual(["item.txt"]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }

  for (const kind of ["create", "overwrite", "edit"] as const) {
    for (const changed of [false, true]) {
      it(`${kind}: ${changed ? "preserves an external edit" : "recovers without another write"} after SIGKILL`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-mutation-recovery-"));
        const directory = path.join(root, "files");
        fs.mkdirSync(directory);
        const target = path.join(directory, "item.txt");
        if (kind !== "create") {
          fs.writeFileSync(target, "before");
          fs.chmodSync(target, 0o640);
        }
        try {
          const crashed = await runChild(root, kind, "crash");
          expect(crashed, crashed.stderr).toMatchObject({ code: null, signal: "SIGKILL", timedOut: false, stdout: "" });
          expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
          if (changed) fs.writeFileSync(target, "external revision must survive");
          const durable = fs.statSync(target);
          const resumed = await runChild(root, kind, "resume");
          expect(resumed, resumed.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
          const reply = JSON.parse(resumed.stdout);
          if (changed) {
            expect(reply).toEqual({ ok: false, error: "local_file_content_conflict" });
            expect(fs.readFileSync(target, "utf8")).toBe("external revision must survive");
          } else {
            expect(reply).toMatchObject({ ok: true, result: { sizeBytes: 100_001,
              ...(kind === "edit" ? { changed: true } : { created: kind === "create" }) } });
            expect(reply.result).not.toHaveProperty("content");
            expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
          }
          expect(fs.statSync(target).ino).toBe(durable.ino);
          expect(fs.statSync(target).mtimeMs).toBe(durable.mtimeMs);
          expect(fs.statSync(target).mode & 0o777).toBe(kind === "create" ? 0o600 : 0o640);
          expect(fs.readdirSync(directory)).toEqual(["item.txt"]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  }
});

async function runChild(root: string, kind: string, phase: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/local-mutation-crash.ts", root, kind, phase], {
    cwd: serviceDirectory, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
