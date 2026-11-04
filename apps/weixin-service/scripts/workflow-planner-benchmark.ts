import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexConversation } from "../src/codex-conversation.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../src/stdio-app-server-transport.js";
import {
  CodexWorkflowIntentPlanner,
  WORKFLOW_PLANNER_DISABLED_FEATURES,
  WORKFLOW_PLANNER_RUNTIME_PROFILE,
  type WorkflowPlannerDiagnostic,
} from "../src/workflow-intent-planner.js";

type Sample = { durationMs: number; outcome: "completed" | "timeout" | "failed"; attempts: number };

const samples = parseSamples(process.argv.slice(2));
const executable = resolveCodexExecutable(process.env);

const input = {
  currentMessage: "发送一张测试图片",
  localDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()),
  timeZone: "Asia/Shanghai",
  candidateIntents: [{
    intent: "media.send-image",
    intentVersion: 1,
    summary: "从已授权本地图片目录查找并发送图片；query、rootId 与 caption 都是可选细化信息。",
    clarificationSlots: [],
  }],
};

const cold: Sample[] = [];
for (let index = 0; index < samples; index += 1) {
  const conversation = createConversation(`cold_${index + 1}`);
  try {
    cold.push(await runSample(conversation));
  } finally {
    await conversation.close();
  }
}

const warmConversation = createConversation("warm");
const warm: Sample[] = [];
try {
  for (let index = 0; index < samples; index += 1) warm.push(await runSample(warmConversation));
} finally {
  await warmConversation.close();
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  samplesPerMode: samples,
  cold: summarize(cold),
  warm: summarize(warm),
}, null, 2)}\n`);

function createConversation(serviceName: string): CodexConversation {
  return new CodexConversation(
    () => spawnStdioAppServer(executable, WORKFLOW_PLANNER_DISABLED_FEATURES),
    30_000,
    undefined,
    undefined,
    30_000,
    {
      serviceName: `weixin_workflow_planner_benchmark_${serviceName}`,
      webSearch: "disabled",
      runtimeProfile: WORKFLOW_PLANNER_RUNTIME_PROFILE,
    },
  );
}

async function runSample(conversation: CodexConversation): Promise<Sample> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-planner-benchmark-"));
  const diagnostics: WorkflowPlannerDiagnostic[] = [];
  const planner = new CodexWorkflowIntentPlanner(conversation, directory, 30_000);
  const startedAt = performance.now();
  try {
    await planner.plan(input, (entry) => diagnostics.push(entry));
    return { durationMs: Math.round(performance.now() - startedAt), outcome: "completed", attempts: attemptsUsed(diagnostics) };
  } catch (error) {
    return {
      durationMs: Math.round(performance.now() - startedAt),
      outcome: error instanceof Error && error.message === "workflow_planner_timeout" ? "timeout" : "failed",
      attempts: attemptsUsed(diagnostics),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function attemptsUsed(diagnostics: WorkflowPlannerDiagnostic[]): number {
  return Math.max(1, ...diagnostics.map((entry) => entry.attempt));
}

function summarize(values: Sample[]): Record<string, unknown> {
  const completed = values.filter((value) => value.outcome === "completed");
  const durations = completed.map((value) => value.durationMs).sort((left, right) => left - right);
  return {
    completed: completed.length,
    timeout: values.filter((value) => value.outcome === "timeout").length,
    failed: values.filter((value) => value.outcome === "failed").length,
    retried: values.filter((value) => value.attempts > 1).length,
    ...(durations.length > 0 ? {
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.at(-1),
    } : {}),
  };
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function parseSamples(args: string[]): number {
  const raw = args.find((value) => value.startsWith("--samples="))?.slice("--samples=".length) ?? "3";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error("workflow_planner_benchmark_samples_invalid");
  return value;
}
