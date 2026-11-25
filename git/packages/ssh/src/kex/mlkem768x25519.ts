/**
 * `mlkem768x25519-sha256` (draft-ietf-sshm-mlkem-hybrid-kex): ML-KEM-768 and
 * X25519 side by side, so the session stays secret unless both are broken.
 * It is what current OpenSSH prefers, and what stops it warning its user on
 * every connection that the key exchange is not post-quantum.
 *
 * ML-KEM comes from WebCrypto, where it is newer than everything else this
 * package uses: Node 24 has it, and Workers has it behind the
 * `webcrypto_modern_algorithms` compatibility flag. The method is offered
 * only where `mlkemAvailable` finds it working.
 */
import { concat, source } from "../bytes";
import { DisconnectReason, SshError } from "../errors";
import { WireWriter } from "../wire";
import { x25519, X25519_KEY_LENGTH } from "./curve25519";
import type { KexMethod } from "./method";

const MLKEM = { name: "ML-KEM-768" } as const;
const MLKEM_PUBLIC_KEY_LENGTH = 1184;

/** The parts of the Modern Algorithms WebCrypto API used here, which the DOM typings do not have yet. */
interface KemSubtle {
  generateKey(
    algorithm: typeof MLKEM,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKeyPair>;
  importKey(
    format: "raw-public",
    key: BufferSource,
    algorithm: typeof MLKEM,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>;
  encapsulateBits(
    algorithm: typeof MLKEM,
    key: CryptoKey,
  ): Promise<{ sharedKey: ArrayBuffer; ciphertext: ArrayBuffer }>;
}

const kem = (): KemSubtle => crypto.subtle as unknown as KemSubtle;

let available: Promise<boolean> | undefined;

/**
 * Whether this runtime can do ML-KEM-768 encapsulation. Found out by doing
 * one, once per isolate: a runtime may have the method names without the
 * algorithm behind them.
 */
export function mlkemAvailable(): Promise<boolean> {
  available ??= (async () => {
    try {
      if (typeof kem().encapsulateBits !== "function") return false;
      const pair = await kem().generateKey(MLKEM, false, ["encapsulateBits", "decapsulateBits"]);
      const { sharedKey } = await kem().encapsulateBits(MLKEM, pair.publicKey);
      return sharedKey.byteLength === 32;
    } catch {
      return false;
    }
  })();
  return available;
}

function invalidKey(): SshError {
  return new SshError(DisconnectReason.KEY_EXCHANGE_FAILED, "invalid key exchange public key");
}

export const mlkem768x25519Sha256: KexMethod = {
  names: ["mlkem768x25519-sha256"],
  async respond(clientInit) {
    // C_INIT is the client's ML-KEM public key followed by its X25519 one.
    if (clientInit.length !== MLKEM_PUBLIC_KEY_LENGTH + X25519_KEY_LENGTH) throw invalidKey();
    let encapsulated: { sharedKey: ArrayBuffer; ciphertext: ArrayBuffer };
    try {
      // Importing checks the key is a well-formed ML-KEM encapsulation key.
      const peer = await kem().importKey(
        "raw-public",
        source(clientInit.subarray(0, MLKEM_PUBLIC_KEY_LENGTH)),
        MLKEM,
        false,
        ["encapsulateBits"],
      );
      encapsulated = await kem().encapsulateBits(MLKEM, peer);
    } catch {
      throw invalidKey();
    }
    const classical = await x25519(clientInit.subarray(MLKEM_PUBLIC_KEY_LENGTH));

    // K = SHA-256(K_PQ || K_CL), and unlike the classical methods it goes
    // into the exchange hash and the key derivation as a string.
    const combined = concat([new Uint8Array(encapsulated.sharedKey), classical.secret]);
    const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", source(combined)));
    combined.fill(0);
    classical.secret.fill(0);
    const encodedSecret = new WireWriter().string(secret).finish();
    secret.fill(0);

    // S_REPLY is the ML-KEM ciphertext followed by the server's X25519 public key.
    return {
      reply: concat([new Uint8Array(encapsulated.ciphertext), classical.publicKey]),
      encodedSecret,
    };
  },
};
