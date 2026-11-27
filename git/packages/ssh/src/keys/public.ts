/**
 * Public keys: decoding the wire blob and the SHA-256 fingerprint.
 */
import { sha256, toBase64 } from "../bytes";
import { WireReader } from "../wire";

export type KeyType =
  "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" | "ssh-rsa";

export const KEY_TYPES: readonly KeyType[] = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
];

/** RSA moduli below this are refused: 1024-bit keys are within reach of a well-funded attacker. */
export const MIN_RSA_BITS = 2048;
/** And above this, so one authentication attempt cannot buy seconds of CPU. */
export const MAX_RSA_BITS = 8192;

export interface EcdsaCurve {
  readonly name: "nistp256" | "nistp384" | "nistp521";
  readonly webCrypto: "P-256" | "P-384" | "P-521";
  readonly hash: "SHA-256" | "SHA-384" | "SHA-512";
  /** Bytes in one coordinate, and in each half of a signature. */
  readonly size: number;
}

export const ECDSA_CURVES: Readonly<Record<string, EcdsaCurve>> = {
  "ecdsa-sha2-nistp256": { name: "nistp256", webCrypto: "P-256", hash: "SHA-256", size: 32 },
  "ecdsa-sha2-nistp384": { name: "nistp384", webCrypto: "P-384", hash: "SHA-384", size: 48 },
  "ecdsa-sha2-nistp521": { name: "nistp521", webCrypto: "P-521", hash: "SHA-512", size: 66 },
};

/** A key as callers see it. */
export interface SshPublicKey {
  /**
   * The key type as it appears in `authorized_keys`: `ssh-ed25519`,
   * `ecdsa-sha2-nistp256`/`384`/`521` or `ssh-rsa`. For RSA this is the key
   * type, not the signature algorithm (`rsa-sha2-256`, `rsa-sha2-512`).
   */
  readonly algorithm: KeyType;
  /** The key blob as sent on the wire. */
  readonly blob: Uint8Array;
  /** `SHA256:...` as `ssh-keygen -lf` prints it. */
  readonly fingerprint: string;
}

/** A blob taken apart into what signature verification needs. */
export type DecodedPublicKey =
  | { readonly type: "ssh-ed25519"; readonly point: Uint8Array }
  | {
      readonly type: "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521";
      readonly curve: EcdsaCurve;
      /** Uncompressed: 0x04, x, y. */
      readonly point: Uint8Array;
    }
  | {
      readonly type: "ssh-rsa";
      /** Both big-endian with no leading zeros. */
      readonly exponent: Uint8Array;
      readonly modulus: Uint8Array;
    };

function bitLength(magnitude: Uint8Array): number {
  if (magnitude.length === 0) return 0;
  return (magnitude.length - 1) * 8 + (32 - Math.clz32(magnitude[0]!));
}

/**
 * Decode a public key blob, or null when it is malformed, of a type this
 * server does not take, or too weak. Structure only: whether an EC point is
 * on its curve is decided by WebCrypto when the key is imported to verify.
 */
export function decodePublicKey(blob: Uint8Array): DecodedPublicKey | null {
  try {
    const reader = new WireReader(blob);
    const type = reader.text();
    if (type === "ssh-ed25519") {
      const point = reader.string();
      reader.end();
      return point.length === 32 ? { type, point } : null;
    }
    if (
      type === "ecdsa-sha2-nistp256" ||
      type === "ecdsa-sha2-nistp384" ||
      type === "ecdsa-sha2-nistp521"
    ) {
      const curve = ECDSA_CURVES[type]!;
      const curveName = reader.text();
      const point = reader.string();
      reader.end();
      if (curveName !== curve.name) return null;
      if (point.length !== 1 + 2 * curve.size || point[0] !== 4) return null;
      return { type, curve, point };
    }
    if (type === "ssh-rsa") {
      const exponent = reader.mpint();
      const modulus = reader.mpint();
      reader.end();
      const bits = bitLength(modulus);
      if (bits < MIN_RSA_BITS || bits > MAX_RSA_BITS) return null;
      // An even or tiny exponent is never a real key; 65537 is what everything generates.
      if (exponent.length === 0 || exponent.length > 4) return null;
      if ((exponent[exponent.length - 1]! & 1) === 0) return null;
      if (exponent.length === 1 && exponent[0]! < 3) return null;
      if ((modulus[modulus.length - 1]! & 1) === 0) return null;
      return { type, exponent, modulus };
    }
    return null;
  } catch {
    return null;
  }
}

/** `SHA256:` and the unpadded base64 of the blob's SHA-256, the form `ssh-keygen -lf` prints. */
export async function fingerprintSha256(blob: Uint8Array): Promise<string> {
  return `SHA256:${toBase64(await sha256(blob)).replace(/=+$/, "")}`;
}

export async function describePublicKey(type: KeyType, blob: Uint8Array): Promise<SshPublicKey> {
  return { algorithm: type, blob, fingerprint: await fingerprintSha256(blob) };
}
