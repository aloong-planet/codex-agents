import { describe, expect, it, vi } from "vitest";

import {
  IntentRegistry,
  WorkflowGateway,
  type WorkflowIntentRegistration,
} from "../src/workflow-gateway.js";

const slotsSchema = {
  type: "object" as const,
  required: ["query"],
  additionalProperties: false,
  properties: { query: { type: "string" as const } },
};

function registration(owner: "legacy" | "shadow" | "workflow" = "workflow"): WorkflowIntentRegistration {
  return {
    intent: "notes.send_original",
    intentVersion: 1,
    summary: "查找并发送笔记原文件",
    owner,
    workflowId: "notes-send-original",
    slotsSchema,
    bindInputRefs: vi.fn(async ({ slots }) => ({ noteRequest: `request-${String(slots.query)}` })),
  };
}

describe("WorkflowGateway", () => {
  it("maps a validated proposal through the reviewed registry and binds only trusted trigger context", async () => {
    const definition = registration();
    const engine = { submit: vi.fn(async () => ({ runId: "run-1", duplicate: false })) };
    const gateway = new WorkflowGateway(new IntentRegistry([definition]), engine);

    await expect(gateway.submit({
      protocolVersion: 1,
      proposal: {
        disposition: "workflow",
        intent: "notes.send_original",
        intentVersion: 1,
        confidence: 0.98,
        slots: { query: "AI 代理" },
        missingSlots: [],
      },
      trusted: {
        triggerId: "wechat-event-1",
        source: "weixin",
        occurredAt: 123,
        accountRef: "account-ref",
        targetRef: "target-ref",
      },
    })).resolves.toEqual({
      owner: "workflow",
      workflowId: "notes-send-original",
      submission: { runId: "run-1", duplicate: false },
    });

    expect(definition.bindInputRefs).toHaveBeenCalledWith({
      slots: { query: "AI 代理" },
      trusted: expect.objectContaining({ triggerId: "wechat-event-1", accountRef: "account-ref" }),
    });
    expect(engine.submit).toHaveBeenCalledWith({
      triggerId: "wechat-event-1",
      source: "weixin",
      occurredAt: 123,
      accountRef: "account-ref",
      targetRef: "target-ref",
      requestedWorkflowId: "notes-send-original",
      inputRefs: { noteRequest: "request-AI 代理" },
    });
  });

  it.each(["legacy", "shadow"] as const)("keeps %s ownership side-effect free", async (owner) => {
    const definition = registration(owner);
    const engine = { submit: vi.fn() };
    const gateway = new WorkflowGateway(new IntentRegistry([definition]), engine);

    await expect(gateway.submit({
      protocolVersion: 1,
      proposal: {
        disposition: "workflow", intent: definition.intent, intentVersion: 1,
        confidence: 1, slots: { query: "demo" }, missingSlots: [],
      },
      trusted: { triggerId: `event-${owner}`, source: "weixin", occurredAt: 1 },
    })).resolves.toEqual({ owner, workflowId: "notes-send-original" });

    expect(definition.bindInputRefs).not.toHaveBeenCalled();
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it.each([
    [{ protocolVersion: 2 }, "workflow_gateway_protocol_unsupported"],
    [{ proposal: { disposition: "ordinary_chat", confidence: 1, slots: {}, missingSlots: [] } }, "workflow_gateway_proposal_not_actionable"],
    [{ proposal: { disposition: "workflow", intent: "missing", intentVersion: 1, confidence: 1, slots: {}, missingSlots: [] } }, "workflow_intent_unavailable"],
    [{ proposal: { disposition: "workflow", intent: "notes.send_original", intentVersion: 1, confidence: 1, slots: { query: "demo", targetRef: "evil" }, missingSlots: [] } }, "workflow_intent_slots_invalid"],
    [{ proposal: { disposition: "workflow", intent: "notes.send_original", intentVersion: 1, confidence: 1, slots: { query: "demo" }, missingSlots: [], workflowId: "evil" } }, "workflow_intent_proposal_invalid"],
  ])("fails closed for an invalid or untrusted gateway envelope", async (override, errorCode) => {
    const gateway = new WorkflowGateway(new IntentRegistry([registration()]), { submit: vi.fn() });
    const input = {
      protocolVersion: 1,
      proposal: {
        disposition: "workflow", intent: "notes.send_original", intentVersion: 1,
        confidence: 1, slots: { query: "demo" }, missingSlots: [],
      },
      trusted: { triggerId: "event-invalid", source: "weixin" as const, occurredAt: 1 },
      ...override,
    };

    await expect(gateway.submit(input)).rejects.toThrow(errorCode);
  });

  it("rejects duplicate intent versions at registry construction", () => {
    expect(() => new IntentRegistry([registration(), registration()])).toThrow("workflow_intent_duplicate");
  });

  it("freezes the registered slot contract against later caller mutation", async () => {
    const definition = registration("workflow");
    const registry = new IntentRegistry([definition]);
    (definition.slotsSchema.properties as Record<string, unknown>).targetRef = { type: "string" };
    const gateway = new WorkflowGateway(registry, { submit: vi.fn() });

    await expect(gateway.submit({
      protocolVersion: 1,
      proposal: {
        disposition: "workflow", intent: definition.intent, intentVersion: 1, confidence: 1,
        slots: { query: "demo", targetRef: "model-controlled" }, missingSlots: [],
      },
      trusted: { triggerId: "event-frozen", source: "weixin", occurredAt: 1 },
    })).rejects.toThrow("workflow_intent_slots_invalid");
  });
});
