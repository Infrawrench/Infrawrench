import { describe, it, expect, vi, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { utils } from "ssh2";

import { InProcessAgent, buildInProcessAgent, type SignOutcome } from "../in-process-agent.js";

// NOTE: this suite deliberately does NOT mock ssh2 — it exercises the real
// OpenSSH agent-protocol framing against real parsed keys generated with
// `ssh-keygen` at runtime. The sibling host-verifier suite mocks ssh2 instead;
// vitest isolates modules per file so the two do not collide.

const { parseKey } = utils;

// ---- SSH agent protocol opcodes (mirrors the source under test) ----
const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

const SSH_AGENT_RSA_SHA2_256 = 1 << 1;
const SSH_AGENT_RSA_SHA2_512 = 1 << 2;

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

function requestIdentitiesFrame(): Buffer {
  return frame(Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES]));
}

/** Reader for an agent response frame: [len][type][...body]. */
function readResponse(buf: Buffer): { type: number; body: Buffer } {
  const len = buf.readUInt32BE(0);
  const type = buf[4]!;
  const body = buf.subarray(5, 4 + len);
  return { type, body };
}

/** Drive a single request through the agent's duplex stream and read the reply. */
async function roundTrip(agent: InProcessAgent, request: Buffer): Promise<Buffer> {
  const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
    agent.getStream((err, s) => {
      if (err || !s) reject(err ?? new Error("no stream"));
      else resolve(s as unknown as NodeJS.ReadWriteStream);
    });
  });
  return new Promise<Buffer>((resolve) => {
    stream.once("data", (chunk: Buffer) => resolve(chunk));
    stream.write(request);
  });
}

// ---- key generation ----
interface KeyFixture {
  pem: string;
  parsed: ReturnType<typeof parseKey> extends Error ? never : any;
}

let tmpDir: string;
const fixtures: Record<"ed" | "rsa" | "ec256" | "ec384" | "ec521", string> = {
  ed: "",
  rsa: "",
  ec256: "",
  ec384: "",
  ec521: "",
};

function keygen(type: string, file: string, extra: string[] = []): string {
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
  return fs.readFileSync(p, "utf8");
}

function parsePriv(pem: string) {
  const k = parseKey(pem);
  if (k instanceof Error) throw k;
  if (Array.isArray(k)) return k[0]!;
  return k;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-agent-test-"));
  fixtures.ed = keygen("ed25519", "ed");
  fixtures.rsa = keygen("rsa", "rsa", ["-b", "2048"]);
  fixtures.ec256 = keygen("ecdsa", "ec256", ["-b", "256"]);
  fixtures.ec384 = keygen("ecdsa", "ec384", ["-b", "384"]);
  fixtures.ec521 = keygen("ecdsa", "ec521", ["-b", "521"]);
});

describe("buildInProcessAgent", () => {
  it("returns null for empty / whitespace input", () => {
    expect(buildInProcessAgent("")).toBeNull();
    expect(buildInProcessAgent("   \n  ")).toBeNull();
  });

  it("returns null for an unparseable key", () => {
    expect(buildInProcessAgent("not a key at all")).toBeNull();
  });

  it("returns null when there are no private keys (public key only)", () => {
    const pub = fs.readFileSync(path.join(tmpDir, "ed.pub"), "utf8");
    expect(buildInProcessAgent(pub)).toBeNull();
  });

  it("builds an agent over a valid private key", () => {
    const agent = buildInProcessAgent(fixtures.ed);
    expect(agent).toBeInstanceOf(InProcessAgent);
    expect(agent!.keyCount).toBe(1);
  });

  it("passes options through to the agent", () => {
    const onSign = vi.fn();
    const agent = buildInProcessAgent(fixtures.ed, { onSign });
    expect(agent).not.toBeNull();
  });
});

describe("InProcessAgent.getIdentities", () => {
  it("returns all keys with no error", () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const cb = vi.fn();
    agent.getIdentities(cb);
    expect(cb).toHaveBeenCalledWith(undefined, [k]);
  });
});

describe("InProcessAgent.sign (BaseAgent override)", () => {
  it("signs with a matching key (callback as 3rd arg)", () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const cb = vi.fn();
    agent.sign(k, Buffer.from("payload"), cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBeNull();
    expect(Buffer.isBuffer(cb.mock.calls[0]![1])).toBe(true);
  });

  it("signs with a matching key (options + callback)", () => {
    const k = parsePriv(fixtures.rsa);
    const agent = new InProcessAgent([k]);
    const cb = vi.fn();
    agent.sign(k, Buffer.from("payload"), { hash: "sha256" }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBeNull();
    expect(Buffer.isBuffer(cb.mock.calls[0]![1])).toBe(true);
  });

  it("returns an error when no matching key", () => {
    const k = parsePriv(fixtures.ed);
    const other = parsePriv(fixtures.rsa);
    const agent = new InProcessAgent([k]);
    const cb = vi.fn();
    agent.sign(other, Buffer.from("x"), cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((cb.mock.calls[0]![0] as Error).message).toMatch(/No matching key/);
  });

  it("is a no-op when no callback is supplied", () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    expect(() => agent.sign(k, Buffer.from("x"), {} as any)).not.toThrow();
  });
});

describe("InProcessAgent.getStream — REQUEST_IDENTITIES", () => {
  it("answers with an IDENTITIES_ANSWER listing the keys", async () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const resp = await roundTrip(agent, requestIdentitiesFrame());
    const { type, body } = readResponse(resp);
    expect(type).toBe(SSH_AGENT_IDENTITIES_ANSWER);
    expect(body.readUInt32BE(0)).toBe(1);
  });
});

