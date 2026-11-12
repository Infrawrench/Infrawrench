import { describe, expect, it } from "vitest";
import { z } from "zod";

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
  const slug = z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(
      z
        .string()
        .min(1)
        .max(40)
        .regex(/^[a-z0-9-]+$/),
    );

  it("gives a normalising (transform + pipe) field a type, by what it accepts", () => {
    const schema = toolInputJsonSchema({ key: slug, label: slug.optional() });
    expect(schema.properties["key"]).toEqual({ type: "string" });
    expect(schema.properties["label"]).toEqual({ type: "string" });
    expect(schema.required).toEqual(["key"]);
  });

  it("keeps plain constraints and descriptions", () => {
    const schema = toolInputJsonSchema({ limit: z.number().int().max(10).describe("Cap.") });
    expect(schema.properties["limit"]).toEqual({
      type: "integer",
      maximum: 10,
      description: "Cap.",
    });
  });
});
