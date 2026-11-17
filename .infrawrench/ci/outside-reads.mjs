// The files a package's tests read by path outside the package, as one hash,
// and the check that every such read is declared.
//
//   node outside-reads.mjs           in a package: write .reads-digest
//   node outside-reads.mjs --list    in a package: print what the hash covers
//   node outside-reads.mjs --check   scan every package and check test.yml
//
// A test job's task cache key holds its own package's files and what it is
// handed: its dependencies' dist/ (`^bundle`) and source (`^source`,
// source-digest.mjs). A file a test reads by path in a package it does not
// depend on (`readFileSync(new URL("../../../other/src/x.ts", import.meta.url))`,
// a scan from the workspace root) is in neither, so the job was replayed from
// the cache when that file changed (#1177).
//
// A package names those files in a `ci-reads.json` beside its package.json:
//
//   { "reads": [{ "files": ["app/packages/other/src/x.ts"],
//                 "from": ["src/__tests__/x.test.ts"],
//                 "why": "asserts the two copies are the same" }] }
//
// `files` are globs from the repository root (`*` within a name, `**` across
// directories, `!` excludes, read in order), `from` the files of this package
// that read them. test.yml's `reads` job hashes what they match into
// .reads-digest, an artifact the package's test jobs are handed and so keyed
// on. Only that package's tests rerun when one of the files changes.
//
// The check is a scan of the text, not a trace of what runs: it sees the ways
// of leaving a package listed under "The scan" below and nothing else. A read
// it cannot see can still be declared.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coverage,
  dependencyClosure,
  listItems,
  readJobs,
  readWorkspace,
} from "./source-digest.mjs";

const DECLARATION = "ci-reads.json";
const DIGEST_FILE = ".reads-digest";
const IGNORE_MARKER = "ci-reads-ignore:";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// The declaration and what it matches
// ---------------------------------------------------------------------------

/** A glob as a pattern over a path from the repository root. */
function globPattern(glob) {
  const source = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/** The directory a glob's matches are all under: its path up to the first `*`. */
function globBase(glob) {
  const literal = glob.split("*")[0];
  return glob.includes("*") ? literal.slice(0, literal.lastIndexOf("/") + 1) : literal;
}

// As the runner's own inputs: what an install writes and git's own files are
// never read into a key.
const NEVER_READ = new Set(["node_modules", ".git"]);

function walk(root, path, files) {
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    if (NEVER_READ.has(entry.name)) continue;
    walk(root, path === "" ? entry.name : `${path}/${entry.name}`, files);
  }
}

/** The files `globs` select, read in order as a filter, and each include's own count. */
function matchFiles(root, globs) {
  const rules = globs.map((glob) => {
    const exclude = glob.startsWith("!");
    const text = exclude ? glob.slice(1) : glob;
    return { glob, exclude, pattern: globPattern(text), base: globBase(text), matched: 0 };
  });
  const candidates = [];
  for (const rule of rules) {
    if (!rule.exclude) walk(root, rule.base.replace(/\/$/, ""), candidates);
  }
  const files = [];
  for (const file of [...new Set(candidates)].sort()) {
    let selected = false;
    for (const rule of rules) {
      if (!rule.pattern.test(file)) continue;
      if (!rule.exclude) rule.matched += 1;
      selected = !rule.exclude;
    }
    if (selected) files.push(file);
  }
  return {
    files,
    unmatched: rules.filter((r) => !r.exclude && r.matched === 0).map((r) => r.glob),
  };
}

/** A package's declaration, or the reasons it cannot be read. */
function readDeclaration(root, dir) {
  const file = join(root, dir, DECLARATION);
  if (!existsSync(file)) return { entries: [], problems: [] };
  const problems = [];
  const bad = (message) => problems.push(`${dir}/${DECLARATION}: ${message}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    bad(`not JSON (${error.message})`);
    return { entries: [], problems };
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const strings = (value) =>
    Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v);
  if (!isObject(raw) || Object.keys(raw).join() !== "reads" || !Array.isArray(raw.reads)) {
    bad('must be `{ "reads": [...] }` and nothing else');
    return { entries: [], problems };
  }
  const entries = [];
  raw.reads.forEach((entry, index) => {
    const where = `reads[${index}]`;
    if (!isObject(entry)) return bad(`${where} is not an object`);
    const unknown = Object.keys(entry).filter((key) => !["files", "from", "why"].includes(key));
    if (unknown.length > 0) return bad(`${where} has unknown keys: ${unknown.join(", ")}`);
    if (!strings(entry.files)) return bad(`${where}.files must be a list of globs`);
    if (!strings(entry.from)) return bad(`${where}.from must be a list of this package's files`);
    if (typeof entry.why !== "string" || entry.why.trim() === "") {
      return bad(`${where}.why must say what the read is for`);
    }
    if (entry.files.some((glob) => /^!?(\/|\.\.?\/)/.test(glob) || glob.includes("\\"))) {
      return bad(`${where}.files are paths from the repository root, without a leading ./ or /`);
    }
    entries.push({ where, files: entry.files, from: entry.from, why: entry.why });
  });
  return { entries, problems };
}

