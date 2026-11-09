// Plans `.infrawrench/ci/typescript.yml`: the Infrawrench CI port of
// `pnpm typecheck` (turbo typecheck, which builds every library first).
//
// turbo builds each library's `dist/` with tsdown, a native binary the CI
// isolate cannot run. Instead each library is typechecked by tsc-rs with
// `--emitDeclarationOnly` into `dist/`, level by level, and handed on to the
// next level as artifacts; then every app's projects are checked against
// them. This script works out the levels and the projects, and writes them
// to $IWCI_OUTPUT for the pipeline's dynamic matrices.
//
// Anything it does not understand fails the run rather than being skipped,
// so a new package shape cannot quietly go unchecked.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LEVELS = 5; // l0 .. l4 in the pipeline
const CHUNKS = ["a", "b", "c"]; // jobs per level
const PER_JOB = 64; // a matrix's limit
const root = process.cwd();

// The workspace's package globs: `dir/*` or a plain directory.
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const globs = [];
for (const line of workspace.split("\n")) {
  if (/^\S/.test(line) && !line.startsWith("packages:")) {
    if (globs.length) break;
    continue;
  }
  const m = line.match(/^\s+-\s+"?([^"#]+?)"?\s*$/);
  if (m) globs.push(m[1]);
}
const dirs = globs.flatMap((g) =>
  g.endsWith("/*")
    ? readdirSync(join(root, g.slice(0, -2)), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${g.slice(0, -2)}/${e.name}`)
    : [g],
);

const packages = new Map(); // name -> { dir, json }
for (const dir of dirs) {
  const file = join(root, dir, "package.json");
  if (!existsSync(file)) continue;
  const json = JSON.parse(readFileSync(file, "utf8"));
  packages.set(json.name, { dir, json });
}

const fail = (message) => {
  console.error(`typescript-plan: ${message}`);
  process.exit(1);
};

// tsc-rs is the catalog's `typescript`; anything else (TypeScript 6, astro
// check) is checked by its own job in the pipeline.
const usesTscRs = (json) =>
  (json.devDependencies?.typescript ?? json.dependencies?.typescript) === "catalog:";
const publishesDist = (json) =>
  /\bdist\//.test(JSON.stringify(json.exports ?? "") + (json.types ?? ""));

const libraries = new Map(); // name -> dir
const checks = []; // tsc-rs projects checked against every library's dist
const others = []; // packages checked by their own job
for (const [name, { dir, json }] of packages) {
  const script = json.scripts?.typecheck;
  if (!script) fail(`${dir} has no typecheck script`);
  if (!usesTscRs(json)) {
    others.push(dir);
    continue;
  }
  const projects = [];
  for (const part of script.split("&&").map((p) => p.trim())) {
    // The prep job does what these do.
    if (part === "node scripts/ensure-env.mjs") continue;
    const words = part.split(/\s+/);
    if (words[0] !== "tsc") fail(`${dir}: cannot port \`${part}\` from its typecheck script`);
    let project = ".";
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "--noEmit") continue;
      if (words[i] === "-p" && words[i + 1]) project = words[++i];
      else fail(`${dir}: cannot port \`${part}\` (only \`tsc --noEmit [-p <project>]\`)`);
    }
    projects.push(project);
  }
  if (publishesDist(json) && projects.includes(".")) {
    libraries.set(name, dir);
    for (const p of projects) if (p !== ".") checks.push(`${dir}/${p}`);
  } else {
    for (const p of projects) checks.push(p === "." ? dir : `${dir}/${p}`);
  }
}

// A library's level: one more than the deepest library it depends on.
const depsOf = (json) =>
  Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies });
const level = new Map();
const levelOf = (name, stack = new Set()) => {
  if (level.has(name)) return level.get(name);
  if (stack.has(name)) fail(`dependency cycle through ${name}`);
  stack.add(name);
  let l = 0;
  for (const dep of depsOf(packages.get(name).json)) {
    if (dep !== name && libraries.has(dep)) l = Math.max(l, levelOf(dep, stack) + 1);
  }
  stack.delete(name);
  level.set(name, l);
  return l;
};
for (const name of libraries.keys()) levelOf(name);

const outputs = {};
for (let l = 0; l < LEVELS; l++) {
  const at = [...libraries].filter(([name]) => level.get(name) === l).map(([, dir]) => dir);
  at.sort();
  if (at.length > PER_JOB * CHUNKS.length) {
    fail(`level ${l} has ${at.length} libraries; the pipeline takes ${PER_JOB * CHUNKS.length}`);
  }
  CHUNKS.forEach((c, i) => {
    outputs[`l${l}${c}`] = at.slice(i * PER_JOB, (i + 1) * PER_JOB);
  });
}
const deepest = Math.max(-1, ...level.values());
if (deepest >= LEVELS) fail(`libraries go ${deepest + 1} levels deep; the pipeline has ${LEVELS}`);
checks.sort();
if (checks.length > PER_JOB) fail(`${checks.length} app projects; the check job takes ${PER_JOB}`);
outputs.checks = checks;

for (const [name, value] of Object.entries(outputs)) {
  appendFileSync(process.env.IWCI_OUTPUT, `${name}=${JSON.stringify(value)}\n`);
}
console.log(
  `${libraries.size} libraries in ${deepest + 1} level(s), ${checks.length} app project(s); ` +
    `checked by their own jobs: ${others.sort().join(", ")}`,
);
