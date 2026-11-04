import { describe, expect, it } from "vitest";

import { renderWorkflowRun } from "../src/weixin-workflow-trigger-adapter.js";

describe("terminal_file_media_workflow_regression", () => {
  it("uses user-facing file messages without exposing internal capabilities", () => {
    const base = {
      runId: "run-1", source: "weixin" as const, triggerId: "event-1", occurredAt: 1,
      revision: 1, createdAt: 1, updatedAt: 1, requestedWorkflowId: "weixin.send-files",
    };
    expect(renderWorkflowRun({ ...base, status: "succeeded" })).toMatchObject({
      reply: "文件已发送，请查收。",
    });
    expect(renderWorkflowRun({ ...base, status: "failed", errorCode: "local_file_content_conflict" })).toMatchObject({
      reply: "文件内容已经发生变化，请重新查找后再发送。",
    });
    expect(renderWorkflowRun({ ...base, status: "failed", errorCode: "local_file_permission_changed" })).toMatchObject({
      reply: "没有读取这个文件的权限，请在“本地权限”中启用后重试。",
    });
  });
});
