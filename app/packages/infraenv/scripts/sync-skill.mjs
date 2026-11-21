// Copies the infraenv agent skill from the website, its source of truth
// (`website/src/data/skills/infraenv/`), into `skills/infraenv/`, where it is
// published with the package: the layout skills-npm, TanStack Intent and other
// skill indexers look for in node_modules (`skills/<name>/SKILL.md`, Agent
// Skills frontmatter).
//
//   node scripts/sync-skill.mjs           write skills/infraenv/
//   node scripts/sync-skill.mjs --check   exit 1 when the committed copy is stale
//
// SKILL.md gets the frontmatter the website's `skillMd` adds (name, then the
// description from skill.json); the references are copied byte for byte.
// Never edit skills/ by hand: change the website folder and run this.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ID = "infraenv";
const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = resolve(PACKAGE, "../website/src/data/skills", SKILL_ID);
export const TARGET = join(PACKAGE, "skills", SKILL_ID);

/**
 * A frontmatter value: plain when YAML reads it back as the same string,
 * double-quoted (JSON is valid YAML there) when it holds `: `, ` #` or starts
 * with a character YAML gives a meaning.
 */
export function yamlScalar(value) {
  const plain =
    value !== "" &&
    !/: |\s#|^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|:$/.test(value) &&
    !/[\n\r\t]/.test(value);
  return plain ? value : JSON.stringify(value);
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** What skills/infraenv/ should hold: a map from relative path to content. */
export function generateSkill(source = SOURCE) {
  const meta = JSON.parse(readFileSync(join(source, "skill.json"), "utf8"));
  if (typeof meta.description !== "string" || !meta.description) {
    throw new Error(`${source}/skill.json has no description`);
  }
  const body = readFileSync(join(source, "SKILL.md"), "utf8").trim() + "\n";
  const files = new Map([
    [
      "SKILL.md",
      `---\nname: ${SKILL_ID}\ndescription: ${yamlScalar(meta.description)}\n---\n\n${body}`,
    ],
  ]);
  const references = join(source, "references");
  if (existsSync(references)) {
    for (const path of filesUnder(references)
      .filter((p) => p.endsWith(".md"))
      .sort()) {
      files.set(relative(source, path).split("\\").join("/"), readFileSync(path, "utf8"));
    }
  }
  return files;
}

/** Paths whose committed copy differs from what `generateSkill` makes, extras included. */
export function staleSkillFiles(target = TARGET, source = SOURCE) {
  const want = generateSkill(source);
  const stale = [];
  for (const [path, content] of want) {
    const file = join(target, path);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) stale.push(path);
  }
  if (existsSync(target)) {
    for (const file of filesUnder(target)) {
      const path = relative(target, file).split("\\").join("/");
      if (!want.has(path)) stale.push(path);
    }
  }
  return stale.sort();
}

function write() {
  rmSync(TARGET, { recursive: true, force: true });
  for (const [path, content] of generateSkill()) {
    const file = join(TARGET, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  console.log(`Wrote ${relative(process.cwd(), TARGET) || "."}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = staleSkillFiles();
    if (stale.length > 0) {
      console.error(
        `skills/${SKILL_ID} is out of date with the website (${stale.join(", ")}). Run \`pnpm --filter @infrawrench/infraenv sync:skill\`.`,
      );
      process.exit(1);
    }
  } else {
    write();
  }
}
