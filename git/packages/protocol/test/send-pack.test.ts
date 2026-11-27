/**
 * The push client against a real Git host: bare repositories behind
 * `git http-backend`. The packs come from the real `git pack-objects`, so
 * what is under test is the conversation and nothing else.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ZERO_OID, encodePktLine, encodePktLines, encodeSideBand } from "@infrawrench/git-core";
import {
  type SendPackRemote,
  SendPackError,
  chooseSendPackCapabilities,
  encodeSendPackCommands,
  fetchReceiveAdvertisement,
  parseReceiveAdvertisement,
  readSendPackReport,
  sendPack,
} from "../src";
import { cleanupTempDirs, describeGit, git, gitOut, tempDir } from "./helpers";
import { type HttpBackend, startHttpBackend } from "./http-backend";

const USER = "x-access-token";
const PASSWORD = "test-credential-not-a-real-one";
const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

/** A pack of what `wants` reach and `haves` do not, from the real git. */
function packOf(
  cwd: string,
  wants: readonly string[],
  haves: readonly string[],
): ReadableStream<Uint8Array> {
  const child = spawn("git", ["pack-objects", "--revs", "--stdout", "-q"], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end([...wants, ...haves.map((have) => `^${have}`)].join("\n") + "\n");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      child.stdout.on("end", () => controller.close());
    },
  });
}

describeGit("send-pack against git http-backend", () => {
  let backend: HttpBackend;
  let root: string;
  let source: string;
  let target: string;
  let remote: SendPackRemote;
  const oid = (rev: string) => gitOut(["rev-parse", rev], { cwd: source });
  const targetRefs = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await gitOut(["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: target }))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ") as [string, string]),
    );

  beforeAll(async () => {
    root = tempDir("send-pack-root");
    target = join(root, "target.git");
    await git(["init", "-q", "--bare", target]);
    await git(["init", "-q", "--bare", join(root, "empty.git")]);
    source = tempDir("send-pack-source");
    await git(["init", "-q", "-b", "main", source]);
    for (const name of ["one", "two", "three"]) {
      writeFileSync(join(source, `${name}.txt`), `${name}\n`.repeat(200));
      await git(["add", "."], { cwd: source });
      await git(["commit", "-q", "-m", name], { cwd: source });
    }
    await git(["tag", "-a", "-m", "release", "v1", "HEAD~1"], { cwd: source });
    await git(["tag", "light", "HEAD~2"], { cwd: source });
    backend = await startHttpBackend({ root, username: USER, password: PASSWORD });
    remote = {
      url: `${backend.origin}/target.git`,
      authorization: AUTH,
      fetch: (url, init) => fetch(url, init),
    };
  });

  afterAll(async () => {
    await backend.close();
    cleanupTempDirs();
  });

  it("reads an empty repository's advertisement", async () => {
    const advertised = await fetchReceiveAdvertisement({
      ...remote,
      url: `${backend.origin}/empty.git`,
    });
    expect(advertised.refs.size).toBe(0);
    expect(advertised.capabilities.has("report-status")).toBe(true);
    expect(advertised.capabilities.has("delete-refs")).toBe(true);
  });

  it("creates branches and tags, annotated ones as tag objects", async () => {
    const advertised = await fetchReceiveAdvertisement(remote);
    const main = await oid("main~1");
    const v1 = await oid("v1");
    const light = await oid("light");
    const report = await sendPack(remote, {
      offered: advertised.capabilities,
      commands: [
        { name: "refs/heads/main", oldOid: ZERO_OID, newOid: main },
        { name: "refs/tags/v1", oldOid: ZERO_OID, newOid: v1 },
        { name: "refs/tags/light", oldOid: ZERO_OID, newOid: light },
      ],
      pack: packOf(source, [main, v1, light], []),
    });
    expect(report.unpackError).toBeNull();
    expect([...report.refs.values()]).toEqual([null, null, null]);
    expect(await targetRefs()).toEqual({
      "refs/heads/main": main,
      "refs/tags/v1": v1,
      "refs/tags/light": light,
    });
    expect(await gitOut(["cat-file", "-t", v1], { cwd: target })).toBe("tag");
    await git(["fsck", "--strict", "--full"], { cwd: target });
  });

  it("fast-forwards with only the new objects, and the credential goes on both requests", async () => {
    const advertised = await fetchReceiveAdvertisement(remote);
    const old = advertised.refs.get("refs/heads/main")!;
    const main = await oid("main");
    let pushed = 0;
    backend.behave({ onPush: (bytes) => (pushed = bytes) });
    const report = await sendPack(remote, {
      offered: advertised.capabilities,
      commands: [{ name: "refs/heads/main", oldOid: old, newOid: main }],
      pack: packOf(source, [main], [old]),
    });
    backend.behave({ onPush: null });
    expect(report.refs.get("refs/heads/main")).toBeNull();
    expect((await targetRefs())["refs/heads/main"]).toBe(main);
    // One commit, one tree, one small blob: nowhere near the whole history.
    expect(pushed).toBeGreaterThan(0);
    expect(pushed).toBeLessThan(2000);
    expect(backend.requests.slice(-2).map((request) => request.authorization)).toEqual([
      AUTH,
      AUTH,
    ]);
  });

  it("is refused for a ref that moved since the advertisement", async () => {
    const advertised = await fetchReceiveAdvertisement(remote);
    const stale = await oid("main~2");
    const report = await sendPack(remote, {
      offered: advertised.capabilities,
      commands: [{ name: "refs/heads/main", oldOid: stale, newOid: await oid("main~1") }],
      pack: packOf(source, [], []),
    });
    expect(report.unpackError).toBeNull();
    expect(report.refs.get("refs/heads/main")).not.toBeNull();
    expect((await targetRefs())["refs/heads/main"]).toBe(await oid("main"));
  });

  it("moves a branch backwards and deletes refs, with no pack for a deletion", async () => {
    let advertised = await fetchReceiveAdvertisement(remote);
    const back = await oid("main~2");
    const forced = await sendPack(remote, {
      offered: advertised.capabilities,
      commands: [
        { name: "refs/heads/main", oldOid: advertised.refs.get("refs/heads/main")!, newOid: back },
      ],
      pack: packOf(source, [], []),
    });
    expect(forced.refs.get("refs/heads/main")).toBeNull();
    expect((await targetRefs())["refs/heads/main"]).toBe(back);

    advertised = await fetchReceiveAdvertisement(remote);
    const deleted = await sendPack(remote, {
      offered: advertised.capabilities,
      commands: [
        {
          name: "refs/tags/light",
          oldOid: advertised.refs.get("refs/tags/light")!,
          newOid: ZERO_OID,
        },
      ],
      pack: null,
    });
    expect(deleted.refs.get("refs/tags/light")).toBeNull();
    expect(Object.keys(await targetRefs())).toEqual(["refs/heads/main", "refs/tags/v1"]);
  });

  it("says what went wrong without the address or the credential", async () => {
    const wrong = { ...remote, authorization: "Basic bm9wZTpub3Bl" };
    const unauthorized = await fetchReceiveAdvertisement(wrong).catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(SendPackError);
    expect((unauthorized as SendPackError).code).toBe("unauthorized");

    backend.behave({ redirect: "http://127.0.0.1:9/elsewhere.git/info/refs" });
    const redirected = await fetchReceiveAdvertisement(remote).catch((error: unknown) => error);
    backend.behave({ redirect: null, status: 404 });
    const missing = await fetchReceiveAdvertisement(remote).catch((error: unknown) => error);
    backend.behave({ status: null });
    expect((redirected as SendPackError).code).toBe("redirected");
    expect((missing as SendPackError).code).toBe("not-found");
    for (const error of [unauthorized, redirected, missing] as SendPackError[]) {
      expect(error.message).not.toContain("127.0.0.1");
      expect(error.message).not.toContain(PASSWORD);
      expect(error.message).not.toContain("Basic");
    }

    const notGit = await fetchReceiveAdvertisement({
      ...remote,
      fetch: async () =>
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    }).catch((error: unknown) => error);
    expect((notGit as SendPackError).code).toBe("not-git");
  });
});

