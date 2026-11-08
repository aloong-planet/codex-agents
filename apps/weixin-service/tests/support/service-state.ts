import os from "node:os";
import path from "node:path";

/** A protected set for tests whose grants hold no service state: LocalFileTools refuses to start without one. */
export const unrelatedProtectedRoots = [path.join(os.tmpdir(), "codex-weixin-tests-unrelated-service-state")];
