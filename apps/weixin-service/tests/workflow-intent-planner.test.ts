import { describe, expect, it, vi } from "vitest";

import {
  CodexWorkflowIntentPlanner,
  WORKFLOW_PLANNER_DISABLED_FEATURES,
  WORKFLOW_PLANNER_RUNTIME_PROFILE,
} from "../src/workflow-intent-planner.js";

const input = {
  currentMessage: "把 AI 代理那篇笔记原文件发给我",
  localDate: "2026-08-25",
  timeZone: "Asia/Shanghai",
  candidateIntents: [{
    intent: "notes.send_original",
    intentVersion: 1,
    summary: "查找并发送笔记原文件",
    clarificationSlots: ["query"],
  }],
};

describe("CodexWorkflowIntentPlanner", () => {
  it("accepts strict slot entries from App Server and rebuilds trusted slots", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "planner-strict-slots"),
      reply: vi.fn(async () => JSON.stringify({
        disposition: "workflow",
        intent: "notes.send_original",
        intentVersion: 1,
        confidence: 0.97,
        slotEntries: [{ key: "query", valueJson: JSON.stringify("AI 代理") }],
        missingSlots: [],
      })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).resolves.toEqual({
      disposition: "workflow",
      intent: "notes.send_original",
      intentVersion: 1,
      confidence: 0.97,
      slots: { query: "AI 代理" },
      missingSlots: [],
    });
    expect(WORKFLOW_PLANNER_RUNTIME_PROFILE.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["disposition", "intent", "intentVersion", "confidence", "slotEntries", "missingSlots"],
      properties: {
        slotEntries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "valueJson"],
          },
        },
      },
    });
  });

  it("does not let diagnostic observation failure change a valid Planner result", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "planner-diagnostics-isolated"),
      reply: vi.fn(async () => JSON.stringify({
        disposition: "ordinary_chat",
        intent: null,
        intentVersion: null,
        confidence: 0.9,
        slotEntries: [],
        missingSlots: [],
      })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input, () => { throw new Error("telemetry failed"); })).resolves.toMatchObject({
      disposition: "ordinary_chat",
    });
  });

  it("uses a fresh isolated thread and returns only validated structured classification", async () => {
    let capturedPrompt = "";
    const agent = {
      startOrResume: vi.fn(async () => "planner-thread"),
      reply: vi.fn(async (_threadId: string, prompt: unknown) => {
        capturedPrompt = String(prompt);
        return JSON.stringify({
          disposition: "workflow",
          intent: "notes.send_original",
          intentVersion: 1,
          confidence: 0.97,
          slotEntries: [{ key: "query", valueJson: JSON.stringify("AI 代理") }],
          missingSlots: [],
        });
      }),
      releaseThread: vi.fn(),
      cancelThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).resolves.toEqual({
      disposition: "workflow",
      intent: "notes.send_original",
      intentVersion: 1,
      confidence: 0.97,
      slots: { query: "AI 代理" },
      missingSlots: [],
    });

    expect(agent.startOrResume).toHaveBeenCalledWith(undefined, "/private/planner", []);
    expect(agent.reply).toHaveBeenCalledTimes(1);
    expect(agent.releaseThread).toHaveBeenCalledWith("planner-thread");
    expect(JSON.parse(capturedPrompt)).toEqual({ schemaVersion: 1, ...input });
    expect(WORKFLOW_PLANNER_RUNTIME_PROFILE).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      outputSchema: expect.objectContaining({ type: "object", additionalProperties: false }),
    });
    expect(WORKFLOW_PLANNER_RUNTIME_PROFILE).not.toHaveProperty("developerInstructions");
    expect(WORKFLOW_PLANNER_DISABLED_FEATURES).toEqual(expect.arrayContaining([
      "plugins", "skill_search", "browser_use", "shell_tool", "unified_exec", "multi_agent",
    ]));
  });

  it("repairs one invalid output on the same thread with the same output schema", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "planner-repair"),
      reply: vi.fn()
        .mockResolvedValueOnce('{"disposition":"workflow","workflowId":"evil"}')
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "needs_clarification",
          intent: "notes.send_original",
          intentVersion: 1,
          confidence: 0.7,
          slotEntries: [],
          missingSlots: ["query"],
        })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).resolves.toMatchObject({
      disposition: "needs_clarification",
      missingSlots: ["query"],
    });
    expect(agent.reply).toHaveBeenCalledTimes(2);
    expect(agent.reply.mock.calls[1]?.[0]).toBe("planner-repair");
    expect(JSON.parse(String(agent.reply.mock.calls[1]?.[1]))).toEqual({
      task: "repair_output_contract",
      schemaVersion: 1,
      errorCode: "workflow_intent_proposal_invalid",
      originalInput: { schemaVersion: 1, ...input },
      invalidOutput: '{"disposition":"workflow","workflowId":"evil"}',
    });
  });

  it("repairs clarification that cites an optional media refinement", async () => {
    const mediaInput = {
      ...input,
      currentMessage: "把相册里的 holiday 图片发给我",
      candidateIntents: [{
        intent: "media.send-image",
        intentVersion: 1,
        summary: "来源已冻结；query、rootId、caption 都是可选细化信息。",
        clarificationSlots: [],
      }],
    };
    const agent = {
      startOrResume: vi.fn(async () => "planner-media-clarification-repair"),
      reply: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "needs_clarification",
          intent: "media.send-image",
          intentVersion: 1,
          confidence: 0.7,
          slotEntries: [],
          missingSlots: ["query"],
        }))
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "workflow",
          intent: "media.send-image",
          intentVersion: 1,
          confidence: 0.98,
          slotEntries: [
            { key: "query", valueJson: JSON.stringify("holiday") },
            { key: "rootId", valueJson: JSON.stringify("pictures") },
          ],
          missingSlots: [],
        })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(mediaInput)).resolves.toMatchObject({
      disposition: "workflow",
      intent: "media.send-image",
      slots: { query: "holiday", rootId: "pictures" },
    });
    expect(agent.reply).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(agent.reply.mock.calls[1]?.[1]))).toMatchObject({
      task: "repair_output_contract",
      originalInput: { candidateIntents: [{ clarificationSlots: [] }] },
    });
  });

  it("does not let repair downgrade an invalid media clarification to ordinary chat", async () => {
    const mediaInput = {
      ...input,
      candidateIntents: [{
        intent: "media.send-image",
        intentVersion: 1,
        summary: "来源已冻结；query 是可选细化信息。",
        clarificationSlots: [],
      }],
    };
    const agent = {
      startOrResume: vi.fn(async () => "planner-media-no-downgrade"),
      reply: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "needs_clarification",
          intent: "media.send-image",
          intentVersion: 1,
          confidence: 0.7,
          slotEntries: [],
          missingSlots: ["query"],
        }))
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "ordinary_chat",
          intent: null,
          intentVersion: null,
          confidence: 1,
          slotEntries: [],
          missingSlots: [],
        })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(mediaInput)).rejects.toThrow("workflow_planner_output_invalid");
  });

  it("keeps the original classification context when repairing malformed slot JSON", async () => {
    const datedInput = {
      ...input,
      currentMessage: "把2026-08-12下的摘要文件发给我",
    };
    const malformed = JSON.stringify({
      disposition: "workflow",
      intent: "notes.send_original",
      intentVersion: 1,
      confidence: 0.98,
      slotEntries: [{ key: "query", valueJson: '"2026-08-12" 摘要文件' }],
      missingSlots: [],
    });
    const agent = {
      startOrResume: vi.fn(async () => "planner-repair-context"),
      reply: vi.fn()
        .mockResolvedValueOnce(malformed)
        .mockImplementationOnce(async (_threadId: string, prompt: unknown) => {
          const repair = JSON.parse(String(prompt)) as Record<string, unknown>;
          const originalInput = repair.originalInput as Record<string, unknown> | undefined;
          return JSON.stringify(originalInput?.currentMessage === datedInput.currentMessage &&
              repair.invalidOutput === malformed
            ? {
                disposition: "workflow",
                intent: "notes.send_original",
                intentVersion: 1,
                confidence: 0.98,
                slotEntries: [{ key: "query", valueJson: JSON.stringify("2026-08-12 摘要文件") }],
                missingSlots: [],
              }
            : {
                disposition: "ordinary_chat",
                intent: null,
                intentVersion: null,
                confidence: 1,
                slotEntries: [],
                missingSlots: [],
              });
        }),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(datedInput)).resolves.toMatchObject({
      disposition: "workflow",
      intent: "notes.send_original",
      slots: { query: "2026-08-12 摘要文件" },
    });
  });

  it("fails closed when repair downgrades a recognized workflow proposal to ordinary chat", async () => {
    const malformed = JSON.stringify({
      disposition: "workflow",
      intent: "notes.send_original",
      intentVersion: 1,
      confidence: 0.98,
      slotEntries: [{ key: "query", valueJson: '"2026-08-12" 摘要文件' }],
      missingSlots: [],
    });
    const agent = {
      startOrResume: vi.fn(async () => "planner-no-downgrade"),
      reply: vi.fn()
        .mockResolvedValueOnce(malformed)
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "ordinary_chat",
          intent: null,
          intentVersion: null,
          confidence: 1,
          slotEntries: [],
          missingSlots: [],
        })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).rejects.toThrow("workflow_planner_output_invalid");
  });

  it("allows repair to request clarification for the same recognized intent", async () => {
    const malformed = JSON.stringify({
      disposition: "workflow",
      intent: "notes.send_original",
      intentVersion: 1,
      confidence: 0.7,
      slotEntries: [{ key: "query", valueJson: "not-json" }],
      missingSlots: [],
    });
    const agent = {
      startOrResume: vi.fn(async () => "planner-repair-clarification"),
      reply: vi.fn()
        .mockResolvedValueOnce(malformed)
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "needs_clarification",
          intent: "notes.send_original",
          intentVersion: 1,
          confidence: 0.7,
          slotEntries: [],
          missingSlots: ["query"],
        })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).resolves.toMatchObject({
      disposition: "needs_clarification",
      intent: "notes.send_original",
      missingSlots: ["query"],
    });
  });

  it("fails closed after the single repair instead of returning ordinary chat", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "planner-invalid"),
      reply: vi.fn().mockResolvedValue("not-json"),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).rejects.toThrow("workflow_planner_output_invalid");
    expect(agent.reply).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate slot keys instead of letting a later value override the first", async () => {
    const duplicate = JSON.stringify({
      disposition: "workflow",
      intent: "notes.send_original",
      intentVersion: 1,
      confidence: 0.9,
      slotEntries: [
        { key: "query", valueJson: JSON.stringify("first") },
        { key: "query", valueJson: JSON.stringify("second") },
      ],
      missingSlots: [],
    });
    const agent = {
      startOrResume: vi.fn(async () => "planner-duplicate-slot"),
      reply: vi.fn().mockResolvedValue(duplicate),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).rejects.toThrow("workflow_planner_output_invalid");
    expect(agent.reply).toHaveBeenCalledTimes(2);
  });

  it("repairs an intent outside the current candidate set instead of widening the route", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "planner-candidate"),
      reply: vi.fn()
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "workflow", intent: "media.send_image", intentVersion: 1,
          confidence: 1, slotEntries: [], missingSlots: [],
        }))
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "ordinary_chat", intent: null, intentVersion: null,
          confidence: 0.9, slotEntries: [], missingSlots: [],
        })),
      releaseThread: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).resolves.toEqual({
      disposition: "ordinary_chat",
      confidence: 0.9,
      slots: {},
      missingSlots: [],
    });
    expect(agent.reply).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the isolated runtime once after a timeout and returns the retry result", async () => {
    const diagnostics: import("../src/workflow-intent-planner.js").WorkflowPlannerDiagnostic[] = [];
    let attempt = 0;
    const agent = {
      startOrResume: vi.fn(async () => `planner-attempt-${++attempt}`),
      reply: vi.fn(async (
        _threadId: string,
        _prompt: string,
        _policy: unknown,
        onProgress?: (event: { kind: "turn_accepted" }) => void,
      ) => {
        onProgress?.({ kind: "turn_accepted" });
        if (attempt === 1) return await new Promise<string>(() => {});
        onProgress?.({ kind: "model_activity", activity: "agent_message" } as never);
        return JSON.stringify({
          disposition: "ordinary_chat",
          intent: null,
          intentVersion: null,
          confidence: 0.9,
          slotEntries: [],
          missingSlots: [],
        });
      }),
      releaseThread: vi.fn(),
      cancelThread: vi.fn(),
      close: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 5);

    await expect(planner.plan(input, (diagnostic) => diagnostics.push(diagnostic))).resolves.toEqual({
      disposition: "ordinary_chat",
      confidence: 0.9,
      slots: {},
      missingSlots: [],
    });
    expect(agent.cancelThread).toHaveBeenCalledWith("planner-attempt-1");
    expect(agent.close).toHaveBeenCalledOnce();
    expect(agent.startOrResume).toHaveBeenCalledTimes(2);
    expect(agent.reply).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attempt: 1,
        phase: "initial",
        stage: "turn_accepted",
        outcome: "completed",
      }),
      expect.objectContaining({
        attempt: 2,
        generation: 2,
        phase: "initial",
        stage: "structured_output",
        outcome: "completed",
      }),
    ]));
  });

  it("stops after the second Planner timeout and never starts a third runtime", async () => {
    const agent = {
      startOrResume: vi.fn(async () => "planner-timeout"),
      reply: vi.fn(async () => await new Promise<string>(() => {})),
      releaseThread: vi.fn(),
      cancelThread: vi.fn(),
      close: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 5);

    await expect(planner.plan(input)).rejects.toThrow("workflow_planner_timeout");
    expect(agent.startOrResume).toHaveBeenCalledTimes(2);
    expect(agent.reply).toHaveBeenCalledTimes(2);
    expect(agent.cancelThread).toHaveBeenCalledTimes(2);
    expect(agent.close).toHaveBeenCalledTimes(2);
  });

  it("classifies an App Server request timeout and safely retries it once", async () => {
    const diagnostics: import("../src/workflow-intent-planner.js").WorkflowPlannerDiagnostic[] = [];
    const agent = {
      startOrResume: vi.fn(async () => "planner-app-server-timeout"),
      reply: vi.fn()
        .mockRejectedValueOnce(new Error("Codex App Server 请求超时：turn/start"))
        .mockResolvedValueOnce(JSON.stringify({
          disposition: "ordinary_chat",
          intent: null,
          intentVersion: null,
          confidence: 0.9,
          slotEntries: [],
          missingSlots: [],
        })),
      releaseThread: vi.fn(),
      cancelThread: vi.fn(),
      close: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input, (entry) => diagnostics.push(entry))).resolves.toMatchObject({
      disposition: "ordinary_chat",
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 1, outcome: "timeout", errorCode: "app_server_timeout" }),
      expect.objectContaining({ attempt: 2, stage: "structured_output", outcome: "completed" }),
    ]));
  });

  it("closes the isolated transport when thread startup fails before a thread id exists", async () => {
    const agent = {
      startOrResume: vi.fn(async () => {
        throw new Error("unsupported turn/start permissions contract");
      }),
      reply: vi.fn(),
      releaseThread: vi.fn(),
      close: vi.fn(),
    };
    const planner = new CodexWorkflowIntentPlanner(agent, "/private/planner", 1_000);

    await expect(planner.plan(input)).rejects.toThrow("unsupported turn/start permissions contract");
    expect(agent.close).toHaveBeenCalledOnce();
  });
});
