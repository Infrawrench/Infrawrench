import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  UuidRef,
  maxLength,
  minLength,
  normalized,
  pattern,
  trimmed,
} from "@infrawrench/api-contract/schemas";

import { toolAnnotations } from "../annotations";
import { toolInputJsonSchema } from "../json-schema";

describe("toolAnnotations", () => {
  it("marks a read tool read-only and states no write hints", () => {
    expect(toolAnnotations({ title: "List budgets", risk: "read" })).toEqual({
      title: "List budgets",
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("states destructiveHint false on an additive write", () => {
    expect(toolAnnotations({ title: "Create budget", risk: "write" })).toEqual({
      title: "Create budget",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("treats a write that replaces existing data as destructive", () => {
    expect(
      toolAnnotations({ title: "Update budget", risk: "write", overwrites: true }).destructiveHint,
    ).toBe(true);
  });

  it("treats every destructive-tier tool as destructive", () => {
    expect(toolAnnotations({ title: "Delete budget", risk: "destructive" }).destructiveHint).toBe(
      true,
    );
  });

  it("is open-world for a tool that reaches outside, or acts through a plugin", () => {
    expect(
      toolAnnotations({ title: "Run SSH", risk: "destructive", openWorld: true }),
    ).toMatchObject({ openWorldHint: true });
    expect(
      toolAnnotations({ title: "Create bucket", risk: "write", pluginId: "aws" }),
    ).toMatchObject({ openWorldHint: true, destructiveHint: false });
  });
});

describe("toolInputJsonSchema", () => {
  const slug = normalized(
    (v) => v.trim().toLowerCase(),
    [minLength(1), maxLength(40), pattern(/^[a-z0-9-]+$/)],
    { description: "A slug." },
  );

  it("gives a normalising field a type, by what it accepts", () => {
    const schema = toolInputJsonSchema({ key: slug, label: Schema.optionalKey(slug) });
    expect(schema.properties["key"]).toEqual({ type: "string", description: "A slug." });
    expect(schema.properties["label"]).toEqual({ type: "string", description: "A slug." });
    expect(schema.required).toEqual(["key"]);
  });

  it("keeps a trimmed field's bounds, as the raw value can only exceed them", () => {
    const schema = toolInputJsonSchema({ name: trimmed([minLength(1), maxLength(3)]) });
    expect(schema.properties["name"]).toEqual({ type: "string", minLength: 1, maxLength: 3 });
  });

  it("keeps plain constraints and descriptions", () => {
    const schema = toolInputJsonSchema({
      limit: Schema.Int.check(Schema.isLessThanOrEqualTo(10)).annotate({ description: "Cap." }),
    });
    expect(schema.properties["limit"]).toEqual({
      type: "integer",
      maximum: 10,
      description: "Cap.",
    });
  });

  it("states a default that decoding fills in", () => {
    const schema = toolInputJsonSchema({
      topN: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
      nested: Schema.Struct({
        on: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      }),
    });
    expect(schema.properties["topN"]).toEqual({ type: "integer", default: 5 });
    expect(schema.properties["nested"]).toMatchObject({
      properties: { on: { type: "boolean", default: false } },
    });
    expect(schema.required).toEqual(["nested"]);
  });

  it("writes unions of bare types, literals and closed objects as JSON Schema does", () => {
    const schema = toolInputJsonSchema({
      value: Schema.Union([Schema.Finite, Schema.String]),
      kind: Schema.Literal("dimension"),
      one: Schema.Literals(["recommended"]),
      choice: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a") }),
        Schema.Struct({ kind: Schema.Literal("b") }),
      ]),
      id: Schema.optionalKey(UuidRef),
    });
    expect(schema.properties["value"]).toEqual({ type: ["number", "string"] });
    expect(schema.properties["kind"]).toEqual({ type: "string", const: "dimension" });
    expect(schema.properties["one"]).toEqual({ type: "string", const: "recommended" });
    expect(schema.properties["choice"]).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", const: "a" } },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { type: "string", const: "b" } },
          required: ["kind"],
          additionalProperties: false,
        },
      ],
    });
    // Documented as a UUID, checked only non-empty: an MCP client must not refuse other ids.
    expect(schema.properties["id"]).toEqual({ type: "string", minLength: 1 });
  });

  it("inlines named schemas rather than referring to them", () => {
    const Named = Schema.Struct({ x: Schema.String }).annotate({ identifier: "Named" });
    const schema = toolInputJsonSchema({ a: Named, b: Schema.Array(Named) });
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema.properties["a"]).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false,
    });
  });
});
