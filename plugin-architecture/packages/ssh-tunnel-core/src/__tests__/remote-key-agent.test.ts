import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { utils, type ParsedKey } from "ssh2";
import type { Duplex } from "node:stream";

import { RemoteKeyAgent, buildRemoteKeyAgent, type RemoteKeyBackend } from "../remote-key-agent.js";
import { signSshData, type SshSignAlgorithm } from "../ssh-signing.js";

// Like the in-process agent suite, this deliberately does NOT mock ssh2 — the
// backend signs with a real key via `signSshData` (exactly what the cloud
// endpoint does), and the agent-protocol framing is driven byte for byte.

const { parseKey } = utils;

// ---- SSH agent protocol opcodes (mirrors the source under test) ----
const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

const SSH_AGENT_RSA_SHA2_256 = 1 << 1;

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}
function sshString(data: Buffer): Buffer {
  return Buffer.concat([u32(data.length), data]);
}
function frame(payload: Buffer): Buffer {
  return Buffer.concat([u32(payload.length), payload]);
}

function buildSignRequest(keyBlob: Buffer, data: Buffer, flags: number): Buffer {
  const payload = Buffer.concat([
    Buffer.from([SSH_AGENTC_SIGN_REQUEST]),
    sshString(keyBlob),
    sshString(data),
    u32(flags),
  ]);
  return frame(payload);
}

function readResponse(buf: Buffer): { type: number; body: Buffer } {
  const len = buf.readUInt32BE(0);
  const type = buf[4]!;
  const body = buf.subarray(5, 4 + len);
  return { type, body };
}

async function openStream(agent: RemoteKeyAgent): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    agent.getStream((err, s) => {
      if (err || !s) reject(err ?? new Error("no stream"));
      else resolve(s);
    });
  });
}

async function roundTrip(agent: RemoteKeyAgent, request: Buffer): Promise<Buffer> {
  const stream = await openStream(agent);
  return new Promise<Buffer>((resolve) => {
    stream.once("data", (chunk: Buffer) => resolve(chunk));
    stream.write(request);
  });
}

// ---- key generation ----
let tmpDir: string;
const fixtures: Record<"ed" | "rsa" | "ec256", { priv: string; pub: string }> = {
  ed: { priv: "", pub: "" },
  rsa: { priv: "", pub: "" },
  ec256: { priv: "", pub: "" },
};

function keygen(type: string, file: string, extra: string[] = []): { priv: string; pub: string } {
  const p = path.join(tmpDir, file);
  execFileSync("ssh-keygen", [
    "-t",
    type,
    "-f",
    p,
    "-N",
    "",
    "-q",
    "-C",
    "test@infrawrench",
    ...extra,
  ]);
  return { priv: fs.readFileSync(p, "utf8"), pub: fs.readFileSync(`${p}.pub`, "utf8") };
}

function parsePub(pub: string): ParsedKey {
  const k = parseKey(pub);
  if (k instanceof Error) throw k;
  return Array.isArray(k) ? k[0]! : k;
}

/** A backend that signs locally with a real key — what the cloud endpoint does. */
function localBackend(fixture: { priv: string; pub: string }): RemoteKeyBackend & {
  signCalls: Array<{ data: Buffer; algorithm: SshSignAlgorithm }>;
} {
  const signCalls: Array<{ data: Buffer; algorithm: SshSignAlgorithm }> = [];
  return {
    signCalls,
    fetchPublicKey: () => Promise.resolve(fixture.pub),
    sign: (data, algorithm) => {
      signCalls.push({ data, algorithm });
      return Promise.resolve(signSshData(fixture.priv, data, algorithm));
    },
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-key-agent-test-"));
  fixtures.ed = keygen("ed25519", "ed");
  fixtures.rsa = keygen("rsa", "rsa", ["-b", "2048"]);
  fixtures.ec256 = keygen("ecdsa", "ec256", ["-b", "256"]);
});