describe("InProcessAgent.getStream — SIGN_REQUEST per key type", () => {
  const cases: Array<{ name: keyof typeof fixtures; flags: number; expectFormat: string }> = [
    { name: "ed", flags: 0, expectFormat: "ssh-ed25519" },
    { name: "rsa", flags: 0, expectFormat: "ssh-rsa" },
    { name: "rsa", flags: SSH_AGENT_RSA_SHA2_256, expectFormat: "rsa-sha2-256" },
    { name: "rsa", flags: SSH_AGENT_RSA_SHA2_512, expectFormat: "rsa-sha2-512" },
    { name: "ec256", flags: 0, expectFormat: "ecdsa-sha2-nistp256" },
    { name: "ec384", flags: 0, expectFormat: "ecdsa-sha2-nistp384" },
    { name: "ec521", flags: 0, expectFormat: "ecdsa-sha2-nistp521" },
  ];

  for (const c of cases) {
    it(`signs ${c.name} flags=${c.flags} → ${c.expectFormat}`, async () => {
      const k = parsePriv(fixtures[c.name]);
      const onSign = vi.fn();
      const agent = new InProcessAgent([k], { onSign });
      const req = buildSignRequest(k.getPublicSSH(), Buffer.from("data-to-sign"), c.flags);
      const resp = await roundTrip(agent, req);
      const { type, body } = readResponse(resp);
      expect(type).toBe(SSH_AGENT_SIGN_RESPONSE);
      // body is an ssh-string-wrapped blob: [string formatId][string sig]
      const blobLen = body.readUInt32BE(0);
      const blob = body.subarray(4, 4 + blobLen);
      const fmtLen = blob.readUInt32BE(0);
      const fmt = blob.subarray(4, 4 + fmtLen).toString("utf8");
      expect(fmt).toBe(c.expectFormat);
      expect(onSign).toHaveBeenCalledWith(
        expect.objectContaining({ failureReason: null, signatureFormat: c.expectFormat }),
      );
    });
  }
});

describe("InProcessAgent.getStream — SIGN_REQUEST error branches", () => {
  it("returns FAILURE when the key blob does not match any key", async () => {
    const k = parsePriv(fixtures.ed);
    const other = parsePriv(fixtures.rsa);
    const onSign = vi.fn();
    const agent = new InProcessAgent([k], { onSign });
    const req = buildSignRequest(other.getPublicSSH(), Buffer.from("x"), 0);
    const resp = await roundTrip(agent, req);
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "no_matching_key" }),
    );
  });

  it("returns FAILURE for a malformed SIGN_REQUEST body (truncated)", async () => {
    const k = parsePriv(fixtures.ed);
    const onSign = vi.fn();
    const agent = new InProcessAgent([k], { onSign });
    // type byte + a length prefix claiming more bytes than present
    const payload = Buffer.concat([Buffer.from([SSH_AGENTC_SIGN_REQUEST]), u32(100)]);
    const resp = await roundTrip(agent, frame(payload));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "malformed_request" }),
    );
  });

  it("returns FAILURE for an unknown opcode (e.g. session-bind extension)", async () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const resp = await roundTrip(agent, frame(Buffer.from([27 /* EXTENSION */])));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
  });

  it("swallows exceptions thrown by the onSign hook", async () => {
    const k = parsePriv(fixtures.ed);
    const onSign = vi.fn(() => {
      throw new Error("audit sink down");
    });
    const agent = new InProcessAgent([k], { onSign });
    const req = buildSignRequest(k.getPublicSSH(), Buffer.from("data"), 0);
    const resp = await roundTrip(agent, req);
    expect(readResponse(resp).type).toBe(SSH_AGENT_SIGN_RESPONSE);
    expect(onSign).toHaveBeenCalled();
  });
});

describe("InProcessAgent.getStream — framing edge cases", () => {
  it("buffers partial frames across writes and emits one reply", async () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      agent.getStream((err, s) => (err || !s ? reject(err) : resolve(s as any)));
    });
    const full = requestIdentitiesFrame();
    const reply = new Promise<Buffer>((resolve) => stream.once("data", (c: Buffer) => resolve(c)));
    // split the frame mid-way
    stream.write(full.subarray(0, 2));
    stream.write(full.subarray(2));
    const { type } = readResponse(await reply);
    expect(type).toBe(SSH_AGENT_IDENTITIES_ANSWER);
  });

  it("destroys the stream on an absurd message length", async () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      agent.getStream((err, s) => (err || !s ? reject(err) : resolve(s as any)));
    });
    const errP = new Promise<Error>((resolve) =>
      (stream as any).once("error", (e: Error) => resolve(e)),
    );
    // length field claims > 256KiB
    stream.write(u32(300 * 1024));
    const err = await errP;
    expect(err.message).toMatch(/Malformed agent message length/);
  });
});

