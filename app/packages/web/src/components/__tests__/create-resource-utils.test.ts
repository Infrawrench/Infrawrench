import { describe, it, expect } from "vitest";
import { evaluateShowWhen, buildDefaultFields } from "@infrawrench/ui";
import { encodeOutputRef, parseOutputRef, isOutputRefValue } from "@infrawrench/plugin-base";

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

  it("matches any value in fieldValues array", () => {
    const field = {
      showWhen: { fieldKey: "eventType", fieldValues: ["push-branch", "push-tag"] },
    };
    expect(evaluateShowWhen(field, { eventType: "push-branch" })).toBe(true);
    expect(evaluateShowWhen(field, { eventType: "push-tag" })).toBe(true);
    expect(evaluateShowWhen(field, { eventType: "manual" })).toBe(false);
  });

  it("prefers fieldValues over fieldValue when both are set", () => {
    const field = {
      showWhen: {
        fieldKey: "eventType",
        fieldValue: "manual",
        fieldValues: ["push-branch", "push-tag"],
      },
    };
    expect(evaluateShowWhen(field, { eventType: "push-branch" })).toBe(true);
    expect(evaluateShowWhen(field, { eventType: "manual" })).toBe(false);
  });

  it("negates with fieldValuesNot", () => {
    const field = { showWhen: { fieldKey: "type", fieldValuesNot: ["A", "AAAA", "CNAME"] } };
    expect(evaluateShowWhen(field, { type: "MX" })).toBe(true);
    expect(evaluateShowWhen(field, { type: "A" })).toBe(false);
  });

  it("requires every condition for allOf", () => {
    const field = {
      showWhen: {
        allOf: [
          { fieldKey: "type", fieldValue: "A" },
          { fieldKey: "content__mode", fieldValue: "picker" },
        ],
      },
    };
    expect(evaluateShowWhen(field, { type: "A", content__mode: "picker" })).toBe(true);
    expect(evaluateShowWhen(field, { type: "A", content__mode: "custom" })).toBe(false);
    expect(evaluateShowWhen(field, { type: "MX", content__mode: "picker" })).toBe(false);
  });

  it("requires at least one condition for anyOf (DNS custom-text gate)", () => {
    const field = {
      showWhen: {
        anyOf: [
          { fieldKey: "content__mode", fieldValue: "custom" },
          { fieldKey: "type", fieldValuesNot: ["A", "AAAA", "CNAME"] },
        ],
      },
    };
    // A record in picker mode → custom text hidden
    expect(evaluateShowWhen(field, { type: "A", content__mode: "picker" })).toBe(false);
    // A record in custom mode → shown
    expect(evaluateShowWhen(field, { type: "A", content__mode: "custom" })).toBe(true);
    // MX record → always shown (not pickable)
    expect(evaluateShowWhen(field, { type: "MX", content__mode: "picker" })).toBe(true);
  });
});

describe("output reference encoding", () => {
  const ref = {
    pluginId: "aws",
    resourceTypeId: "elastic-ip",
    resourceId: "acct:elastic-ip:eipalloc-123",
    accountId: "acct",
    outputKey: "publicIp",
    value: "203.0.113.5",
  };

  it("round-trips an encoded reference", () => {
    const encoded = encodeOutputRef(ref);
    expect(isOutputRefValue(encoded)).toBe(true);
    expect(parseOutputRef(encoded)).toEqual(ref);
  });

  it("treats plain literals as non-references", () => {
    expect(isOutputRefValue("203.0.113.5")).toBe(false);
    expect(parseOutputRef("203.0.113.5")).toBeNull();
    expect(parseOutputRef("example.com")).toBeNull();
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
