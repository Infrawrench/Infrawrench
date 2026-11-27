/**
 * The OpenSSH private key container (`-----BEGIN OPENSSH PRIVATE KEY-----`,
 * OpenSSH's PROTOCOL.key), for the server's host key.
 *
 * Only unencrypted ed25519 keys are read. A passphrase-protected key needs
 * bcrypt-pbkdf, which WebCrypto does not have, and a server's host key lives
 * in a secret store rather than behind a passphrase.
 */
import { constantTimeEqual, fromBase64, fromUtf8 } from "../bytes";
import { WireReader } from "../wire";
import { describePublicKey, type SshPublicKey } from "./public";

const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END = "-----END OPENSSH PRIVATE KEY-----";
const MAGIC = "openssh-key-v1\0";

export interface OpenSshPrivateKey {
  readonly publicKey: SshPublicKey;
  /** The 32-byte ed25519 seed. Secret. */
  readonly seed: Uint8Array;
  readonly comment: string;
}

/** Thrown for a key that cannot be used; the message never includes key material. */
export class KeyFormatError extends Error {
  override readonly name = "KeyFormatError";
}

export async function parseOpenSshPrivateKey(pem: string): Promise<OpenSshPrivateKey> {
  const begin = pem.indexOf(BEGIN);
  const end = pem.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new KeyFormatError(
      "not an OpenSSH private key (expected a BEGIN OPENSSH PRIVATE KEY block)",
    );
  }
  const data = fromBase64(pem.slice(begin + BEGIN.length, end).replace(/\s+/g, ""));
  if (!data) throw new KeyFormatError("OpenSSH private key is not valid base64");

  try {
    return await decode(data);
  } catch (error) {
    if (error instanceof KeyFormatError) throw error;
    // A parse failure deeper down is a truncated or corrupt file.
    throw new KeyFormatError("OpenSSH private key is malformed");
  }
}

async function decode(data: Uint8Array): Promise<OpenSshPrivateKey> {
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i))
      throw new KeyFormatError("OpenSSH private key is malformed");
  }
  const outer = new WireReader(data, MAGIC.length);
  const cipher = outer.text();
  const kdf = outer.text();
  outer.string(); // KDF options, empty for an unencrypted key
  const count = outer.uint32();
  if (cipher !== "none" || kdf !== "none") {
    throw new KeyFormatError(
      "the private key is passphrase-protected; use an unencrypted key (ssh-keygen -p -N '')",
    );
  }
  if (count !== 1) throw new KeyFormatError("expected exactly one key in the file");
  const publicBlob = outer.string();
  const privateSection = outer.string();
  outer.end();

  const inner = new WireReader(privateSection);
  // Two copies of one random number; they differ when decryption went wrong,
  // which for an unencrypted key means corruption.
  if (inner.uint32() !== inner.uint32())
    throw new KeyFormatError("OpenSSH private key is malformed");
  const type = inner.text();
  if (type !== "ssh-ed25519") {
    throw new KeyFormatError(`unsupported host key type ${type}; only ssh-ed25519 is supported`);
  }
  const point = inner.string();
  const secret = inner.string();
  const comment = fromUtf8(inner.string());
  // What is left is padding: 1, 2, 3, ...
  for (let expected = 1; inner.remaining > 0; expected++) {
    if (inner.byte() !== (expected & 0xff))
      throw new KeyFormatError("OpenSSH private key is malformed");
  }
  // The secret is the seed followed by the public point again.
  if (point.length !== 32 || secret.length !== 64) {
    throw new KeyFormatError("OpenSSH private key is malformed");
  }
  if (!constantTimeEqual(secret.subarray(32), point)) {
    throw new KeyFormatError("OpenSSH private key is malformed");
  }
  const publicKey = await describePublicKey("ssh-ed25519", publicBlob.slice());
  const embedded = new WireReader(publicBlob);
  if (embedded.text() !== "ssh-ed25519" || !constantTimeEqual(embedded.string(), point)) {
    throw new KeyFormatError("the public and private halves of the key do not match");
  }
  return { publicKey, seed: secret.slice(0, 32), comment };
}
