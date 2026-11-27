/** Reading a pasted `authorized_keys` line, and when a token runs out. */

const KEY_TYPES =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

/**
 * The comment at the end of a public key line (`you@host`), which becomes
 * the key's title when none is typed. Null when the text is not a key line
 * or has no comment. Options before the key type (`command="..." ssh-...`)
 * are skipped, as `authorized_keys` allows them.
 */
export function commentOfKey(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  const typeIndex = parts.findIndex((part) => KEY_TYPES.test(part));
  if (typeIndex < 0 || parts[typeIndex + 1] === undefined) return null;
  const comment = parts.slice(typeIndex + 2).join(" ");
  return comment === "" ? null : comment;
}

export type Expiry = "expired" | "soon" | "later" | "never";

/** Where a token is in its life: `soon` is within a week. */
export function expiryOf(expiresAt: string | null, now: number = Date.now()): Expiry {
  if (expiresAt === null) return "never";
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return "expired";
  return left < 7 * 86_400_000 ? "soon" : "later";
}
