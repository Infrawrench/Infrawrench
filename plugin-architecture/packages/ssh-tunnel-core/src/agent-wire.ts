/**
 * OpenSSH agent-protocol wire helpers, shared by the two agents in this
 * package: `InProcessAgent` (private key in memory) and `RemoteKeyAgent`
 * (private key behind a signing callback, e.g. an HTTPS endpoint).
 *
 * The framing is hand-rolled — ssh2's AgentProtocol server mode replies with
 * FAILURE for unknown opcodes but doesn't advance past their body, so a
 * `session-bind@openssh.com` request from modern OpenSSH (sent before
 * REQUEST_IDENTITIES on forwarded agent connections) corrupts the stream
 * and the real REQUEST_IDENTITIES is interpreted as garbage.
 */
import { Duplex } from "node:stream";
// ssh2 is CJS with lazy getter exports; when it stays external to the server
// bundles, node's ESM interop can't see its named exports. Default-import +
// destructure works everywhere (dev tsx, bundled, external).
import ssh2 from "ssh2";
import type { ParsedKey, SigningRequestOptions } from "ssh2";

import type { SshSignAlgorithm } from "./ssh-signing.js";

const { utils } = ssh2;
const { parseKey } = utils;

// SSH agent protocol message types (draft-miller-ssh-agent).
export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_SIGN_RESPONSE = 14;

export const SSH_AGENT_RSA_SHA2_256 = 1 << 1;
export const SSH_AGENT_RSA_SHA2_512 = 1 << 2;

export interface SignParams {
  formatId: SshSignAlgorithm | null;
  hash: SigningRequestOptions["hash"];
  kind: "ed25519" | "rsa" | "ecdsa" | null;
}

export function resolveSignParams(keyType: string, flags: number): SignParams {
  switch (keyType) {
    case "ssh-ed25519":
      return { formatId: "ssh-ed25519", hash: undefined, kind: "ed25519" };
    case "ssh-rsa":
      if (flags & SSH_AGENT_RSA_SHA2_256)
        return { formatId: "rsa-sha2-256", hash: "sha256", kind: "rsa" };
      if (flags & SSH_AGENT_RSA_SHA2_512)
        return { formatId: "rsa-sha2-512", hash: "sha512", kind: "rsa" };
      return { formatId: "ssh-rsa", hash: "sha1", kind: "rsa" };
    case "ecdsa-sha2-nistp256":
      return { formatId: "ecdsa-sha2-nistp256", hash: "sha256", kind: "ecdsa" };
    case "ecdsa-sha2-nistp384":
      return { formatId: "ecdsa-sha2-nistp384", hash: "sha512", kind: "ecdsa" };
    case "ecdsa-sha2-nistp521":
      return { formatId: "ecdsa-sha2-nistp521", hash: "sha512", kind: "ecdsa" };
    default:
      return { formatId: null, hash: undefined, kind: null };
  }
}

/**
 * Frame a stream of agent messages into `handler(type, body)` calls and push
 * each reply back, preserving request order even when a handler is async —
 * a remote signer answers over the network while the next request may already
 * have arrived.
 */
export function makeAgentStream(
  handler: (type: number, body: Buffer) => Buffer | Promise<Buffer>,
): Duplex {
  let buffer: Buffer = Buffer.alloc(0);
  // Replies chain behind one another so an async handler cannot reorder them.
  let replies: Promise<void> = Promise.resolve();
  const stream = new Duplex({
    read() {
      /* push-driven from _write */
    },
    write(chunk: Buffer, _enc, done) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (msgLen < 1 || msgLen > 256 * 1024) {
          stream.destroy(new Error(`Malformed agent message length: ${msgLen}`));
          return;
        }
        if (buffer.length < 4 + msgLen) break;
        const msgType = buffer[4]!;
        const body = buffer.subarray(5, 4 + msgLen);
        const reply = handler(msgType, body);
        replies = replies
          .then(async () => {
            const bytes = await reply;
            if (!stream.destroyed) stream.push(bytes);
          })
          .catch((err: unknown) => {
            if (!stream.destroyed) {
              stream.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          });
        buffer = buffer.subarray(4 + msgLen);
      }
      done();
    },
  });
  return stream;
}

export function buildIdentitiesAnswer(keys: readonly ParsedKey[]): Buffer {
  const parts: Buffer[] = [uint32(keys.length)];
  for (const k of keys) {
    parts.push(sshString(k.getPublicSSH()));
    parts.push(sshString(Buffer.from(k.comment || "", "utf8")));
  }
  const payload = Buffer.concat([Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]), ...parts]);
  return frame(payload);
}

export function buildSignResponse(formatId: string, sigBytes: Buffer): Buffer {
  const blob = Buffer.concat([sshString(Buffer.from(formatId, "utf8")), sshString(sigBytes)]);
  const payload = Buffer.concat([Buffer.from([SSH_AGENT_SIGN_RESPONSE]), sshString(blob)]);
  return frame(payload);
}

export function failureFrame(): Buffer {
  return frame(Buffer.from([SSH_AGENT_FAILURE]));
}

export function frame(payload: Buffer): Buffer {
  return Buffer.concat([uint32(payload.length), payload]);
}

export function uint32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

export function sshString(data: Buffer): Buffer {
  return Buffer.concat([uint32(data.length), data]);
}

export class BodyReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  readUInt32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error("Truncated uint32");
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  readString(): Buffer {
    const len = this.readUInt32();
    if (this.pos + len > this.buf.length) throw new Error("Truncated string");
    const s = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

export function toPublicSSH(pubKey: ParsedKey | Buffer | string): Buffer | null {
  if (Buffer.isBuffer(pubKey)) return pubKey;
  if (typeof pubKey === "object" && pubKey !== null && "getPublicSSH" in pubKey) {
    return pubKey.getPublicSSH();
  }
  if (typeof pubKey === "string") {
    const parsed = parseKey(pubKey);
    if (!(parsed instanceof Error) && !Array.isArray(parsed)) return parsed.getPublicSSH();
  }
  return null;
}

// Node returns ECDSA signatures DER-encoded; SSH expects two mpints.
export function derToSshEcdsa(der: Buffer): Buffer | null {
  try {
    let p = 0;
    if (der[p++] !== 0x30) return null;
    p = skipDerLength(der, p).next;
    if (der[p++] !== 0x02) return null;
    let info = skipDerLength(der, p);
    const r = der.subarray(info.next, info.next + info.len);
    p = info.next + info.len;
    if (der[p++] !== 0x02) return null;
    info = skipDerLength(der, p);
    const s = der.subarray(info.next, info.next + info.len);
    return Buffer.concat([sshString(r), sshString(s)]);
  } catch {
    return null;
  }
}

function skipDerLength(der: Buffer, pos: number): { len: number; next: number } {
  let lenByte = der[pos++]!;
  if ((lenByte & 0x80) === 0) return { len: lenByte, next: pos };
  const nBytes = lenByte & 0x7f;
  let len = 0;
  for (let i = 0; i < nBytes; i++) len = (len << 8) | der[pos++]!;
  return { len, next: pos };
}
