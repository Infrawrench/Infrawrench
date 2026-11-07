import { describe, expect, it } from "vitest";
import type { Patch } from "../config.js";
import type { JsonObject } from "../json.js";
import { applyPatches } from "../patches.js";

const patch = (pointer: string, value: Patch["value"]): Patch => ({ pointer, value, why: "test" });

const doc = (): JsonObject => ({
  paths: { "/a/{id}": { get: { required: ["x"], tags: ["one"] } } },
  components: {
    schemas: {
      Ref: { $ref: "#/components/schemas/Real" },
      Real: { properties: { x: { type: "string" } } },
    },
  },
});

describe("applyPatches", () => {
  it("overwrites by JSON pointer, with ~1 for a slash", () => {
    const target = doc();
    applyPatches(target, [patch("/paths/~1a~1{id}/get/required", [])]);
    expect(target).toMatchObject({ paths: { "/a/{id}": { get: { required: [] } } } });
  });

  it("decodes percent-encoding in every segment, the last included", () => {
    const target: JsonObject = { paths: { "/a b": { "c d": 1 } } };
    applyPatches(target, [patch("/paths/~1a%20b/c%20d", 2)]);
    expect(target).toEqual({ paths: { "/a b": { "c d": 2 } } });
  });

  it("writes through a $ref on the way", () => {
    const target = doc();
    applyPatches(target, [patch("/components/schemas/Ref/properties/x", {})]);
    expect(target).toMatchObject({ components: { schemas: { Real: { properties: { x: {} } } } } });
  });

  it("addresses an array item", () => {
    const target = doc();
    applyPatches(target, [patch("/paths/~1a~1{id}/get/tags/0", "two")]);
    expect(target).toMatchObject({ paths: { "/a/{id}": { get: { tags: ["two"] } } } });
  });

  it("adds a key that is not there yet", () => {
    const target = doc();
    applyPatches(target, [patch("/paths/~1a~1{id}/get/nullable", true)]);
    expect(target).toMatchObject({ paths: { "/a/{id}": { get: { nullable: true } } } });
  });

  it("fails when a patch no longer changes anything, so it does not rot", () => {
    expect(() => applyPatches(doc(), [patch("/paths/~1a~1{id}/get/required", ["x"])])).toThrowError(
      expect.objectContaining({
        kind: "patch",
        message: expect.stringContaining("changes nothing"),
      }),
    );
  });

  it("fails when the parent has gone", () => {
    expect(() => applyPatches(doc(), [patch("/paths/~1gone/get/required", [])])).toThrowError(
      expect.objectContaining({ kind: "patch", message: expect.stringContaining("no parent") }),
    );
  });
});