describe("InProcessAgent.getStream — signRaw / key-type edge cases via fake ParsedKey", () => {
  // A minimal ParsedKey-shaped stub: enough surface for findKey + the sign path.
  function fakeKey(opts: { type: string; pub: Buffer; sign: () => Buffer | Error | never }) {
    return {
      type: opts.type,
      comment: "",
      getPublicSSH: () => opts.pub,
      isPrivateKey: () => true,
      sign: opts.sign,
    } as any;
  }

  it("reports unsupported_key_type and returns FAILURE for an unknown key type", async () => {
    const pub = Buffer.from("unknown-pubkey-blob");
    const onSign = vi.fn();
    const key = fakeKey({ type: "ssh-dss", pub, sign: () => Buffer.from("sig") });
    const agent = new InProcessAgent([key], { onSign });
    const resp = await roundTrip(agent, buildSignRequest(pub, Buffer.from("x"), 0));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ keyType: "ssh-dss", failureReason: "unsupported_key_type" }),
    );
  });

  it("reports sign_error and returns FAILURE when the key's sign() throws", async () => {
    const pub = Buffer.from("ed-like-pubkey-blob");
    const onSign = vi.fn();
    const key = fakeKey({
      type: "ssh-ed25519",
      pub,
      sign: () => {
        throw new Error("hardware token unplugged");
      },
    });
    const agent = new InProcessAgent([key], { onSign });
    const resp = await roundTrip(agent, buildSignRequest(pub, Buffer.from("x"), 0));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: expect.stringContaining("sign_error:") }),
    );
  });

  it("reports sign_error when sign() returns an Error object", async () => {
    const pub = Buffer.from("ed-like-pubkey-blob-2");
    const onSign = vi.fn();
    const key = fakeKey({
      type: "ssh-ed25519",
      pub,
      sign: () => new Error("bad signature"),
    });
    const agent = new InProcessAgent([key], { onSign });
    const resp = await roundTrip(agent, buildSignRequest(pub, Buffer.from("x"), 0));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: expect.stringContaining("sign_error:") }),
    );
  });

  it("treats a non-buffer sign() return as an error", async () => {
    const pub = Buffer.from("ed-like-pubkey-blob-3");
    const onSign = vi.fn();
    const key = fakeKey({
      type: "ssh-ed25519",
      pub,
      sign: () => 123 as unknown as Buffer,
    });
    const agent = new InProcessAgent([key], { onSign });
    const resp = await roundTrip(agent, buildSignRequest(pub, Buffer.from("x"), 0));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: expect.stringContaining("sign_error:") }),
    );
  });

  it("reports ecdsa_conversion_failed when ECDSA sign() yields non-DER bytes", async () => {
    const pub = Buffer.from("ec-like-pubkey-blob");
    const onSign = vi.fn();
    const key = fakeKey({
      type: "ecdsa-sha2-nistp256",
      pub,
      // not a DER SEQUENCE → derToSshEcdsa returns null
      sign: () => Buffer.from([0x00, 0x01, 0x02, 0x03]),
    });
    const agent = new InProcessAgent([key], { onSign });
    const resp = await roundTrip(agent, buildSignRequest(pub, Buffer.from("x"), 0));
    expect(readResponse(resp).type).toBe(SSH_AGENT_FAILURE);
    expect(onSign).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "ecdsa_conversion_failed" }),
    );
  });
});

describe("findKey via string public key (toPublicSSH string branch)", () => {
  it("matches when the BaseAgent.sign pubKey is given as an OpenSSH string", () => {
    const k = parsePriv(fixtures.ed);
    const pubString = fs.readFileSync(path.join(tmpDir, "ed.pub"), "utf8");
    const agent = new InProcessAgent([k]);
    const cb = vi.fn();
    agent.sign(pubString as any, Buffer.from("payload"), cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBeNull();
    expect(Buffer.isBuffer(cb.mock.calls[0]![1])).toBe(true);
  });

  it("returns an error for an unparseable string pubKey", () => {
    const k = parsePriv(fixtures.ed);
    const agent = new InProcessAgent([k]);
    const cb = vi.fn();
    agent.sign("garbage" as any, Buffer.from("x"), cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe("SignOutcome typing sanity", () => {
  it("constructs the expected shape", () => {
    const ok: SignOutcome = {
      keyType: "ssh-ed25519",
      failureReason: null,
      signatureFormat: "ssh-ed25519",
    };
    const bad: SignOutcome = { keyType: null, failureReason: "no_matching_key" };
    expect(ok.failureReason).toBeNull();
    expect(bad.signatureFormat).toBeUndefined();
  });
});
