import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AppServerCapabilities = {
  restrictedReadSupported: boolean;
  namedPermissionsSupported: boolean;
  structuredOutputSupported: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  const item = record(value);
  if (!item) return false;
  return Object.prototype.hasOwnProperty.call(item, key) ||
    Object.values(item).some((child) => containsKey(child, key));
}

function containsEnum(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) {
    return value.includes(expected) || value.some((item) => containsEnum(item, expected));
  }
  const item = record(value);
  return item ? Object.values(item).some((child) => containsEnum(child, expected)) : false;
}

export function inspectAppServerSchema(
  schema: unknown,
  protocol: { permissionProfileListSupported?: boolean } = {},
): AppServerCapabilities {
  const root = record(schema);
  const definitions = record(record(schema)?.definitions);
  const sandboxPolicy = record(definitions?.SandboxPolicy);
  const alternatives = Array.isArray(sandboxPolicy?.oneOf) ? sandboxPolicy.oneOf : [];
  const readOnly = alternatives.find((candidate) => {
    const item = record(candidate);
    return item?.title === "ReadOnlySandboxPolicy" || containsEnum(candidate, "readOnly");
  });
  const permissions = record(record(root?.properties)?.permissions);
  const outputSchema = record(record(root?.properties)?.outputSchema);
  const permissionTypes = Array.isArray(permissions?.type)
    ? permissions.type
    : [permissions?.type];
  return {
    restrictedReadSupported: Boolean(
      readOnly &&
      containsKey(readOnly, "access") &&
      containsKey(readOnly, "readableRoots") &&
      containsKey(readOnly, "includePlatformDefaults") &&
      containsEnum(readOnly, "restricted"),
    ),
    namedPermissionsSupported: permissionTypes.includes("string") || protocol.permissionProfileListSupported === true,
    structuredOutputSupported: outputSchema !== null,
  };
}

export function probeAppServerCapabilities(executable: string): AppServerCapabilities {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-schema-"));
  try {
    const result = spawnSync(
      executable,
      ["app-server", "generate-json-schema", "--out", directory],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (result.status !== 0) return {
      restrictedReadSupported: false,
      namedPermissionsSupported: false,
      structuredOutputSupported: false,
    };
    const schemaPath = path.join(directory, "v2", "TurnStartParams.json");
    if (!fs.existsSync(schemaPath)) return {
      restrictedReadSupported: false,
      namedPermissionsSupported: false,
      structuredOutputSupported: false,
    };
    const permissionProfileListSupported =
      fs.existsSync(path.join(directory, "v2", "PermissionProfileListParams.json")) &&
      fs.existsSync(path.join(directory, "v2", "PermissionProfileListResponse.json"));
    return inspectAppServerSchema(
      JSON.parse(fs.readFileSync(schemaPath, "utf8")),
      { permissionProfileListSupported },
    );
  } catch {
    return {
      restrictedReadSupported: false,
      namedPermissionsSupported: false,
      structuredOutputSupported: false,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
