import { describe, expect, it } from "vitest";

import {
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_SECTION_LABELS,
  ORG_CONFIG_SECTION_READ_PERMISSIONS,
  ORG_CONFIG_SECTION_WRITE_PERMISSIONS,
  isValidOrgConfigKey,
  orgConfigPlanIsNoop,
  slugifyOrgConfigKey,
  tallyOrgConfigChanges,
  uniqueOrgConfigKey,
  type OrgConfigChange,
} from "../org-config";

/**
 * Key derivation is the load-bearing piece: a document key is what an apply
 * matches an existing row on, so a key that moves is a delete-and-recreate.
 */
describe("slugifyOrgConfigKey", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyOrgConfigKey("Monthly Cloud Spend")).toBe("monthly-cloud-spend");
  });

  it("collapses runs of punctuation into a single hyphen and trims the ends", () => {
    expect(slugifyOrgConfigKey("  **Prod** — EU/West!  ")).toBe("prod-eu-west");
  });

  it("falls back to a usable key for a name with nothing to slugify", () => {
    expect(slugifyOrgConfigKey("🎉🎉")).toBe("item");
    expect(slugifyOrgConfigKey("")).toBe("item");
  });

  it("truncates without leaving a trailing hyphen", () => {
    const key = slugifyOrgConfigKey(`${"a".repeat(79)} tail`);
    expect(key.length).toBeLessThanOrEqual(80);
    expect(key.endsWith("-")).toBe(false);
  });

  it("produces keys the API accepts", () => {
    for (const name of ["Home", "CPU > 90%", "  spaced  out  ", "🎉"]) {
      expect(isValidOrgConfigKey(slugifyOrgConfigKey(name))).toBe(true);
    }
  });
});

describe("uniqueOrgConfigKey", () => {
  it("disambiguates duplicate names rather than colliding", () => {
    const taken = new Set<string>();
    expect(uniqueOrgConfigKey("Home", taken)).toBe("home");
    expect(uniqueOrgConfigKey("Home", taken)).toBe("home-2");
    expect(uniqueOrgConfigKey("home", taken)).toBe("home-3");
  });

  it("is stable for the same input order", () => {
    const run = () => {
      const taken = new Set<string>();
      return ["Costs", "Costs", "Alerts"].map((n) => uniqueOrgConfigKey(n, taken));
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual(["costs", "costs-2", "alerts"]);
  });
});

describe("permission tables", () => {
  it("covers every section, in both directions", () => {
    for (const section of ORG_CONFIG_SECTIONS) {
      expect(ORG_CONFIG_SECTION_LABELS[section]).toBeTruthy();
      expect(ORG_CONFIG_SECTION_READ_PERMISSIONS[section]).toMatch(/:/);
      expect(ORG_CONFIG_SECTION_WRITE_PERMISSIONS[section]).toMatch(/:/);
    }
  });
});

describe("plan helpers", () => {
  const change = (action: OrgConfigChange["action"]): OrgConfigChange => ({
    section: "budgets",
    key: `k-${action}`,
    name: action,
    action,
  });

  it("tallies each action", () => {
    expect(tallyOrgConfigChanges([change("create"), change("create"), change("delete")])).toEqual({
      create: 2,
      update: 0,
      delete: 1,
      unchanged: 0,
    });
  });

  it("treats an all-unchanged plan as a no-op", () => {
    const counts = tallyOrgConfigChanges([change("unchanged")]);
    expect(orgConfigPlanIsNoop({ mode: "merge", changes: [], unresolved: [], counts })).toBe(true);
  });

  it("does not treat a plan with deletions as a no-op", () => {
    const counts = tallyOrgConfigChanges([change("delete")]);
    expect(orgConfigPlanIsNoop({ mode: "replace", changes: [], unresolved: [], counts })).toBe(
      false,
    );
  });
});
