/**
 * What a client can ask for by naming ids, and the bounds on what it can
 * make the server hold. A history made and pushed by the real `git`; the
 * requests written by hand, since `git` never sends most of them.
 */
import {
  DELIM_PKT,
  FLUSH_PKT,
  concatBytes,
  decodeLatin1,
  encodePktLine,
} from "@infrawrench/git-core";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { MemoryBackend, type ServeLimits, newServeStats, serve } from "../src";
import {
  type TestServer,
  cleanupTempDirs,
  commitFile,
  describeGit,
  git,
  gitOut,
  initRepo,
  resetClock,
  startServer,
} from "./helpers";

afterAll(cleanupTempDirs);

type Line = string | "<delim>" | "<flush>";

const encode = (lines: readonly Line[]): Uint8Array =>
  concatBytes(
    lines.map((line) =>
      line === "<delim>" ? DELIM_PKT : line === "<flush>" ? FLUSH_PKT : encodePktLine(`${line}\n`),
    ),
  );

async function ask(
  backend: MemoryBackend,
  version: 0 | 2,
  lines: readonly Line[],
  options: { readonly limits?: ServeLimits; readonly statelessRpc?: boolean } = {},
): Promise<{ text: string; objectsSent: number; errors: unknown[] }> {
  const stats = newServeStats();
  const errors: unknown[] = [];
  const output = serve({
    backend,
    request: {
      service: "git-upload-pack",
      version,
      statelessRpc: options.statelessRpc ?? true,
      advertiseOnly: false,
    },
    input: [encode(lines)],
    stats,
    onError: (error) => errors.push(error),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const chunks: Uint8Array[] = [];
  const reader = output.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return { text: decodeLatin1(concatBytes(chunks)), objectsSent: stats.objectsSent, errors };
}

describeGit("ids a client names", () => {
  let backend: MemoryBackend;
  let server: TestServer;
  let work: string;
  let kept: string;
  let dropped: string;
  let keptObjects: number;

  beforeEach(async () => {
    resetClock();
    backend = new MemoryBackend();
    server = await startServer(backend);
    work = await initRepo("reach");
    await commitFile(work, "a.txt", "a\n", "a");
    kept = await commitFile(work, "b.txt", "b\n", "b");
    await git(["remote", "add", "origin", server.httpUrl], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
    // A commit that is pushed and then forced away: still stored, reached by nothing.
    dropped = await commitFile(work, "secret.txt", "a secret\n", "oops");
    await git(["push", "-q", "origin", "main"], { cwd: work });
    await git(["reset", "-q", "--hard", kept], { cwd: work });
    await git(["push", "-q", "--force", "origin", "main"], { cwd: work });
    expect(await backend.has(dropped)).toBe(true);
    keptObjects = (await gitOut(["rev-list", "--objects", kept], { cwd: work })).split("\n").length;
  });
  afterEach(async () => {
    expect(server.errors).toEqual([]);
    await server.close();
  });

  const fetch = (args: readonly string[]): Line[] => [
    "command=fetch",
    "object-format=sha1",
    "<delim>",
    ...args,
    "<flush>",
  ];

  it("refuses a want of a commit no ref reaches, in v0 and v2", async () => {
    const v2 = await ask(backend, 2, fetch([`want ${dropped}`, "done"]));
    expect(v2.text).toContain(`ERR upload-pack: not our ref ${dropped}`);
    const v0 = await ask(backend, 0, [`want ${dropped} side-band-64k`, "<flush>", "done"]);
    expect(v0.text).toContain(`ERR upload-pack: not our ref ${dropped}`);
  });

  it("does not unshallow a commit the wants do not reach", async () => {
    const unshallow = await ask(
      backend,
      2,
      fetch([`want ${kept}`, `shallow ${dropped}`, "deepen 2147483647", "done"]),
    );
    expect(unshallow.errors).toEqual([]);
    expect(unshallow.text).not.toContain(dropped);
    // Exactly the history of the commit asked for, and none of the other one's.
    expect(unshallow.objectsSent).toBe(keptObjects);

    const relative = await ask(
      backend,
      2,
      fetch([`want ${kept}`, `shallow ${dropped}`, "deepen 1", "deepen-relative", "done"]),
    );
    expect(relative.text).not.toContain(dropped);
    expect(relative.objectsSent).toBeLessThan(keptObjects);

    const v0 = await ask(backend, 0, [
      `want ${kept} side-band-64k`,
      `shallow ${dropped}`,
      "deepen 2147483647",
      "<flush>",
      "done",
    ]);
    expect(v0.text).not.toContain(dropped);
    expect(v0.objectsSent).toBe(keptObjects);
  });

  it("still unshallows a client's own boundary", async () => {
    const parent = await gitOut(["rev-parse", `${kept}~1`], { cwd: work });
    const deeper = await ask(
      backend,
      2,
      fetch([`want ${kept}`, `shallow ${kept}`, "deepen 2147483647", "done"]),
    );
    expect(deeper.text).toContain(`unshallow ${kept}`);
    // With no haves sent, that is the whole history of the commit.
    expect(deeper.objectsSent).toBe(keptObjects);
    expect(deeper.text).not.toContain(`unshallow ${parent}`);
  });

  it("does not clone what a forced push left behind", async () => {
    const result = await ask(backend, 2, fetch([`want ${kept}`, "ofs-delta", "done"]));
    expect(result.objectsSent).toBe(keptObjects);
  });

  it("bounds every list a request can grow", async () => {
    const limits: ServeLimits = {
      maxWants: 1,
      maxHaves: 1,
      maxShallows: 1,
      maxDeepenNots: 1,
      maxArgumentBytes: 200,
    };
    const tooMany = async (args: string[], message: string): Promise<void> => {
      const { text } = await ask(backend, 2, fetch(args), { limits });
      expect(text).toContain(`ERR ${message}`);
    };
    await tooMany([`want ${kept}`, `want ${kept}`], "upload-pack: too many wants");
    await tooMany([`want ${kept}`, `have ${kept}`, `have ${kept}`], "fetch: too many haves");
    await tooMany(
      [`want ${kept}`, `shallow ${kept}`, `shallow ${kept}`, "deepen 1"],
      "upload-pack: too many shallow lines",
    );
    await tooMany(
      [`want ${kept}`, "deepen-not main", "deepen-not main"],
      "upload-pack: too many deepen-not lines",
    );
    await tooMany(
      Array.from({ length: 20 }, () => "no-progress"),
      "too many arguments to one command",
    );
    const v0 = await ask(backend, 0, [`want ${kept}`, `want ${kept}`, "<flush>"], { limits });
    expect(v0.text).toContain("ERR upload-pack: too many wants");

    // ls-refs with more prefixes than allowed lists everything instead of comparing each.
    const prefixes = await ask(
      backend,
      2,
      ["command=ls-refs", "<delim>", "ref-prefix refs/tags/", "ref-prefix refs/x/", "<flush>"],
      { limits: { maxRefPrefixes: 1 } },
    );
    expect(prefixes.text).toContain(`${kept} refs/heads/main`);

    // A stateful conversation runs a bounded number of commands.
    const listing: Line[] = ["command=ls-refs", "<delim>", "<flush>"];
    const commands = await ask(backend, 2, [...listing, ...listing, ...listing], {
      limits: { maxCommands: 2 },
      statelessRpc: false,
    });
    expect(commands.text).toContain("ERR too many commands");
  });
});
