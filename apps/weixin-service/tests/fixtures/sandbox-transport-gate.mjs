// Test-only external subprocess transport gate. The production sandbox worker,
// permission checks, filesystem operations and journal all remain real.
import childProcess from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
let held = false;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  if (!Array.isArray(args[1]) || !args[1].some((value) => String(value).endsWith("file-sandbox-worker.mjs"))) return child;
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = function (chunk, ...rest) {
    let frame;
    if (Buffer.isBuffer(chunk) && chunk.length > 4) {
      try { frame = JSON.parse(chunk.subarray(4).toString("utf8")); } catch { /* Non-frame data passes through. */ }
    }
    if (!held && frame?.type === "execute" && frame.operation?.type === process.env.FIXTURE_GATE_OPERATION) {
      held = true;
      const release = (message) => {
        if (message !== "release-sandbox") return;
        process.off("message", release);
        write(chunk, ...rest);
      };
      process.on("message", release);
      process.send?.({ kind: "sandbox-held", operation: frame.operation.type });
      return true;
    }
    return write(chunk, ...rest);
  };
  return child;
};
syncBuiltinESMExports();
