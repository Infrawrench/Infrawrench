import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY_MARKER, bundledSkillDir, placeSkill } from "../commands/skill";
import { cleanupTempDirs, gitInit, isolateGit, runCli, tempDir } from "./harness";

beforeAll(isolateGit);
afterAll(cleanupTempDirs);

/** A repository with the package installed: its skill under node_modules. */
function projectWithPackage(): string {
  const root = gitInit();
  const installed = join(root, "node_modules", "@infrawrench", "infraenv", "skills", "infraenv");
  mkdirSync(installed, { recursive: true });
  cpSync(bundledSkillDir(), installed, { recursive: true });
  return root;
}

describe("infraenv skill", () => {
  it("prints where the bundled skill is", async () => {
    const result = await runCli(["skill"], { cwd: tempDir() });
    expect(result.code).toBe(0);
    const first = result.out.split("\n")[0]!;
    expect(first.endsWith(join("skills", "infraenv", "SKILL.md"))).toBe(true);
    expect(readFileSync(first, "utf8")).toMatch(/^---\nname: infraenv\n/);
  });

  it("links into .agents/skills, and .claude/skills when .claude exists, relatively", async () => {
    const root = projectWithPackage();
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    const result = await runCli(["skill", "install"], { cwd: root });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    for (const dir of [".agents", ".claude"]) {
      const link = join(root, dir, "skills", "infraenv");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(
        join("..", "..", "node_modules", "@infrawrench", "infraenv", "skills", "infraenv"),
      );
      expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    }
    const again = await runCli(["skill", "install"], { cwd: root });
    expect(again.out).toContain("already linked");
  });

  it("leaves .claude alone when the repository has none", async () => {
    const root = projectWithPackage();
    await runCli(["skill", "install"], { cwd: root });
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("never replaces a directory it did not create", async () => {
    const root = projectWithPackage();
    const mine = join(root, ".agents", "skills", "infraenv");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "mine");
    const result = await runCli(["skill", "install"], { cwd: root });
    expect(result.code).toBe(1);
    expect(result.out).toContain("skipped: a directory infraenv did not create is there");
    expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("mine");
  });

  it("fails when the package is not in node_modules", async () => {
    const result = await runCli(["skill", "install"], { cwd: gitInit() });
    expect(result.code).toBe(1);
    expect(result.err).toContain("is not installed in this project");
  });
});

describe("placeSkill on Windows", () => {
  it("copies, marks the copy, and replaces only a marked copy", () => {
    const dir = tempDir();
    const target = join(dir, ".agents", "skills", "infraenv");
    expect(placeSkill(bundledSkillDir(), target, "win32").result).toBe("copied");
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(existsSync(join(target, COPY_MARKER))).toBe(true);
    expect(placeSkill(bundledSkillDir(), target, "win32").result).toBe("replaced");
  });
});
