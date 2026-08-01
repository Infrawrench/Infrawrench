import { describe, expect, it } from "vitest";
import {
  complianceScore,
  describeTagViolations,
  extractRecordTags,
  fieldsDeclareTagField,
  taggedSpendPercent,
  tagPolicyViolations,
} from "../tag-policy";

describe("extractRecordTags", () => {
  it("returns null when no tag-shaped field exists (cannot be tagged)", () => {
    expect(extractRecordTags({ name: "web-1", region: "fra1" })).toBeNull();
    expect(extractRecordTags(null)).toBeNull();
    expect(extractRecordTags(undefined)).toBeNull();
  });

  it("reads a plain object map (values coerced to strings)", () => {
    expect(extractRecordTags({ tags: { owner: "astrid", replicas: 3, ha: true } })).toEqual({
      owner: "astrid",
      replicas: "3",
      ha: "true",
    });
  });

  it("matches tags/labels case-insensitively and merges both", () => {
    expect(extractRecordTags({ Tags: { owner: "a" }, labels: { env: "prod" } })).toEqual({
      owner: "a",
      env: "prod",
    });
  });

  it("parses a comma-separated k=v string (the string-list convention)", () => {
    expect(extractRecordTags({ tags: "owner=astrid, env=prod, standalone" })).toEqual({
      owner: "astrid",
      env: "prod",
      standalone: "",
    });
  });

  it("splits on whichever of = or : appears first so values may contain the other", () => {
    expect(extractRecordTags({ tags: "url=https://example.com, note:a=b" })).toEqual({
      url: "https://example.com",
      note: "a=b",
    });
  });

  it("parses a JSON-encoded map or array", () => {
    expect(extractRecordTags({ tags: '{"owner":"astrid"}' })).toEqual({ owner: "astrid" });
    expect(extractRecordTags({ tags: '[{"key":"env","value":"prod"}]' })).toEqual({ env: "prod" });
    expect(extractRecordTags({ tags: '["owner=astrid","env:prod"]' })).toEqual({
      owner: "astrid",
      env: "prod",
    });
  });

  it("treats a present-but-empty tag field as taggable and untagged", () => {
    expect(extractRecordTags({ tags: "" })).toEqual({});
    expect(extractRecordTags({ tags: "not json {" })).toEqual({ "not json {": "" });
  });
});

describe("tagPolicyViolations", () => {
  const required = [{ key: "owner" }, { key: "env", allowedValues: ["prod", "staging"] }];

  it("passes when every key is present with an allowed value", () => {
    expect(tagPolicyViolations({ Owner: "astrid", env: "prod" }, required)).toEqual([]);
  });

  it("flags missing keys and empty values", () => {
    const violations = tagPolicyViolations({ env: "" }, required);
    expect(violations).toEqual([
      { key: "owner", reason: "missing" },
      { key: "env", reason: "missing" },
    ]);
    expect(describeTagViolations(violations)).toContain('missing required tag "owner"');
  });

  it("flags disallowed values (values compared exactly, keys case-insensitively)", () => {
    expect(tagPolicyViolations({ owner: "a", ENV: "dev" }, required)).toEqual([
      { key: "env", reason: "value_not_allowed", value: "dev", allowedValues: ["prod", "staging"] },
    ]);
  });
});

describe("fieldsDeclareTagField", () => {
  it("recognises tags/labels keys regardless of case", () => {
    expect(fieldsDeclareTagField([{ key: "name" }, { key: "Tags" }])).toBe(true);
    expect(fieldsDeclareTagField([{ key: "labels" }])).toBe(true);
    expect(fieldsDeclareTagField([{ key: "name" }])).toBe(false);
  });
});

describe("scores", () => {
  it("complianceScore rounds and returns null when nothing is evaluable", () => {
    expect(complianceScore(2, 3)).toBe(67);
    expect(complianceScore(0, 0)).toBeNull();
  });

  it("taggedSpendPercent is null with no spend and clamps to 0-100", () => {
    expect(taggedSpendPercent({ totals: {}, untaggedTotals: {} }, "USD")).toBeNull();
    expect(taggedSpendPercent({ totals: { USD: 100 }, untaggedTotals: { USD: 25 } }, "USD")).toBe(
      75,
    );
  });
});
