import { Duplex } from "node:stream";
import {
  BaseAgent,
  utils,
  type GetStreamCallback,
  type IdentityCallback,
  type ParsedKey,
  type SignCallback,
  type SigningRequestOptions,
} from "ssh2";
import { logAudit } from "@/services/audit";

const { parseKey } = utils;

// Context recorded on every forwarded sign-request so users can see exactly
// which key the cloud proxy used to authenticate on their behalf. Optional —
// when omitted, the agent skips audit writes (used by tests / non-cloud paths).
export interface AgentAuditContext {
  organizationId: string;
  userId?: string | undefined;
  accountId: string;
  resourceId?: string | undefined;
  sshKeyId: string;
  sshHost: string;
  sshUsername: string;
}

// SSH agent protocol message types (draft-miller-ssh-agent).
const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

const SSH_AGENT_RSA_SHA2_256 = 1 << 1;
const SSH_AGENT_RSA_SHA2_512 = 1 << 2;

// Mirror of the desktop in-process agent. Kept duplicated because only
// @infrawrench/web depends on ssh2 server-side; hoist into server-core if a
// third caller appears.
class InProcessAgent extends BaseAgent<ParsedKey> {
  constructor(
    private readonly keys: ParsedKey[],
    private readonly audit?: AgentAuditContext,
  ) {
    super();
  }

  get keyCount(): number {
    return this.keys.length;
  }

  override getIdentities(cb: IdentityCallback<ParsedKey>): void {
    cb(undefined, this.keys);
  }

  override sign(
    pubKey: ParsedKey,
    data: Buffer,
    optionsOrCb: SigningRequestOptions | SignCallback,
    cb?: SignCallback,
  ): void {
    const callback: SignCallback | undefined = typeof optionsOrCb === "function" ? optionsOrCb : cb;
    const options: SigningRequestOptions =
      typeof optionsOrCb === "object" && optionsOrCb !== null ? optionsOrCb : {};
    if (!callback) return;
    const key = this.findKey(pubKey);
    if (!key) return callback(new Error("No matching key in Infrawrench agent"));
    const sig = signRaw(key, data, options.hash);
    if (sig instanceof Error) return callback(sig);
    callback(null, sig);
  }

  // Hand-rolled framing — ssh2's AgentProtocol server mode replies with
  // FAILURE for unknown opcodes but doesn't advance past their body, so a
  // `session-bind@openssh.com` request from modern OpenSSH (sent before
  // REQUEST_IDENTITIES on forwarded agent connections) corrupts the stream.
  getStream(cb: GetStreamCallback): void {
    const handler = (type: number, body: Buffer): Buffer => this.handleMessage(type, body);
    cb(null, makeAgentStream(handler));
  }

