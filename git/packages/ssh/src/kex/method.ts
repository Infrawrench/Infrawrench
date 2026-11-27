/**
 * What the transport needs from a key exchange method, and the two pieces
 * every method shares: the exchange hash and key derivation (RFC 4253,
 * sections 7.2 and 8). Both methods here hash with SHA-256.
 */
import { concat, source } from "../bytes";
import { WireWriter } from "../wire";

export interface KexResult {
  /** The server's value for the reply message: Q_S, or S_REPLY for a hybrid method. */
  readonly reply: Uint8Array;
  /**
   * The shared secret K in the encoding its method puts into the exchange
   * hash and the key derivation: an mpint for curve25519-sha256, a string
   * for the hybrid method. Secret.
   */
  readonly encodedSecret: Uint8Array;
}

export interface KexMethod {
  /** The names this method is negotiated under. */
  readonly names: readonly string[];
  /** The server's side of the exchange, given the value from the client's init message. */
  respond(clientInit: Uint8Array): Promise<KexResult>;
}

export interface ExchangeHashInput {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly clientKexInit: Uint8Array;
  readonly serverKexInit: Uint8Array;
  readonly hostKeyBlob: Uint8Array;
  readonly clientInit: Uint8Array;
  readonly serverReply: Uint8Array;
  readonly encodedSecret: Uint8Array;
}

/** H: the hash the host key signs, and the session id when it is the first one. */
export async function exchangeHash(input: ExchangeHashInput): Promise<Uint8Array> {
  const data = new WireWriter()
    .string(input.clientVersion)
    .string(input.serverVersion)
    .string(input.clientKexInit)
    .string(input.serverKexInit)
    .string(input.hostKeyBlob)
    .string(input.clientInit)
    .string(input.serverReply)
    .raw(input.encodedSecret)
    .finish();
  return new Uint8Array(await crypto.subtle.digest("SHA-256", source(data)));
}

/**
 * Key material for one purpose: `letter` is "A" to "F". The hash is extended
 * with itself until there are `length` bytes.
 */
export async function deriveKey(
  encodedSecret: Uint8Array,
  hash: Uint8Array,
  sessionId: Uint8Array,
  letter: string,
  length: number,
): Promise<Uint8Array> {
  const prefix = concat([encodedSecret, hash]);
  const digest = async (tail: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", source(concat([prefix, tail]))));

  let material: Uint8Array = await digest(concat([Uint8Array.of(letter.charCodeAt(0)), sessionId]));
  while (material.length < length) {
    material = concat([material, await digest(material)]);
  }
  return material.subarray(0, length);
}
