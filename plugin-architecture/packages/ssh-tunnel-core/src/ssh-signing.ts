/**
 * SSH signature algorithm vocabulary and the private-key signing primitive
 * behind the cloud "SSH agent" endpoint.
 *
 * A client that cannot hold the private key (the desktop app using an
 * org-managed cloud key) names one of these algorithms and sends the exact
 * bytes SSH wants signed; the server holding the key answers with the raw
 * signature `ParsedKey.sign` produces — Ed25519/RSA bytes as-is, ECDSA in
 * DER. Raw is the right wire form because both consumers already normalise
 * it: ssh2's `authPK` runs agent signatures through `convertSignature`, and
 * the agent-protocol path (`RemoteKeyAgent`) converts DER ECDSA to the SSH
 * two-mpint form itself.
 */
// ssh2 is CJS with lazy getter exports; when it stays external to the server
// bundles, node's ESM interop can't see its named exports. Default-import +
// destructure works everywhere (dev tsx, bundled, external).
import ssh2 from "ssh2";

const { utils } = ssh2;
const { parseKey } = utils;

/** SSH signature format identifiers the signing endpoint accepts. */
export const SSH_SIGN_ALGORITHMS = [
  "ssh-ed25519",
  "ssh-rsa",
  "rsa-sha2-256",
  "rsa-sha2-512",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
] as const;

export type SshSignAlgorithm = (typeof SSH_SIGN_ALGORITHMS)[number];

export function isSshSignAlgorithm(value: string): value is SshSignAlgorithm {
  return (SSH_SIGN_ALGORITHMS as readonly string[]).includes(value);
}

/** The key type a signature algorithm belongs to. */
export function keyTypeForAlgorithm(algorithm: SshSignAlgorithm): string {
  switch (algorithm) {
    case "ssh-rsa":
    case "rsa-sha2-256":
    case "rsa-sha2-512":
      return "ssh-rsa";
    default:
      return algorithm;
  }
}

/**
 * The signature algorithm to request for a key, given the hash ssh2 asks for
 * during publickey auth (`options.hash` in `BaseAgent.sign` — set only for
 * RSA, where the negotiated `rsa-sha2-*` algorithm decides it).
 */
export function signatureAlgorithmFor(
  keyType: string,
  hash?: string | undefined,
): SshSignAlgorithm | null {
  switch (keyType) {
    case "ssh-ed25519":
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
      return keyType;
    case "ssh-rsa":
      if (hash === "sha512") return "rsa-sha2-512";
      if (hash === "sha256") return "rsa-sha2-256";
      return "ssh-rsa";
    default:
      return null;
  }
}

/**
 * Sign `data` with a PEM private key, producing the raw signature for
 * `algorithm`. Throws on an unparseable key, a key/algorithm mismatch, or a
 * signing failure — the caller turns those into HTTP 400s.
 *
 * The hash is passed explicitly only for the RSA variants; Ed25519 and ECDSA
 * ignore a caller-supplied hash in favour of the one their key implies, which
 * ssh2 fills in when none is given.
 */
export function signSshData(
  privateKeyPem: string,
  data: Buffer,
  algorithm: SshSignAlgorithm,
): Buffer {
  const parsed = parseKey(privateKeyPem);
  if (parsed instanceof Error) {
    throw new Error(`Private key is unparseable: ${parsed.message}`);
  }
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  const key = keys.find((k) => k.isPrivateKey());
  if (!key) throw new Error("No private key present");

  if (key.type !== keyTypeForAlgorithm(algorithm)) {
    throw new Error(`Key type ${key.type} cannot produce a ${algorithm} signature`);
  }

  let hash: "sha1" | "sha256" | "sha512" | undefined;
  if (algorithm === "rsa-sha2-256") hash = "sha256";
  else if (algorithm === "rsa-sha2-512") hash = "sha512";
  else if (algorithm === "ssh-rsa") hash = "sha1";

  let result: unknown;
  try {
    // ssh2's ParsedKey.sign is typed as returning Buffer but actually
    // returns `Buffer | Error` — guard explicitly.
    result = key.sign(data, hash);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (result instanceof Error) throw result;
  if (!Buffer.isBuffer(result)) throw new Error(`Unexpected sign() return: ${typeof result}`);
  return result;
}
