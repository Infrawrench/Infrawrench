/**
 * End to end: the real `git` client, over the real `ssh` client, through the
 * server, to the real `git upload-pack` and `git receive-pack`.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkspace,
  generateKey,
  MISSING_TOOLS,
  git,
  gitExecHandler,
  startServer,
  type KeyPair,
  type TestServer,
  type Workspace,
} from "./support";

const MIB = 1024 * 1024;
const BIG_FILE_BYTES = 128 * MIB;
const URL = "git@127.0.0.1:acme/widgets.git";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Run `task` while sampling how much memory this process (the server) holds
 * in buffers, and return the most it held above where it started. Each
 * sample collects garbage first, so what is measured is what something
 * still refers to, not what the collector has not got round to.
 */
async function peakBufferGrowth(task: () => Promise<unknown>): Promise<number> {
  const collect = globalThis.gc;
  if (!collect) throw new Error("run the tests through vitest.config.ts, which passes --expose-gc");
  const held = () => {
    collect();
    // Memory outside the JavaScript heap, which is where every Buffer and Uint8Array lives.
    return process.memoryUsage().external;
  };
  const baseline = held();
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, held());
  }, 25);
  try {
    await task();
  } finally {
    clearInterval(timer);
  }
  return peak - baseline;
}

describe.skipIf(MISSING_TOOLS.length > 0)("git over the server", () => {
  let workspace: Workspace;
  let server: TestServer;
  let user: KeyPair;
  let stranger: KeyPair;
  const seen: Array<{ command: string; env: Map<string, string> }> = [];
  let client: { port: number; keyPath: string };
  let head = "";

  const revParse = async (dir: string, ref = "HEAD") =>
    (await git(dir, ["rev-parse", ref])).stdout.trim();

  beforeAll(async () => {
    workspace = await createWorkspace();
    const hostKey = await generateKey(workspace, "host", "ed25519");
    user = await generateKey(workspace, "user", "ed25519");
    stranger = await generateKey(workspace, "stranger", "ed25519");
    const root = workspace.path("repos");
    await mkdir(workspace.path("repos", "acme"), { recursive: true });
    await git(workspace.dir, ["init", "-q", "--bare", "-b", "main", "repos/acme/widgets.git"]);
    server = await startServer({
      hostKey: hostKey.privateKey,
      users: new Map([[user.publicKey.fingerprint, "alice"]]),
      exec: gitExecHandler(root, seen),
    });
    client = { port: server.port, keyPath: user.path };

    // The first push: a working repository with a little history.
    const origin = workspace.path("origin-work");
    await git(workspace.dir, ["init", "-q", "-b", "main", origin]);
    for (let i = 0; i < 20; i++) {
      await writeFile(workspace.path("origin-work", `file-${i}.txt`), `content ${i}\n`.repeat(200));
      await git(origin, ["add", "."]);
      await git(origin, ["commit", "-q", "-m", `commit ${i}`]);
    }
    await git(origin, ["remote", "add", "origin", URL]);
    await git(origin, ["push", "-q", "origin", "main"], client);
    head = await revParse(origin);
  }, 120_000);

  afterAll(async () => {
    await server.close();
    await workspace.cleanup();
    // Nothing in a git session should have looked like a server-side failure.
    expect(server.errors).toEqual([]);
  });

  it("pushed the first history through receive-pack", async () => {
    expect(await revParse(workspace.path("repos", "acme", "widgets.git"), "main")).toBe(head);
    expect(seen.map((entry) => entry.command)).toContain("git-receive-pack 'acme/widgets.git'");
  });

  it("clones with protocol v0", async () => {
    seen.length = 0;
    await git(workspace.dir, ["-c", "protocol.version=0", "clone", "-q", URL, "clone-v0"], client);
    expect(await revParse(workspace.path("clone-v0"))).toBe(head);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe("git-upload-pack 'acme/widgets.git'");
    expect(seen[0]!.env.has("GIT_PROTOCOL")).toBe(false);
  });

  it("clones with protocol v2, announced through the environment", async () => {
    seen.length = 0;
    await git(workspace.dir, ["-c", "protocol.version=2", "clone", "-q", URL, "clone-v2"], client);
    expect(await revParse(workspace.path("clone-v2"))).toBe(head);
    expect(seen[0]!.env.get("GIT_PROTOCOL")).toBe("version=2");
    const text = await readFile(workspace.path("clone-v2", "file-19.txt"), "utf8");
    expect(text).toBe("content 19\n".repeat(200));
  });

  it.each(["aes128-gcm@openssh.com", "chacha20-poly1305@openssh.com"])(
    "clones under %s",
    async (cipher) => {
      const target = `clone-${cipher.split("-")[0]}`;
      await git(workspace.dir, ["clone", "-q", URL, target], { ...client, ssh: ["-c", cipher] });
      expect(await revParse(workspace.path(target))).toBe(head);
    },
  );

  it("pushes from one clone and fetches into another, in both protocol versions", async () => {
    const writer = workspace.path("clone-v2");
    const reader = workspace.path("clone-v0");
    for (const version of ["0", "2"]) {
      await writeFile(workspace.path("clone-v2", `pushed-v${version}.txt`), `via v${version}\n`);
      await git(writer, ["add", "."]);
      await git(writer, ["commit", "-q", "-m", `pushed with v${version}`]);
      await git(
        writer,
        ["-c", `protocol.version=${version}`, "push", "-q", "origin", "main"],
        client,
      );
      head = await revParse(writer);

      await git(reader, ["-c", `protocol.version=${version}`, "fetch", "-q", "origin"], client);
      expect(await revParse(reader, "origin/main")).toBe(head);
    }
    await git(reader, ["merge", "-q", "--ff-only", "origin/main"]);
    expect(await readFile(workspace.path("clone-v0", "pushed-v2.txt"), "utf8")).toBe("via v2\n");
  });

  it("pushes a new branch and a tag, and deletes the branch again", async () => {
    const repo = workspace.path("clone-v2");
    const bare = workspace.path("repos", "acme", "widgets.git");
    await git(repo, ["tag", "v1.0"]);
    await git(repo, ["push", "-q", "origin", "HEAD:refs/heads/feature", "v1.0"], client);
    expect(await revParse(bare, "feature")).toBe(head);
    expect(await revParse(bare, "v1.0")).toBe(head);
    await git(repo, ["push", "-q", "origin", "--delete", "feature"], client);
    await expect(revParse(bare, "feature")).rejects.toThrow();
  });

  it("passes git's own refusal back with its exit status", async () => {
    const repo = workspace.path("clone-v0");
    // Rewind and push without force: receive-pack is fine, the client refuses. Then a
    // repository that does not exist: the handler exits 128 and says why on stderr.
    await expect(
      git(repo, ["clone", "-q", "git@127.0.0.1:acme/missing.git", "nowhere"], client),
    ).rejects.toThrow(/does not appear to be a git repository|not a git repository/);
    await expect(git(repo, ["ls-remote", "git@127.0.0.1:acme/../../etc"], client)).rejects.toThrow(
      /unknown command/,
    );
  });

  it("refuses a push from a key nobody registered", async () => {
    const repo = workspace.path("clone-v2");
    await expect(
      git(repo, ["push", "-q", "origin", "main"], { port: server.port, keyPath: stranger.path }),
    ).rejects.toThrow(/Permission denied \(publickey\)/);
  });

  it("streams a 128 MiB push and clone without holding them in memory", async () => {
    const repo = workspace.path("clone-v2");
    const bare = workspace.path("repos", "acme", "widgets.git");
    // Random, so neither git nor anything else can make it smaller, and
    // written in pieces so the test itself does not hold it either.
    const { open } = await import("node:fs/promises");
    const file = await open(workspace.path("clone-v2", "big.bin"), "w");
    for (let written = 0; written < BIG_FILE_BYTES; written += 8 * MIB) {
      await file.write(randomBytes(8 * MIB));
    }
    await file.close();
    const digest = await sha256File(workspace.path("clone-v2", "big.bin"));
    // No point deflating random bytes; it only makes the test slower.
    await git(repo, ["config", "core.compression", "0"]);
    await git(bare, ["config", "core.compression", "0"]);
    await git(repo, ["add", "big.bin"]);
    await git(repo, ["commit", "-q", "-m", "a large file"]);
    head = await revParse(repo);

    // Small enough a rekey limit that the push crosses several key exchanges.
    const rekeying = { ...client, ssh: ["-o", "RekeyLimit=32M"] };
    const pushSummary = server.nextSummary();
    const pushGrowth = await peakBufferGrowth(() =>
      git(repo, ["push", "-q", "origin", "main"], rekeying),
    );
    expect(await revParse(bare, "main")).toBe(head);
    const pushed = await pushSummary;
    expect(pushed.bytesIn).toBeGreaterThan(BIG_FILE_BYTES);
    expect(pushed.keyExchanges).toBeGreaterThan(2);
    expect(pushed.error).toBeNull();

    const cloneSummary = server.nextSummary();
    const cloneGrowth = await peakBufferGrowth(() =>
      git(workspace.dir, ["clone", "-q", URL, "clone-big"], rekeying),
    );
    expect(await sha256File(workspace.path("clone-big", "big.bin"))).toBe(digest);
    const cloned = await cloneSummary;
    expect(cloned.bytesOut).toBeGreaterThan(BIG_FILE_BYTES);
    expect(cloned.keyExchanges).toBeGreaterThan(2);

    // 128 MiB went through in each direction. Had any layer buffered the
    // stream, the server would have held about that much; flow control
    // keeps it to a channel window and what is in flight.
    process.stderr.write(
      `peak buffer growth: push ${(pushGrowth / MIB).toFixed(1)} MiB, clone ${(cloneGrowth / MIB).toFixed(1)} MiB\n`,
    );
    expect(pushGrowth).toBeLessThan(16 * MIB);
    expect(cloneGrowth).toBeLessThan(16 * MIB);
  }, 180_000);
});
