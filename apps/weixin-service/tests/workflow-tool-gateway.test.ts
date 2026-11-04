import { describe, expect, it, vi } from "vitest";

import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import {
  WorkflowToolGateway,
  type WorkflowToolRegistration,
} from "../src/workflow-tool-gateway.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

const trusted: TrustedWorkflowTurn = {
  eventKey: "event-1",
  accountId: "account-1",
  target: "target-1",
  occurredAt: 1_788_200_000_000,
  originalTextRef: "filequery_11111111111111111111111111111111",
  attachmentRefs: [],
};

describe("WorkflowToolGateway", () => {
  it("maps a validated weixin.send_files request to its reviewed template with trusted trigger fields", async () => {
    const registration: WorkflowToolRegistration = {
      toolId: "weixin.send_files",
      toolVersion: 1,
      templateId: "weixin.send-files",
      bindInputRefs: vi.fn(() => ({ sendManifest: "sendmanifest_11111111111111111111111111111111" })),
    };
    const engine = {
      supersedePendingSignals: vi.fn(() => []),
      submit: vi.fn(async () => ({ runId: "run-1", duplicate: false })),
      get: vi.fn(() => ({ runId: "run-1", status: "needs_input" })),
    };
    const projector = vi.fn(() => ({ outcome: "needs_input" as const, reply: "请选择一个文件。", runRef: "run-ref-1" }));
    const gateway = new WorkflowToolGateway(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      [registration],
      engine,
      projector,
    );

    await expect(gateway.submit({
      toolId: "weixin.send_files",
      toolVersion: 1,
      arguments: { disposition: "selected", fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
    }, trusted)).resolves.toEqual({
      disposition: "claimed",
      runRef: "run-1",
      receipt: {
        outcome: "needs_input",
        reply: "请选择一个文件。",
        runRef: "run-ref-1",
      },
    });
    expect(registration.bindInputRefs).toHaveBeenCalledWith({
      arguments: { disposition: "selected", fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
      trusted,
    });
    expect(engine.submit).toHaveBeenCalledWith({
      triggerId: "event-1",
      source: "weixin",
      occurredAt: trusted.occurredAt,
      requestedWorkflowId: "weixin.send-files",
      accountRef: "account-1",
      targetRef: "target-1",
      inputRefs: { sendManifest: "sendmanifest_11111111111111111111111111111111" },
    });
    expect(projector).toHaveBeenCalledWith(engine.get.mock.results[0]?.value, trusted);
  });

  it("supersedes the current target pending request before submitting a distinct model-selected workflow", async () => {
    const supersedePendingSignals = vi.fn(() => ["old-run"]);
    const submit = vi.fn(async () => ({ runId: "run-new", duplicate: false }));
    const gateway = new WorkflowToolGateway(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      [{
        toolId: "weixin.send_files",
        toolVersion: 1,
        templateId: "weixin.send-files",
        bindInputRefs: () => ({ sendManifest: "sendmanifest_11111111111111111111111111111111" }),
      }],
      {
        supersedePendingSignals,
        submit,
        get: () => ({ runId: "run-new", status: "succeeded" }),
      },
      () => ({ outcome: "accepted", reply: "文件已发送，请查收。" }),
    );

    await gateway.submit({
      toolId: "weixin.send_files",
      toolVersion: 1,
      arguments: { disposition: "selected", fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
    }, trusted);

    expect(supersedePendingSignals).toHaveBeenCalledWith("account-1", "target-1");
    expect(supersedePendingSignals.mock.invocationCallOrder[0])
      .toBeLessThan(submit.mock.invocationCallOrder[0]!);
  });

  it("rejects unavailable, invalid, or mismatched registrations before submitting a run", async () => {
    const engine = { supersedePendingSignals: vi.fn(() => []), submit: vi.fn(), get: vi.fn() };
    const gateway = new WorkflowToolGateway(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      [{
        toolId: "weixin.send_files",
        toolVersion: 1,
        templateId: "weixin.send-files",
        bindInputRefs: vi.fn(() => ({})),
      }],
      engine,
      vi.fn(),
    );

    await expect(gateway.submit({
      toolId: "weixin.send_files",
      toolVersion: 1,
      arguments: { path: "/private/secret" },
    }, trusted)).rejects.toThrow("workflow_tool_arguments_invalid");
    await expect(gateway.submit({
      toolId: "media.send",
      toolVersion: 1,
      arguments: { kind: "image", source: "local" },
    }, trusted)).rejects.toThrow("workflow_tool_unavailable");
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it("allows one domain member to select only from its reviewed source-specific templates", async () => {
    const submit = vi.fn(async () => ({ runId: "run-media", duplicate: false }));
    const gateway = new WorkflowToolGateway(
      createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true }),
      [{
        toolId: "media.send",
        toolVersion: 1,
        templateId: "media.send-image",
        workflowIds: ["media.send-image-one-message", "weixin.send-local-images"],
        resolveWorkflowId: ({ arguments: value }) =>
          (value as { source: string }).source === "local"
            ? "weixin.send-local-images"
            : "media.send-image-one-message",
        bindInputRefs: () => ({ mediaRequest: "mediareq_11111111111111111111111111111111" }),
      }],
      { supersedePendingSignals: () => [], submit, get: () => ({ runId: "run-media", status: "succeeded" }) },
      () => ({ outcome: "accepted", reply: "图片已发送，请查收。" }),
    );

    await gateway.submit({
      toolId: "media.send",
      toolVersion: 1,
      arguments: {
        kind: "image",
        source: "local",
        disposition: "selected",
        fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      },
    }, trusted);

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      requestedWorkflowId: "weixin.send-local-images",
    }));
  });
});
