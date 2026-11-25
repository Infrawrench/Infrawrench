/**
 * User authentication (RFC 4252): the `publickey` method and nothing else.
 *
 * A client first asks whether a key would be acceptable, without proving it
 * holds it, and then sends the same request with a signature over the
 * session id and the request. Who a key belongs to is the caller's business;
 * this module only establishes that the client holds it.
 */
import { DisconnectReason, SshError } from "./errors";
import { decodePublicKey, describePublicKey, type SshPublicKey } from "./keys/public";
import {
  algorithmFitsKey,
  isSignatureAlgorithm,
  verifySignature,
  type SignatureAlgorithm,
} from "./keys/verify";
import { Msg } from "./messages";
import type { PacketSink } from "./transport/transport";
import { WireReader, WireWriter } from "./wire";

/**
 * `query`: the client asked whether the key would be accepted and has proved
 * nothing. `verified`: the client has just proved it holds the key.
 */
export type AuthPhase = "query" | "verified";

export interface UserAuthOptions<Principal> {
  readonly sessionId: Uint8Array;
  readonly maxAttempts: number;
  authenticate(user: string, key: SshPublicKey, phase: AuthPhase): Promise<Principal | null>;
  onError(error: unknown): void;
}

/**
 * Requests of any kind before the connection is dropped, as a multiple of the
 * failure limit. Queries that are answered "yes" are not failures, so without
 * this a client could ask about its own key for ever.
 */
const REQUESTS_PER_ATTEMPT = 4;

export class UserAuth<Principal> {
  private failures = 0;
  private requests = 0;

  constructor(
    private readonly sink: PacketSink,
    private readonly options: UserAuthOptions<Principal>,
  ) {}

  /**
   * Handle one `SSH_MSG_USERAUTH_REQUEST`. Resolves with the principal once
   * the client is authenticated (success has been sent by then), null while
   * it is not.
   */
  async handle(payload: Uint8Array): Promise<{ principal: Principal } | null> {
    const reader = new WireReader(payload, 1);
    const user = reader.text();
    const service = reader.text();
    const method = reader.text();
    if (service !== "ssh-connection") {
      throw new SshError(DisconnectReason.SERVICE_NOT_AVAILABLE, "unknown service");
    }
    if (++this.requests > this.options.maxAttempts * REQUESTS_PER_ATTEMPT) {
      throw tooManyFailures();
    }

    if (method === "none") {
      // How a client asks which methods exist; every client opens with it,
      // so it is not held against the limit.
      await this.sendFailure();
      return null;
    }
    if (method !== "publickey") return this.fail();

    const hasSignature = reader.boolean();
    const algorithm = reader.text();
    const blob = reader.string();
    const signature = hasSignature ? reader.string() : null;
    reader.end();

    // `ssh-rsa` (RSA with SHA-1) and anything unknown stop here, before the
    // key is even looked at.
    if (!isSignatureAlgorithm(algorithm)) return this.fail();
    const decoded = decodePublicKey(blob);
    if (!decoded || !algorithmFitsKey(algorithm, decoded)) return this.fail();
    // A copy: the blob points into the packet, and the callback may keep the key.
    const key = await describePublicKey(decoded.type, blob.slice());

    if (!signature) {
      if ((await this.lookUp(user, key, "query")) === null) return this.fail();
      await this.sink.reply(
        new WireWriter().byte(Msg.USERAUTH_PK_OK).string(algorithm).string(key.blob).finish(),
      );
      return null;
    }

    // The signature is checked first: an unauthenticated client should not
    // be able to learn anything from the lookup, or cause one per packet,
    // without holding a key.
    const signed = signedData(this.options.sessionId, user, service, algorithm, key.blob);
    if (!(await verifySignature(decoded, algorithm, signature, signed))) return this.fail();
    const principal = await this.lookUp(user, key, "verified");
    if (principal === null) return this.fail();

    await this.sink.reply(Uint8Array.of(Msg.USERAUTH_SUCCESS));
    return { principal };
  }

  private async lookUp(user: string, key: SshPublicKey, phase: AuthPhase) {
    try {
      return await this.options.authenticate(user, key, phase);
    } catch (error) {
      // A lookup that breaks refuses the key. The client is told nothing more
      // than "no", and the host hears about it.
      this.options.onError(error);
      return null;
    }
  }

  private async fail(): Promise<null> {
    if (++this.failures >= this.options.maxAttempts) throw tooManyFailures();
    await this.sendFailure();
    return null;
  }

  private sendFailure(): Promise<void> {
    return this.sink.reply(
      new WireWriter().byte(Msg.USERAUTH_FAILURE).nameList(["publickey"]).boolean(false).finish(),
    );
  }
}

function tooManyFailures(): SshError {
  return new SshError(DisconnectReason.PROTOCOL_ERROR, "Too many authentication failures");
}

/** What a client signs to prove it holds a key (RFC 4252, section 7). */
function signedData(
  sessionId: Uint8Array,
  user: string,
  service: string,
  algorithm: SignatureAlgorithm,
  blob: Uint8Array,
): Uint8Array {
  return new WireWriter()
    .string(sessionId)
    .byte(Msg.USERAUTH_REQUEST)
    .string(user)
    .string(service)
    .string("publickey")
    .boolean(true)
    .string(algorithm)
    .string(blob)
    .finish();
}
