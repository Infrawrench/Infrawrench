/**
 * In-process SSH agent that talks the OpenSSH agent protocol from memory
 * using the user's existing private key, so agent forwarding works without
 * an OS-level ssh-agent / Pageant / 1Password running.
 *
 * Shared between `@infrawrench/desktop` (Electron main) and `@infrawrench/web`
 * (Hono server-side proxy). The forwarded surface area equals the single key
 * the user logged in with — nothing else is exposed to the remote host.
 *
 * The web side wires an optional `onSign` callback to push an audit log row
 * on every sign-request; the desktop side does not need that hook and passes
 * `undefined`. Keeping the audit policy out of this module lets the shared
 * core stay free of `db` / Postgres / org-scoped dependencies.
 *
 * The agent-protocol framing lives in `agent-wire.ts`, shared with
 * `RemoteKeyAgent` (same protocol, private key behind a signing callback).
 */
// ssh2 is CJS with lazy getter exports; when it stays external to the server
// bundles, node's ESM interop can't see its named exports. Default-import +
// destructure works everywhere (dev tsx, bundled, external).
import ssh2 from "ssh2";
import type {
  GetStreamCallback,
  IdentityCallback,
  ParsedKey,
  SignCallback,
  SigningRequestOptions,
} from "ssh2";

import {
  BodyReader,
  buildIdentitiesAnswer,
  buildSignResponse,
  derToSshEcdsa,
  failureFrame,
  makeAgentStream,
  resolveSignParams,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  toPublicSSH,
} from "./agent-wire.js";

const { BaseAgent, utils } = ssh2;
const { parseKey } = utils;

/**
 * Outcome of a single SIGN_REQUEST, surfaced via the optional `onSign` hook
 * so callers (web) can write an audit row. `signatureFormat` is the SSH
 * format identifier we replied with (e.g. `rsa-sha2-256`, `ssh-ed25519`).
 * `keyType` is the matched private key's type. Exactly one of
 * `failureReason` (non-null) or `signatureFormat` (non-null) is set.
 */
export interface SignOutcome {
  keyType: string | null;
  failureReason: string | null;
  signatureFormat?: string | undefined;
}

export interface InProcessAgentOptions {
  /**
   * Called once per SIGN_REQUEST after the response (or failure) has been
   * computed. Fire-and-forget — exceptions inside the callback are swallowed
   * so a misbehaving audit sink can't break SSH.
   */
  onSign?: (outcome: SignOutcome) => void;
}

export class InProcessAgent extends BaseAgent<ParsedKey> {
  constructor(
    private readonly keys: ParsedKey[],
    private readonly opts: InProcessAgentOptions = {},
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

  getStream(cb: GetStreamCallback): void {
    const handler = (type: number, body: Buffer): Buffer => this.handleMessage(type, body);
    cb(null, makeAgentStream(handler));
  }

  private handleMessage(type: number, body: Buffer): Buffer {
    if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      return buildIdentitiesAnswer(this.keys);
    }
    if (type === SSH_AGENTC_SIGN_REQUEST) {
      const resp = this.handleSign(body);
      return resp ?? failureFrame();
    }
    // Unknown opcode (e.g. SSH_AGENTC_EXTENSION for session-bind) — fail
    // explicitly but still consume the body (caller already skipped it).
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
      this.reportSign({ keyType: null, failureReason: "malformed_request" });
      return null;
    }
    const key = this.findKey(keyBlob);
    if (!key) {
      console.error("[ssh-agent] SIGN_REQUEST: no matching key");
      this.reportSign({ keyType: null, failureReason: "no_matching_key" });
      return null;
    }

    const { formatId, hash, kind } = resolveSignParams(key.type, flags);
    if (!formatId) {
      console.error(`[ssh-agent] SIGN_REQUEST: unsupported key type ${key.type}`);
      this.reportSign({ keyType: key.type, failureReason: "unsupported_key_type" });
      return null;
    }
    const raw = signRaw(key, data, hash);
    if (raw instanceof Error) {
      console.error(`[ssh-agent] SIGN_REQUEST failed: ${raw.message}`);
      this.reportSign({ keyType: key.type, failureReason: `sign_error:${raw.message}` });
      return null;
    }

    let sigBytes: Buffer;
    if (kind === "ecdsa") {
      const conv = derToSshEcdsa(raw);
      if (!conv) {
        console.error("[ssh-agent] SIGN_REQUEST: ECDSA signature conversion failed");
        this.reportSign({ keyType: key.type, failureReason: "ecdsa_conversion_failed" });
        return null;
      }
      sigBytes = conv;
    } else {
      sigBytes = raw;
    }

    this.reportSign({ keyType: key.type, failureReason: null, signatureFormat: formatId });
    return buildSignResponse(formatId, sigBytes);
  }

  private reportSign(outcome: SignOutcome): void {
    const cb = this.opts.onSign;
    if (!cb) return;
    try {
      cb(outcome);
    } catch (e) {
      console.error("[ssh-agent] onSign hook threw:", e);
    }
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

/**
 * Parse an OpenSSH-formatted PEM private key (or list of keys) and build an
 * `InProcessAgent` over the usable private entries. Returns `null` when the
 * input is empty, unparseable, or contains no private keys.
 */
export function buildInProcessAgent(
  privateKeyPem: string,
  options: InProcessAgentOptions = {},
): InProcessAgent | null {
  if (!privateKeyPem || !privateKeyPem.trim()) return null;
  const parsed = parseKey(privateKeyPem);
  if (parsed instanceof Error) return null;
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  const usable = keys.filter((k) => k.isPrivateKey());
  if (usable.length === 0) return null;
  return new InProcessAgent(usable, options);
}

function signRaw(
  key: ParsedKey,
  data: Buffer,
  hash: SigningRequestOptions["hash"],
): Buffer | Error {
  let result: unknown;
  try {
    // ssh2's ParsedKey.sign is typed as returning Buffer but actually
    // returns `Buffer | Error` — guard explicitly.
    result = key.sign(data, hash);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  if (result instanceof Error) return result;
  if (!Buffer.isBuffer(result)) return new Error(`Unexpected sign() return: ${typeof result}`);
  return result;
}
