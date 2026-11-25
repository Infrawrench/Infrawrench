import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type MemoryObjectStore, collectBytes } from "@infrawrench/git-core";
import { tarArchive, tarGzArchive, zipArchive } from "../src";
import { Repo, cleanupTempDirs, describeGit, loadStore, prng, tempDir } from "./helpers";

afterAll(cleanupTempDirs);

/** Everything under a directory: kind, executable bit, and content or link target. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = prefix + name;
      if (stat.isSymbolicLink()) out.set(key, `link ${readlinkSync(path)}`);
      else if (stat.isDirectory()) {
        out.set(key, "dir");
        walk(path, `${key}/`);
      } else {
        const executable = (stat.mode & 0o100) !== 0 ? "x" : "-";
        out.set(key, `file ${executable} ${readFileSync(path).toString("base64")}`);
      }
    }
  };
  walk(root, "");
  return out;
}

function run(command: string, args: string[], cwd: string, input?: Uint8Array): void {
  const result = spawnSync(command, args, { cwd, ...(input ? { input } : {}) });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  }
}

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

describeGit("archives against git archive", () => {
  let repo: Repo;
  let store: MemoryObjectStore;
  let head: string;
  let time: number;

  beforeAll(() => {
    repo = new Repo("archive");
    const next = prng(88);
    const bytes = (n: number): Uint8Array => new Uint8Array(n).map(() => next() & 255);
    repo.write("README.md", "# Archive\n");
    repo.write("empty.txt", "");
    repo.write("exactly-512.bin", bytes(512));
    repo.write("one-over.bin", bytes(513));
    repo.write("src/main.c", "int main(void) { return 0; }\n".repeat(400));
    repo.write("src/deep/er/still/file.txt", "deep\n");
    repo.write("bin/run.sh", "#!/bin/sh\necho run\n");
    repo.chmod("bin/run.sh", 0o755);
    repo.symlink("../README.md", "src/readme-link");
    repo.symlink(`${"up/".repeat(40)}target`, "long-link");
    repo.write("café/über.txt", "accents\n");
    // Over 100 bytes but splittable at a slash, then one with a single component too long to split.
    repo.write(`${"segment/".repeat(14)}leaf.txt`, "split across prefix and name\n");
    repo.write(`${"n".repeat(140)}.txt`, "needs a pax path\n");
    repo.write(`${"dir-".repeat(30)}/${"x".repeat(120)}`, "long both ways\n");
    repo.run("add", "-A");
    // A submodule entry without a submodule: only the tree entry matters to an archive.
    repo.run(
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,1234567890123456789012345678901234567890,vendor/module",
    );
    repo.clock += 60;
    repo.run("commit", "-q", "-m", "everything an archive has to cope with");
    head = repo.rev("HEAD");
    time = repo.clock;
    store = loadStore(repo);
  });

  it("writes the tar git writes, byte for byte", async () => {
    for (const prefix of ["", "project-1.0/", "a/b/c/", "no-slash-", `${"p".repeat(90)}/`]) {
      const expected = repo.raw(["archive", "--format=tar", `--prefix=${prefix}`, head]).stdout;
      const ours = await collectBytes(
        tarArchive(store, repo.tree(head), { prefix, time, commit: head }),
      );
      expect(ours.length, prefix).toBe(expected.length);
      expect(Buffer.from(ours).equals(expected), prefix).toBe(true);
    }
    // A bare tree: no commit id inside, and the time is whatever the caller says.
    const expected = repo.raw([
      "archive",
      "--format=tar",
      "--mtime=@1600000000",
      "--prefix=t/",
      repo.tree(head),
    ]).stdout;
    const ours = await collectBytes(
      tarArchive(store, repo.tree(head), { prefix: "t/", time: 1_600_000_000 }),
    );
    expect(Buffer.from(ours).equals(expected)).toBe(true);
  });

  it("carries the commit id where git get-tar-commit-id finds it", async () => {
    const ours = await collectBytes(
      tarArchive(store, repo.tree(head), { prefix: "p/", time, commit: head }),
    );
    expect(repo.raw(["get-tar-commit-id"], { input: ours }).stdout.toString().trim()).toBe(head);
  });

  it("gzips to the same tar", async () => {
    const options = { prefix: "p/", time, commit: head };
    const tar = await collectBytes(tarArchive(store, repo.tree(head), options));
    const gz = await collectBytes(tarGzArchive(store, repo.tree(head), options));
    expect(gz.length).toBeLessThan(tar.length);
    expect(Buffer.from(gunzipSync(gz)).equals(Buffer.from(tar))).toBe(true);
  });

  it("streams in pieces rather than one buffer", async () => {
    const reader = tarArchive(store, repo.tree(head), { time }).getReader();
    let chunks = 0;
    let largest = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      largest = Math.max(largest, value.length);
    }
    expect(chunks).toBeGreaterThan(30);
    // Nothing larger than the largest file (plus padding to tar's block) is ever in hand.
    expect(largest).toBeLessThanOrEqual(12_000);
  });

  it.skipIf(!hasUnzip)("zips to the same files, modes and links", async () => {
    const reference = tempDir("archive-ref");
    run("tar", ["-xf", "-"], reference, repo.raw(["archive", "--prefix=z/", head]).stdout);
    const expected = snapshot(reference);
    expect(expected.size).toBeGreaterThan(20);

    for (const forceZip64 of [false, true]) {
      const zip = await collectBytes(
        zipArchive(store, repo.tree(head), { prefix: "z/", time, commit: head, forceZip64 }),
      );
      const dir = tempDir("archive-zip");
      const file = join(dir, "out.zip");
      writeFileSync(file, zip);
      run("unzip", ["-tq", file], dir);
      mkdirSync(join(dir, "x"));
      run("unzip", ["-q", file, "-d", join(dir, "x")], dir);
      const got = snapshot(join(dir, "x"));
      // unzip leaves the submodule's empty directory and every other one in place, as tar does.
      expect(got, `zip64 ${forceZip64}`).toEqual(expected);
      // The commit id is the archive comment, as in git's own zips.
      const listing = spawnSync("unzip", ["-z", file]).stdout.toString();
      expect(listing).toContain(head);
    }
  });
});
