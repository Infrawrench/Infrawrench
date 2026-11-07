import { describe, expect, it } from "vitest";
import { documentToTypes } from "../generate.js";
import type { JsonObject, JsonValue } from "../json.js";

const options = { silent: true };

/** One operation answering `schema`, with `schemas` in components. */
const doc = (schema: JsonObject, schemas: JsonObject): JsonObject => ({
  openapi: "3.1.0",
  info: { title: "x", version: "1" },
  paths: {
    "/a": {
      get: {
        operationId: "getA",
        responses: {
          "200": { description: "ok", content: { "application/json": { schema } } },
        },
      },
    },
  },
  components: { schemas },
});

const typesOf = (schema: JsonObject, schemas: JsonObject) =>
  documentToTypes(doc(schema, schemas), { paths: { "/a": ["get"] }, patches: [] }, options);

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** An object schema whose `type` property is `declared`, plus one field to tell it by. */
const member = (declared: JsonValue, field: string): JsonObject => ({
  type: "object",
  required: ["type", field],
  properties: { type: declared, [field]: { type: "number" } },
});

const usage = {
  oneOf: [ref("UsageDuration"), ref("UsageTokens")],
  discriminator: { propertyName: "type" },
};

describe("a discriminator with no mapping", () => {
  it("takes each member's value from its enum, not from the schema's name", async () => {
    const types = await typesOf(usage, {
      UsageDuration: member({ type: "string", enum: ["duration"] }, "seconds"),
      UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
    });
    expect(types).toContain('type: "duration"');
    expect(types).toContain('type: "tokens"');
    expect(types).not.toContain('type: "UsageDuration"');
    expect(types).not.toContain('type: "UsageTokens"');
  });

  it("takes it from a const", async () => {
    const types = await typesOf(usage, {
      UsageDuration: member({ const: "duration" }, "seconds"),
      UsageTokens: member({ const: "tokens" }, "tokens"),
    });
    expect(types).toContain('type: "duration"');
    expect(types).toContain('type: "tokens"');
  });

  it("takes it from an enum the property refers to", async () => {
    const types = await typesOf(usage, {
      DurationKind: { type: "string", enum: ["duration"] },
      UsageDuration: member(ref("DurationKind"), "seconds"),
      UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
    });
    expect(types).toContain('type: "duration"');
    expect(types).not.toContain('type: "UsageDuration"');
  });

  it("keeps every value of a member with several", async () => {
    const types = await typesOf(usage, {
      UsageDuration: member({ type: "string", enum: ["seconds", "minutes"] }, "seconds"),
      UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
    });
    expect(types).toMatch(/type: "seconds" \| "minutes"|type: "minutes" \| "seconds"/);
  });

  it("reads a member written as allOf, without making the type never", async () => {
    const types = await typesOf(usage, {
      Base: { type: "object", properties: { id: { type: "string" } } },
      UsageDuration: {
        allOf: [ref("Base"), member({ type: "string", enum: ["duration"] }, "seconds")],
      },
      UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
    });
    expect(types).toContain('type: "duration"');
    expect(types).not.toContain('type: "UsageDuration"');
  });

  it("uses the schema's name for a member that declares no value, as OpenAPI says to", async () => {
    const types = await typesOf(usage, {
      UsageDuration: member({ type: "string" }, "seconds"),
      UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
    });
    expect(types).toContain('type: "UsageDuration"');
    expect(types).toContain('type: "tokens"');
  });
});

describe("a discriminator with a mapping", () => {
  it("wins over what a member declares, because it is what the document says", async () => {
    const types = await typesOf(
      {
        oneOf: [ref("UsageDuration"), ref("UsageTokens")],
        discriminator: {
          propertyName: "type",
          mapping: {
            mapped_duration: "#/components/schemas/UsageDuration",
            mapped_tokens: "#/components/schemas/UsageTokens",
          },
        },
      },
      {
        UsageDuration: member({ type: "string", enum: ["duration"] }, "seconds"),
        UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
      },
    );
    expect(types).toContain('type: "mapped_duration"');
    expect(types).toContain('type: "mapped_tokens"');
  });

  it("is completed for a member it leaves out", async () => {
    const types = await typesOf(
      {
        oneOf: [ref("UsageDuration"), ref("UsageTokens")],
        discriminator: {
          propertyName: "type",
          mapping: { mapped_duration: "#/components/schemas/UsageDuration" },
        },
      },
      {
        UsageDuration: member({ type: "string", enum: ["duration"] }, "seconds"),
        UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
      },
    );
    expect(types).toContain('type: "mapped_duration"');
    expect(types).toContain('type: "tokens"');
    expect(types).not.toContain('type: "UsageTokens"');
  });

  it("reads a target named bare rather than by pointer", async () => {
    const types = await typesOf(
      {
        oneOf: [ref("UsageDuration"), ref("UsageTokens")],
        discriminator: {
          propertyName: "type",
          mapping: { mapped_duration: "UsageDuration", mapped_tokens: "UsageTokens" },
        },
      },
      {
        UsageDuration: member({ type: "string" }, "seconds"),
        UsageTokens: member({ type: "string" }, "tokens"),
      },
    );
    expect(types).toContain('type: "mapped_duration"');
    expect(types).not.toContain('type: "UsageDuration"');
  });
});

describe("a discriminator on a base schema that others inherit from", () => {
  it("takes each child's value from what the child declares", async () => {
    const types = await typesOf(
      { oneOf: [ref("Cat"), ref("Dog")] },
      {
        Pet: {
          type: "object",
          required: ["kind"],
          properties: { kind: { type: "string" } },
          discriminator: { propertyName: "kind" },
        },
        Cat: {
          allOf: [
            ref("Pet"),
            { type: "object", properties: { kind: { type: "string", enum: ["cat"] } } },
          ],
        },
        Dog: {
          allOf: [
            ref("Pet"),
            { type: "object", properties: { kind: { type: "string", enum: ["dog"] } } },
          ],
        },
      },
    );
    expect(types).toContain('kind: "cat"');
    expect(types).toContain('kind: "dog"');
    expect(types).not.toContain('kind: "Cat"');
    expect(types).not.toContain('kind: "Dog"');
  });
});

describe("a document this has nothing to say about", () => {
  it("leaves a property called discriminator alone", async () => {
    const types = await typesOf(
      {
        type: "object",
        properties: { discriminator: { type: "object", properties: { propertyName: {} } } },
      },
      {},
    );
    expect(types).toContain("discriminator?:");
  });

  it("does not spin on a member that inherits from itself", async () => {
    const types = await typesOf(usage, {
      UsageDuration: { allOf: [ref("UsageDuration")] },
      UsageTokens: member({ type: "string", enum: ["tokens"] }, "tokens"),
    });
    expect(types).toContain('type: "tokens"');
  });
});
