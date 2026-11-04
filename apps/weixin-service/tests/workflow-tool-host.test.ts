import { describe, expect, it, vi } from "vitest";

import { WorkflowToolCatalog, createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import {
  WorkflowToolHost,
  type TrustedWorkflowTurn,
  type WorkflowHandoffReceipt,
  type WorkflowToolGatewayResult,
} from "../src/workflow-tool-host.js";

const trusted: TrustedWorkflowTurn = {
  eventKey: "event-1",
  accountId: "account-1",
  target: "target-1",
  occurredAt: 1_788_200_000_000,
  originalTextRef: "text-ref-1",
  attachmentRefs: [],
};

const accepted: WorkflowHandoffReceipt = {
  outcome: "accepted",
  reply: "文件工作流已开始处理。",
  runRef: "run-ref-1",
};

const claimed: WorkflowToolGatewayResult = { disposition: "claimed", runRef: "run-1", receipt: accepted };

describe("WorkflowToolHost", () => {
  it.each(["local_file_search_timeout", "local_file_search_incomplete"])("preserves read-only search failure without recommending an identical retry: %s", async (code) => {
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, directFiles: true, media: false }),
      { submit: async () => claimed }, { execute: async () => { throw new Error(code); } });
    const binding = host.bind("search-timeout", trusted);
    try {
      const result = await host.execute("find", { kind: "file", limit: 1 }, { threadId: "search-timeout", turnId: "turn", namespace: "files" });
      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0]!.text)).toEqual({ ok: false,
        error: { code, retryable: false, action: "change_request" } });
    } finally { await binding.release(); }
  });

  it.each(["local_file_query_queue_full", "local_file_query_queue_timeout"])("reports queue pressure as a domain failure distinct from scan budget: %s", async (code) => {
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, directFiles: true, media: false }),
      { submit: async () => claimed }, { execute: async () => { throw new Error(code); } });
    const binding = host.bind("query-queue", trusted);
    try {
      const result = await host.execute("find", { kind: "file", limit: 1 }, { threadId: "query-queue", turnId: "turn", namespace: "files" });
      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0]!.text)).toEqual({ ok: false,
        error: { code, retryable: true, action: "retry_later" } });
    } finally { await binding.release(); }
  });

  it("holds the binding until an admitted read finishes and rejects new work during release", async () => {
    let finish!: (value: unknown) => void;
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, directFiles: true, media: false }), { submit: async () => claimed }, {
      execute: () => new Promise((resolve) => { finish = resolve; }),
    });
    const binding = host.bind("draining", trusted);
    const context = { threadId: "draining", turnId: "turn", namespace: "files" };
    const reading = host.execute("find", { query: "one" }, context);
    let released = false;
    const releasing = Promise.resolve(binding.release()).then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(() => host.bind("draining", trusted)).toThrow("workflow_tool_turn_already_bound");
    const late = await host.execute("find", { query: "two" }, context);
    expect(late.contentItems[0]!.text).toContain("workflow_tool_turn_closed");
    finish({ entries: [] });
    await reading;
    await releasing;
    expect(released).toBe(true);
    await host.bind("draining", trusted).release();
  });

  it("returns an inline query result to the model without claiming the workflow owner", async () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.find",
      version: 2,
      description: "Find authorized files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      executionClass: "inline_query",
    }]);
    const gateway = { submit: vi.fn() };
    const inlineTools = {
      execute: vi.fn(async () => ({ matches: [{ fileRef: "file-ref-1", name: "demo.md" }] })),
    };
    const host = new WorkflowToolHost(catalog, gateway, inlineTools);
    const binding = host.bind("thread-1", trusted);

    await expect(host.execute("find", { query: "demo" }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "files",
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          data: { matches: [{ fileRef: "file-ref-1", name: "demo.md" }] },
          meta: {},
        }),
      }],
    });
    expect(inlineTools.execute).toHaveBeenCalledWith({
      toolId: "files.find",
      toolVersion: 2,
      arguments: { query: "demo" },
    }, trusted);
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-1" });
  });

  it("returns a structured safe inline error so the model can correct the request", async () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.read",
      version: 2,
      description: "Read one authorized file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["fileRef"],
        properties: { fileRef: { type: "string" } },
      },
      executionClass: "inline_query",
    }]);
    const host = new WorkflowToolHost(catalog, { submit: vi.fn() }, {
      execute: vi.fn(async () => { throw new Error("local_file_reference_invalid"); }),
    });
    const binding = host.bind("thread-errors", trusted);

    await expect(host.execute("read", { fileRef: "stale" }, {
      threadId: "thread-errors", turnId: "turn-errors", namespace: "files",
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: false,
          error: {
            code: "local_file_reference_invalid",
            retryable: true,
            action: "refresh_reference",
          },
        }),
      }],
    });
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-errors" });
  });

  it("file_tool_error_diagnostics_are_model_repairable: separates domain errors from protocol failures", async () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.find",
      version: 2,
      description: "Find authorized files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      executionClass: "inline_query",
    }]);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("local_file_permission_denied"))
      .mockRejectedValueOnce(new Error("internal failure at /Users/private/secret.txt"))
      .mockResolvedValueOnce({ body: "x".repeat(100_000) });
    const host = new WorkflowToolHost(catalog, { submit: vi.fn() }, { execute });
    host.bind("thread-envelope", trusted);
    const context = { threadId: "thread-envelope", turnId: "turn-envelope", namespace: "files" };

    const invalid = await host.execute("find", { query: 7, path: "/Users/private/secret.txt" }, context);
    expect(invalid.success).toBe(true);
    const invalidEnvelope = JSON.parse(invalid.contentItems[0]!.text) as Record<string, unknown>;
    expect(invalidEnvelope).toMatchObject({
      ok: false,
      error: {
        code: "workflow_tool_arguments_invalid",
        retryable: true,
        action: "correct_arguments",
      },
    });
    expect(invalid.contentItems[0]!.text).not.toContain("/Users/private");

    const denied = await host.execute("find", { query: "demo" }, context);
    expect(denied.success).toBe(true);
    expect(JSON.parse(denied.contentItems[0]!.text)).toEqual({
      ok: false,
      error: {
        code: "local_file_permission_denied",
        retryable: false,
        action: "check_permissions",
      },
    });

    const internal = await host.execute("find", { query: "demo" }, context);
    expect(internal.success).toBe(false);
    expect(JSON.parse(internal.contentItems[0]!.text)).toEqual({
      ok: false,
      error: {
        code: "workflow_tool_internal_error",
        retryable: true,
        action: "retry_later",
      },
    });
    expect(internal.contentItems[0]!.text).not.toContain("private");

    const oversized = await host.execute("find", { query: "demo" }, context);
    expect(oversized.success).toBe(true);
    expect(JSON.parse(oversized.contentItems[0]!.text)).toEqual({
      ok: false,
      error: {
        code: "workflow_tool_result_too_large",
        retryable: true,
        action: "narrow_request",
      },
    });
    expect(Buffer.byteLength(oversized.contentItems[0]!.text, "utf8")).toBeLessThanOrEqual(65_536);
  });

  it("binds trusted turn context and submits a schema-valid namespaced member once", async () => {
    const gateway = { submit: vi.fn(async () => claimed) };
    const host = new WorkflowToolHost(
      createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true }),
      gateway,
    );
    const binding = host.bind("thread-1", trusted);

    await expect(host.execute("send_files", {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "weixin",
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          data: { status: "workflow_claimed", finalReplyOwner: "workflow" },
          meta: {},
        }),
      }],
    });
    expect(gateway.submit).toHaveBeenCalledWith({
      toolId: "weixin.send_files",
      toolVersion: 1,
      arguments: {
        disposition: "selected",
        fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      },
    }, trusted);
    expect(binding.snapshot()).toEqual({ owner: "workflow", runRef: "run-1", receipt: accepted, turnId: "turn-1" });

    await expect(host.execute("send", { kind: "image", source: "local" }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "media",
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: false,
          error: { code: "workflow_turn_already_claimed", retryable: false, action: "stop" },
        }),
      }],
    });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    binding.release();
  });

  it("rejects unknown or invalid tool requests before claiming the workflow owner", async () => {
    const gateway = { submit: vi.fn(async () => claimed) };
    const host = new WorkflowToolHost(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      gateway,
    );
    const binding = host.bind("thread-1", trusted);

    await expect(host.execute("send_files", { path: "/private/secret" }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "weixin",
    })).resolves.toMatchObject({ success: true });
    await expect(host.execute("send", { kind: "image", source: "local" }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "media",
    })).resolves.toMatchObject({ success: false });
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-1" });
    expect(gateway.submit).not.toHaveBeenCalled();

    await host.execute("send_files", {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "weixin",
    });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps the model owner when terminal workflow preflight fails", async () => {
    const gateway = { submit: vi.fn(async () => {
      throw new Error("workflow_file_reference_stale");
    }) };
    const host = new WorkflowToolHost(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      gateway,
    );
    const binding = host.bind("thread-1", trusted);

    await expect(host.execute("send_files", {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "weixin",
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: false,
          error: {
            code: "workflow_file_reference_stale",
            retryable: true,
            action: "refresh_reference",
          },
        }),
      }],
    });
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-1" });
  });

  it("returns a recoverable terminal preflight result to the model without claiming the owner", async () => {
    const gateway = {
      submit: vi.fn(async () => ({
        disposition: "continue" as const,
        result: { status: "rejected", error: "file_reference_stale" },
      })),
    };
    const host = new WorkflowToolHost(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      gateway,
    );
    const binding = host.bind("thread-1", trusted);

    await expect(host.execute("send_files", {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }, {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: "weixin",
    })).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          data: { status: "rejected", error: "file_reference_stale" },
          meta: {},
        }),
      }],
    });
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-1" });
  });

  it("accepts at most one terminal workflow while preflight is in progress", async () => {
    const finishPreflights: Array<(result: WorkflowToolGatewayResult) => void> = [];
    const gateway = {
      submit: vi.fn(() => new Promise<WorkflowToolGatewayResult>((resolve) => {
        finishPreflights.push(resolve);
      })),
    };
    const host = new WorkflowToolHost(
      createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true }),
      gateway,
    );
    const binding = host.bind("thread-1", trusted);
    const context = { threadId: "thread-1", turnId: "turn-1", namespace: "weixin" };

    const argumentsValue = {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    };
    const first = host.execute("send_files", argumentsValue, context);
    const second = host.execute("send_files", argumentsValue, context);
    await Promise.resolve();
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: false,
          error: {
            code: "workflow_terminal_preflight_in_progress",
            retryable: true,
            action: "wait",
          },
        }),
      }],
    });

    finishPreflights[0]!(claimed);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(binding.snapshot()).toEqual({ owner: "workflow", runRef: "run-1", receipt: accepted, turnId: "turn-1" });
  });

  it("dynamic_tool_execution_scheduler_preserves_domains: runs reads concurrently and serializes one resource", async () => {
    const catalog = new WorkflowToolCatalog([
      {
        id: "files.find",
        version: 2,
        description: "Find files.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["query"],
          properties: { query: { type: "string" } },
        },
        executionClass: "inline_query",
      },
      {
        id: "files.edit",
        version: 1,
        description: "Edit a file.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["fileRef", "value"],
          properties: { fileRef: { type: "string" }, value: { type: "string" } },
        },
        executionClass: "inline_mutation",
      },
    ]);
    const started: string[] = [];
    const finish = new Map<string, (value: unknown) => void>();
    const inlineTools = {
      execute: vi.fn((request: { toolId: string; arguments: unknown }) => {
        const argumentsRecord = request.arguments as Record<string, string>;
        const key = request.toolId === "files.find" ? `read:${argumentsRecord.query}` : `write:${argumentsRecord.value}`;
        started.push(key);
        return new Promise((resolve) => finish.set(key, resolve));
      }),
    };
    const host = new WorkflowToolHost(catalog, { submit: vi.fn() }, inlineTools);
    host.bind("thread-scheduler", trusted);
    const queryContext = { threadId: "thread-scheduler", turnId: "turn-scheduler", namespace: "files" };

    const readA = host.execute("find", { query: "a" }, queryContext);
    const readB = host.execute("find", { query: "b" }, queryContext);
    await vi.waitFor(() => expect(started).toEqual(["read:a", "read:b"]));

    const writeA = host.execute("edit", { fileRef: "same-file", value: "a" }, queryContext);
    const writeB = host.execute("edit", { fileRef: "same-file", value: "b" }, queryContext);
    await vi.waitFor(() => expect(started).toContain("write:a"));
    expect(started).not.toContain("write:b");

    finish.get("write:a")?.({ revision: 1 });
    await vi.waitFor(() => expect(started).toContain("write:b"));
    finish.get("write:b")?.({ revision: 2 });
    finish.get("read:a")?.({ query: "a" });
    finish.get("read:b")?.({ query: "b" });

    await expect(Promise.all([readA, readB, writeA, writeB])).resolves.toHaveLength(4);

    const budgetHost = new WorkflowToolHost(catalog, { submit: vi.fn() }, {
      execute: vi.fn(async () => ({ matches: [] })),
    });
    budgetHost.bind("thread-budget", trusted);
    const budgetContext = { threadId: "thread-budget", turnId: "turn-budget", namespace: "files" };
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      budgetHost.execute("find", { query: String(index) }, budgetContext)));
    expect(results.filter((result) => JSON.parse(result.contentItems[0]!.text).ok === true)).toHaveLength(24);
    expect(JSON.parse(results[24]!.contentItems[0]!.text)).toEqual({
      ok: false,
      error: {
        code: "workflow_tool_budget_exhausted",
        retryable: false,
        action: "stop",
      },
    });
  });

  it("terminal_preflight_concurrency_barrier: waits accepted mutations and rejects new mutations or terminals", async () => {
    const catalog = new WorkflowToolCatalog([
      {
        id: "files.find", version: 2, description: "Find files.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["query"],
          properties: { query: { type: "string" } },
        },
        executionClass: "inline_query",
      },
      {
        id: "files.edit", version: 1, description: "Edit a file.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["fileRef"],
          properties: { fileRef: { type: "string" } },
        },
        executionClass: "inline_mutation",
      },
      {
        id: "weixin.send_files", version: 1, description: "Send files.",
        inputSchema: { type: "object", additionalProperties: false },
        executionClass: "terminal_workflow", effectClass: "external_send", templateId: "send-files",
      },
    ]);
    let finishRead: ((value: unknown) => void) | undefined;
    let finishMutation: ((value: unknown) => void) | undefined;
    const inlineTools = {
      execute: vi.fn((request: { toolId: string }) => new Promise((resolve) => {
        if (request.toolId === "files.find") finishRead = resolve;
        else finishMutation = resolve;
      })),
    };
    const gateway = { submit: vi.fn(async () => claimed) };
    const host = new WorkflowToolHost(catalog, gateway, inlineTools);
    const binding = host.bind("thread-barrier", trusted);
    const files = { threadId: "thread-barrier", turnId: "turn-barrier", namespace: "files" };
    const weixin = { ...files, namespace: "weixin" };

    const read = host.execute("find", { query: "demo" }, files);
    const mutation = host.execute("edit", { fileRef: "file-1" }, files);
    await vi.waitFor(() => expect(inlineTools.execute).toHaveBeenCalledTimes(2));
    const terminal = host.execute("send_files", {}, weixin);
    await Promise.resolve();
    expect(gateway.submit).not.toHaveBeenCalled();

    const lateMutation = await host.execute("edit", { fileRef: "file-2" }, files);
    const secondTerminal = await host.execute("send_files", {}, weixin);
    expect(JSON.parse(lateMutation.contentItems[0]!.text)).toMatchObject({
      ok: false, error: { code: "workflow_terminal_preflight_in_progress" },
    });
    expect(JSON.parse(secondTerminal.contentItems[0]!.text)).toMatchObject({
      ok: false, error: { code: "workflow_terminal_preflight_in_progress" },
    });
    expect(inlineTools.execute).toHaveBeenCalledTimes(2);

    finishRead?.({ matches: [] });
    await read;
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-barrier" });

    finishMutation?.({ edited: true });
    await mutation;
    await expect(terminal).resolves.toMatchObject({ success: true });
    expect(gateway.submit).toHaveBeenCalledOnce();
    expect(binding.snapshot()).toEqual({ owner: "workflow", runRef: "run-1", receipt: accepted, turnId: "turn-barrier" });
  });

  it("terminal_workflow_owner_state_machine: returns to model on preflight failure and never returns after claim", async () => {
    const gateway = {
      submit: vi.fn()
        .mockRejectedValueOnce(new Error("workflow_file_reference_stale"))
        .mockResolvedValueOnce(claimed),
    };
    const host = new WorkflowToolHost(
      createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      gateway,
    );
    const binding = host.bind("thread-owner", trusted);
    const context = { threadId: "thread-owner", turnId: "turn-owner", namespace: "weixin" };
    const argumentsValue = {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    };

    const failed = await host.execute("send_files", argumentsValue, context);
    expect(JSON.parse(failed.contentItems[0]!.text)).toMatchObject({
      ok: false, error: { code: "workflow_file_reference_stale" },
    });
    expect(binding.snapshot()).toEqual({ owner: "model", turnId: "turn-owner" });

    await host.execute("send_files", argumentsValue, context);
    expect(binding.snapshot()).toEqual({ owner: "workflow", runRef: "run-1", receipt: accepted, turnId: "turn-owner" });
    const afterClaim = await host.execute("send_files", argumentsValue, context);
    expect(JSON.parse(afterClaim.contentItems[0]!.text)).toEqual({
      ok: false,
      error: { code: "workflow_turn_already_claimed", retryable: false, action: "stop" },
    });
    expect(gateway.submit).toHaveBeenCalledTimes(2);
  });

  it("dynamic_tool_protocol_trace_is_safe_and_complete: records bounded metadata without arguments or references", async () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.edit", version: 1, description: "Edit a file.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["fileRef", "oldText", "newText"],
        properties: {
          fileRef: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
        },
      },
      executionClass: "inline_mutation",
    }]);
    const traces: unknown[] = [];
    let clock = 1_000;
    const host = new WorkflowToolHost(
      catalog,
      { submit: vi.fn() },
      { execute: vi.fn(async () => ({ fileRef: "fileref_result_secret", sizeBytes: 12 })) },
      { now: () => (clock += 5), trace: (event) => traces.push(event) },
    );
    host.bind("thread-trace", trusted);
    const result = await host.execute("edit", {
      fileRef: "fileref_input_secret",
      oldText: "private body token-123",
      newText: "/Users/private/secret.txt",
    }, { threadId: "thread-trace", turnId: "turn-trace", namespace: "files" });

    expect(result.success).toBe(true);
    expect(traces).toEqual([expect.objectContaining({
      toolId: "files.edit",
      toolVersion: 1,
      executionClass: "inline_mutation",
      argumentSummary: {
        keys: ["fileRef", "newText", "oldText"],
        stringLengths: { fileRef: 20, newText: 25, oldText: 22 },
      },
      waitMs: expect.any(Number),
      durationMs: expect.any(Number),
      resultBytes: expect.any(Number),
      resultSuccess: true,
      ownerBefore: "model",
      ownerAfter: "model",
    })]);
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain("fileref_input_secret");
    expect(serialized).not.toContain("fileref_result_secret");
    expect(serialized).not.toContain("token-123");
    expect(serialized).not.toContain("/Users/private");
  });

  it("dynamic_tool_protocol_trace_is_safe_and_complete: retains rejected query inputs for diagnosis", async () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.find", version: 2, description: "Find files.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: { query: { type: "string" } },
      },
      executionClass: "inline_query",
    }]);
    const traces: unknown[] = [];
    const host = new WorkflowToolHost(
      catalog,
      { submit: vi.fn() },
      { execute: vi.fn() },
      { trace: (event) => traces.push(event) },
    );
    host.bind("thread-invalid-trace", trusted);

    await host.execute("find", {
      query: "demo",
      "/Users/private/token-123": "secret",
    }, { threadId: "thread-invalid-trace", turnId: "turn-invalid-trace", namespace: "files" });

    expect(traces).toEqual([expect.objectContaining({
      argumentSummary: {
        keys: ["query"],
        unknownKeyCount: 1,
        stringLengths: { query: 4 },
        queryInputs: { query: "demo", "/Users/private/token-123": "secret" },
      },
      errorCode: "workflow_tool_arguments_invalid",
    })]);
    expect(JSON.stringify(traces)).toContain("/Users/private/token-123");
  });

  it("dynamic_tool_protocol_trace_is_safe_and_complete: preserves terminal wait time on preflight failure", async () => {
    const catalog = new WorkflowToolCatalog([
      {
        id: "files.edit", version: 1, description: "Edit a file.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["fileRef"],
          properties: { fileRef: { type: "string" } },
        },
        executionClass: "inline_mutation",
      },
      {
        id: "weixin.send_files", version: 1, description: "Send files.",
        inputSchema: { type: "object", additionalProperties: false },
        executionClass: "terminal_workflow", effectClass: "external_send", templateId: "send-files",
      },
    ]);
    let finishMutation: ((value: unknown) => void) | undefined;
    let clock = 1_000;
    const traces: Array<{ toolId: string; waitMs: number; errorCode?: string }> = [];
    const host = new WorkflowToolHost(
      catalog,
      { submit: vi.fn(async () => { throw new Error("workflow_file_reference_stale"); }) },
      { execute: vi.fn(() => new Promise((resolve) => { finishMutation = resolve; })) },
      { now: () => clock, trace: (event) => traces.push(event) },
    );
    host.bind("thread-wait-trace", trusted);
    const files = { threadId: "thread-wait-trace", turnId: "turn-wait-trace", namespace: "files" };
    const weixin = { ...files, namespace: "weixin" };

    const mutation = host.execute("edit", { fileRef: "file-1" }, files);
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf("function"));
    const terminal = host.execute("send_files", {}, weixin);
    clock = 1_042;
    finishMutation?.({ edited: true });
    await mutation;
    await terminal;

    expect(traces.find((event) => event.toolId === "weixin.send_files")).toMatchObject({
      waitMs: 42,
      errorCode: "workflow_file_reference_stale",
    });
  });
});
