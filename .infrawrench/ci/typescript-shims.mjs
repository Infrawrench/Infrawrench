// Declaration shims for `.infrawrench/ci/typescript.yml`.
//
// The pipeline typechecks each library with tsc-rs and `--emitDeclarationOnly`
// into `dist/`, standing in for tsdown (a native binary the CI isolate cannot
// run). tsc writes each source file's declarations beside where tsdown puts
// them, except where tsdown renames an entry: `schemas: "src/schemas/index.ts"`
// becomes `dist/schemas.d.ts`, while tsc writes `dist/schemas/index.d.ts`. For
// each export whose types are not where tsc puts them, this writes a shim that
// re-exports them. The prep job hands them to every job.
//
// A library whose types it cannot place fails the run rather than leaving a
// hole another job would trip over.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const fail = (message) => {
  console.error(`typescript-shims: ${message}`);
  process.exit(1);
};

// The workspace's package globs, `dir/*` or a plain directory.
const globs = [];
for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
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

let libraries = 0;
let shims = 0;
for (const dir of dirs) {
  const file = join(root, dir, "package.json");
  if (!existsSync(file)) continue;
  const json = JSON.parse(readFileSync(file, "utf8"));
  // The pipeline's `build` job: packages built by tsdown.
  if (!json.scripts?.build?.startsWith("tsdown")) continue;
  libraries++;
  const typesPaths = new Set();
  if (typeof json.types === "string") typesPaths.add(json.types);
  for (const target of Object.values(json.exports ?? {})) {
    const types = typeof target === "object" && target !== null ? target.types : undefined;
    if (typeof types === "string") typesPaths.add(types);
  }
  for (const types of typesPaths) {
    const m = types.match(/^\.\/dist\/(.+)\.d\.ts$/);
    if (!m || m[1].includes("*")) continue;
    const at = (p) => existsSync(join(root, dir, p));
    if (at(`src/${m[1]}.ts`) || at(`src/${m[1]}.tsx`)) continue;
    if (!at(`src/${m[1]}/index.ts`) && !at(`src/${m[1]}/index.tsx`)) {
      fail(`${dir}: cannot tell which source ${types} is built from`);
    }
    const out = join(root, dir, "dist", `${m[1]}.d.ts`);
    mkdirSync(dirname(out), { recursive: true });
    const base = m[1].split("/").pop();
    writeFileSync(out, `export * from "./${base}/index.js";\n`);
    shims++;
  }
}
console.log(`${shims} declaration shim(s) for ${libraries} libraries`);
