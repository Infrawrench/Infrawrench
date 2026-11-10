import { describe, expect, it } from "vitest";
import { PRODUCT_IDS } from "@infrawrench/client-core";
import { SETTINGS_SECTIONS, firstSettingsSection, groupSettingsSections } from "../sections.js";

const all = () => true;

describe("settings groups", () => {
  it("puts every section in exactly one group, organization first", () => {
    const groups = groupSettingsSections(all);
    expect(groups[0]!.id).toBe("org");
    const keys = groups.flatMap((g) => g.sections.map((s) => s.key));
    expect([...keys].sort()).toEqual(SETTINGS_SECTIONS.map((s) => s.key).sort());
    for (const section of SETTINGS_SECTIONS) {
      expect(["org", ...PRODUCT_IDS]).toContain(section.group);
    }
  });

  it("hides the sections of an app that is turned off", () => {
    const groups = groupSettingsSections(all, ["costs"]);
    expect(groups.map((g) => g.id)).not.toContain("costs");
    expect(groups.flatMap((g) => g.sections.map((s) => s.key))).not.toContain("cost-centres");
  });

  it("drops a group the caller can read nothing of", () => {
    const groups = groupSettingsSections(() => false);
    for (const group of groups) {
      expect(group.sections.every((s) => !s.requiresPermission)).toBe(true);
    }
    expect(groups.map((g) => g.id)).not.toContain("automation");
  });

  it("opens an app's first readable section, and nothing for an app without settings", () => {
    expect(firstSettingsSection("infrastructure")).toBe("ssh-keys");
    expect(firstSettingsSection("costs", (p) => p === "costs:read")).toBe("cost-centres");
    expect(firstSettingsSection("observability")).toBeUndefined();
  });
});
