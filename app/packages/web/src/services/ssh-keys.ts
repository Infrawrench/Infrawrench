/**
 * Shared SSH public key validation — used by the HTTP routes and the MCP/chat
 * tool registry.
 */
export function validateSshPublicKey(key: string): { keyType: string; publicKey: string } {
  const trimmed = key.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) throw new Error("Invalid SSH public key format");

  const keyType = parts[0]!;
  const validTypes = [
    "ssh-rsa",
    "ssh-ed25519",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
  ];
  if (!validTypes.includes(keyType)) {
    throw new Error(`Unsupported key type: ${keyType}`);
  }

  const blob = Buffer.from(parts[1]!, "base64");
  if (blob.length < 16) throw new Error("SSH public key blob is too short");

  // The type embedded in the blob must match the outer prefix.
  const typeLen = blob.readUInt32BE(0);
  const embeddedType = blob.subarray(4, 4 + typeLen).toString("utf8");
  if (embeddedType !== keyType) {
    throw new Error("SSH public key type mismatch");
  }

  return { keyType, publicKey: trimmed };
}
