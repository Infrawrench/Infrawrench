import { describe, it, expect } from "vitest";
import { evaluateShowWhen, buildDefaultFields } from "@/components/CreateResourceModal";

describe("evaluateShowWhen", () => {
  it("returns true when no showWhen is set", () => {
    expect(evaluateShowWhen({}, {})).toBe(true);
  });

  it("returns true when field value matches showWhen condition", () => {
    const field = { showWhen: { fieldKey: "region", fieldValue: "us-east-1" } };
    const fields = { region: "us-east-1" };
    expect(evaluateShowWhen(field, fields)).toBe(true);
  });

  it("returns false when field value does not match", () => {
    const field = { showWhen: { fieldKey: "region", fieldValue: "us-east-1" } };
    const fields = { region: "eu-west-1" };
    expect(evaluateShowWhen(field, fields)).toBe(false);
  });

  it("returns false when referenced field is missing", () => {
    const field = { showWhen: { fieldKey: "region", fieldValue: "us-east-1" } };
    expect(evaluateShowWhen(field, {})).toBe(false);
  });
});

describe("buildDefaultFields", () => {
  it("returns empty object for empty fields array", () => {
    expect(buildDefaultFields([])).toEqual({});
  });

  it("uses defaultValue when provided", () => {
    const fields = [{ key: "name", kind: "text", defaultValue: "my-db" }];
    expect(buildDefaultFields(fields)).toEqual({ name: "my-db" });
  });

  it("uses defaultGb for disk-slider kind", () => {
    const fields = [{ key: "disk", kind: "disk-slider", defaultGb: 50, minGb: 10 }];
    expect(buildDefaultFields(fields)).toEqual({ disk: "50" });
  });

  it("falls back to minGb when defaultGb is not set", () => {
    const fields = [{ key: "disk", kind: "disk-slider", minGb: 10 }];
    expect(buildDefaultFields(fields)).toEqual({ disk: "10" });
  });

  it("falls back to 20 when neither defaultGb nor minGb is set", () => {
    const fields = [{ key: "disk", kind: "disk-slider" }];
    expect(buildDefaultFields(fields)).toEqual({ disk: "20" });
  });

  it("prefers defaultValue over disk-slider fallback", () => {
    const fields = [{ key: "disk", kind: "disk-slider", defaultValue: "100", defaultGb: 50 }];
    expect(buildDefaultFields(fields)).toEqual({ disk: "100" });
  });

  it("skips fields with no default and non-disk-slider kind", () => {
    const fields = [
      { key: "name", kind: "text" },
      { key: "region", kind: "select", defaultValue: "us-east-1" },
    ];
    expect(buildDefaultFields(fields)).toEqual({ region: "us-east-1" });
  });
});
