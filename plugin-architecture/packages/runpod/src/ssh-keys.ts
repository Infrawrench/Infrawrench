import { base64ToBytes, bytesToBase64 } from "@infrawrench/plugin-base";

/**
 * Runpod keeps an account's SSH public keys as a list of authorized_keys lines
 * (`GET /v2/account/ssh-keys`), replaced whole by `PUT` on the same path. They
 * reach pods created with `startSsh`, which this plugin always sets, and running
 * pods keep what they started with.
 *
 * A key's identity here is its OpenSSH SHA256 fingerprint, which is stable no
 * matter how the line is commented or reordered.
 */

export interface ParsedSshKey {
  /** Full authorized_keys line as stored. */
  line: string;
  type: string;
  /** Base64 key blob. */
  blob: string;
  comment: string;
}

const KEY_LINE = /^(?:\S+\s+)?((?:ssh|ecdsa|sk)-[A-Za-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/;

export function parseSshKeys(lines: string | readonly string[] | null | undefined): ParsedSshKey[] {
  const out: ParsedSshKey[] = [];
  const entries = typeof lines === "string" ? lines.split(/\r?\n/) : (lines ?? []);
  for (const raw of entries) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    out.push({ line, type: m[1]!, blob: m[2]!, comment: (m[3] ?? "").trim() });
  }
  return out;
}

/** OpenSSH-style `SHA256:<unpadded base64>` fingerprint of a key blob. */
export async function sshFingerprint(blob: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(blob);
  } catch {
    return `SHA256:invalid-${blob.slice(0, 12)}`;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
}

/**
 * URL-safe externalId for a fingerprint (`SHA256:abc+/` → `sha256-abc-_`),
 * so it survives being embedded in a host resource id.
 */
export function fingerprintId(fingerprint: string): string {
  return fingerprint
    .replace(/^SHA256:/, "sha256-")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** A key as the API takes it: `<type> <base64-key> [comment]`, with nothing in front. */
export function sshKeyLine(key: Pick<ParsedSshKey, "type" | "blob" | "comment">): string {
  return [key.type, key.blob, key.comment].filter(Boolean).join(" ");
}
