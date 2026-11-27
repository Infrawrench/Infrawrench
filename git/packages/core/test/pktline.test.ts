import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELIM_PKT,
  FLUSH_PKT,
  GitError,
  PKT_MAX_DATA,
  PKT_MAX_LENGTH,
  type Pkt,
  PktLineReader,
  RESPONSE_END_PKT,
  SIDE_BAND_MAX_LENGTH,
  collectBytes,
  concatBytes,
  decodePktLines,
  decodeSideBand,
  demuxSideBand,
  encodePktLine,
  encodePktLines,
  encodeSideBand,
  encodeSideBandRun,
  indexPack,
  memoryRangeReader,
  muxSideBand,
  pktLineText,
  streamOf,
} from "../src";
import {
  chunked,
  cleanupTempDirs,
  describeGit,
  git,
  gitRaw,
  makeFixtureRepo,
  prng,
  randomBytes,
} from "./helpers";

afterAll(cleanupTempDirs);

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("encoding", () => {
  it("writes the length in four hex digits, counting itself", () => {
    expect(decode(encodePktLine("hello\n"))).toBe("000ahello\n");
    expect(decode(encodePktLine(""))).toBe("0004");
    expect(decode(encodePktLine(new Uint8Array(251)).subarray(0, 4))).toBe("00ff");
    expect(decode(FLUSH_PKT)).toBe("0000");
    expect(decode(DELIM_PKT)).toBe("0001");
    expect(decode(RESPONSE_END_PKT)).toBe("0002");
    expect(decode(encodePktLines(["a\n", null, "b"]))).toBe("0006a\n00000005b");
  });

  it("enforces the 65520-byte limit", () => {
    const largest = encodePktLine(new Uint8Array(PKT_MAX_DATA));
    expect(largest.length).toBe(PKT_MAX_LENGTH);
    expect(decode(largest.subarray(0, 4))).toBe("fff0");
    expect(() => encodePktLine(new Uint8Array(PKT_MAX_DATA + 1))).toThrow(GitError);
  });
});

describe("decoding", () => {
  it("decodes data and the three markers", () => {
    const pkts = decodePktLines(text("000ahello\n0000000100020004"));
    expect(pkts.map((p) => p.type)).toEqual(["data", "flush", "delim", "response-end", "data"]);
    expect(pktLineText(pkts[0]!)).toBe("hello");
    expect((pkts[4] as { data: Uint8Array }).data.length).toBe(0);
    expect(() => pktLineText(pkts[1]!)).toThrow(GitError);
  });

  it("accepts upper-case hex and rejects malformed lengths", () => {
    expect(decodePktLines(text("000Ahello\n"))).toHaveLength(1);
    for (const bad of ["0003", "00zz", "-001", "000", "0009abc", "fff1" + "x".repeat(10)]) {
      expect(() => decodePktLines(text(bad)), bad).toThrow(GitError);
    }
  });

  it("reads the same packets from a stream however it is chunked", async () => {
    const next = prng(8);
    const payloads: Array<Uint8Array | null> = [];
    for (let i = 0; i < 200; i++) {
      payloads.push(
        i % 17 === 0 ? null : randomBytes(next() % (i % 23 === 0 ? PKT_MAX_DATA : 300), next),
      );
    }
    payloads.push(new Uint8Array(PKT_MAX_DATA), new Uint8Array(0));
    const wire = encodePktLines(payloads);
    for (const size of [1, 3, 4, 5, 1000, 70_000, wire.length]) {
      if (size === 1 && wire.length > 400_000) continue;
      const reader = new PktLineReader(chunked(wire, size));
      const seen: Pkt[] = [];
      for await (const pkt of reader)
        seen.push(pkt.type === "data" ? { type: "data", data: pkt.data.slice() } : pkt);
      expect(seen).toHaveLength(payloads.length);
      for (const [i, payload] of payloads.entries()) {
        if (payload === null) expect(seen[i]!.type).toBe("flush");
        else expect(Buffer.compare((seen[i] as { data: Uint8Array }).data, payload)).toBe(0);
      }
      expect(await reader.read()).toBeNull();
    }
  });

  it("reports a stream that ends inside a packet", async () => {
    await expect(new PktLineReader([text("00")]).read()).rejects.toThrow(GitError);
    await expect(new PktLineReader([text("000ahel")]).read()).rejects.toThrow(GitError);
    await expect(new PktLineReader([text("zzzz")]).read()).rejects.toThrow(GitError);
    expect(await new PktLineReader([]).read()).toBeNull();
  });

  it("hands back the raw bytes that follow the packets, as receive-pack needs", async () => {
    const next = prng(9);
    const raw = randomBytes(100_000, next);
    const wire = concatBytes([
      encodePktLines(["old new refs/heads/main\0report-status\n", null]),
      raw,
    ]);
    for (const size of [1, 7, 50, 64_000, wire.length]) {
      const reader = new PktLineReader(streamOf(...chunked(wire, size)));
      const section = await reader.readSection();
      expect(section.end).toBe("flush");
      expect(section.lines).toHaveLength(1);
      expect(Buffer.compare(await collectBytes(reader.rest()), raw)).toBe(0);
      await expect(reader.read()).rejects.toThrow(/handed off/);
    }
    const reader = new PktLineReader([wire]);
    await reader.readSection();
    expect(Buffer.compare(await collectBytes(reader.restStream()), raw)).toBe(0);
  });
});

