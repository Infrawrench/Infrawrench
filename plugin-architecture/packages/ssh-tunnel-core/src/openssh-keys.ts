/**
 * OpenSSH ed25519 key generation and formatting helpers, shared by the web
 * server (SSH-key routes, agent-VM keys) and the desktop main process
 * (agent-VM keys). Pure `node:crypto` — no ssh2 dependency.
 */
import * as crypto from "node:crypto";
import { promisify } from "node:util";

const generateKeyPair = promisify(crypto.generateKeyPair);

/** Length-prefixed SSH wire string: uint32be(len) + data. */
export function sshWireString(type: string, ...bufs: Uint8Array[]): Buffer {
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(type.length);
  const parts: Uint8Array[] = [typeLen, Buffer.from(type)];
  for (const buf of bufs) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    parts.push(len, buf);
  }
  return Buffer.concat(parts);
}

/**
 * Unencrypted OpenSSH private key file for an ed25519 key, matching
 * `ssh-keygen -t ed25519` (including the trailing newline).
 * Spec: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 */
export function buildOpenSshPrivateKey(privSeed: Buffer, pubKey: Buffer, comment: string): string {
  const AUTH_MAGIC = "openssh-key-v1\0";
  const cipherName = "none";
  const kdfName = "none";
  const kdfOptions = Buffer.alloc(0);
  const keyCount = 1;

  const pubBlob = sshWireString("ssh-ed25519", pubKey);

  const checkInt = crypto.randomBytes(4);
  const keyType = Buffer.from("ssh-ed25519");
  const keyTypeLenBuf = Buffer.alloc(4);
  keyTypeLenBuf.writeUInt32BE(keyType.length);
  const pubLenBuf = Buffer.alloc(4);
  pubLenBuf.writeUInt32BE(pubKey.length);
  // Ed25519 private key in OpenSSH = 64 bytes: seed (32) + public (32)
  const fullPriv = Buffer.concat([privSeed, pubKey]);
  const fullPrivLenBuf = Buffer.alloc(4);
  fullPrivLenBuf.writeUInt32BE(fullPriv.length);
  const commentBuf = Buffer.from(comment);
  const commentLenBuf = Buffer.alloc(4);
  commentLenBuf.writeUInt32BE(commentBuf.length);

  // The OpenSSH format repeats the checkint to detect bad decryption.
  const privSection = Buffer.concat([
    checkInt,
    checkInt,
    keyTypeLenBuf,
    keyType,
    pubLenBuf,
    pubKey,
    fullPrivLenBuf,
    fullPriv,
    commentLenBuf,
    commentBuf,
  ]);

  // Pad to 8-byte boundary (cipher block size for "none").
  const padLen = 8 - (privSection.length % 8);
  const padding = Buffer.alloc(padLen === 8 ? 0 : padLen);
  for (let i = 0; i < padding.length; i++) padding[i] = i + 1;
  const paddedPriv = Buffer.concat([privSection, padding]);

  const cipherBuf = Buffer.from(cipherName);
  const cipherLenBuf = Buffer.alloc(4);
  cipherLenBuf.writeUInt32BE(cipherBuf.length);
  const kdfBuf = Buffer.from(kdfName);
  const kdfLenBuf = Buffer.alloc(4);
  kdfLenBuf.writeUInt32BE(kdfBuf.length);
  const kdfOptLenBuf = Buffer.alloc(4);
  kdfOptLenBuf.writeUInt32BE(kdfOptions.length);
  const keyCountBuf = Buffer.alloc(4);
  keyCountBuf.writeUInt32BE(keyCount);
  const pubBlobLenBuf = Buffer.alloc(4);
  pubBlobLenBuf.writeUInt32BE(pubBlob.length);
  const privLenBuf = Buffer.alloc(4);
  privLenBuf.writeUInt32BE(paddedPriv.length);

  const payload = Buffer.concat([
    Buffer.from(AUTH_MAGIC),
    cipherLenBuf,
    cipherBuf,
    kdfLenBuf,
    kdfBuf,
    kdfOptLenBuf,
    kdfOptions,
    keyCountBuf,
    pubBlobLenBuf,
    pubBlob,
    privLenBuf,
    paddedPriv,
  ]);

  const b64 = payload.toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * Generate a fresh ed25519 keypair and return it in OpenSSH formats:
 * a `ssh-ed25519 <blob> <comment>` public-key line and an unencrypted
 * OpenSSH private-key file.
 */
export async function generateEd25519OpenSshKeyPair(
  comment: string,
): Promise<{ publicKey: string; privateKey: string }> {
  const { publicKey: pubPem, privateKey: privPem } = await generateKeyPair("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const spkiDer = crypto.createPublicKey(pubPem).export({ type: "spki", format: "der" });
  const pkcs8Der = crypto.createPrivateKey(privPem).export({ type: "pkcs8", format: "der" });
  const rawPubKey = Buffer.from(spkiDer).subarray(12); // 32 bytes after SPKI header
  const rawPrivKey = Buffer.from(pkcs8Der).subarray(16); // 32 bytes after PKCS#8 header
  const publicKey = `ssh-ed25519 ${sshWireString("ssh-ed25519", rawPubKey).toString("base64")} ${comment}`;
  const privateKey = buildOpenSshPrivateKey(rawPrivKey, rawPubKey, comment);
  return { publicKey, privateKey };
}

/**
 * `SHA256:<base64>` fingerprint of a raw SSH key blob, matching
 * `ssh-keygen -lf` output (trailing `=` padding stripped).
 */
export function sha256Fingerprint(keyBlob: Uint8Array): string {
  const hash = crypto.createHash("sha256").update(keyBlob).digest("base64");
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

/** Fingerprint of an OpenSSH `<type> <base64-blob> [comment]` public-key line. */
export function computeSshPublicKeyFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !parts[1]) throw new Error("Invalid SSH public key format");
  return sha256Fingerprint(Buffer.from(parts[1], "base64"));
}
