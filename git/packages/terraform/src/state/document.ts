import { isRecord } from "../util/bytes.js";

/**
 * Reading a state document's header. The backend stores a state as the bytes
 * Terraform sent and never rewrites them, so all it needs from the JSON is
 * what orders versions (`serial`), what tells two states apart (`lineage`)
 * and a little to show in a listing.
 */

/** The only state format Terraform has written since 0.12. */
export const STATE_FORMAT_VERSION = 4;

/** The largest state the backend takes unless a host says otherwise: 32 MiB. */
export const DEFAULT_MAX_STATE_BYTES = 32 * 1024 * 1024;

const MAX_LINEAGE_LENGTH = 128;

export interface StateHeader {
  readonly serial: number;
  readonly lineage: string;
  readonly terraformVersion: string | null;
  readonly resourceCount: number;
}

export type StateHeaderResult =
  | { readonly ok: true; readonly header: StateHeader }
  | { readonly ok: false; readonly reason: string };

export function readStateHeader(bytes: Uint8Array): StateHeaderResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "The state is not UTF-8 text." };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The state is not valid JSON." };
  }
  if (!isRecord(doc)) return { ok: false, reason: "The state is not a JSON object." };

  if (doc["version"] !== STATE_FORMAT_VERSION) {
    const found = typeof doc["version"] === "number" ? String(doc["version"]) : "none";
    return {
      ok: false,
      reason: `Only state format version ${STATE_FORMAT_VERSION} is stored (found ${found}).`,
    };
  }
  const serial = doc["serial"];
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 0) {
    return { ok: false, reason: "The state's serial is not a non-negative integer." };
  }
  const lineage = doc["lineage"];
  if (typeof lineage !== "string" || lineage === "" || lineage.length > MAX_LINEAGE_LENGTH) {
    return { ok: false, reason: "The state has no lineage." };
  }
  const terraformVersion = doc["terraform_version"];
  const resources = doc["resources"];
  return {
    ok: true,
    header: {
      serial,
      lineage,
      terraformVersion:
        typeof terraformVersion === "string" && terraformVersion.length <= 64
          ? terraformVersion
          : null,
      resourceCount: Array.isArray(resources) ? resources.length : 0,
    },
  };
}

/**
 * The same document with another top-level `serial`, every other byte as it
 * was. Restoring an old version writes it again as the newest, and going
 * through `JSON.parse` and `JSON.stringify` for that would round any integer
 * past 2^53 in a resource's attributes. Null when the text has no top-level
 * numeric `serial`. The number is replaced whole, however it was written.
 */
export function withSerial(text: string, serial: number): string | null {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i += 1;
      if (depth !== 1 || text.slice(start, i) !== '"serial"') continue;
      let j = i;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      // A string at depth 1 that is not followed by a colon is a value, not a key.
      if (text[j] !== ":") continue;
      j += 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      // The whole number, as JSON spells one: `1e3` is a serial too, and
      // replacing only its digits would leave the exponent behind.
      const number = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(j, j + 64));
      if (!number) return null;
      return text.slice(0, j) + String(serial) + text.slice(j + number[0].length);
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    i += 1;
  }
  return null;
}
