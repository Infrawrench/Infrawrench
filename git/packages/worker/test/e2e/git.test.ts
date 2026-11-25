/**
 * The whole path in workerd: the real `git` (and `ssh`) against the worker
 * running under `wrangler dev`, with local R2, Durable Objects and queues.
 *
 * Opt-in, because it starts workerd: `GIT_WORKER_E2E=1 pnpm --filter
 * @infrawrench/git-worker test test/e2e`.
 */
import { join } from "node:path";
import { signGitJobToken } from "@infrawrench/client-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  commitFile,
  git,
  gitOut,
  hasGit,
  initRepo,
  run,
  tempDir,
} from "../support/git";
import type { Fixture } from "./entry";
import {
  JOB_TOKEN_KEY,
  type SshKey,
  type TestWorker,
  generateKey,
  hasSsh,
  startWorker,
} from "./harness";

const enabled = process.env.GIT_WORKER_E2E === "1" && hasGit && hasSsh;

const ALICE_TOKEN = "iwg_test_alice_0000000000000000000000000000";
const BOB_TOKEN = "iwg_test_bob_000000000000000000000000000000";
const CAROL_READ_TOKEN = "iwg_test_carol_0000000000000000000000000000";

const basic = (token: string): string[] => [
  "-c",
  `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
];

describe.skipIf(!enabled)("git against the worker in workerd", () => {
  let worker: TestWorker;
  let aliceKey: SshKey;
  let deployKey: SshKey;
  let strangerKey: SshKey;
  let work: string;
  let head: string;

  const url = (path: string): string => `${worker.httpUrl}/${path}`;

  beforeAll(async () => {
    [aliceKey, deployKey, strangerKey] = await Promise.all([
      generateKey("alice"),
      generateKey("deploy"),
      generateKey("stranger"),
    ]);
    const fixture: Fixture = {
      tokens: {
        [ALICE_TOKEN]: { userId: "alice", scopes: ["repo:read", "repo:write"] },
        [BOB_TOKEN]: { userId: "bob", scopes: ["repo:read", "repo:write"] },
        [CAROL_READ_TOKEN]: { userId: "carol", scopes: ["repo:read", "repo:write"] },
      },
      keys: {
        [aliceKey.fingerprint]: { userId: "alice" },
        [deployKey.fingerprint]: { deployKeyFor: "repo-private", readOnly: true },
      },
      users: { alice: "alice", bob: "bob", carol: "carol" },
      repositories: [
        {
          id: "repo-public",
          owner: "alice",
          name: "public",
          ownerUserId: "alice",
          visibility: "public",
        },
        {
          id: "repo-private",
          owner: "alice",
          name: "private",
          ownerUserId: "alice",
          visibility: "private",
          collaborators: { carol: "read" },
        },
        {
          id: "repo-archived",
          owner: "alice",
          name: "archived",
          ownerUserId: "alice",
          visibility: "public",
          archived: true,
        },
        {
          id: "repo-protected",
          owner: "alice",
          name: "protected",
          ownerUserId: "alice",
          visibility: "public",
          collaborators: { bob: "write" },
          rules: [
            {
              pattern: "*",
              requirePullRequest: false,
              requiredApprovals: 0,
              dismissStaleApprovals: false,
              requiredStatusContexts: [],
              allowForcePush: false,
              allowDeletion: false,
              restrictPushers: false,
              pusherUserIds: [],
              enforceAdmins: false,
            },
          ],
        },
        { id: "repo-fork", owner: "bob", name: "fork", ownerUserId: "bob", visibility: "public" },
        {
          id: "repo-readme",
          owner: "alice",
          name: "readme",
          ownerUserId: "alice",
          visibility: "public",
        },
        {
          id: "repo-ssh",
          owner: "alice",
          name: "ssh",
          ownerUserId: "alice",
          visibility: "private",
        },
      ],
    };
    worker = await startWorker(fixture, { sshMaxFailures: 3 });

    work = await initRepo("work");
    for (let i = 0; i < 5; i++) {
      head = await commitFile(
        work,
        `src/file-${i % 2}.txt`,
        `line ${i}\n`.repeat(300 + i),
        `c${i}`,
      );
    }
    await git(["tag", "-a", "-m", "one", "v1"], { cwd: work });
  }, 180_000);

  afterAll(async () => {
    await worker?.stop();
    cleanupTempDirs();
  });

  it("pushes over HTTPS with a token and clones back in every protocol version", async () => {
    await git([...basic(ALICE_TOKEN), "push", "-q", url("alice/public.git"), "main", "v1"], {
      cwd: work,
    });
    for (const version of [0, 1, 2]) {
      const clone = join(tempDir(`clone-v${version}`), "clone");
      // No credentials: the repository is public.
      await git(["-c", `protocol.version=${version}`, "clone", "-q", url("alice/public"), clone]);
      await git(["fsck", "--strict", "--full"], { cwd: clone });
      expect(await gitOut(["rev-parse", "HEAD", "v1"], { cwd: clone })).toBe(
        await gitOut(["rev-parse", "main", "v1"], { cwd: work }),
      );
    }
    const shallow = join(tempDir("shallow"), "clone");
    await git(["clone", "-q", "--depth", "1", url("alice/public.git"), shallow]);
    expect(await gitOut(["rev-list", "--count", "HEAD"], { cwd: shallow })).toBe("1");
    await git(["fetch", "-q", "--unshallow"], { cwd: shallow });
    expect(await gitOut(["rev-list", "--count", "HEAD"], { cwd: shallow })).toBe("5");
  });

  it("answers by who is asking: 401 to prompt, 404 to hide, 403 to explain", async () => {
    const info = (path: string, service: string, token?: string): Promise<Response> =>
      fetch(`${url(path)}/info/refs?service=${service}`, {
        headers: token
          ? { Authorization: `Basic ${Buffer.from(`git:${token}`).toString("base64")}` }
          : {},
      });
    // Nobody: a private repository and a missing one look the same, and git is asked for credentials.
    for (const path of ["alice/private.git", "alice/no-such-repo.git"]) {
      const response = await info(path, "git-upload-pack");
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Basic realm="git.infrawrench.com", charset="UTF-8"',
      );
    }
    // A push to a public repository needs someone.
    expect((await info("alice/public.git", "git-receive-pack")).status).toBe(401);
    // A token we do not know is refused outright, even where anonymous would do.
    expect((await info("alice/public.git", "git-upload-pack", "iwg_unknown")).status).toBe(401);
    // Someone with no access to a private repository is told it is not there.
    expect((await info("alice/private.git", "git-upload-pack", BOB_TOKEN)).status).toBe(404);
    // A collaborator who may read gets in, and is told why they may not push.
    expect((await info("alice/private.git", "git-upload-pack", CAROL_READ_TOKEN)).status).toBe(200);
    const denied = await info("alice/private.git", "git-receive-pack", CAROL_READ_TOKEN);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("You do not have permission to push to alice/private.\n");
    const archived = await info("alice/archived.git", "git-receive-pack", ALICE_TOKEN);
    expect(archived.status).toBe(403);
    expect(await archived.text()).toBe("alice/archived is archived and read-only.\n");
    // The dumb protocol is not served.
    expect((await fetch(`${url("alice/public.git")}/info/refs`)).status).toBe(403);

    const response = await info("alice/public.git", "git-upload-pack");
    expect(response.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect((await response.text()).startsWith("001e# service=git-upload-pack\n0000")).toBe(true);

    // And git itself shows the reason for a refused push.
    const pushed = await git(
      [...basic(CAROL_READ_TOKEN), "push", url("alice/private.git"), "main"],
      {
        cwd: work,
        allowFailure: true,
      },
    );
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("You do not have permission to push to alice/private.");
  });

  it("enforces protected branches and puts each accepted push on the queue", async () => {
    await git(
      [...basic(BOB_TOKEN), "push", "-q", url("alice/protected.git"), "main", "main:release"],
      {
        cwd: work,
      },
    );
    const other = await initRepo("diverged");
    await commitFile(other, "x.txt", "x\n", "unrelated");
    const forced = await git(
      [...basic(BOB_TOKEN), "push", "--force", url("alice/protected.git"), "main"],
      { cwd: other, allowFailure: true },
    );
    expect(forced.status).not.toBe(0);
    expect(forced.stderr).toContain("protected branch: force pushes are not allowed");
    const removed = await git(
      [...basic(BOB_TOKEN), "push", url("alice/protected.git"), ":release"],
      {
        cwd: work,
        allowFailure: true,
      },
    );
    expect(removed.stderr).toContain("protected branch: deletion is not allowed");
    // The owner administers the repository and the rule does not bind administrators. Over SSH:
    // a personal access token never acts as an administrator, whoever it belongs to.
    const asToken = await git(
      [...basic(ALICE_TOKEN), "push", "--force", url("alice/protected.git"), "main"],
      { cwd: other, allowFailure: true },
    );
    expect(asToken.stderr).toContain("protected branch: force pushes are not allowed");
    await git(["push", "-q", "--force", worker.sshUrl("alice/protected.git"), "main"], {
      cwd: other,
      env: { GIT_SSH_COMMAND: worker.sshCommand(aliceKey) },
    });

    let events: Awaited<ReturnType<TestWorker["events"]>> = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      events = (await worker.events()).filter((event) => event.repoId === "repo-protected");
      if (events.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(
      events.map((event) => event.updates.map((update) => [update.name, update.forced])),
    ).toEqual([
      [
        ["refs/heads/main", false],
        ["refs/heads/release", false],
      ],
      [["refs/heads/main", true]],
    ]);
  });

  it("serves a file and an archive of a commit to a job token, and to nothing less", async () => {
    await git([...basic(ALICE_TOKEN), "push", "-q", url("alice/private.git"), "main"], {
      cwd: work,
    });
    const expires = Math.floor(Date.now() / 1000) + 600;
    const read = await signGitJobToken(JOB_TOKEN_KEY, {
      repositoryId: "repo-private",
      access: "read",
      runId: "run-1",
      expiresAt: expires,
    });
    const raw = await fetch(`${url("alice/private")}/raw/${head}/src/file-0.txt`, {
      headers: { Authorization: `Bearer ${read}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("cache-control")).toBe("private, no-store");
    expect(await raw.text()).toBe("line 4\n".repeat(304));
    expect(
      (
        await fetch(`${url("alice/private")}/raw/${head}/nope.txt`, {
          headers: { Authorization: `Bearer ${read}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${url("alice/private")}/raw/${head}/src/file-0.txt`)).status).toBe(401);

    // The runner's fetch: one commit by id, shallow, with the job token as the password.
    const fetched = await initRepo("job-fetch");
    await git([...basic(read), "fetch", "-q", "--depth", "1", url("alice/private.git"), head], {
      cwd: fetched,
    });
    expect(await gitOut(["rev-parse", "FETCH_HEAD"], { cwd: fetched })).toBe(head);
    // A read token does not push.
    const pushed = await git(
      [...basic(read), "push", url("alice/private.git"), "main:refs/heads/x"],
      {
        cwd: work,
        allowFailure: true,
      },
    );
    expect(pushed.status).not.toBe(0);

    // The archive link's token is bound to the commit and opens nothing else.
    const bound = await signGitJobToken(JOB_TOKEN_KEY, {
      repositoryId: "repo-private",
      access: "read",
      runId: "run-1",
      expiresAt: expires,
      commit: head,
    });
    const archive = await fetch(`${url("alice/private")}/archive/${head}.tar.gz?token=${bound}`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("cache-control")).toBe("private, no-store");
    const out = tempDir("archive");
    const tarball = join(out, "source.tar.gz");
    const { writeFileSync, readFileSync, readdirSync } = await import("node:fs");
    writeFileSync(tarball, Buffer.from(await archive.arrayBuffer()));
    await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", out]);
    expect(readdirSync(join(out, "src")).sort()).toEqual(["file-0.txt", "file-1.txt"]);
    expect(readFileSync(join(out, "src/file-0.txt"), "utf8")).toBe("line 4\n".repeat(304));
    const other = await gitOut(["rev-parse", "HEAD~1"], { cwd: work });
    expect(
      (await fetch(`${url("alice/private")}/archive/${other}.tar.gz?token=${bound}`)).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url("alice/private")}/raw/${head}/src/file-0.txt`, {
          headers: { Authorization: `Bearer ${bound}` },
        })
      ).status,
    ).toBe(401);
  });

  it("pushes, clones and fetches over SSH, in protocol v0 and v2", async () => {
    const env = { GIT_SSH_COMMAND: worker.sshCommand(aliceKey) };
    // Every form of the path a client may send.
    await git(["push", "-q", worker.sshUrl("alice/ssh.git"), "main", "v1"], { cwd: work, env });
    for (const [version, path] of [
      [0, "alice/ssh.git"],
      [2, "alice/ssh"],
    ] as const) {
      const clone = join(tempDir(`ssh-v${version}`), "clone");
      await git(["-c", `protocol.version=${version}`, "clone", "-q", worker.sshUrl(path), clone], {
        env,
      });
      await git(["fsck", "--strict", "--full"], { cwd: clone });
      expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(
        await gitOut(["rev-parse", "main"], { cwd: work }),
      );

      // A fetch with haves: the negotiation goes back and forth on one open stream.
      await commitFile(clone, "local.txt", `local ${version}\n`, "local only");
      const next = await commitFile(
        work,
        `ssh-${version}.txt`,
        `v${version}\n`,
        `over ssh v${version}`,
      );
      await git(["push", "-q", worker.sshUrl("alice/ssh.git"), "main"], { cwd: work, env });
      await git(["-c", `protocol.version=${version}`, "fetch", "-q", "origin"], {
        cwd: clone,
        env,
      });
      expect(await gitOut(["rev-parse", "origin/main"], { cwd: clone })).toBe(next);
      await git(["fsck", "--strict"], { cwd: clone });
    }
  });

  it("knows who an SSH key belongs to: a greeting, a read-only deploy key, a stranger", async () => {
    const ssh = (key: SshKey, ...command: string[]) =>
      run(
        "ssh",
        [
          ...worker.sshCommand(key).split(" ").slice(1),
          "-p",
          String(worker.sshPort),
          "git@127.0.0.1",
          ...command,
        ],
        { allowFailure: true },
      );
    const greeting = await ssh(aliceKey);
    expect(greeting.status).toBe(1);
    expect(greeting.stdout + greeting.stderr).toContain(
      "Hi alice! You've authenticated, but git.infrawrench.com does not provide shell access.",
    );
    const shell = await ssh(aliceKey, "ls", "/");
    expect(shell.status).toBe(1);
    expect(shell.stderr).toContain("ERROR: Only git commands are served here.");
    const home = await ssh(aliceKey, "git-upload-pack '~alice/ssh.git'");
    expect(home.stderr).toContain("Home directory paths are not supported");
    const traversal = await ssh(aliceKey, "git-upload-pack '../../etc/passwd'");
    expect(traversal.stderr).toContain("Invalid repository path");

    // The deploy key reads its one repository and nothing else, and does not push.
    await git([...basic(ALICE_TOKEN), "push", "-q", url("alice/private.git"), "main"], {
      cwd: work,
    });
    const deployEnv = { GIT_SSH_COMMAND: worker.sshCommand(deployKey) };
    const clone = join(tempDir("deploy"), "clone");
    await git(["clone", "-q", worker.sshUrl("alice/private.git"), clone], { env: deployEnv });
    const pushed = await git(
      ["push", worker.sshUrl("alice/private.git"), "main:refs/heads/deploy"],
      {
        cwd: work,
        env: deployEnv,
        allowFailure: true,
      },
    );
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("You do not have permission to push to alice/private.");
    const elsewhere = await git(["ls-remote", worker.sshUrl("alice/ssh.git")], {
      env: deployEnv,
      allowFailure: true,
    });
    expect(elsewhere.stderr).toContain("ERROR: Repository not found.");

    // A key nobody registered is refused, and after a few tries so is the address.
    const strangerEnv = { GIT_SSH_COMMAND: worker.sshCommand(strangerKey) };
    for (let attempt = 0; attempt < 4; attempt++) {
      const refused = await git(["ls-remote", worker.sshUrl("alice/public.git")], {
        env: strangerEnv,
        allowFailure: true,
      });
      expect(refused.status).not.toBe(0);
    }
    const blocked = await git(["ls-remote", worker.sshUrl("alice/public.git")], {
      env: { GIT_SSH_COMMAND: worker.sshCommand(aliceKey) },
      allowFailure: true,
    });
    expect(blocked.status).not.toBe(0);
  });

  it("initialises with a README, forks, repacks and deletes through the object's RPC", async () => {
    const made = await worker.rpc<{ head: string; commit: string }>("repo-readme", "init", {
      defaultBranch: "trunk",
      readme: { content: "# Readme\n", authorName: "Alice", authorEmail: "alice@example.com" },
    });
    expect(made.head).toBe("refs/heads/trunk");
    const clone = join(tempDir("readme"), "clone");
    await git(["clone", "-q", url("alice/readme.git"), clone]);
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(made.commit);
    expect(await gitOut(["symbolic-ref", "--short", "HEAD"], { cwd: clone })).toBe("trunk");

    // Several pushes, then a forced repack: one pack, and it still clones.
    for (let i = 0; i < 3; i++) {
      await commitFile(clone, "README.md", `# Readme\n\nrevision ${i}\n`, `edit ${i}`);
      await git([...basic(ALICE_TOKEN), "push", "-q", "origin", "trunk"], { cwd: clone });
    }
    expect((await worker.rpc<{ livePacks: number }>("repo-readme", "stats")).livePacks).toBe(4);
    expect(await worker.rpc("repo-readme", "maintain", { force: true })).toEqual({
      deleted: 0,
      repacked: true,
    });
    const stats = await worker.rpc<{ livePacks: number; pendingBytes: number }>(
      "repo-readme",
      "stats",
    );
    expect(stats.livePacks).toBe(1);
    expect(stats.pendingBytes).toBeGreaterThan(0);
    const repacked = join(tempDir("repacked"), "clone");
    await git(["clone", "-q", url("alice/readme.git"), repacked]);
    await git(["fsck", "--strict", "--full"], { cwd: repacked });
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: repacked })).toBe(
      await gitOut(["rev-parse", "HEAD"], { cwd: clone }),
    );

    // A fork is a copy: it survives its parent.
    const forked = await worker.rpc<{ branches: number; liveBytes: number }>(
      "repo-fork",
      "forkFrom",
      "repo-readme",
    );
    expect(forked.branches).toBe(1);
    expect(
      (await worker.rpc<{ deletedFiles: number }>("repo-readme", "destroy")).deletedFiles,
    ).toBeGreaterThan(0);
    const fork = join(tempDir("fork"), "clone");
    await git(["clone", "-q", url("bob/fork.git"), fork]);
    await git(["fsck", "--strict", "--full"], { cwd: fork });
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: fork })).toBe(
      await gitOut(["rev-parse", "HEAD"], { cwd: clone }),
    );
    const gone = join(tempDir("gone"), "clone");
    const empty = await git(["clone", url("alice/readme.git"), gone]);
    expect(empty.stderr).toContain("empty repository");
  });
});
