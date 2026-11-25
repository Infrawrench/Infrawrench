/**
 * A real history through the protocol: this repository's own, pushed whole
 * to the server and cloned back, over both forms of the transport. Skipped
 * on a checkout too shallow to say anything.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBackend } from "../src";
import {
  type TestServer,
  cleanupTempDirs,
  git,
  gitOut,
  hasGit,
  startServer,
  tempDir,
} from "./helpers";

afterAll(cleanupTempDirs);

const run = (args: string[]): string => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const source = hasGit ? run(["rev-parse", "--show-toplevel"]) : "";
const enough = hasGit && Number(run(["rev-list", "--count", "HEAD"])) >= 200;

describe.skipIf(!enough).each([
  { name: "http", url: (s: TestServer) => s.httpUrl },
  { name: "stream", url: (s: TestServer) => s.streamUrl },
])("this repository's history over $name", ({ name, url }) => {
  let mirror = "";
  let server: TestServer;
  let backend: MemoryBackend;

  beforeAll(async () => {
    mirror = join(tempDir("monorepo"), "mirror.git");
    await git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, mirror]);
    backend = new MemoryBackend();
    server = await startServer(backend);
  });
  afterAll(async () => {
    expect(server.errors).toEqual([]);
    await server.close();
  });

  it("is pushed, cloned back whole, fetched from and passes fsck", async () => {
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: mirror });
    const branch = await gitOut(["symbolic-ref", "--short", "HEAD"], { cwd: mirror });
    const objects = Number(
      (await gitOut(["count-objects", "-v"], { cwd: mirror })).match(/in-pack: (\d+)/)![1],
    );
    backend.headRef = `refs/heads/${branch}`;

    let started = performance.now();
    await git(["push", "-q", url(server), `${branch}:${branch}`], { cwd: mirror });
    const pushMs = performance.now() - started;
    expect(backend.refs.get(`refs/heads/${branch}`)).toBe(head);
    const packBytes = backend.packs.reduce((sum, pack) => sum + pack.bytes.length, 0);

    const clone = join(tempDir("monorepo-clone"), "clone.git");
    started = performance.now();
    await git(["clone", "-q", "--bare", url(server), clone]);
    const cloneMs = performance.now() - started;
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(head);
    await git(["fsck", "--full", "--no-dangling"], { cwd: clone });

    // An older commit as the only thing the client has: the rest arrives by walking history.
    const old = await gitOut(["rev-parse", "HEAD~50"], { cwd: mirror });
    const partial = join(tempDir("monorepo-partial"), "partial.git");
    await git(["init", "-q", "--bare", partial]);
    await git(["fetch", "-q", mirror, `${old}:refs/heads/old`], { cwd: partial });
    backend.serveStoredPack = false;
    server.requests.length = 0;
    started = performance.now();
    await git(["fetch", "-q", url(server), `${branch}:refs/heads/new`], { cwd: partial });
    const fetchMs = performance.now() - started;
    backend.serveStoredPack = true;
    expect(await gitOut(["rev-parse", "refs/heads/new"], { cwd: partial })).toBe(head);
    await git(["fsck", "--no-dangling"], { cwd: partial });
    const sent = server.requests.reduce((sum, request) => sum + request.stats.objectsSent, 0);
    expect(sent).toBeGreaterThan(50);
    expect(sent).toBeLessThan(objects / 2);

    const mib = packBytes / 1024 / 1024;
    console.log(
      `git-protocol monorepo over ${name}: ${objects} objects, ${mib.toFixed(1)} MiB pack; ` +
        `push ${(pushMs / 1000).toFixed(1)} s (${(mib / (pushMs / 1000)).toFixed(1)} MiB/s), ` +
        `clone ${(cloneMs / 1000).toFixed(1)} s (${(mib / (cloneMs / 1000)).toFixed(1)} MiB/s), ` +
        `fetch of the last 50 commits ${(fetchMs / 1000).toFixed(1)} s (${sent} objects)`,
    );
  });
});
