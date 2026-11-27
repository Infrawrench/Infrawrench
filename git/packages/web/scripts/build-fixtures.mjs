#!/usr/bin/env node
/**
 * Builds the dev mock's Git fixtures (`src/mock/fixtures/*.generated.json`).
 *
 * Each fixture is a real repository: this script writes it with `git` in a
 * temporary directory, from the scripted histories in `scripts/fixtures/`,
 * then reads back commits, trees, blobs and blame. Dates and identities are
 * fixed, so the object ids are the same on every run and the output only
 * changes when a history does. The output is committed; run
 * `pnpm --filter @infrawrench/git-web fixtures` after editing a history.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "mock", "fixtures");

const HISTORIES = ["infra", "edge-router"];

function makeGit(cwd) {
  return (args, options = {}) =>
    execFileSync("git", args, {
      cwd,
      encoding: options.encoding === undefined ? "utf8" : options.encoding,
      input: options.input,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        TZ: "UTC",
        ...options.env,
      },
    });
}

function identityEnv(person, when) {
  return {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
    GIT_COMMITTER_DATE: when,
  };
}

/** Runs one scripted history and returns the directory holding the repository. */
function writeRepository(history) {
  const dir = mkdtempSync(join(tmpdir(), "git-web-fixture-"));
  const git = makeGit(dir);
  git(["init", "-q", "-b", history.defaultBranch]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "tag.gpgsign", "false"]);

  for (const step of history.steps) {
    if (step.checkout !== undefined) {
      git(["checkout", "-q", ...(step.create === true ? ["-b"] : []), step.checkout]);
      continue;
    }
    if (step.tag !== undefined) {
      if (step.message === undefined) git(["tag", step.tag]);
      else
        git(["tag", "-a", step.tag, "-m", step.message], {
          env: identityEnv(step.by, step.at),
        });
      continue;
    }
    if (step.merge !== undefined) {
      git(["merge", "-q", "--no-ff", step.merge, "-m", step.message], {
        env: identityEnv(step.by, step.at),
      });
      continue;
    }
    for (const [path, content] of Object.entries(step.files ?? {})) {
      const full = join(dir, path);
      if (content === null) {
        git(["rm", "-q", "-r", "--", path]);
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      if (typeof content === "object" && content.symlink !== undefined) {
        rmSync(full, { force: true });
        symlinkSync(content.symlink, full);
      } else if (typeof content === "object" && content.submodule !== undefined) {
        git(["update-index", "--add", "--cacheinfo", `160000,${content.submodule},${path}`]);
        continue;
      } else if (typeof content === "object" && content.bytes !== undefined) {
        writeFileSync(full, content.bytes);
      } else if (typeof content === "object" && content.executable !== undefined) {
        writeFileSync(full, content.executable);
        chmodSync(full, 0o755);
      } else {
        writeFileSync(full, content);
      }
      git(["add", "--", path]);
    }
    for (const [from, to] of Object.entries(step.rename ?? {})) {
      mkdirSync(dirname(join(dir, to)), { recursive: true });
      git(["mv", "--", from, to]);
    }
    git(["commit", "-q", "--allow-empty", "-m", step.message], {
      env: identityEnv(step.by, step.at),
    });
  }
  git(["checkout", "-q", history.defaultBranch]);
  return dir;
}

