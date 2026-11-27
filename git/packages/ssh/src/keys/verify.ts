/**
 * Checking a signature made by a user's key, with WebCrypto doing the
 * mathematics.
 */
import { source, toBase64Url } from "../bytes";
import { WireReader } from "../wire";
import type { DecodedPublicKey } from "./public";

/**
 * Signature algorithms a client may authenticate with, in the order they are
 * advertised in `server-sig-algs`. `ssh-rsa` is absent on purpose: it is RSA
 * with SHA-1, and SHA-1 collisions are practical.
 */
export const SIGNATURE_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
] as const;

export type SignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

export function isSignatureAlgorithm(name: string): name is SignatureAlgorithm {
  return (SIGNATURE_ALGORITHMS as readonly string[]).includes(name);
}

/** Whether a key of this type can produce signatures of this algorithm. */
export function algorithmFitsKey(algorithm: SignatureAlgorithm, key: DecodedPublicKey): boolean {
  if (algorithm === "rsa-sha2-256" || algorithm === "rsa-sha2-512") return key.type === "ssh-rsa";
  return algorithm === key.type;
}

/** Rejects when WebCrypto refuses the key, for instance an EC point that is not on its curve. */
export async function importVerifyKey(
  key: DecodedPublicKey,
  algorithm: SignatureAlgorithm,
): Promise<CryptoKey> {
  switch (key.type) {
    case "ssh-ed25519":
      return crypto.subtle.importKey("raw", source(key.point), { name: "Ed25519" }, false, [
        "verify",
      ]);
    case "ssh-rsa":
      // RSA has no raw format in WebCrypto; a JWK carries the two numbers.
      return crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: toBase64Url(key.modulus), e: toBase64Url(key.exponent), ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: algorithm === "rsa-sha2-256" ? "SHA-256" : "SHA-512" },
        false,
        ["verify"],
      );
    default:
      return crypto.subtle.importKey(
        "raw",
        source(key.point),
        { name: "ECDSA", namedCurve: key.curve.webCrypto },
        false,
        ["verify"],
      );
  }
}

function leftPad(value: Uint8Array, length: number): Uint8Array | null {
  if (value.length > length) return null;
  const out = new Uint8Array(length);
  out.set(value, length - value.length);
  return out;
}

/**
 * The signature bytes WebCrypto expects, from an SSH signature blob
 * (`string algorithm, string signature`), or null when the blob is malformed
 * or names a different algorithm than the request did.
 */
function rawSignature(
  key: DecodedPublicKey,
  algorithm: SignatureAlgorithm,
  blob: Uint8Array,
): Uint8Array | null {
  const reader = new WireReader(blob);
  const name = reader.text();
  const signature = reader.string();
  reader.end();
  // The name inside the signature decides the hash for RSA, so it has to be
  // the algorithm that was asked for; otherwise a client could ask for
  // rsa-sha2-512 and sign with something weaker.
  if (name !== algorithm) return null;

  switch (key.type) {
    case "ssh-ed25519":
      return signature.length === 64 ? signature : null;
    case "ssh-rsa":
      // Some implementations drop leading zero bytes; PKCS#1 wants the modulus length.
      return leftPad(signature, key.modulus.length);
    default: {
      // SSH sends r and s as two mpints; WebCrypto wants them fixed-width, side by side.
      const inner = new WireReader(signature);
      const r = leftPad(inner.mpint(), key.curve.size);
      const s = leftPad(inner.mpint(), key.curve.size);
      inner.end();
      if (!r || !s) return null;
      const out = new Uint8Array(key.curve.size * 2);
      out.set(r, 0);
      out.set(s, key.curve.size);
      return out;
    }
  }
}

/**
 * Whether `signatureBlob` is `key`'s signature over `data` under `algorithm`.
 * Never throws: anything malformed is simply not a valid signature.
 */
export async function verifySignature(
  key: DecodedPublicKey,
  algorithm: SignatureAlgorithm,
  signatureBlob: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (!algorithmFitsKey(algorithm, key)) return false;
  try {
    const signature = rawSignature(key, algorithm, signatureBlob);
    if (!signature) return false;
    const cryptoKey = await importVerifyKey(key, algorithm);
    const params: AlgorithmIdentifier | EcdsaParams =
      key.type === "ssh-ed25519"
        ? { name: "Ed25519" }
        : key.type === "ssh-rsa"
          ? { name: "RSASSA-PKCS1-v1_5" }
          : { name: "ECDSA", hash: key.curve.hash };
    return await crypto.subtle.verify(params, cryptoKey, source(signature), source(data));
  } catch {
    return false;
  }
}
