import { describe, expect, it } from "vitest";
import { generateSkill, staleSkillFiles, yamlScalar } from "../../scripts/sync-skill.mjs";

describe("the published agent skill", () => {
  it("is what sync-skill.mjs generates from the website's skill folder", () => {
    // On failure: `pnpm --filter @infrawrench/infraenv sync:skill`, then commit skills/.
    expect(staleSkillFiles()).toEqual([]);
  });

  it("has Agent Skills frontmatter and its references", () => {
    const files = generateSkill();
    const skill = files.get("SKILL.md")!;
    expect(skill).toMatch(/^---\nname: infraenv\ndescription: .+\n---\n\n# /);
    expect([...files.keys()]).toEqual([
      "SKILL.md",
      "references/format.md",
      "references/migrate.md",
    ]);
  });
});

describe("yamlScalar", () => {
  it("quotes only what YAML would read differently", () => {
    expect(yamlScalar("Create and check files.")).toBe("Create and check files.");
    expect(yamlScalar("replacement for .env: each")).toBe('"replacement for .env: each"');
    expect(yamlScalar("a # comment")).toBe('"a # comment"');
    expect(yamlScalar("`code` first")).toBe('"`code` first"');
  });
});