function parseSignature(line) {
  const match = /^(.*) <(.*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(line);
  if (!match) throw new Error(`Unreadable signature: ${line}`);
  const [, name, email, seconds, sign, hours, minutes] = match;
  const offset = (Number(hours) * 60 + Number(minutes)) * (sign === "-" ? -1 : 1);
  return {
    name,
    email,
    when: new Date(Number(seconds) * 1000).toISOString(),
    timezoneOffset: offset,
  };
}

function readRepository(dir) {
  const git = makeGit(dir);
  const fixture = {
    defaultBranch: git(["symbolic-ref", "--short", "HEAD"]).trim(),
    branches: {},
    tags: {},
    order: [],
    commits: {},
    trees: {},
    blobs: {},
    blame: {},
  };

  for (const line of git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])
    .trim()
    .split("\n")) {
    const [name, oid] = line.split(" ");
    fixture.branches[name.slice("refs/heads/".length)] = oid;
  }

  const tagLines = git([
    "for-each-ref",
    "--format=%(refname) %(objectname) %(objecttype)",
    "refs/tags",
  ])
    .trim()
    .split("\n")
    .filter((line) => line !== "");
  for (const line of tagLines) {
    const [ref, oid, type] = line.split(" ");
    const name = ref.slice("refs/tags/".length);
    const commit = git(["rev-parse", `${ref}^{commit}`]).trim();
    if (type === "tag") {
      const raw = git(["cat-file", "tag", oid]);
      const [head, ...body] = raw.split("\n\n");
      const tagger = head.split("\n").find((l) => l.startsWith("tagger "));
      fixture.tags[name] = {
        oid,
        commit,
        annotated: true,
        tagger: tagger ? parseSignature(tagger.slice("tagger ".length)) : null,
        message: body.join("\n\n").trimEnd(),
      };
    } else {
      fixture.tags[name] = { oid, commit, annotated: false, tagger: null, message: null };
    }
  }

  fixture.order = git(["rev-list", "--all", "--date-order"]).trim().split("\n");

  const treeAt = new Map();
  const readTree = (treeOid) => {
    if (fixture.trees[treeOid]) return;
    const entries = [];
    const out = git(["ls-tree", "-z", "-l", treeOid]);
    for (const record of out.split("\0")) {
      if (record === "") continue;
      const [meta, name] = record.split("\t");
      const [mode, type, oid, size] = meta.split(/\s+/);
      entries.push([mode, oid, name]);
      if (type === "tree") readTree(oid);
      else if (type === "blob" && !fixture.blobs[oid]) {
        const bytes = git(["cat-file", "blob", oid], { encoding: "buffer" });
        const binary = bytes.subarray(0, 8000).includes(0);
        fixture.blobs[oid] = binary
          ? { size: Number(size), binary: true, base64: bytes.toString("base64") }
          : { size: Number(size), binary: false, text: bytes.toString("utf8") };
      }
    }
    fixture.trees[treeOid] = entries;
  };

  /** path -> [mode, oid] for every blob of a commit. */
  const flatten = (commitOid) => {
    if (treeAt.has(commitOid)) return treeAt.get(commitOid);
    const files = new Map();
    const out = git(["ls-tree", "-z", "-r", commitOid]);
    for (const record of out.split("\0")) {
      if (record === "") continue;
      const [meta, path] = record.split("\t");
      const [mode, , oid] = meta.split(" ");
      files.set(path, [mode, oid]);
    }
    treeAt.set(commitOid, files);
    return files;
  };

  for (const oid of fixture.order) {
    const raw = git(["cat-file", "commit", oid]);
    const split = raw.indexOf("\n\n");
    const header = raw.slice(0, split).split("\n");
    const message = raw.slice(split + 2).replace(/\n$/, "");
    const field = (name) =>
      header.filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1));
    const tree = field("tree")[0];
    const parents = field("parent");
    readTree(tree);

    const changes = [];
    const diffArgs =
      parents.length === 0
        ? ["diff-tree", "--root", "-r", "-M", "--no-commit-id", "--raw", "-z", oid]
        : ["diff-tree", "-r", "-M", "--raw", "-z", parents[0], oid];
    const records = git(diffArgs).split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record.startsWith(":")) continue;
      const [oldMode, newMode, oldOid, newOid, status] = record.slice(1).split(" ");
      const letter = status[0];
      const first = records[++i];
      const second = letter === "R" || letter === "C" ? records[++i] : null;
      changes.push({
        status: letter,
        path: second ?? first,
        oldPath: second === null ? null : first,
        similarity: second === null ? null : Number(status.slice(1)),
        oldMode: oldMode === "000000" ? null : oldMode,
        newMode: newMode === "000000" ? null : newMode,
        oldOid: /^0+$/.test(oldOid) ? null : oldOid,
        newOid: /^0+$/.test(newOid) ? null : newOid,
      });
    }

    fixture.commits[oid] = {
      oid,
      tree,
      parents,
      author: parseSignature(field("author")[0]),
      committer: parseSignature(field("committer")[0]),
      message,
      changes,
    };

    // Blame every text file this commit is the newest change of: the ones no
    // parent holds with the same content (Git's own history simplification).
    const files = flatten(oid);
    const parentFiles = parents.map(flatten);
    for (const [path, [mode, blobOid]] of files) {
      if (mode === "160000" || mode === "120000") continue;
      if (parentFiles.some((p) => p.get(path)?.[1] === blobOid)) continue;
      if (fixture.blobs[blobOid]?.binary !== false) continue;
      if (fixture.blobs[blobOid].text === "") continue;
      fixture.blame[`${oid}:${path}`] = readBlame(git, oid, path);
    }
  }
  return fixture;
}

function readBlame(git, commitOid, path) {
  const out = git(["blame", "--porcelain", "-M", commitOid, "--", path]);
  const ranges = [];
  const origin = new Map();
  let current = null;
  for (const line of out.split("\n")) {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (head) {
      const [, oid, originalLine, finalLine, count] = head;
      if (count !== undefined) {
        current = {
          startLine: Number(finalLine),
          lineCount: Number(count),
          commitOid: oid,
          originalStartLine: Number(originalLine),
        };
        ranges.push(current);
      }
      if (!origin.has(oid)) origin.set(oid, { path, previous: null });
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("filename ")) origin.get(current.commitOid).path = line.slice(9);
    else if (line.startsWith("previous "))
      origin.get(current.commitOid).previous = line.slice(9, 49);
  }
  return ranges.map((r) => [
    r.startLine,
    r.lineCount,
    r.commitOid,
    r.originalStartLine,
    origin.get(r.commitOid).path,
    origin.get(r.commitOid).previous,
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const name of HISTORIES) {
  const { history } = await import(`./fixtures/${name}.mjs`);
  const dir = writeRepository(history);
  try {
    const fixture = readRepository(dir);
    writeFileSync(join(outDir, `${name}.generated.json`), `${JSON.stringify(fixture)}\n`);
    console.log(
      `${name}: ${fixture.order.length} commits, ${Object.keys(fixture.blobs).length} blobs`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
