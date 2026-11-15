// What a workspace package's dependents read of it apart from its dist/, as
// one hash, and the check that test.yml hands it to every job that needs it.
//
//   node source-digest.mjs           in a package: write .source-digest
//   node source-digest.mjs --list    in a package: print what the hash covers
//   node source-digest.mjs --check   check test.yml against the workspace
//
// A job's task cache key holds its own package's files and the artifacts it
// is handed. A dependency's dist/ is an artifact (`^bundle`, `^build`); the
// files of a dependency that a job reads straight from the checkout are not,
// so test.yml's `source` job writes this hash for every package and `^source`
// hands it on like a dist/ (#1175). No dependencies: it runs before any
// install, and in `prep`, which has none.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST_FILE = ".source-digest";

// ---------------------------------------------------------------------------
// What the hash covers
// ---------------------------------------------------------------------------

/** A library: the packages test.yml's `bundle` and `build` jobs select. */
const isBuilt = (pkg) => /^tsdown/.test(pkg.scripts?.build ?? "");

/** The fields of package.json that decide what an import of the package resolves to. */
const RESOLUTION_FIELDS = [
  "name",
  "type",
  "exports",
  "imports",
  "main",
  "module",
  "browser",
  "types",
  "typings",
  "typesVersions",
  "bin",
];

