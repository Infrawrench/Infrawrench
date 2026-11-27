/**
 * `authorized_keys` lines: what a user pastes when they add a key.
 */
import { fromBase64 } from "../bytes";
import {
  decodePublicKey,
  describePublicKey,
  KEY_TYPES,
  type DecodedPublicKey,
  type KeyType,
  type SshPublicKey,
} from "./public";
import { importVerifyKey } from "./verify";

export interface AuthorizedKey extends SshPublicKey {
  /** Whatever followed the key on the line, trimmed; empty when nothing did. */
  readonly comment: string;
}

/** A line is a few hundred bytes for most keys; the largest RSA key this server takes is about 1,400. */
const MAX_LINE_LENGTH = 8192;

/**
 * Parse one public key line (`ssh-ed25519 AAAA... comment`), the content of a
 * `.pub` file. Resolves with null when the line is not one valid key of a
 * supported type. Lines with `authorized_keys` options in front of the type
 * are refused on purpose: a forge has no use for them, and accepting a prefix
 * it then ignores would mislead.
 */
export async function parseAuthorizedKey(line: string): Promise<AuthorizedKey | null> {
  if (line.length > MAX_LINE_LENGTH) return null;
  const match = /^[ \t]*(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(line.replace(/[\r\n]+$/, ""));
  if (!match) return null;
  const [, type, encoded, comment] = match;
  if (!KEY_TYPES.includes(type as KeyType)) return null;
  const blob = fromBase64(encoded!);
  if (!blob) return null;
  const decoded = decodePublicKey(blob);
  // The type in front must be the type inside, or the line names one key and carries another.
  if (!decoded || decoded.type !== type) return null;
  if (!(await isUsable(decoded))) return null;
  return { ...(await describePublicKey(decoded.type, blob)), comment: (comment ?? "").trim() };
}

/** Whether WebCrypto accepts the key, which is where an EC point off its curve is caught. */
async function isUsable(key: DecodedPublicKey): Promise<boolean> {
  try {
    await importVerifyKey(key, key.type === "ssh-rsa" ? "rsa-sha2-256" : key.type);
    return true;
  } catch {
    return false;
  }
}
