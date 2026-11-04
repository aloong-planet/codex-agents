import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Direct-dependency gate for the complete business-module families and shared contracts.
// Startup composition and legacy adapter compatibility remain outside this boundary.
const core = [...new Set([...fs.readdirSync(path.resolve(import.meta.dirname, "../src"))
  .filter((file) => /^(?:conversation|account-memory|workflow|local-file|scheduled|plan-).*\.ts$/u.test(file)),
  "channel-turn-adapter.ts", "conversation-workflow-trigger-adapter.ts", "channel-contract.ts", "conversation-service.ts", "personal-owner-identity.ts", "media-delivery.ts", "media-delivery-router.ts",
  "workflow-media-provider.ts", "workflow-media-request-store.ts", "workflow-media-send-intent.ts",
  "workflow-media-artifact-store.ts", "workflow-file-artifact-store.ts", "workflow-tool-production.ts",
  "notification-channel.ts", "scheduled-tasks.ts", "plan-follow-up-monitor.ts",
  "workflow-retirement-notifier.ts", "workflow-reply-renderer.ts", "workflow-delivery-messages.ts", "workflow-run-target-store.ts"])];
function forbiddenImports(source: string): string[] {
  const tree = ts.createSourceFile("core.ts", source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const add = (value: ts.Node) => {
    if (ts.isStringLiteral(value)) imports.push(value.text);
    else imports.push("<computed-import>");
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      if (node.arguments[0]) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports.filter((name) => name === "<computed-import>" || /(?:weixin-|feishu-|ilink-|demo-service|login-|larksuite|public\/)/u.test(name));
}

describe("conversation core dependency gate", () => {
  it.each(core)("%s has no direct platform, SDK or management UI dependency", (file) => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src", file), "utf8");
    expect(forbiddenImports(source)).toEqual([]);
  });

  it("rejects value, type, re-export and dynamic adapter dependencies", () => {
    expect(forbiddenImports(`
      import { A } from "./weixin-conversation-channel.js";
      export type { B } from "./demo-service.js";
      type C = import("@larksuiteoapi/node-sdk").Client;
      const d = import("./feishu-channel.js");
      const e = require("./login-output.js");
      const f = import(variablePath);
    `)).toEqual(["./weixin-conversation-channel.js", "./demo-service.js", "@larksuiteoapi/node-sdk",
      "./feishu-channel.js", "./login-output.js", "<computed-import>"]);
  });
});
