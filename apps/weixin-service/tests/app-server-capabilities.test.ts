import { describe, expect, it } from "vitest";

import { inspectAppServerSchema } from "../src/app-server-capabilities.js";

function schemaWithReadOnly(properties: Record<string, unknown>) {
  return {
    properties: {},
    definitions: {
      SandboxPolicy: {
        oneOf: [{
          title: "ReadOnlySandboxPolicy",
          properties: {
            type: { enum: ["readOnly"] },
            ...properties,
          },
        }],
      },
    },
  };
}

describe("inspectAppServerSchema", () => {
  it("fails closed when the installed schema cannot restrict read access", () => {
    expect(inspectAppServerSchema(schemaWithReadOnly({ networkAccess: { type: "boolean" } })))
      .toEqual({
        restrictedReadSupported: false,
        namedPermissionsSupported: false,
        structuredOutputSupported: false,
      });
  });

  it("accepts a read-only sandbox schema with explicit restricted roots", () => {
    expect(inspectAppServerSchema(schemaWithReadOnly({
      access: {
        oneOf: [{
          properties: {
            type: { enum: ["restricted"] },
            readableRoots: { type: "array" },
            includePlatformDefaults: { type: "boolean" },
          },
        }],
      },
    }))).toEqual({
      restrictedReadSupported: true,
      namedPermissionsSupported: false,
      structuredOutputSupported: false,
    });
  });

  it("accepts the current turn permissions field only when it selects a named profile", () => {
    const schema = schemaWithReadOnly({});
    schema.properties = { permissions: { type: ["string", "null"] } };

    expect(inspectAppServerSchema(schema)).toMatchObject({ namedPermissionsSupported: true });
  });

  it("detects the named permissions protocol from the generated profile-list schemas", () => {
    const schema = schemaWithReadOnly({});
    schema.properties = { outputSchema: {} };

    expect(inspectAppServerSchema(schema, { permissionProfileListSupported: true })).toMatchObject({
      namedPermissionsSupported: true,
      structuredOutputSupported: true,
    });
  });

  it("detects the structured output field required by isolated semantic turns", () => {
    const schema = schemaWithReadOnly({});
    schema.properties = { outputSchema: { type: ["object", "null"] } };

    expect(inspectAppServerSchema(schema)).toMatchObject({ structuredOutputSupported: true });
  });
});
