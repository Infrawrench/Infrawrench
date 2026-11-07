import { describe, expect, it } from "vitest";
import type { HttpMethod } from "../config.js";
import type { JsonObject } from "../json.js";
import {
  containExternalRefs,
  dropErrorResponses,
  inlineDeepRefs,
  prune,
  stripPathPrefix,
  withoutDocs,
} from "../prune.js";

const ok = (schema: JsonObject): JsonObject => ({
  responses: { "200": { content: { "application/json": { schema } } } },
});

const base = (paths: JsonObject, schemas: JsonObject = {}): JsonObject => ({
  openapi: "3.1.0",
  info: { title: "x", version: "1" },
  paths,
  components: { schemas },
  webhooks: { hook: { $ref: "#/components/schemas/OnlyWebhook" } },
});

describe("prune", () => {
  it("keeps the listed operations and what they reach, and nothing else", () => {
    const doc = base(
      {
        "/a": {
          parameters: [],
          get: ok({ $ref: "#/components/schemas/A" }),
          post: ok({ $ref: "#/components/schemas/Unused" }),
        },
        "/b": { get: ok({ $ref: "#/components/schemas/Unused" }) },
      },
      {
        A: { properties: { b: { $ref: "#/components/schemas/B" } } },
        B: { type: "string" },
        Unused: { type: "string" },
        OnlyWebhook: { type: "string" },
      },
    );
    const pruned = prune(doc, { "/a": ["get"] });
    expect(Object.keys(pruned)).toEqual(["openapi", "info", "paths", "components"]);
    expect(pruned["paths"]).toHaveProperty(["/a", "parameters"]);
    expect(pruned["paths"]).not.toHaveProperty(["/a", "post"]);
    expect(pruned["paths"]).not.toHaveProperty(["/b"]);
    expect(Object.keys(Object(Object(pruned["components"])["schemas"]))).toEqual(["A", "B"]);
  });

  it("keeps a schema only a discriminator mapping names, by pointer or bare", () => {
    const doc = base(
      {
        "/a": {
          get: ok({
            discriminator: {
              propertyName: "t",
              mapping: { x: "#/components/schemas/X", y: "Y" },
            },
          }),
        },
      },
      { X: { type: "string" }, Y: { type: "string" }, Z: { type: "string" } },
    );
    const schemas = Object(Object(prune(doc, { "/a": ["get"] })["components"])["schemas"]);
    expect(Object.keys(schemas).sort()).toEqual(["X", "Y"]);
  });

  it("forgives a mapping that leads nowhere, but not a $ref", () => {
    const mapping = base({
      "/a": { get: ok({ discriminator: { propertyName: "t", mapping: { x: "Gone" } } }) },
    });
    expect(() => prune(mapping, { "/a": ["get"] })).not.toThrow();
    const ref = base({ "/a": { get: ok({ $ref: "#/components/schemas/Gone" }) } });
    expect(() => prune(ref, { "/a": ["get"] })).toThrowError(
      expect.objectContaining({ kind: "parse", message: expect.stringContaining("Dangling") }),
    );
  });

  it("does not mistake a property called discriminator for one", () => {
    const doc = base({
      "/a": {
        get: ok({
          properties: { discriminator: { properties: { mapping: { type: "string" } } } },
        }),
      },
    });
    expect(() => prune(doc, { "/a": ["get"] })).not.toThrow();
  });

  it.each<[Record<string, HttpMethod[]>, string]>([
    [{ "/gone": ["get"] }, "/gone is not in the document"],
    [{ "/a": ["post"] }, "POST /a is not in the document"],
  ])("says when an operation has gone: %j", (wanted, message) => {
    const doc = base({ "/a": { get: ok({}) } });
    expect(() => prune(doc, wanted)).toThrowError(
      expect.objectContaining({ kind: "operation-removed", message }),
    );
  });

  it("follows percent-encoded and escaped pointers into components", () => {
    const doc = base(
      {
        "/a": {
          get: ok({
            allOf: [
              { $ref: "#/components/schemas/With%20Space" },
              { $ref: "#/components/schemas/With~1Slash" },
            ],
          }),
        },
      },
      { "With Space": { type: "string" }, "With/Slash": { type: "string" } },
    );
    const schemas = Object(Object(prune(doc, { "/a": ["get"] })["components"])["schemas"]);
    expect(schemas).toEqual({
      "With Space": { type: "string" },
      "With/Slash": { type: "string" },
    });
  });

  it("does not find inherited properties through a pointer", () => {
    const doc = base({ "/a": { get: ok({ $ref: "#/components/schemas/constructor" }) } });
    expect(() => prune(doc, { "/a": ["get"] })).toThrow(/Dangling/);
  });
});