const A = "a".repeat(40);
const B = "b".repeat(40);

it("parses an advertisement with capabilities, a .have line and a bad name", () => {
  const body = encodePktLines([
    "# service=git-receive-pack\n",
    null,
    `${A} refs/heads/main\0report-status delete-refs side-band-64k ofs-delta agent=git/2.50\n`,
    `${B} .have\n`,
    `${B} refs/heads/..bad\n`,
    `${B} refs/tags/v1\n`,
    null,
  ]);
  const advertised = parseReceiveAdvertisement(body);
  expect([...advertised.refs]).toEqual([
    ["refs/heads/main", A],
    ["refs/tags/v1", B],
  ]);
  expect(advertised.extraHaves).toEqual([B]);
  expect(chooseSendPackCapabilities(advertised.capabilities, "test")).toEqual([
    "report-status",
    "side-band-64k",
    "ofs-delta",
    "agent=test",
  ]);
});

it("refuses an answer that is not an advertisement", () => {
  expect(() => parseReceiveAdvertisement(new TextEncoder().encode("<html>"))).toThrow(
    SendPackError,
  );
  expect(() => parseReceiveAdvertisement(encodePktLines([`${A} refs/heads/main\n`, null]))).toThrow(
    SendPackError,
  );
});

it("writes the commands as git does", () => {
  const text = new TextDecoder().decode(
    encodeSendPackCommands(
      [
        { name: "refs/heads/main", oldOid: A, newOid: B },
        { name: "refs/heads/gone", oldOid: B, newOid: ZERO_OID },
      ],
      ["report-status", "side-band-64k"],
    ),
  );
  expect(text).toBe(
    `0083${A} ${B} refs/heads/main\0 report-status side-band-64k\n` +
      `0066${B} ${ZERO_OID} refs/heads/gone\n0000`,
  );
});

it("reads a report through the side band, cut anywhere, with progress in between", async () => {
  const inner = encodePktLines([
    "unpack ok\n",
    "ok refs/heads/main\n",
    "ng refs/heads/locked protected branch hook declined\n",
    null,
  ]);
  const frames = [
    ...encodeSideBand(2, new TextEncoder().encode("Resolving deltas\r"), 65520),
    ...encodeSideBand(1, inner.subarray(0, 7), 65520),
    ...encodeSideBand(1, inner.subarray(7, 30), 65520),
    ...encodeSideBand(2, new TextEncoder().encode("remote: hello\n"), 65520),
    ...encodeSideBand(1, inner.subarray(30), 65520),
    encodePktLines([null]),
  ];
  const report = await readSendPackReport(frames, true);
  expect(report.unpackError).toBeNull();
  expect([...report.refs]).toEqual([
    ["refs/heads/main", null],
    ["refs/heads/locked", "protected branch hook declined"],
  ]);
});

it("reads a plain report and a failed unpack, and refuses an answer with neither", async () => {
  const report = await readSendPackReport(
    [
      encodePktLines([
        "unpack index-pack abnormal exit\n",
        "ng refs/heads/main unpacker error\n",
        null,
      ]),
    ],
    false,
  );
  expect(report.unpackError).toBe("index-pack abnormal exit");
  expect(report.refs.get("refs/heads/main")).toBe("unpacker error");
  await expect(readSendPackReport([encodePktLine("hello\n")], false)).rejects.toThrow(
    SendPackError,
  );
});
