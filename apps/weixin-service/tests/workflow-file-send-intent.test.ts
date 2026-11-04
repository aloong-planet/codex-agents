import { describe, expect, it } from "vitest";

import {
  WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW,
  WEIXIN_SEND_FILES_WORKFLOW,
} from "../src/workflow-file-send-intent.js";

describe("weixin.send_files workflow", () => {
  it("loads a manifest, gates candidates, prepares immutable snapshots, and maps one effect per file", () => {
    expect(WEIXIN_SEND_FILES_WORKFLOW.steps.map((step) =>
      step.kind === "input_gate" ? "input_gate" : step.capability)).toEqual([
      "files.load_send_manifest",
      "input_gate",
      "files.prepare_send_selection",
      "weixin.submit_file",
    ]);
    expect(WEIXIN_SEND_FILES_WORKFLOW.steps[1]).toMatchObject({ kind: "input_gate", selectionMode: "multiple" });
    expect(WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW.steps[1]).toMatchObject({ kind: "input_gate", selectionMode: "single" });
  });
});
