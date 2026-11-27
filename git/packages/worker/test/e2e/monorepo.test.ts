/**
 * This repository's own history through the worker in workerd: pushed and
 * cloned over HTTPS and over SSH, with the time each takes and how much
 * memory workerd grew by. It is a measurement more than a test, so it is
 * opt-in: `GIT_WORKER_BENCH=1 pnpm --filter @infrawrench/git-worker test
 * test/e2e/monorepo.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, downloadPack, git, gitOut, hasGit, tempDir } from "../support/git";
import { type SshKey, type TestWorker, generateKey, hasSsh, startWorker } from "./harness";

const local = (args: string[]): string =>
  spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const source = hasGit ? local(["rev-parse", "--show-toplevel"]) : "";
const enabled =
  process.env.GIT_WORKER_BENCH === "1" &&
  hasGit &&
  hasSsh &&
  Number(local(["rev-list", "--count", "HEAD"])) >= 200;

const TOKEN = "iwg_test_bench_0000000000000000000000000000";
const MIB = 1024 * 1024;

describe.skipIf(!enabled)("this repository's history through workerd", () => {
  let worker: TestWorker;
  let key: SshKey;
  let mirror = "";
  let branch = "";
  let head = "";
  let packMib = 0;
  let objects = 0;

  beforeAll(async () => {
    key = await generateKey("bench");
    worker = await startWorker({
      tokens: { [TOKEN]: { userId: "alice", scopes: ["repo:read", "repo:write"] } },
      keys: { [key.fingerprint]: { userId: "alice" } },
      users: { alice: "alice" },
      repositories: ["http", "ssh"].map((name) => ({
        id: `repo-${name}`,
        owner: "alice",
        name,
        ownerUserId: "alice",
        visibility: "public" as const,
      })),
    });
    mirror = join(tempDir("monorepo"), "mirror.git");
    await git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, mirror]);
    branch = await gitOut(["symbolic-ref", "--short", "HEAD"], { cwd: mirror });
    head = await gitOut(["rev-parse", "HEAD"], { cwd: mirror });
    const counted = await gitOut(["count-objects", "-v"], { cwd: mirror });
    objects = Number(/in-pack: (\d+)/.exec(counted)![1]);
    packMib = Number(/size-pack: (\d+)/.exec(counted)![1]) / 1024;
  }, 600_000);

  afterAll(async () => {
    await worker?.stop();
    cleanupTempDirs();
  });

  /** Runs `work` while sampling workerd's memory, and returns how long it took and the peak. */
  async function measured(
    work: () => Promise<unknown>,
  ): Promise<{ seconds: number; peakMib: number }> {
    let peak = worker.memory();
    const timer = setInterval(() => {
      peak = Math.max(peak, worker.memory());
    }, 250);
    const started = performance.now();
    try {
      await work();
    } finally {
      clearInterval(timer);
    }
    return { seconds: (performance.now() - started) / 1000, peakMib: peak / MIB };
  }

  it.each([
    { name: "https", repo: "repo-http" },
    { name: "ssh", repo: "repo-ssh" },
  ])("pushes and clones over $name", async ({ name, repo }) => {
    const ssh = name === "ssh";
    const url = ssh ? worker.sshUrl("alice/ssh.git") : `${worker.httpUrl}/alice/http.git`;
    const env = ssh ? { GIT_SSH_COMMAND: worker.sshCommand(key) } : {};
    const auth = ssh
      ? []
      : [
          "-c",
          `http.extraHeader=Authorization: Basic ${Buffer.from(`git:${TOKEN}`).toString("base64")}`,
        ];
    await worker.rpc(repo, "init", { defaultBranch: branch });
    const baseline = worker.memory() / MIB;

    const push = await measured(() =>
      git([...auth, "push", "-q", url, `${branch}:${branch}`], { cwd: mirror, env }),
    );
    const stats = await worker.rpc<{ livePacks: number; objects: number; liveBytes: number }>(
      repo,
      "stats",
    );
    expect(stats.livePacks).toBe(1);
    // The branch alone: the mirror also holds tag objects, which this push does not send.
    expect(stats.objects).toBeGreaterThan(objects * 0.9);

    const clone = join(tempDir(`bench-${name}`), "clone.git");
    const cloned = await measured(() => git(["clone", "-q", "--bare", url, clone], { env }));
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(head);
    await git(["fsck", "--full", "--no-dangling"], { cwd: clone });
    // The same clone without the client's own indexing, over HTTP whichever transport is under test.
    const wire = await downloadPack(`${worker.httpUrl}/alice/${ssh ? "ssh" : "http"}.git`, [head]);

    // A client that has an older commit: the rest is found by walking history in the Durable Object.
    const old = await gitOut(["rev-parse", "HEAD~50"], { cwd: mirror });
    const partial = join(tempDir(`bench-partial-${name}`), "partial.git");
    await git(["init", "-q", "--bare", partial]);
    await git(["fetch", "-q", mirror, `${old}:refs/heads/old`], { cwd: partial });
    const fetched = await measured(() =>
      git(["fetch", "-q", url, `${branch}:refs/heads/new`], { cwd: partial, env }),
    );
    expect(await gitOut(["rev-parse", "refs/heads/new"], { cwd: partial })).toBe(head);
    await git(["fsck", "--no-dangling"], { cwd: partial });

    // A shallow clone of the tip, which is what a CI runner does.
    const shallow = join(tempDir(`bench-shallow-${name}`), "shallow.git");
    const shallowed = await measured(() =>
      git(["clone", "-q", "--bare", "--depth", "1", url, shallow], { env }),
    );
    await git(["fsck", "--no-dangling"], { cwd: shallow });

    const rate = (seconds: number): string => `${(packMib / seconds).toFixed(1)} MiB/s`;
    const grew = (peak: number): string => `+${Math.max(0, peak - baseline).toFixed(0)} MiB`;
    const report = [
      `git-worker monorepo over ${name}: ${objects} objects, ${packMib.toFixed(1)} MiB pack; workerd at ${baseline.toFixed(0)} MiB before`,
      `  push          ${push.seconds.toFixed(1)} s  ${rate(push.seconds)}  workerd ${grew(push.peakMib)}`,
      `  clone         ${cloned.seconds.toFixed(1)} s  ${rate(cloned.seconds)}  workerd ${grew(cloned.peakMib)}`,
      `  clone, server only ${wire.seconds.toFixed(1)} s  ${rate(wire.seconds)} (${(wire.bytes / MIB).toFixed(1)} MiB over HTTP)`,
      `  fetch (50)    ${fetched.seconds.toFixed(1)} s  workerd ${grew(fetched.peakMib)}`,
      `  clone depth 1 ${shallowed.seconds.toFixed(1)} s  workerd ${grew(shallowed.peakMib)}`,
    ].join("\n");
    console.log(report);
    // Vitest keeps a passing test's console output to itself under some reporters.
    if (process.env.GIT_WORKER_BENCH_OUT)
      appendFileSync(process.env.GIT_WORKER_BENCH_OUT, `${report}\n`);
  });
});
