/**
 * `curve25519-sha256` (RFC 8731): an X25519 exchange, the hash that binds it
 * to everything both sides said, and the keys derived from the result.
 */
import { concat, isAllZero, source } from "../bytes";
import { DisconnectReason, SshError } from "../errors";
import { WireWriter } from "../wire";

export interface Exchange {
  /** The server's ephemeral public key, Q_S. */
  readonly serverPublic: Uint8Array;
  /** The shared secret K, as the magnitude of the integer the RFC makes of it. */
  readonly secret: Uint8Array;
}

/** One side of an X25519 exchange with a fresh ephemeral key. */
export async function exchange(clientPublic: Uint8Array): Promise<Exchange> {
  if (clientPublic.length !== 32) {
    throw new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "invalid key exchange public key");
  }
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  let secret: Uint8Array;
  try {
    const peer = await crypto.subtle.importKey(
      "raw",
      source(clientPublic),
      { name: "X25519" },
      false,
      [],
    );
    secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: peer }, pair.privateKey, 256),
    );
  } catch {
    throw new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "invalid key exchange public key");
  }
  // A low-order point makes the secret zero whatever the server's key is, so
  // the client would not have had to contribute anything. RFC 8731 requires
  // the check; some WebCrypto implementations also refuse on their own.
  if (isAllZero(secret)) {
    throw new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "invalid key exchange public key");
  }
  return { serverPublic, secret };
}

export interface ExchangeHashInput {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly clientKexInit: Uint8Array;
  readonly serverKexInit: Uint8Array;
  readonly hostKeyBlob: Uint8Array;
  readonly clientPublic: Uint8Array;
  readonly serverPublic: Uint8Array;
  readonly secret: Uint8Array;
}

/** H: the hash the host key signs, and the session id when it is the first one. */
export async function exchangeHash(input: ExchangeHashInput): Promise<Uint8Array> {
  const data = new WireWriter()
    .string(input.clientVersion)
    .string(input.serverVersion)
    .string(input.clientKexInit)
    .string(input.serverKexInit)
    .string(input.hostKeyBlob)
    .string(input.clientPublic)
    .string(input.serverPublic)
    .mpint(input.secret)
    .finish();
  return new Uint8Array(await crypto.subtle.digest("SHA-256", source(data)));
}

/**
 * Key material for one purpose (RFC 4253, section 7.2): `letter` is "A" to
 * "F". The hash is extended with itself until there are `length` bytes.
 */
export async function deriveKey(
  secret: Uint8Array,
  hash: Uint8Array,
  sessionId: Uint8Array,
  letter: string,
  length: number,
): Promise<Uint8Array> {
  const prefix = new WireWriter().mpint(secret).raw(hash).finish();
  const digest = async (tail: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", source(concat([prefix, tail]))));

  let material: Uint8Array = await digest(concat([Uint8Array.of(letter.charCodeAt(0)), sessionId]));
  while (material.length < length) {
    material = concat([material, await digest(material)]);
  }
  return material.subarray(0, length);
}
