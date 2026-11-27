/**
 * SSH public keys as people paste them: reading a `.pub` line, and the
 * fingerprint a key is stored and looked up by.
 */
import { fromBase64, fromUtf8, sha256, toBase64 } from "./encoding";

/**
 * The key types accepted for Git. `ssh-dss` is left out (broken), and the
 * `sk-` hardware-backed types wait for the SSH server to verify them.
 */
export const SSH_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
] as const;
export type SshKeyAlgorithm = (typeof SSH_KEY_ALGORITHMS)[number];

/** RSA keys shorter than this are refused. */
export const MIN_RSA_BITS = 2048;

export interface ParsedPublicKey {
  readonly algorithm: SshKeyAlgorithm;
  /** The key blob, as SSH sends it on the wire. */
  readonly blob: Uint8Array<ArrayBuffer>;
  /** The blob in base64: the middle field of the line, and what is stored. */
  readonly publicKey: string;
  /** `SHA256:...`, as `ssh-keygen -lf` prints it. */
  readonly fingerprint: string;
  /** The line's trailing comment (`me@laptop`), or empty. */
  readonly comment: string;
}

export type PublicKeyProblem = "format" | "algorithm" | "mismatch" | "weak";

/** `SHA256:` and the unpadded base64 of the blob's SHA-256. */
export const sshFingerprint = async (blob: Uint8Array<ArrayBuffer>): Promise<string> =>
  `SHA256:${toBase64(await sha256(blob)).replace(/=+$/, "")}`;

/** Read one length-prefixed field of a key blob; null when the blob ends early. */
const readField = (
  blob: Uint8Array,
  offset: number,
): { readonly value: Uint8Array; readonly next: number } | null => {
  if (offset + 4 > blob.length) return null;
  const length =
    ((blob[offset]! << 24) |
      (blob[offset + 1]! << 16) |
      (blob[offset + 2]! << 8) |
      blob[offset + 3]!) >>>
    0;
  const start = offset + 4;
  if (start + length > blob.length) return null;
  return { value: blob.subarray(start, start + length), next: start + length };
};

/** Bits in an SSH `mpint`: its length without the leading zero bytes. */
const mpintBits = (value: Uint8Array): number => {
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  if (start === value.length) return 0;
  return (value.length - start - 1) * 8 + (32 - Math.clz32(value[start]!));
};

const isAlgorithm = (name: string): name is SshKeyAlgorithm =>
  (SSH_KEY_ALGORITHMS as readonly string[]).includes(name);

/**
 * Parse a public key line (`ssh-ed25519 AAAA... comment`). The algorithm the
 * line names must be the one inside the blob, so a key cannot be stored under
 * a type it is not.
 */
export const parsePublicKey = async (
  line: string,
): Promise<
  | { readonly ok: true; readonly key: ParsedPublicKey }
  | { readonly ok: false; readonly problem: PublicKeyProblem }
> => {
  // One key on one line; a pasted line's own trailing newline is fine.
  const trimmed = line.trim();
  const fields = trimmed.split(/[ \t]+/);
  const [name, encoded] = fields;
  if (!name || !encoded || /[\r\n]/.test(trimmed)) return { ok: false, problem: "format" };
  if (!isAlgorithm(name)) return { ok: false, problem: "algorithm" };
  const blob = fromBase64(encoded);
  if (!blob) return { ok: false, problem: "format" };

  const inner = readField(blob, 0);
  const innerName = inner ? fromUtf8(inner.value.slice()) : null;
  if (!inner || innerName === null) return { ok: false, problem: "format" };
  if (innerName !== name) return { ok: false, problem: "mismatch" };

  if (name === "ssh-rsa") {
    const exponent = readField(blob, inner.next);
    const modulus = exponent ? readField(blob, exponent.next) : null;
    if (!modulus) return { ok: false, problem: "format" };
    if (mpintBits(modulus.value) < MIN_RSA_BITS) return { ok: false, problem: "weak" };
  }

  return {
    ok: true,
    key: {
      algorithm: name,
      blob,
      publicKey: toBase64(blob),
      fingerprint: await sshFingerprint(blob),
      comment: fields.slice(2).join(" "),
    },
  };
};

export const publicKeyProblemMessage = (problem: PublicKeyProblem): string => {
  switch (problem) {
    case "format":
      return "That is not an SSH public key. Paste the contents of the .pub file.";
    case "algorithm":
      return `Unsupported key type. Use one of: ${SSH_KEY_ALGORITHMS.join(", ")}.`;
    case "mismatch":
      return "The key's type does not match its contents.";
    case "weak":
      return `RSA keys must be at least ${MIN_RSA_BITS} bits.`;
  }
};
