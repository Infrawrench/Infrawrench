/**
 * SSH agent whose private key lives somewhere else.
 *
 * The desktop app uses this for org-managed cloud SSH keys: the private half
 * never leaves Infrawrench Cloud, so the agent answers ssh2's publickey auth
 * (and, when forwarded, the OpenSSH agent protocol) by sending each
 * to-be-signed blob to a backend — an HTTPS signing endpoint — and relaying
 * the signature. The SSH connection itself stays wherever the caller opened
 * it; only signatures cross the network.
 *
 * Mirrors `InProcessAgent` (same framing via `agent-wire.ts`, same
 * `SignOutcome` hook) with the one structural difference that every sign is
 * asynchronous, which `makeAgentStream` accommodates by chaining replies in
 * request order.
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
import type { InProcessAgentOptions, SignOutcome } from "./in-process-agent.js";
import { signatureAlgorithmFor, type SshSignAlgorithm } from "./ssh-signing.js";

const { BaseAgent, utils } = ssh2;
const { parseKey } = utils;

/** What a `RemoteKeyAgent` needs from whoever actually holds the key. */
export interface RemoteKeyBackend {
  /** The key's OpenSSH-format public line (`ssh-ed25519 AAAA… comment`). */
  fetchPublicKey(): Promise<string>;
  /**
   * Sign `data`, producing the raw signature for `algorithm` (the bytes
   * `ParsedKey.sign` returns — ECDSA still DER; the agent converts where the
   * agent protocol requires the SSH form). Rejections surface as auth
   * failures, so their messages should already be user-readable.
   */
  sign(data: Buffer, algorithm: SshSignAlgorithm): Promise<Buffer>;
}

export class RemoteKeyAgent extends BaseAgent<ParsedKey> {
  private keyPromise: Promise<ParsedKey> | undefined;

  constructor(
    private readonly backend: RemoteKeyBackend,
    private readonly opts: InProcessAgentOptions = {},
  ) {
    super();
  }

  /** Fetch-and-parse once; a failed fetch is retried on the next request. */
  private key(): Promise<ParsedKey> {
    this.keyPromise ??= this.backend.fetchPublicKey().then((pub) => {
      const parsed = parseKey(pub);
      if (parsed instanceof Error) {
        throw new Error(`Remote SSH key is unparseable: ${parsed.message}`);
      }
      const key = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!key) throw new Error("Remote SSH key is empty");
      return key;
    });
    this.keyPromise.catch(() => {
      this.keyPromise = undefined;
    });
    return this.keyPromise;
  }

  override getIdentities(cb: IdentityCallback<ParsedKey>): void {
    this.key().then(
      (key) => cb(undefined, [key]),
      (err: Error) => cb(err),
    );
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

    void (async () => {
      let keyType: string | null = null;
      try {
        const key = await this.key();
        keyType = key.type;
        const wanted = toPublicSSH(pubKey);
        if (!wanted || !key.getPublicSSH().equals(wanted)) {
          throw new Error("No matching key in Infrawrench remote agent");
        }
        const algorithm = signatureAlgorithmFor(key.type, options.hash);
        if (!algorithm) throw new Error(`Unsupported key type ${key.type}`);
        const sig = await this.backend.sign(data, algorithm);
        this.reportSign({ keyType, failureReason: null, signatureFormat: algorithm });
        callback(null, sig);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.reportSign({ keyType, failureReason: `sign_error:${err.message}` });
        callback(err);
      }
    })();
  }

  getStream(cb: GetStreamCallback): void {
    const handler = (type: number, body: Buffer): Promise<Buffer> => this.handleMessage(type, body);
    cb(null, makeAgentStream(handler));
  }

  private async handleMessage(type: number, body: Buffer): Promise<Buffer> {
    if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      try {
        return buildIdentitiesAnswer([await this.key()]);
      } catch (e) {
        console.error(`[remote-key-agent] REQUEST_IDENTITIES failed: ${(e as Error).message}`);
        return failureFrame();
      }
    }
    if (type === SSH_AGENTC_SIGN_REQUEST) {
      return (await this.handleSign(body)) ?? failureFrame();
    }
    // Unknown opcode (e.g. SSH_AGENTC_EXTENSION for session-bind) — fail
    // explicitly but still consume the body (caller already skipped it).
    return failureFrame();
  }

  private async handleSign(body: Buffer): Promise<Buffer | null> {
    let keyBlob: Buffer;
    let data: Buffer;
    let flags: number;
    try {
      const r = new BodyReader(body);
      keyBlob = r.readString();
      data = r.readString();
      flags = r.readUInt32();
    } catch (e) {
      console.error(`[remote-key-agent] SIGN_REQUEST malformed: ${(e as Error).message}`);
      this.reportSign({ keyType: null, failureReason: "malformed_request" });
      return null;
    }

    let key: ParsedKey;
    try {
      key = await this.key();
    } catch (e) {
      console.error(`[remote-key-agent] SIGN_REQUEST: key fetch failed: ${(e as Error).message}`);
      this.reportSign({ keyType: null, failureReason: "key_fetch_failed" });
      return null;
    }
    if (!key.getPublicSSH().equals(keyBlob)) {
      console.error("[remote-key-agent] SIGN_REQUEST: no matching key");
      this.reportSign({ keyType: null, failureReason: "no_matching_key" });
      return null;
    }

    const { formatId, kind } = resolveSignParams(key.type, flags);
    if (!formatId) {
      console.error(`[remote-key-agent] SIGN_REQUEST: unsupported key type ${key.type}`);
      this.reportSign({ keyType: key.type, failureReason: "unsupported_key_type" });
      return null;
    }

    let raw: Buffer;
    try {
      raw = await this.backend.sign(data, formatId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[remote-key-agent] SIGN_REQUEST failed: ${message}`);
      this.reportSign({ keyType: key.type, failureReason: `sign_error:${message}` });
      return null;
    }

    let sigBytes: Buffer;
    if (kind === "ecdsa") {
      const conv = derToSshEcdsa(raw);
      if (!conv) {
        console.error("[remote-key-agent] SIGN_REQUEST: ECDSA signature conversion failed");
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
      console.error("[remote-key-agent] onSign hook threw:", e);
    }
  }
}

/** Build a `RemoteKeyAgent` over a backend holding exactly one key. */
export function buildRemoteKeyAgent(
  backend: RemoteKeyBackend,
  options: InProcessAgentOptions = {},
): RemoteKeyAgent {
  return new RemoteKeyAgent(backend, options);
}