describe("side-band", () => {
  it("splits data to the packet limit and back", async () => {
    const data = randomBytes(200_000, prng(10));
    for (const limit of [SIDE_BAND_MAX_LENGTH, PKT_MAX_LENGTH]) {
      const packets = encodeSideBand(1, data, limit);
      expect(packets).toHaveLength(Math.ceil(data.length / (limit - 5)));
      for (const packet of packets) expect(packet.length).toBeLessThanOrEqual(limit);
      const wire = concatBytes([
        ...encodeSideBand(2, "Counting objects\r"),
        ...packets,
        ...encodeSideBand(2, "done\n"),
        FLUSH_PKT,
        encodePktLine("after\n"),
      ]);
      const reader = new PktLineReader(chunked(wire, 4000));
      const progress: string[] = [];
      const out = await collectBytes(
        demuxSideBand(reader, { onProgress: (bytes) => progress.push(decode(bytes)) }),
      );
      expect(Buffer.compare(out, data)).toBe(0);
      expect(progress).toEqual(["Counting objects\r", "done\n"]);
      // The demux stopped at the flush and left the stream usable.
      expect(pktLineText((await reader.read())!)).toBe("after");
    }
    expect(encodeSideBand(1, new Uint8Array(0))).toEqual([]);
    expect(() => encodeSideBand(1, data, 5)).toThrow(GitError);
  });

  it("frames a run of pieces as the same packets, in one buffer", () => {
    const data = randomBytes(200_000, prng(11));
    for (const limit of [SIDE_BAND_MAX_LENGTH, PKT_MAX_LENGTH]) {
      const expected = concatBytes(encodeSideBand(1, data, limit));
      for (const size of [1, 7, 994, 995, 996, 65_515, 70_000, data.length]) {
        const pieces = [...chunked(data, size)];
        expect(Buffer.compare(encodeSideBandRun(1, pieces, data.length, limit), expected)).toBe(0);
      }
      // Only what was asked for: the rest of the last piece is the caller's to send later.
      const room = limit - 5;
      const part = encodeSideBandRun(1, [data.subarray(0, 10), data.subarray(10)], room * 2, limit);
      expect(Buffer.compare(part, expected.subarray(0, limit * 2))).toBe(0);
    }
    expect(encodeSideBandRun(1, [], 0)).toHaveLength(0);
    expect(() => encodeSideBandRun(1, [data.subarray(0, 10)], 11)).toThrow(GitError);
    expect(() => encodeSideBandRun(1, [data], 10, 5)).toThrow(GitError);
  });

  it("surfaces a channel 3 message as an error and rejects unknown channels", async () => {
    const wire = concatBytes([...encodeSideBand(1, "ok"), ...encodeSideBand(3, "fatal: nope\n")]);
    await expect(collectBytes(demuxSideBand(new PktLineReader([wire])))).rejects.toThrow(
      /fatal: nope/,
    );
    expect(() => decodeSideBand(Uint8Array.from([9, 1]))).toThrow(GitError);
    expect(() => decodeSideBand(new Uint8Array(0))).toThrow(GitError);
    expect(decodeSideBand(Uint8Array.from([2, 65]))).toEqual({
      channel: 2,
      data: Uint8Array.from([65]),
    });
  });

  it("muxes a stream into packets a demux reads back", async () => {
    const data = randomBytes(300_000, prng(11));
    const muxed = await collectBytes(muxSideBand(chunked(data, 100_000)));
    const out = await collectBytes(demuxSideBand(new PktLineReader([muxed, FLUSH_PKT])));
    expect(Buffer.compare(out, data)).toBe(0);
  });
});