  private handleMessage(type: number, body: Buffer): Buffer {
    if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      console.log(`[ssh-agent] REQUEST_IDENTITIES → ${this.keys.length} key(s)`);
      return buildIdentitiesAnswer(this.keys);
    }
    if (type === SSH_AGENTC_SIGN_REQUEST) {
      const resp = this.handleSign(body);
      return resp ?? failureFrame();
    }
    return failureFrame();
  }

  private handleSign(body: Buffer): Buffer | null {
    let keyBlob: Buffer;
    let data: Buffer;
    let flags: number;
    try {
      const r = new BodyReader(body);
      keyBlob = r.readString();
      data = r.readString();
      flags = r.readUInt32();
    } catch (e) {
      console.error(`[ssh-agent] SIGN_REQUEST malformed: ${(e as Error).message}`);
      this.auditSign(null, "malformed_request");
      return null;
    }
    const key = this.findKey(keyBlob);
    if (!key) {
      console.error("[ssh-agent] SIGN_REQUEST: no matching key");
      this.auditSign(null, "no_matching_key");
      return null;
    }

    const { formatId, hash, kind } = resolveSignParams(key.type, flags);
    if (!formatId) {
      console.error(`[ssh-agent] SIGN_REQUEST: unsupported key type ${key.type}`);
      this.auditSign(key.type, "unsupported_key_type");
      return null;
    }
    const raw = signRaw(key, data, hash);
    if (raw instanceof Error) {
      console.error(`[ssh-agent] SIGN_REQUEST failed: ${raw.message}`);
      this.auditSign(key.type, `sign_error:${raw.message}`);
      return null;
    }

    let sigBytes: Buffer;
    if (kind === "ecdsa") {
      const conv = derToSshEcdsa(raw);
      if (!conv) {
        console.error("[ssh-agent] SIGN_REQUEST: ECDSA signature conversion failed");
        this.auditSign(key.type, "ecdsa_conversion_failed");
        return null;
      }
      sigBytes = conv;
    } else {
      sigBytes = raw;
    }

    const blob = Buffer.concat([sshString(Buffer.from(formatId, "utf8")), sshString(sigBytes)]);
    const payload = Buffer.concat([Buffer.from([SSH_AGENT_SIGN_RESPONSE]), sshString(blob)]);
    console.log(`[ssh-agent] SIGN_REQUEST → ${formatId} (${sigBytes.length} bytes)`);
    this.auditSign(key.type, null, formatId);
    return frame(payload);
  }

  private auditSign(keyType: string | null, failureReason: string | null, formatId?: string): void {
    if (!this.audit) return;
    const audit = this.audit;
    void logAudit({
      organizationId: audit.organizationId,
      userId: audit.userId,
      action: failureReason ? "ssh.agent.sign_failed" : "ssh.agent.sign",
      entityType: "ssh-session",
      entityId: audit.accountId,
      metadata: {
        sshKeyId: audit.sshKeyId,
        sshHost: audit.sshHost,
        sshUsername: audit.sshUsername,
        ...(audit.resourceId ? { resourceId: audit.resourceId } : {}),
        ...(keyType ? { keyType } : {}),
        ...(formatId ? { signatureFormat: formatId } : {}),
        ...(failureReason ? { failureReason } : {}),
      },
    });
  }

  private findKey(pubKey: ParsedKey | Buffer | string): ParsedKey | null {
    const wanted = toPublicSSH(pubKey);
    if (!wanted) return null;
    for (const k of this.keys) {
      if (k.getPublicSSH().equals(wanted)) return k;
    }
    return null;
  }
}

function toPublicSSH(pubKey: ParsedKey | Buffer | string): Buffer | null {
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

export function buildInProcessAgent(
  privateKeyPem: string,
  audit?: AgentAuditContext,
): InProcessAgent | null {
  if (!privateKeyPem || !privateKeyPem.trim()) return null;
  const parsed = parseKey(privateKeyPem);
  if (parsed instanceof Error) return null;
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  const usable = keys.filter((k) => k.isPrivateKey());
  if (usable.length === 0) return null;
  return new InProcessAgent(usable, audit);
}

function signRaw(
  key: ParsedKey,
  data: Buffer,
  hash: SigningRequestOptions["hash"],
): Buffer | Error {
  let result: unknown;
  try {
    result = key.sign(data, hash);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  if (result instanceof Error) return result;
  if (!Buffer.isBuffer(result)) return new Error(`Unexpected sign() return: ${typeof result}`);
  return result;
}

interface SignParams {
  formatId: string | null;
  hash: SigningRequestOptions["hash"];
  kind: "ed25519" | "rsa" | "ecdsa" | null;
}

function resolveSignParams(keyType: string, flags: number): SignParams {
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

function makeAgentStream(handler: (type: number, body: Buffer) => Buffer): Duplex {
  let buffer: Buffer = Buffer.alloc(0);
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
        stream.push(handler(msgType, body));
        buffer = buffer.subarray(4 + msgLen);
      }
      done();
    },
  });
  return stream;
}

function buildIdentitiesAnswer(keys: readonly ParsedKey[]): Buffer {
  const parts: Buffer[] = [uint32(keys.length)];
  for (const k of keys) {
    parts.push(sshString(k.getPublicSSH()));
    parts.push(sshString(Buffer.from(k.comment || "", "utf8")));
  }
  const payload = Buffer.concat([Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]), ...parts]);
  return frame(payload);
}

function failureFrame(): Buffer {
  return frame(Buffer.from([SSH_AGENT_FAILURE]));
}

function frame(payload: Buffer): Buffer {
  return Buffer.concat([uint32(payload.length), payload]);
}

function uint32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

function sshString(data: Buffer): Buffer {
  return Buffer.concat([uint32(data.length), data]);
}

class BodyReader {
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

// Node returns ECDSA signatures DER-encoded; SSH expects two mpints.
function derToSshEcdsa(der: Buffer): Buffer | null {
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