/** Every file an entry point field names, without a leading `./`. */
function entryTargets(pkg) {
  const targets = new Set();
  const collect = (value) => {
    if (typeof value === "string") targets.add(value.replace(/^\.\//, ""));
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  for (const field of ["exports", "main", "module", "browser", "types", "typings", "bin"]) {
    collect(pkg[field]);
  }
  return [...targets].sort();
}

const outsideDist = (pkg) => entryTargets(pkg).filter((target) => !target.startsWith("dist/"));

/**
 * True for a package whose dependents read files of it that no `bundle` or
 * `build` hands them: one with no build, or a library with an entry point
 * outside dist/.
 */
const shipsSource = (pkg) => !isBuilt(pkg) || outsideDist(pkg).length > 0;

// A test file is an entry point of its own package's suite and nothing
// imports one, so a dependent's result cannot depend on it. Helpers and
// fixtures beside the tests are still covered.
const isTestFile = (name) => /\.test\.[cm]?[jt]sx?$/.test(name);

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

function walk(root, relative = "") {
  const files = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...walk(root, path));
    } else if (path !== DIGEST_FILE && !isTestFile(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * The files of the package in `dir` its dependents may read from the
 * checkout, and whether the whole of package.json is among them.
 *
 * - A package with no build ships its source: every file but its tests.
 * - A library is read through its dist/, which `bundle` and `build` hand on,
 *   so only its entry points outside dist/ count. One that imports nothing by
 *   a relative path (a hand-written declaration file) is covered alone.
 *   Anything else can reach any file of the package (plugin-base's
 *   `./test-harness` is src/test-harness.ts, which imports most of src/), so
 *   the package is covered whole, as if it had no build: wider than an import
 *   graph would be, never narrower.
 */
function coverage(dir, pkg) {
  if (!isBuilt(pkg)) return { whole: true, files: walk(dir) };
  const outside = outsideDist(pkg);
  const leaf = (target) => {
    if (target.includes("*")) return false;
    const path = join(dir, target);
    // A target that is not in the checkout (written by a build) has nothing to read.
    if (!existsSync(path)) return true;
    return lstatSync(path).isFile() && !/["'`]\.{1,2}\//.test(readFileSync(path, "utf8"));
  };
  if (outside.every(leaf)) {
    return { whole: false, files: outside.filter((target) => existsSync(join(dir, target))) };
  }
  return { whole: true, files: walk(dir) };
}

function digest(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const { whole, files } = coverage(dir, pkg);
  const hash = createHash("sha256");
  hash.update("source-digest 1\n");
  if (!whole) {
    const fields = RESOLUTION_FIELDS.map((field) => [field, pkg[field] ?? null]);
    hash.update(`${JSON.stringify(fields)}\n`);
  }
  for (const file of files.sort()) {
    const path = join(dir, file);
    const content = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
    hash.update(`${file}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return { hash: hash.digest("hex"), whole, files };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

// `packages:` jobs with a task cache that are not handed `^source`, and why
// their result cannot depend on another package's files.
const PACKAGE_JOBS_WITHOUT_SOURCE = {
  bundle:
    "tsdown bundles a library's own entry points and leaves every workspace dependency external",
  prettier: "Prettier reads the files of the one package it is given",
};

// Task-cached jobs that run inside a package without loading it: they name
// what they read themselves.
const JOBS_THAT_IMPORT_NOTHING = {
  "translations-audit": "parses the sources its inputs list as text and follows no import",
  "translations-status": "reads the sources and catalogs its inputs list and follows no import",
  migrations: "drizzle-kit reads drizzle.config.ts and the migration files, which its inputs list",
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** The workspace's packages by directory, from pnpm-workspace.yaml's `packages:` list. */
function readWorkspace(root) {
  const lines = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start < 0) throw new Error("pnpm-workspace.yaml has no `packages:` list");
  const directories = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line);
    if (!item) break;
    const pattern = item[1];
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const base = pattern.slice(0, -2);
      for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(`${base}/${entry.name}`);
      }
    } else if (!/[*!]/.test(pattern)) {
      directories.push(pattern);
    } else {
      throw new Error(`pnpm-workspace.yaml: this check cannot expand "${pattern}"`);
    }
  }
  const packages = new Map();
  for (const dir of directories.sort()) {
    const file = join(root, dir, "package.json");
    if (existsSync(file)) packages.set(dir, JSON.parse(readFileSync(file, "utf8")));
  }
  return packages;
}

/** The directories of every workspace package `dir` depends on, directly or not. */
function dependencyClosure(packages, dir) {
  const byName = new Map([...packages].map(([directory, pkg]) => [pkg.name, directory]));
  const seen = new Set();
  const queue = [dir];
  while (queue.length > 0) {
    const pkg = packages.get(queue.pop());
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        const dependency = byName.get(name);
        if (dependency && !seen.has(dependency)) {
          seen.add(dependency);
          queue.push(dependency);
        }
      }
    }
  }
  seen.delete(dir);
  return [...seen].sort();
}

/**
 * test.yml's jobs, each as its keys' text. Not a YAML parser: it reads the
 * layout Prettier keeps the file in (a job two spaces in, its keys four) and
 * the aliases jobs share, which is all the check needs, and the check fails
 * on a job it cannot read rather than passing it.
 */
function readJobs(text) {
  const lines = text.split("\n").filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) throw new Error("no `jobs:` in the pipeline");
  const jobs = new Map();
  let job = null;
  let key = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([\w-]+):\s*$/.exec(line);
    if (header) {
      job = new Map();
      key = null;
      jobs.set(header[1], job);
      continue;
    }
    const entry = /^ {4}([\w-]+):(.*)$/.exec(line);
    if (entry && job) {
      key = entry[1];
      job.set(key, entry[2]);
    } else if (/^ {5,}\S/.test(line) && job && key) {
      job.set(key, `${job.get(key)}\n${line}`);
    } else if (line.trim() !== "") {
      throw new Error(`cannot read this line of the pipeline: ${JSON.stringify(line)}`);
    }
  }
  const anchors = new Map();
  for (const keys of jobs.values()) {
    for (const [name, value] of keys) {
      const anchor = /^\s*&([\w-]+)\s?/.exec(value);
      if (!anchor) continue;
      keys.set(name, value.slice(anchor[0].length));
      anchors.set(anchor[1], keys.get(name));
    }
  }
  for (const [id, keys] of jobs) {
    for (const [name, value] of keys) {
      const alias = /^\s*\*([\w-]+)\s*$/.exec(value);
      if (!alias) continue;
      if (!anchors.has(alias[1])) throw new Error(`${id}.${name}: no anchor for *${alias[1]}`);
      keys.set(name, anchors.get(alias[1]));
    }
  }
  return jobs;
}

/** Every item of the lists in a key's text, flow (`[a, b]`) or block (`- a`). */
function listItems(value = "") {
  const unquote = (item) =>
    item
      .trim()
      .replace(/\s+#.*$/, "")
      .replace(/^(["'])(.*)\1$/, "$2");
  const items = [];
  for (const [, flow] of value.matchAll(/\[([^\]]*)\]/g)) items.push(...flow.split(","));
  for (const [, block] of value.matchAll(/^\s*-\s+(.*)$/gm)) items.push(block);
  return items.map(unquote).filter((item) => item !== "");
}

function check(root) {
  const packages = readWorkspace(root);
  const jobs = readJobs(readFileSync(join(root, ".infrawrench/ci/test.yml"), "utf8"));
  const problems = [];
  const needsSource = (keys) => listItems(keys.get("needs")).includes("^source");
  const uncovered = (dir, listed, only = () => true) =>
    dependencyClosure(packages, dir)
      .filter((dependency) => only(packages.get(dependency)))
      .filter((dependency) => !listed.includes(`${dependency}/**`));

  // The job that writes the digests: every package, each handing on its
  // dependencies', kept as an artifact.
  const source = jobs.get("source");
  if (!source) {
    problems.push("there is no `source` job");
  } else {
    if (source.get("packages")?.trim() !== "true") {
      problems.push("`source` must be `packages: true`: a package left out is a package unkeyed");
    }
    if (!needsSource(source)) {
      problems.push(
        '`source` must need "^source", or a dependency\'s dependencies are not handed on',
      );
    }
    if (!listItems(source.get("artifacts")).includes(DIGEST_FILE)) {
      problems.push(`\`source\` must keep ${DIGEST_FILE} as an artifact`);
    }
  }

  // `isBuilt` here and the two jobs that hand on a dist/ must select the
  // same packages, or a package is neither built nor covered as source.
  for (const id of ["bundle", "build"]) {
    if (!/scripts:\s*\{\s*build:\s*"tsdown\*"\s*\}/.test(jobs.get(id)?.get("packages") ?? "")) {
      problems.push(
        `\`${id}\` no longer selects \`scripts: { build: "tsdown*" }\`: change isBuilt in source-digest.mjs with it`,
      );
    }
  }

  for (const [id, keys] of jobs) {
    const cached = keys.has("task-cache") && keys.get("task-cache").trim() !== "false";
    if (keys.has("packages")) {
      if (cached) {
        if (id in PACKAGE_JOBS_WITHOUT_SOURCE || needsSource(keys)) continue;
        problems.push(
          `\`${id}\` is task-cached and runs in packages without needing "^source", so a change to ` +
            "the source of a package it depends on does not rerun it. Add it to `needs`, or list " +
            "the job in PACKAGE_JOBS_WITHOUT_SOURCE with why it reads no other package.",
        );
      } else if (keys.has("paths")) {
        // Skipped by `paths:` instead: they must name every package the job's own depends on.
        const only = listItems(/only:\s*\[[^\]]*\]/.exec(keys.get("packages"))?.[0]);
        if (only.length !== 1 || !packages.has(only[0])) {
          problems.push(
            `\`${id}\` has \`paths:\` but is not for one package, so they cannot be checked`,
          );
          continue;
        }
        for (const dependency of uncovered(only[0], listItems(keys.get("paths")))) {
          problems.push(
            `\`${id}\`: \`paths:\` leaves out ${dependency}/**, which ${only[0]} depends on`,
          );
        }
      }
      continue;
    }
    // A job of its own for one package (`cwd:`): its inputs name what it reads.
    const cwd = /^\s*\/app\/(\S+?)\/?\s*$/.exec(keys.get("cwd") ?? "")?.[1];
    const dir = cwd && [...packages.keys()].find((d) => cwd === d || cwd.startsWith(`${d}/`));
    if (!cached || !dir || id in JOBS_THAT_IMPORT_NOTHING) continue;
    for (const dependency of uncovered(dir, listItems(keys.get("task-cache")), shipsSource)) {
      problems.push(
        `\`${id}\` runs in ${dir}, which depends on ${dependency}, a package that ships source, but ` +
          `its task cache inputs leave out ${dependency}/**. Add it, make the job a \`packages:\` job ` +
          'that needs "^source", or list it in JOBS_THAT_IMPORT_NOTHING with why.',
      );
    }
  }

  // An excuse for a job that is gone, or no longer what it was, is removed.
  for (const id of Object.keys(PACKAGE_JOBS_WITHOUT_SOURCE)) {
    if (!jobs.get(id)?.has("packages")) {
      problems.push(
        `PACKAGE_JOBS_WITHOUT_SOURCE lists \`${id}\`, which is not a \`packages:\` job`,
      );
    }
  }
  for (const id of Object.keys(JOBS_THAT_IMPORT_NOTHING)) {
    if (!jobs.has(id) || jobs.get(id).has("packages")) {
      problems.push(`JOBS_THAT_IMPORT_NOTHING lists \`${id}\`, which is not a job of its own`);
    }
  }

  return { problems, jobs: jobs.size, packages: packages.size };
}

// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === "--check") {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { problems, jobs, packages } = check(root);
  if (problems.length > 0) {
    console.error(`.infrawrench/ci/test.yml: ${problems.length} problem(s) with source coverage`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`source coverage: ${jobs} jobs checked against ${packages} packages`);
} else if (mode === "--list") {
  const { hash, whole, files } = digest(process.cwd());
  console.log(`${hash} ${whole ? "whole package" : "entry points"}`);
  for (const file of files) console.log(file);
} else if (mode === undefined) {
  writeFileSync(DIGEST_FILE, `${digest(process.cwd()).hash}\n`);
} else {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}
