/**
 * The server's host key: what it proves its identity with in every key
 * exchange.
 */
import { source, utf8 } from "./bytes";
import { KeyFormatError, parseOpenSshPrivateKey } from "./keys/openssh-private";
import type { SshPublicKey } from "./keys/public";
import { WireWriter } from "./wire";

export interface HostKey {
  /** The host key algorithm offered in key exchange. */
  readonly algorithm: "ssh-ed25519";
  readonly publicKey: SshPublicKey;
  /** An SSH signature blob (`string algorithm, string signature`) over `data`. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/**
 * WebCrypto imports an ed25519 private key only as PKCS#8 or JWK. PKCS#8 for
 * ed25519 is this fixed header followed by the 32-byte seed (RFC 8410).
 */
const PKCS8_ED25519_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
);

/**
 * Load a host key from an unencrypted OpenSSH private key file's text. Do
 * this once per isolate and pass the result to every `serveConnection`: the
 * key object is not extractable afterwards and importing costs a little.
 */
export async function loadHostKey(pem: string): Promise<HostKey> {
  const parsed = await parseOpenSshPrivateKey(pem);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(parsed.seed, PKCS8_ED25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, [
    "sign",
  ]);
  pkcs8.fill(0);
  parsed.seed.fill(0);

  const sign = async (data: Uint8Array): Promise<Uint8Array> => {
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, source(data));
    return new WireWriter().string("ssh-ed25519").string(new Uint8Array(signature)).finish();
  };

  // The file states its public key separately from the seed. Clients pin the
  // stated one, so a file whose halves disagree would produce signatures no
  // client accepts; find that out here rather than at the first connection.
  const point = parsed.publicKey.blob.subarray(parsed.publicKey.blob.length - 32);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    source(point),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const probe = utf8("infrawrench-git-ssh host key self-check");
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, source(probe));
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, source(probe)))) {
    throw new KeyFormatError("the public and private halves of the key do not match");
  }

  return { algorithm: "ssh-ed25519", publicKey: parsed.publicKey, sign };
}
