/**
 * `infraenv skill [install]`: the agent skill this package publishes in
 * `skills/infraenv/` (generated from the website's copy by
 * `scripts/sync-skill.mjs`).
 *
 * Skill indexers (skills-npm, TanStack Intent) find it in node_modules on
 * their own; `install` is for everyone else. It links the skill where agents
 * look in a repository, `.agents/skills/infraenv` and, when the repository has
 * a `.claude` directory, `.claude/skills/infraenv`. The link is relative and
 * points into node_modules, so it works on every clone once dependencies are
 * installed. Windows gets a copy (a directory symlink there needs developer
 * mode), marked so a later install knows it may replace it. Anything else at
 * those paths is left alone.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ParsedArgs } from "../args";
import { gitRoot } from "../git";
import { Failure, printer, type Io } from "../io";
import { display } from "../locate";
import { PACKAGE_ROOT } from "../version";

export const SKILL_NAME = "infraenv";
export const SKILL_URL = "https://infrawrench.com/skills/infraenv.md";
const PACKAGE_NAME = "@infrawrench/infraenv";
/** Written into a copy (Windows) so a later install knows it made it. */
export const COPY_MARKER = ".infraenv-skill";

/** The skill inside this package. */
export function bundledSkillDir(): string {
  return join(PACKAGE_ROOT, "skills", SKILL_NAME);
}

/**
 * The skill as the project installed it: the nearest
 * `node_modules/@infrawrench/infraenv/skills/infraenv` from `cwd` up to `root`.
 * Null when the package is not a dependency (run through npx, say).
 */
export function installedSkillDir(cwd: string, root: string): string | null {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, "node_modules", PACKAGE_NAME, "skills", SKILL_NAME);
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (dir === root || parent === dir) return null;
    dir = parent;
  }
}

export type SkillLinkResult = "linked" | "copied" | "replaced" | "unchanged" | "skipped";

/** Make `target` the skill at `source`; never replaces what it did not make. */
export function placeSkill(
  source: string,
  target: string,
  platform: NodeJS.Platform,
): { result: SkillLinkResult; reason?: string } {
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null;
  }
  const relativeSource = relative(dirname(target), source);
  if (existing) {
    if (existing.isSymbolicLink()) {
      let current: string | null = null;
      try {
        current = relative(dirname(target), resolve(dirname(target), readlinkSync(target)));
      } catch {
        current = null;
      }
      if (current === relativeSource && platform !== "win32") return { result: "unchanged" };
    } else if (!(existing.isDirectory() && existsSync(join(target, COPY_MARKER)))) {
      return {
        result: "skipped",
        reason: `${existing.isDirectory() ? "a directory" : "a file"} infraenv did not create is there`,
      };
    }
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(dirname(target), { recursive: true });
  if (platform === "win32") {
    cpSync(source, target, { recursive: true, dereference: true });
    writeFileSync(
      join(target, COPY_MARKER),
      "Copied by `infraenv skill install`; it replaces this directory on the next install.\n",
    );
    return { result: existing ? "replaced" : "copied" };
  }
  symlinkSync(relativeSource, target, "dir");
  return { result: existing ? "replaced" : "linked" };
}

export async function skill(io: Io, args: ParsedArgs): Promise<number> {
  const p = printer(io);
  const bundled = bundledSkillDir();
  if (args.rest[0] !== "install") {
    if (args.json) {
      p.json({ name: SKILL_NAME, path: join(bundled, "SKILL.md"), url: SKILL_URL });
    } else {
      p.line(join(bundled, "SKILL.md"));
      p.line(p.c.dim(`Also at ${SKILL_URL}. \`infraenv skill install\` links it for agents.`));
    }
    return 0;
  }

  const root = (await gitRoot(io.cwd)) ?? io.cwd;
  const source = installedSkillDir(io.cwd, root);
  if (source === null) {
    throw new Failure(
      `${PACKAGE_NAME} is not installed in this project, so there is nothing in node_modules to link. Add it as a devDependency first, or copy ${display(io.cwd, bundled)} yourself.`,
    );
  }
  const targets = [join(root, ".agents", "skills", SKILL_NAME)];
  const claude = join(root, ".claude");
  if (existsSync(claude) && statSync(claude).isDirectory()) {
    targets.push(join(claude, "skills", SKILL_NAME));
  }

  const rows = targets.map((target) => {
    try {
      return { path: target, ...placeSkill(source, target, io.platform) };
    } catch (error) {
      throw new Failure(
        `Could not place the skill at ${display(io.cwd, target)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  if (args.json) {
    p.json({ source, targets: rows });
  } else {
    for (const row of rows) {
      const where = display(io.cwd, row.path);
      p.line(
        row.result === "skipped"
          ? p.c.yellow(`${where}  skipped: ${row.reason}`)
          : `${where}  ${row.result === "unchanged" ? p.c.dim("already linked") : p.c.green(row.result)}`,
      );
    }
  }
  return rows.some((row) => row.result === "skipped") ? 1 : 0;
}