function digest(root, dir) {
  const { entries, problems } = readDeclaration(root, dir);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const files = [...new Set(entries.flatMap((entry) => matchFiles(root, entry.files).files))];
  const hash = createHash("sha256");
  hash.update("reads-digest 1\n");
  for (const file of files.sort()) {
    const path = join(root, file);
    const content = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
    hash.update(`${file}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return { hash: hash.digest("hex"), files };
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------
//
// In every package, by the text of its files:
//
// 1. In a test file (below): a quoted path that starts with `../` and, read
//    against the file's directory, ends outside the package. That is
//    `new URL("../../../x", import.meta.url)`, `resolve(__dirname, "../../..")`
//    and an import or a `vi.mock` alike.
// 2. In a test file: `".."` arguments (`join(here, "..", "..")`) that climb
//    past the package, counting the climb of a constant the statement uses
//    (`const SRC = join(__dirname, "..", "..")`, then `join(SRC, "..", "..")`).
// 3. In a test file: a string that names the workspace's root
//    (`pnpm-workspace.yaml`) or one of its package directories
//    (`app/packages/...`), which is how a test that walks up from the cwd
//    builds its paths.
// 4. In any source file: an import by a relative path that ends outside the
//    package.
// 5. In a tsconfig: any relative path that ends outside the package.
//
// What already is in the key is left alone: node_modules (the lockfile stands
// for it), the root files every job is keyed on, and a file of a package this
// one depends on that `^source` covers. A finding that reads nothing is
// excused where it is, with `// ci-reads-ignore: <why>` on its line or the
// line above; an excuse that excuses nothing fails.
//
// Not seen: a path put together at run time some other way (a loop over
// `dirname`, an environment variable, a path a helper in another package
// returns), and a read in a source file that only a test reaches.

const CODE_FILE = /\.[cm]?[jt]sx?$/;

/** A file a test job runs or loads its settings from, rather than one it tests. */
const isTestFile = (path) =>
  /(^|\/)(__tests__|__mocks__|tests?|e2e)\//.test(path) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
  /(^|\/)(vitest|vite)\.[\w.-]+$/.test(path);

// Root files in every key: the runner adds the workspace's settings and
// lockfile to each job's, and every job that loads a package names
// tsconfig.base.json in its `root-inputs` (checked below).
const KEYED_ROOT_FILES = new Set([
  "tsconfig.base.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
]);

const IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function packageFiles(root, dir) {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(join(root, dir, path), { withFileTypes: true })) {
      const child = path === "" ? entry.name : `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!NEVER_READ.has(entry.name) && entry.name !== "dist") visit(child);
      } else if (CODE_FILE.test(entry.name) || /^tsconfig[\w.-]*\.json$/.test(entry.name)) {
        files.push(child);
      }
    }
  };
  visit("");
  return files.sort();
}

const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);
const STRING = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])(\.{1,2}\/[^"']*)\1/g;
/**
 * How many directories a path starts by going up, and whether it says what
 * from: `../../x` is read against the file, `${here}/../../x` and `/../../x`
 * against whatever is put before them.
 */
function climbOf(path) {
  const match = /^(\$\{[^}]*\}\/|\/)?(?:\.\/)?((?:\.\.(?:\/|$))+)/.exec(path);
  if (!match) return { climb: 0, relative: false };
  return { climb: match[2].match(/\.\./g).length, relative: match[1] === undefined };
}

/**
 * What one file is seen to reach outside its package: `{ line, text, target }`
 * each, `target` a path from the repository root when the scan can tell.
 */
function findings(root, dir, file, packageParents) {
  const lines = readFileSync(join(root, dir, file), "utf8").split("\n");
  const fileDir = dirname(join(dir, file));
  const depth = dirname(file) === "." ? 0 : dirname(file).split("/").length;
  const found = [];
  const outside = (from, path) => {
    const target = relative(root, resolve(root, from, path)).replaceAll("\\", "/");
    const inside = target === dir || target.startsWith(`${dir}/`);
    return inside ? null : target;
  };

  if (file.endsWith(".json")) {
    lines.forEach((line, index) => {
      for (const [, path] of line.matchAll(/"(\.{1,2}\/[^"]*)"/g)) {
        const target = outside(fileDir, path);
        if (target !== null) found.push({ line: index + 1, text: path, target });
      }
    });
    return found;
  }

  if (!isTestFile(file)) {
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      for (const [, , path] of line.matchAll(IMPORT)) {
        const target = outside(fileDir, path);
        if (target !== null) found.push({ line: index + 1, text: path, target });
      }
    });
    return found;
  }

  // A test file, a statement at a time (Prettier ends each with `;`, `{` or
  // `}` at the end of a line), carrying how far each constant climbs.
  const climbs = new Map();
  let statement = [];
  const finish = () => {
    const text = statement.map((s) => s.code).join("\n");
    // The cwd of a test job is the package, so any climb from it leaves.
    const base = /\bcwd\(\)/.test(text) ? 0 : depth;
    const declared = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text)?.[1];
    let inherited = 0;
    for (const [name] of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (name !== declared) inherited = Math.max(inherited, climbs.get(name) ?? 0);
    }
    let alone = 0;
    let aloneLine = 0;
    let furthest = 0;
    for (const { code, line } of statement) {
      for (const [, , value] of code.matchAll(STRING)) {
        const marker =
          value.includes("pnpm-workspace.yaml") ||
          packageParents.some((parent) => new RegExp(`(^|/)${parent}(/|$)`).test(value));
        if (marker) found.push({ line, text: value, target: null });
        const { climb, relative: fromFile } = climbOf(value);
        if (climb === 0) continue;
        if (value === "..") {
          alone += 1;
          aloneLine = line;
          continue;
        }
        furthest = Math.max(furthest, climb);
        if (marker) continue;
        if (fromFile && inherited === 0 && base === depth) {
          const target = outside(fileDir, value);
          if (target !== null) found.push({ line, text: value, target });
        } else if (inherited + climb > base) {
          found.push({ line, text: value, target: null });
        }
      }
    }
    if (alone > 0 && inherited + alone > base) {
      found.push({ line: aloneLine, text: Array(alone).fill('".."').join(", "), target: null });
    }
    if (declared && inherited + alone + furthest > 0) {
      climbs.set(declared, inherited + alone + furthest);
    }
    statement = [];
  };
  lines.forEach((raw, index) => {
    if (isComment(raw)) return;
    const code = raw.replace(/\s\/\/\s.*$/, "");
    statement.push({ code, line: index + 1 });
    if (/[;{}]\s*$/.test(code)) finish();
  });
  finish();
  return found;
}

/** The lines of a file that carry an excuse, and the reason each gives. */
function excuses(root, dir, file) {
  const marked = new Map();
  readFileSync(join(root, dir, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      const at = line.indexOf(IGNORE_MARKER);
      if (at < 0) return;
      const reason = line.slice(at + IGNORE_MARKER.length).replace(/\*\/\s*\}?\s*$/, "");
      marked.set(index + 1, reason.trim());
    });
  return marked;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

// Task-cached `packages:` jobs that run Vitest without being handed the
// package's .reads-digest, each with the test files it runs. The check holds
// them to it: a file among those that reads outside the package fails.
const TEST_JOBS_WITHOUT_READS = {
  "postgres-db": {
    why: "runs the files of src/__tests__/db/",
    runs: (file) => file.startsWith("src/__tests__/db/"),
  },
  "postgres-shadow": {
    why: "runs the suites that use helpers/fake-postgres",
    runs: (file, text) => text.includes("helpers/fake-postgres"),
  },
};

const HELP_TEST =
  `A test that reads a file outside its package: nothing puts that file in the test job's task ` +
  `cache key, so the job is replayed from the cache when the file changes. Name what it reads in ` +
  `the package's ${DECLARATION}: { "reads": [{ "files": ["app/packages/other/src/x.ts"], "from": ` +
  `["src/__tests__/x.test.ts"], "why": "..." }] }. \`files\` are globs from the repository root, ` +
  `\`from\` the test files that read them. If the line reads nothing (a path in test data, a ` +
  `layout written to a temporary directory), excuse it with \`// ${IGNORE_MARKER} <why>\` on it ` +
  `or the line above.`;
const HELP_SOURCE =
  `A source file or a tsconfig that points outside its package: no job is keyed on what it ` +
  `points at. Reach the other package through a dependency on it, which \`^source\` and ` +
  `\`^build\` follow. If nothing is read through the path, excuse the line with ` +
  `\`// ${IGNORE_MARKER} <why>\` on it or the line above.`;

function check(root) {
  const packages = readWorkspace(root);
  const jobs = readJobs(readFileSync(join(root, ".infrawrench/ci/test.yml"), "utf8"));
  const problems = [];

  // The directories packages sit in (`app/packages`), for rule 3.
  const packageParents = [
    ...new Set([...packages.keys()].filter((d) => d.includes("/")).map((d) => dirname(d))),
  ].map((parent) => parent.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));

  /** True for a file of a package `dir` depends on that `^source` already covers. */
  const covered = new Map();
  const coveredBySource = (dir, target) => {
    for (const dependency of dependencyClosure(packages, dir)) {
      if (!target.startsWith(`${dependency}/`)) continue;
      if (!covered.has(dependency)) {
        const files = coverage(join(root, dependency), packages.get(dependency)).files;
        covered.set(dependency, new Set(files));
      }
      const inside = target.slice(dependency.length + 1);
      return IMPORT_EXTENSIONS.some((extension) => covered.get(dependency).has(inside + extension));
    }
    return false;
  };
  const alreadyKeyed = (dir, target) =>
    target.split("/").includes("node_modules") ||
    KEYED_ROOT_FILES.has(target) ||
    coveredBySource(dir, target);

  const help = new Set();
  let scanned = 0;
  let declared = 0;
  /** Per package: the test files that read outside it, declared or not. */
  const readers = new Map();
  for (const dir of packages.keys()) {
    const { entries, problems: unreadable } = readDeclaration(root, dir);
    problems.push(...unreadable);
    const matches = entries.map((entry) => {
      const { files: matchedFiles, unmatched } = matchFiles(root, entry.files);
      return { ...entry, matchedFiles, unmatched };
    });
    declared += entries.length;

    for (const entry of matches) {
      const at = `${dir}/${DECLARATION}: ${entry.where}`;
      for (const glob of entry.unmatched) {
        problems.push(
          `${at}.files: "${glob}" matches no file. A file that moved is no longer keyed.`,
        );
      }
      const own = entry.files
        .filter((glob) => !glob.startsWith("!"))
        .filter((glob) => {
          const base = globBase(glob);
          return base === dir || base.startsWith(`${dir}/`);
        });
      for (const glob of own) {
        problems.push(
          `${at}.files: "${glob}" is inside the package, which its jobs are keyed on already.`,
        );
      }
      for (const file of entry.from) {
        if (!statSync(join(root, dir, file), { throwIfNoEntry: false })?.isFile()) {
          problems.push(
            `${at}.from: ${file} is not a file of ${dir}. Remove the entry with the read.`,
          );
        }
      }
    }

    const reading = new Set(matches.flatMap((entry) => entry.from));
    for (const file of packageFiles(root, dir)) {
      scanned += 1;
      const marked = excuses(root, dir, file);
      const used = new Set();
      const open = findings(root, dir, file, packageParents)
        .filter((finding) => finding.target === null || !alreadyKeyed(dir, finding.target))
        .filter((finding) => {
          const line = [finding.line, finding.line - 1].find((l) => marked.has(l));
          if (line === undefined) return true;
          used.add(line);
          return false;
        });
      for (const [line, reason] of marked) {
        const at = `${dir}/${file}:${line}`;
        if (reason === "") problems.push(`${at}: \`${IGNORE_MARKER}\` needs a reason after it.`);
        else if (!used.has(line)) {
          problems.push(`${at}: this \`${IGNORE_MARKER}\` excuses nothing. Remove it.`);
        }
      }
      if (open.length === 0) continue;
      const seen = open.map((f) => `${dir}/${file}:${f.line} (${f.text})`).join(", ");

      if (!isTestFile(file)) {
        problems.push(`${seen}: a path that leaves ${dir}, in a file that is not a test.`);
        help.add(HELP_SOURCE);
        continue;
      }
      reading.add(file);
      const entriesForFile = matches.filter((entry) => entry.from.includes(file));
      if (entriesForFile.length === 0) {
        problems.push(`${seen}: a test that reads outside ${dir}, in no ${dir}/${DECLARATION}.`);
        help.add(HELP_TEST);
        continue;
      }
      const named = new Set(entriesForFile.flatMap((entry) => entry.matchedFiles));
      for (const finding of open) {
        if (finding.target === null) continue;
        const candidates = IMPORT_EXTENSIONS.map((extension) => finding.target + extension);
        const target = candidates.find((path) =>
          statSync(join(root, path), { throwIfNoEntry: false })?.isFile(),
        );
        if (target && !named.has(target)) {
          problems.push(
            `${dir}/${file}:${finding.line}: reads ${target}, which the entries of ` +
              `${dir}/${DECLARATION} that name this file do not list.`,
          );
        }
      }
    }
    if (reading.size > 0) readers.set(dir, reading);
  }

  // The pipeline: the job that writes the digests, and who is handed them.
  const needs = (keys) => listItems(keys.get("needs"));
  const isCached = (keys) => keys.has("task-cache") && keys.get("task-cache").trim() !== "false";
  const reads = jobs.get("reads");
  if (!reads) {
    problems.push("test.yml has no `reads` job");
  } else {
    if (!listItems(reads.get("packages")).includes(DECLARATION)) {
      problems.push(`\`reads\` must run in the packages that have a ${DECLARATION}`);
    }
    if (isCached(reads)) {
      problems.push(
        "`reads` must not be task-cached: its key cannot hold the files it hashes, which are " +
          "outside its package",
      );
    }
    if (!listItems(reads.get("artifacts")).includes(DIGEST_FILE)) {
      problems.push(`\`reads\` must keep ${DIGEST_FILE} as an artifact`);
    }
  }
  for (const [id, keys] of jobs) {
    if (!keys.has("packages") || !isCached(keys)) continue;
    if (needs(keys).includes("^source") && id !== "source") {
      if (!listItems(keys.get("task-cache")).includes("tsconfig.base.json")) {
        problems.push(
          `\`${id}\` loads a package without tsconfig.base.json in its \`root-inputs\`, which ` +
            "this check takes every such job to be keyed on",
        );
      }
    }
    if (!/\bvitest\b/.test(keys.get("run") ?? "") || needs(keys).includes("reads")) continue;
    const excused = TEST_JOBS_WITHOUT_READS[id];
    if (!excused) {
      problems.push(
        `\`${id}\` runs Vitest in packages and is task-cached without needing \`reads\`, so a ` +
          "file its tests read outside their package does not rerun it. Add `reads` to its " +
          "`needs`, or list it in TEST_JOBS_WITHOUT_READS with the test files it runs.",
      );
      continue;
    }
    const only = listItems(/only:\s*\[[^\]]*\]/.exec(keys.get("packages"))?.[0]);
    for (const dir of only.filter((d) => readers.has(d))) {
      for (const file of readers.get(dir)) {
        const text = readFileSync(join(root, dir, file), "utf8");
        if (excused.runs(file, text)) {
          problems.push(
            `\`${id}\` runs ${dir}/${file}, which reads outside the package, but is not handed ` +
              "the package's reads. Add `reads` to its `needs` and take it out of " +
              "TEST_JOBS_WITHOUT_READS.",
          );
        }
      }
    }
  }
  for (const id of Object.keys(TEST_JOBS_WITHOUT_READS)) {
    const keys = jobs.get(id);
    if (!keys?.has("packages") || needs(keys).includes("reads")) {
      problems.push(
        `TEST_JOBS_WITHOUT_READS lists \`${id}\`, which is not a \`packages:\` job without \`reads\``,
      );
    }
  }

  return { problems, help: [...help], scanned, declared, packages: packages.size };
}

// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === "--check") {
  const { problems, help, scanned, declared, packages } = check(ROOT);
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) with reads outside a package`);
    for (const problem of problems) console.error(`- ${problem}`);
    for (const paragraph of help) console.error(`\n${paragraph}`);
    process.exit(1);
  }
  console.log(
    `outside reads: ${scanned} files of ${packages} packages scanned, ${declared} declared read(s)`,
  );
} else if (mode === "--list" || mode === undefined) {
  const dir = relative(ROOT, process.cwd()).replaceAll("\\", "/");
  if (dir === "" || dir.startsWith("..")) throw new Error(`${process.cwd()} is not a package`);
  const { hash, files } = digest(ROOT, dir);
  if (mode === undefined) {
    writeFileSync(DIGEST_FILE, `${hash}\n`);
  } else {
    console.log(hash);
    for (const file of files) console.log(file);
  }
} else {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}