describeGit("against git upload-pack", () => {
  let repo = "";
  beforeAll(() => {
    repo = makeFixtureRepo({ commits: 30, largeBytes: 200_000 });
  });

  /** One protocol v2 request to a real upload-pack, the way smart HTTP delivers it. */
  function uploadPack(request: Uint8Array): Uint8Array {
    const result = gitRaw(["upload-pack", "--stateless-rpc", repo], {
      input: request,
      env: { GIT_PROTOCOL: "version=2" },
    });
    return new Uint8Array(result.stdout);
  }

  it("reads the advertisement git writes", () => {
    const out = gitRaw(["upload-pack", "--advertise-refs", repo], {
      env: { GIT_PROTOCOL: "version=2" },
    });
    const lines = decodePktLines(new Uint8Array(out.stdout));
    expect(pktLineText(lines[0]!)).toBe("version 2");
    expect(lines.at(-1)!.type).toBe("flush");
    const capabilities = lines.slice(1, -1).map(pktLineText);
    expect(capabilities).toContain("ls-refs=unborn");
    expect(capabilities.some((line) => line.startsWith("fetch="))).toBe(true);
  });

  it("lists refs with a request written here", () => {
    const request = concatBytes([
      encodePktLine("command=ls-refs\n"),
      encodePktLine("object-format=sha1\n"),
      DELIM_PKT,
      encodePktLine("peel\n"),
      encodePktLine("symrefs\n"),
      FLUSH_PKT,
    ]);
    const lines = decodePktLines(uploadPack(request));
    expect(lines.at(-1)!.type).toBe("flush");
    const listed = lines.slice(0, -1).map(pktLineText);
    const head = git(["rev-parse", "HEAD"], { cwd: repo });
    expect(listed).toContain(`${head} HEAD symref-target:refs/heads/main`);
    const tag = git(["rev-parse", "refs/tags/v1.0"], { cwd: repo });
    const peeled = git(["rev-parse", "refs/tags/v1.0^{}"], { cwd: repo });
    expect(listed).toContain(`${tag} refs/tags/v1.0 peeled:${peeled}`);
    const expected = git(["for-each-ref", "--format=%(objectname) %(refname)"], {
      cwd: repo,
    }).split("\n");
    expect(listed.slice(1).map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(expected);
  });

  it("fetches a pack over side-band-64k and indexes it", async () => {
    const head = git(["rev-parse", "HEAD"], { cwd: repo });
    const request = concatBytes([
      encodePktLine("command=fetch\n"),
      encodePktLine("object-format=sha1\n"),
      DELIM_PKT,
      encodePktLine("ofs-delta\n"),
      encodePktLine("no-progress\n"),
      encodePktLine(`want ${head}\n`),
      encodePktLine("done\n"),
      FLUSH_PKT,
    ]);
    const response = uploadPack(request);
    const reader = new PktLineReader(chunked(response, 8192));
    expect(pktLineText((await reader.read())!)).toBe("packfile");
    const pack = await collectBytes(demuxSideBand(reader));
    expect(await reader.read()).toBeNull();
    const result = await indexPack([pack], { readRange: memoryRangeReader(pack) });
    const expected = git(["rev-list", "--objects", head], { cwd: repo })
      .split("\n")
      .map((line) => line.split(" ")[0]!)
      .sort();
    expect([...result.objects].map((o) => o.oid).sort()).toEqual(expected);
  });
});
