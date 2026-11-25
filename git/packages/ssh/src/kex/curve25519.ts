/**
 * `curve25519-sha256` (RFC 8731): an X25519 exchange with a fresh key for
 * every connection.
 */
import { isAllZero, source } from "../bytes";
import { DisconnectReason, SshError } from "../errors";
import { WireWriter } from "../wire";
import type { KexMethod } from "./method";

export const X25519_KEY_LENGTH = 32;

function invalidKey(): SshError {
  return new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "invalid key exchange public key");
}

/** One side of an X25519 exchange: a fresh public key and the secret shared with `peerPublic`. */
export async function x25519(
  peerPublic: Uint8Array,
): Promise<{ publicKey: Uint8Array; secret: Uint8Array }> {
  if (peerPublic.length !== X25519_KEY_LENGTH) throw invalidKey();
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  let secret: Uint8Array;
  try {
    const peer = await crypto.subtle.importKey(
      "raw",
      source(peerPublic),
      { name: "X25519" },
      false,
      [],
    );
    secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: peer }, pair.privateKey, 256),
    );
  } catch {
    throw invalidKey();
  }
  // A low-order point makes the secret zero whatever the server's key is, so
  // the client would not have had to contribute anything. RFC 8731 requires
  // the check; some WebCrypto implementations also refuse on their own.
  if (isAllZero(secret)) throw invalidKey();
  return { publicKey, secret };
}

export const curve25519Sha256: KexMethod = {
  names: ["curve25519-sha256", "curve25519-sha256@libssh.org"],
  async respond(clientInit) {
    const { publicKey, secret } = await x25519(clientInit);
    // K is the 32 bytes read as a big-endian integer, in mpint form.
    const encodedSecret = new WireWriter().mpint(secret).finish();
    secret.fill(0);
    return { reply: publicKey, encodedSecret };
  },
};
