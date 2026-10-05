import { describe, expect, it } from "vitest";
import {
  applyTagKeySettings,
  groupTagKeyOptions,
  hiddenTagKeyMatch,
  isTagKeyHidden,
  normalizeTagKeySettings,
  suggestTagKeyPrefixes,
  TAG_KEY_SETTINGS_LIMITS,
  tagKeyMatchesPattern,
  tagKeyPatternError,
  tagKeySettingsError,
} from "../tag-keys";

describe("tagKeyMatchesPattern", () => {
  it("matches exact keys case-sensitively", () => {
    expect(tagKeyMatchesPattern("Name", "Name")).toBe(true);
    expect(tagKeyMatchesPattern("name", "Name")).toBe(false);
    expect(tagKeyMatchesPattern("Name2", "Name")).toBe(false);
  });

  it("matches prefix patterns", () => {
    expect(tagKeyMatchesPattern("aws:cloudformation:stack-id", "aws:cloudformation:*")).toBe(true);
    expect(tagKeyMatchesPattern("aws:cloudformation:", "aws:cloudformation:*")).toBe(true);
    expect(tagKeyMatchesPattern("aws:autoscaling:groupName", "aws:cloudformation:*")).toBe(false);
  });
});

describe("tagKeyPatternError", () => {
  it("accepts exact keys and trailing-star prefixes", () => {
    expect(tagKeyPatternError("team")).toBeNull();
    expect(tagKeyPatternError("aws:*")).toBeNull();
  });

  it("refuses a lone star, inner stars and blanks", () => {
    expect(tagKeyPatternError("*")).toMatch(/every tag key/);
    expect(tagKeyPatternError("aws:*:id")).toMatch(/end of a pattern/);
    expect(tagKeyPatternError("  ")).toMatch(/empty/);
    expect(tagKeyPatternError("x".repeat(TAG_KEY_SETTINGS_LIMITS.maxKeyLength + 1))).toMatch(
      /longer/,
    );
  });
});

describe("hiddenTagKeyMatch / isTagKeyHidden", () => {
  const settings = { hidden: ["aws:*", "Name"], preferred: ["aws:team"] };

  it("names the entry that matched, exact first", () => {
    expect(hiddenTagKeyMatch("Name", ["N*", "Name"])).toBe("Name");
    expect(hiddenTagKeyMatch("aws:createdBy", settings.hidden)).toBe("aws:*");
    expect(hiddenTagKeyMatch("team", settings.hidden)).toBeNull();
  });

  it("never hides a preferred key, even under a hidden prefix", () => {
    expect(isTagKeyHidden("aws:team", settings)).toBe(false);
    expect(isTagKeyHidden("aws:createdBy", settings)).toBe(true);
  });
});

describe("tagKeySettingsError", () => {
  it("accepts a well-formed document", () => {
    expect(tagKeySettingsError({ hidden: ["aws:*"], preferred: ["team"] })).toBeNull();
  });

  it("refuses a key that is both hidden and preferred", () => {
    expect(tagKeySettingsError({ hidden: ["team"], preferred: ["team"] })).toMatch(/both/);
  });

  it("refuses patterns in the preferred list", () => {
    expect(tagKeySettingsError({ hidden: [], preferred: ["team*"] })).toMatch(/exact keys/);
  });

  it("refuses invalid hidden patterns", () => {
    expect(tagKeySettingsError({ hidden: ["*"], preferred: [] })).toMatch(/every tag key/);
  });

  it("enforces the list caps", () => {
    const many = Array.from(
      { length: TAG_KEY_SETTINGS_LIMITS.maxPreferred + 1 },
      (_, i) => `k${i}`,
    );
    expect(tagKeySettingsError({ hidden: [], preferred: many })).toMatch(/At most/);
  });
});

describe("normalizeTagKeySettings", () => {
  it("trims, dedupes and drops invalid entries", () => {
    expect(
      normalizeTagKeySettings({
        hidden: [" aws:* ", "aws:*", "*", "a*b", "", "team"],
        preferred: ["team", "team", "env*", " env "],
      }),
    ).toEqual({ hidden: ["aws:*"], preferred: ["team", "env"] });
  });

  it("reads a missing or malformed row as the defaults", () => {
    expect(normalizeTagKeySettings(null)).toEqual({ hidden: [], preferred: [] });
    expect(normalizeTagKeySettings({ hidden: "nope" as unknown as string[] })).toEqual({
      hidden: [],
      preferred: [],
    });
  });
});

describe("applyTagKeySettings", () => {
  const keys = ["zone", "aws:cloudformation:stack-id", "env", "team", "Name", "aws:team"];
  const settings = { hidden: ["aws:*", "Name"], preferred: ["team", "aws:team", "missing"] };

  it("pins preferred keys in order, sorts the rest and drops hidden keys", () => {
    expect(applyTagKeySettings(keys, settings)).toEqual([
      { value: "team", label: "team", preferred: true },
      { value: "aws:team", label: "aws:team", preferred: true },
      { value: "env", label: "env" },
      { value: "zone", label: "zone" },
    ]);
  });

  it("keeps hidden keys, flagged and last, when asked", () => {
    const options = applyTagKeySettings(keys, settings, { includeHidden: true });
    expect(options.slice(-2)).toEqual([
      { value: "aws:cloudformation:stack-id", label: "aws:cloudformation:stack-id", hidden: true },
      { value: "Name", label: "Name", hidden: true },
    ]);
  });

  it("is a plain alphabetical list with no settings", () => {
    expect(applyTagKeySettings(["b", "a", "b"], { hidden: [], preferred: [] })).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });
});

describe("groupTagKeyOptions", () => {
  it("splits preferred from the rest without reordering", () => {
    const { preferred, others } = groupTagKeyOptions([
      { value: "a", preferred: true },
      { value: "b" },
      { value: "c", preferred: true },
    ]);
    expect(preferred.map((o) => o.value)).toEqual(["a", "c"]);
    expect(others.map((o) => o.value)).toEqual(["b"]);
  });
});

describe("suggestTagKeyPrefixes", () => {
  const keys = [
    "aws:cloudformation:stack-id",
    "aws:cloudformation:stack-name",
    "aws:cloudformation:logical-id",
    "kubernetes.io/cluster",
    "kubernetes.io/role",
    "aws:createdBy",
    "team",
  ];

  it("offers namespaces shared by several keys, busiest first", () => {
    expect(suggestTagKeyPrefixes(keys, { hidden: [], preferred: [] })).toEqual([
      { pattern: "aws:cloudformation:*", keyCount: 3 },
      { pattern: "kubernetes.io/*", keyCount: 2 },
    ]);
  });

  it("skips namespaces already covered by a hidden entry", () => {
    expect(
      suggestTagKeyPrefixes(keys, { hidden: ["aws:*", "kubernetes.io/*"], preferred: [] }),
    ).toEqual([]);
  });

  it("does not count preferred keys", () => {
    expect(suggestTagKeyPrefixes(["k8s/a", "k8s/b"], { hidden: [], preferred: ["k8s/a"] })).toEqual(
      [],
    );
  });
});