describe("RemoteKeyAgent.getIdentities", () => {
  it("fetches and parses the public key once", async () => {
    const backend = localBackend(fixtures.ed);
    const fetchSpy = vi.spyOn(backend, "fetchPublicKey");
    const agent = buildRemoteKeyAgent(backend);
    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      agent.getIdentities((err, ks) =>
        err || !ks ? reject(err) : resolve([...ks] as ParsedKey[]),
      );
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.getPublicSSH().equals(parsePub(fixtures.ed.pub).getPublicSSH())).toBe(true);
    await new Promise<ParsedKey[]>((resolve, reject) => {
      agent.getIdentities((err, ks) =>
        err || !ks ? reject(err) : resolve([...ks] as ParsedKey[]),
      );
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a fetch failure and retries on the next call", async () => {
    let calls = 0;
    const backend: RemoteKeyBackend = {
      fetchPublicKey: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("cloud unreachable"))
          : Promise.resolve(fixtures.ed.pub);
      },
      sign: () => Promise.reject(new Error("unused")),
    };
    const agent = buildRemoteKeyAgent(backend);
    const err = await new Promise<Error | null | undefined>((resolve) => {
      agent.getIdentities((e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      agent.getIdentities((e, ks) => (e || !ks ? reject(e) : resolve([...ks] as ParsedKey[])));
    });
    expect(keys).toHaveLength(1);
  });

  it("errors on an unparseable public key", async () => {
    const backend: RemoteKeyBackend = {
      fetchPublicKey: () => Promise.resolve("not a key"),
      sign: () => Promise.reject(new Error("unused")),
    };
    const agent = buildRemoteKeyAgent(backend);
    const err = await new Promise<Error | null | undefined>((resolve) => {
      agent.getIdentities((e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/unparseable/);
  });
});

describe("RemoteKeyAgent.sign (BaseAgent override — the auth path)", () => {
  it("ed25519: relays the backend signature, verifiable with the public key", async () => {
    const backend = localBackend(fixtures.ed);
    const onSign = vi.fn();
    const agent = buildRemoteKeyAgent(backend, { onSign });
    const pub = parsePub(fixtures.ed.pub);
    const data = Buffer.from("session-blob-to-sign");
    const sig = await new Promise<Buffer>((resolve, reject) => {
      agent.sign(pub, data, {}, (err, s) => (err || !s ? reject(err) : resolve(s)));
    });
    expect(backend.signCalls).toEqual([{ data, algorithm: "ssh-ed25519" }]);
    expect(pub.verify(data, sig)).toBe(true);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: null, signatureFormat: "ssh-ed25519" }),
    );
  });

  it("rsa: maps options.hash to the rsa-sha2 algorithm", async () => {
    const backend = localBackend(fixtures.rsa);
    const agent = buildRemoteKeyAgent(backend);
    const pub = parsePub(fixtures.rsa.pub);
    const data = Buffer.from("payload");
    const sig = await new Promise<Buffer>((resolve, reject) => {
      agent.sign(pub, data, { hash: "sha256" }, (err, s) => (err || !s ? reject(err) : resolve(s)));
    });
    expect(backend.signCalls[0]!.algorithm).toBe("rsa-sha2-256");
    expect(Buffer.isBuffer(sig)).toBe(true);
  });

  it("errors when the requested key does not match", async () => {
    const backend = localBackend(fixtures.ed);
    const onSign = vi.fn();
    const agent = buildRemoteKeyAgent(backend, { onSign });
    const other = parsePub(fixtures.rsa.pub);
    const err = await new Promise<Error | null | undefined>((resolve) => {
      agent.sign(other, Buffer.from("x"), {}, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/No matching key/);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: expect.stringContaining("sign_error:") }),
    );
    expect(backend.signCalls).toHaveLength(0);
  });

  it("errors when the backend rejects", async () => {
    const backend: RemoteKeyBackend = {
      fetchPublicKey: () => Promise.resolve(fixtures.ed.pub),
      sign: () => Promise.reject(new Error("cloud said 403")),
    };
    const agent = buildRemoteKeyAgent(backend);
    const err = await new Promise<Error | null | undefined>((resolve) => {
      agent.sign(parsePub(fixtures.ed.pub), Buffer.from("x"), {}, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cloud said 403/);
  });
});

describe("RemoteKeyAgent.getStream — the forwarded agent-protocol path", () => {
  it("answers REQUEST_IDENTITIES with the fetched key", async () => {
    const agent = buildRemoteKeyAgent(localBackend(fixtures.ed));
    const resp = await roundTrip(agent, frame(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES])));
    const { type, body } = readResponse(resp);
    expect(type).toBe(SSH_AGENT_IDENTITIES_ANSWER);
    expect(body.readUInt32BE(0)).toBe(1);
  });

  it("signs ed25519 with correct SSH framing", async () => {
    const backend = localBackend(fixtures.ed);
    const onSign = vi.fn();
    const agent = buildRemoteKeyAgent(backend, { onSign });
    const pub = parsePub(fixtures.ed.pub);
    const data = Buffer.from("data-to-sign");
    const resp = await roundTrip(agent, buildSignRequest(pub.getPublicSSH(), data, 0));
    const { type, body } = readResponse(resp);
    expect(type).toBe(SSH_AGENT_SIGN_RESPONSE);
    const blobLen = body.readUInt32BE(0);
    const blob = body.subarray(4, 4 + blobLen);
    const fmtLen = blob.readUInt32BE(0);
    const fmt = blob.subarray(4, 4 + fmtLen).toString("utf8");
    expect(fmt).toBe("ssh-ed25519");
    const sigLen = blob.readUInt32BE(4 + fmtLen);
    const sig = blob.subarray(4 + fmtLen + 4, 4 + fmtLen + 4 + sigLen);
    expect(pub.verify(data, sig)).toBe(true);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: null, signatureFormat: "ssh-ed25519" }),
    );
  });

  it("maps agent flags to rsa-sha2-256 and converts nothing for RSA", async () => {
    const backend = localBackend(fixtures.rsa);
    const agent = buildRemoteKeyAgent(backend);
    const pub = parsePub(fixtures.rsa.pub);
    const resp = await roundTrip(
      agent,
      buildSignRequest(pub.getPublicSSH(), Buffer.from("x"), SSH_AGENT_RSA_SHA2_256),
    );
    expect(readResponse(resp).type).toBe(SSH_AGENT_SIGN_RESPONSE);
    expect(backend.signCalls[0]!.algorithm).toBe("rsa-sha2-256");
  });

  it("converts the backend's DER ECDSA signature to two SSH mpints", async () => {
    const backend = localBackend(fixtures.ec256);
    const agent = buildRemoteKeyAgent(backend);
    const pub = parsePub(fixtures.ec256.pub);
    const resp = await roundTrip(agent, buildSignRequest(pub.getPublicSSH(), Buffer.from("x"), 0));
    const { type, body } = readResponse(resp);
    expect(type).toBe(SSH_AGENT_SIGN_RESPONSE);
    const blobLen = body.readUInt32BE(0);
    const blob = body.subarray(4, 4 + blobLen);
    const fmtLen = blob.readUInt32BE(0);
    expect(blob.subarray(4, 4 + fmtLen).toString("utf8")).toBe("ecdsa-sha2-nistp256");
    // The signature payload is [string r][string s], not DER (0x30 SEQUENCE).
    const sig = blob.subarray(4 + fmtLen + 4);
    expect(sig[0]).not.toBe(0x30);
    const rLen = sig.readUInt32BE(0);
    const sLen = sig.readUInt32BE(4 + rLen);
    expect(4 + rLen + 4 + sLen).toBe(sig.length);
  });

  it("returns FAILURE when the backend rejects", async () => {
    const onSign = vi.fn();
    const backend: RemoteKeyBackend = {
      fetchPublicKey: () => Promise.resolve(fixtures.ed.pub),
      sign: () => Promise.reject(new Error("signing endpoint down")),
    };
    const agent = buildRemoteKeyAgent(backend, { onSign });
    const pub = parsePub(fixtures.ed.pub);
    const resp = await roundTrip(agent, buildSignRequest(pub.getPublicSSH(), Buffer.from("x"), 0));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "sign_error:signing endpoint down" }),
    );
  });

  it("returns FAILURE for a non-matching key blob", async () => {
    const agent = buildRemoteKeyAgent(localBackend(fixtures.ed));
    const other = parsePub(fixtures.rsa.pub);
    const resp = await roundTrip(
      agent,
      buildSignRequest(other.getPublicSSH(), Buffer.from("x"), 0),
    );
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
  });

  it("returns FAILURE for an unknown opcode", async () => {
    const agent = buildRemoteKeyAgent(localBackend(fixtures.ed));
    const resp = await roundTrip(agent, frame(Buffer.from([27 /* EXTENSION */])));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
  });

  it("keeps replies in request order when the first sign resolves last", async () => {
    const pub = parsePub(fixtures.ed.pub);
    let resolveFirst: ((sig: Buffer) => void) | undefined;
    let call = 0;
    const backend: RemoteKeyBackend = {
      fetchPublicKey: () => Promise.resolve(fixtures.ed.pub),
      sign: (data, algorithm) => {
        call += 1;
        if (call === 1) {
          return new Promise<Buffer>((resolve) => {
            resolveFirst = (sig) => resolve(sig);
          });
        }
        return Promise.resolve(signSshData(fixtures.ed.priv, data, algorithm));
      },
    };
    const agent = buildRemoteKeyAgent(backend);
    const stream = await openStream(agent);
    const chunks: Buffer[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      stream.on("data", (c: Buffer) => {
        chunks.push(c);
        if (chunks.length === 2) resolve();
      });
    });
    const dataA = Buffer.from("first");
    const dataB = Buffer.from("second");
    stream.write(buildSignRequest(pub.getPublicSSH(), dataA, 0));
    stream.write(buildSignRequest(pub.getPublicSSH(), dataB, 0));
    // Let the second request's (immediate) signature race the first.
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks).toHaveLength(0);
    resolveFirst!(signSshData(fixtures.ed.priv, dataA, "ssh-ed25519"));
    await gotTwo;
    // Both are SIGN_RESPONSEs; the first reply must verify against dataA.
    const first = readResponse(chunks[0]!);
    expect(first.type).toBe(SSH_AGENT_SIGN_RESPONSE);
    const blobLen = first.body.readUInt32BE(0);
    const blob = first.body.subarray(4, 4 + blobLen);
    const fmtLen = blob.readUInt32BE(0);
    const sigLen = blob.readUInt32BE(4 + fmtLen);
    const sigBytes = blob.subarray(4 + fmtLen + 4, 4 + fmtLen + 4 + sigLen);
    expect(pub.verify(dataA, sigBytes)).toBe(true);
  });
});