describe("inlineDeepRefs", () => {
  it("puts a schema where it is used when it lives inside something else", () => {
    const doc = base(
      {
        "/a": { get: ok({ $ref: "#/paths/~1b/get/responses/200" }) },
        "/b": { get: { responses: { "200": { type: "string" } } } },
        "/c": { get: ok({ $ref: "#/components/schemas/Tag/allOf/0" }) },
      },
      { Tag: { allOf: [{ type: "number" }] } },
    );
    inlineDeepRefs(doc);
    expect(JSON.stringify(doc["paths"])).not.toContain("$ref");
    expect(doc["paths"]).toMatchObject({
      "/c": {
        get: {
          responses: { "200": { content: { "application/json": { schema: { type: "number" } } } } },
        },
      },
    });
  });

  it("leaves a cycle as a reference rather than looping", () => {
    const doc = base(
      {},
      {
        A: {
          properties: {
            x: { properties: { self: { $ref: "#/components/schemas/A/properties/x" } } },
          },
        },
      },
    );
    expect(() => inlineDeepRefs(doc)).not.toThrow();
  });
});

describe("stripPathPrefix", () => {
  it("drops paths outside the prefix and shortens the rest", () => {
    const doc = base({ "/api/v4/a": {}, "/other": {}, "/api/v4x/b": {} });
    stripPathPrefix(doc, "/api/v4");
    expect(Object.keys(Object(doc["paths"]))).toEqual(["/a"]);
  });

  it("fails when nothing matches", () => {
    expect(() => stripPathPrefix(base({ "/a": {} }), "/api")).toThrowError(
      expect.objectContaining({ kind: "operation-removed" }),
    );
  });
});

describe("withoutDocs", () => {
  it("drops documentation keywords but not fields or literals that share a name", () => {
    expect(
      withoutDocs({
        description: "gone",
        example: { $ref: "#/components/schemas/OnlyInAnExample" },
        properties: { description: { type: "string", title: "gone" } },
        default: { description: "kept" },
        enum: [{ title: "kept" }],
      }),
    ).toEqual({
      properties: { description: { type: "string" } },
      default: { description: "kept" },
      enum: [{ title: "kept" }],
    });
  });
});

describe("dropErrorResponses", () => {
  const shape = (responses: JsonObject): JsonObject => ({
    paths: { "/a": { get: { responses } } },
  });

  it("keeps only 2xx", () => {
    const doc = shape({ "200": { a: 1 }, "404": {}, default: {} });
    dropErrorResponses(doc);
    expect(doc).toEqual(shape({ "200": { a: 1 } }));
  });

  it("uses default as the 200 when an operation has no 2xx", () => {
    const doc = shape({ default: { a: 1 }, "500": {} });
    dropErrorResponses(doc);
    expect(doc).toEqual(shape({ "200": { a: 1 } }));
  });
});

describe("containExternalRefs", () => {
  it.each([
    [{ $ref: "https://evil.test/x.json" }],
    [{ $ref: "../../.env" }],
    [{ $ref: "file:///etc/passwd" }],
    [{ a: [{ $ref: "./x.yaml#/A" }] }],
    [{ externalValue: "https://evil.test/x.json" }],
    [{ discriminator: { mapping: { a: "https://evil.test/x.json" } } }],
    [{ discriminator: { mapping: { a: "../secrets.yaml" } } }],
    [{ discriminator: { mapping: { a: "x.json" } } }],
    [{ properties: { "x-named": { $ref: "./x.json" } } }],
    [{ properties: { default: { $ref: "./x.json" } } }],
    [{ headers: { "x-named": { $ref: "./x.json" } } }],
  ])("refuses %j", (node) => {
    expect(() => containExternalRefs(node)).toThrowError(
      expect.objectContaining({ kind: "unsafe" }),
    );
  });

  it("allows what stays inside the document", () => {
    const node = {
      $ref: "#/components/schemas/A",
      properties: { $ref: { type: "string" }, externalValue: { type: "string" } },
      discriminator: { mapping: { a: "A", b: "#/components/schemas/B" } },
      "x-local": { $ref: "#/components/schemas/A" },
      "x-plain": { code: "text" },
    };
    const before = JSON.stringify(node);
    containExternalRefs(node);
    expect(JSON.stringify(node)).toBe(before);
  });

  it("leaves a literal value alone, which is never followed", () => {
    const node = { default: { $ref: "./x.json" }, enum: [{ $ref: "./x.json" }] };
    expect(() => containExternalRefs(node)).not.toThrow();
  });

  it("removes an extension holding one, at any depth, and nothing else", () => {
    const node: JsonObject = {
      type: "string",
      "x-direct": { $ref: "./x.json" },
      "x-samples": [{ code: { $ref: "./snippets/a.ts" } }],
      "x-keep": { a: 1 },
    };
    containExternalRefs(node);
    expect(node).toEqual({ type: "string", "x-keep": { a: 1 } });
  });
});
