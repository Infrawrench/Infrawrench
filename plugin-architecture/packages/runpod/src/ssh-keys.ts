import { base64ToBytes, bytesToBase64 } from "@infrawrench/plugin-base";

/**
 * Runpod keeps an account's SSH public keys as one newline-separated string
 * (`myself.pubKey`, the console's Settings, SSH Public Keys box), written back
 * whole with `updateUserSettings(input: {pubKey})`. That is exactly what
 * `runpodctl ssh add-key` does (runpodctl `api/user.go`, 2026-10). Each line
 * is an authorized_keys entry; Runpod injects all of them into every new pod.
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

export function parseSshKeys(pubKey: string | null | undefined): ParsedSshKey[] {
  const out: ParsedSshKey[] = [];
  for (const raw of (pubKey ?? "").split(/\r?\n/)) {
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
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

/** Join keys back into the stored form (blank line between, as runpodctl writes it). */
export function joinSshKeys(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n\n");
}
