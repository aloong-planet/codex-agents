import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

describe("Weixin inbound architecture", () => {
  it("production_parity_gate_selects_the_live_cross_ticket_workflow", () => {
    const serviceDirectory = path.resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(serviceDirectory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const command = manifest.scripts["test:e2e:production-parity"]!;
    expect(command).toContain("WORKFLOW_SIMULATOR_MODEL=live");
    const selection = command.match(/ -g "([^"]+)"/u)?.[1];
    expect(selection, "the live gate must declare the scenarios it runs").toBeDefined();
    const selected = new RegExp(selection!);
    for (const scenario of [
      "production_weixin_agent_loop_full_workflow: a real model finds, edits, verifies, and sends the original file",
      "sends the latest modified local image without asking for a selection",
      "keeps ordinary chat in the main Codex turn without creating a workflow run",
      "continues a simulated Weixin file-send workflow after the user selects one fuzzy match",
      "production_file_matrix_latest_pdf",
      "production_file_matrix_complete_set",
      "production_file_matrix_grep_answer",
      "production_file_matrix_read_summary",
      "production_file_matrix_create_file",
      "production_file_matrix_edit_conflict",
      "production_file_matrix_incomplete_scan_latest",
      "production_file_matrix_incomplete_scan_all",
      "production_file_matrix_untrusted_document",
    ]) {
      expect(selected.test(scenario), `live gate omits ${scenario}`).toBe(true);
    }
  });

  it("production_assembly_retains_tool_protocol_and_acceptance_coverage", () => {
    const serviceDirectory = path.resolve(import.meta.dirname, "..");
    const catalogSource = fs.readFileSync(path.join(serviceDirectory, "src/workflow-tool-catalog.ts"), "utf8");
    expect([...catalogSource.matchAll(/^\s+id: "([a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*)",$/gmu)]
      .map((match) => match[1])).toEqual([
      "files.find",
      "files.grep",
      "files.read",
      "files.edit",
      "files.write",
      "weixin.send_files",
      "media.send",
    ]);
    const driverSource = fs.readFileSync(path.join(serviceDirectory, "src/app-server-turn-driver.ts"), "utf8");
    for (const method of [
      "turn/started",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "turn/completed",
      "error",
      "item/tool/call",
      "item/permissions/requestApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ]) {
      expect(driverSource, `${method} is absent from the turn protocol driver`).toContain(`"${method}"`);
    }
    const mainSource = fs.readFileSync(path.join(serviceDirectory, "src/main.ts"), "utf8");
    for (const dependency of [
      "CodexConversation",
      "WeixinCodexService",
      "LocalFileTools",
      "WorkflowEngine",
      "WeixinWorkflowTriggerAdapter",
      "createProductionWorkflowToolCatalog",
      "WorkflowToolGateway",
      "WorkflowToolHost",
    ]) {
      expect(mainSource, `${dependency} is absent from production assembly`).toContain(dependency);
    }

    const testDefinitions = [
      ...typescriptFiles(path.join(serviceDirectory, "tests")),
      ...typescriptFiles(path.join(serviceDirectory, "e2e")),
    ].flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/(?:it|test)\(\s*["'`]([^"'`]+)["'`]/gu)])
      .flatMap((match) => match[1] === undefined ? [] : [match[1]]);
    for (const name of [
      "production_assembly_retains_tool_protocol_and_acceptance_coverage",
      "production_weixin_agent_loop_full_workflow",
      "production_pending_restart_and_new_goal_workflow",
      "production_contract_and_access_rotation_regression",
      "production_file_matrix_latest_pdf",
      "production_file_matrix_complete_set",
      "production_file_matrix_grep_answer",
      "production_file_matrix_read_summary",
      "production_file_matrix_create_file",
      "production_file_matrix_edit_conflict",
      "production_file_matrix_incomplete_scan",
      "production_file_matrix_untrusted_document",
    ]) {
      expect(testDefinitions.some((definition) => definition.startsWith(name)), `${name} is not defined`).toBe(true);
    }
  });

  it("weixin_inbound_never_uses_turn_steer", () => {
    const sourceDirectory = path.resolve(import.meta.dirname, "../src");
    const violations = typescriptFiles(sourceDirectory)
      .filter((file) => fs.readFileSync(file, "utf8").includes("turn/steer"))
      .map((file) => path.relative(sourceDirectory, file));

    expect(violations).toEqual([]);
  });

  it("new_file_requests_have_no_resolver_or_query_rewriter_execution_path", () => {
    const sourceDirectory = path.resolve(import.meta.dirname, "../src");
    const retiredImplementations = [
      "workflow-file-query-rewriter.ts",
      "workflow-files-provider.ts",
    ].filter((file) => fs.existsSync(path.join(sourceDirectory, file)));
    const mainSource = fs.readFileSync(path.join(sourceDirectory, "main.ts"), "utf8");

    expect(retiredImplementations).toEqual([]);
    expect(mainSource).not.toContain("WorkflowFilesProvider");
    expect(mainSource).not.toContain("PlannerWorkflowFileQueryRewriter");
    expect(mainSource).not.toContain("CodexWorkflowIntentPlanner");
    expect(mainSource).toMatch(/\bworkflowRetirementNotifier(?:\?\.|\.)migrate\(\)/u);
    expect(mainSource).toMatch(/\bworkflowRetirementNotifier(?:\?\.|\.)start\(\)/u);
    const retirementSource = fs.readFileSync(path.join(sourceDirectory, "workflow-retirement-notifier.ts"), "utf8");
    expect(retirementSource).toContain('retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired"');
    expect(retirementSource).toContain('"notes.send-file-resolved", "media.send-local-image-resolved"');
  });
});
