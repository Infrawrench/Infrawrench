/**
 * Input rules Temporal Cloud enforces, checked before a request is sent so a
 * mistake reads as a sentence rather than as a gateway error. Sources:
 * https://docs.temporal.io/cloud/namespaces (names, tags, descriptions) and
 * https://docs.temporal.io/evaluate/cloud/limits (retention, search attributes).
 */

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 90;
export const MAX_NAMESPACE_TAGS = 10;

/** Custom search attributes allowed per type per namespace. */
export const SEARCH_ATTRIBUTE_LIMITS: Record<string, number> = {
  SEARCH_ATTRIBUTE_TYPE_BOOL: 20,
  SEARCH_ATTRIBUTE_TYPE_DATETIME: 20,
  SEARCH_ATTRIBUTE_TYPE_DOUBLE: 20,
  SEARCH_ATTRIBUTE_TYPE_INT: 20,
  SEARCH_ATTRIBUTE_TYPE_KEYWORD: 40,
  SEARCH_ATTRIBUTE_TYPE_KEYWORD_LIST: 5,
  SEARCH_ATTRIBUTE_TYPE_TEXT: 5,
};

export function validateRetention(raw: string): number {
  const days = Number(raw);
  if (!Number.isInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
    throw new Error(
      `Retention must be a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}`,
    );
  }
  return days;
}

export function validateNamespaceName(raw: string): string {
  const name = raw.trim();
  if (name.length < 2 || name.length > 39) {
    throw new Error("A namespace name must be 2 to 39 characters long");
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
    throw new Error(
      "A namespace name uses lowercase letters, digits and hyphens, starts with a letter and ends with a letter or digit",
    );
  }
  return name;
}

export function validateDescription(raw: string): string {
  const text = raw.trim();
  if (text.length > 255) throw new Error("A description can be at most 255 characters");
  if (/[^\x20-\x7E\s]/.test(text)) {
    throw new Error("A description can only contain printable ASCII characters");
  }
  return text;
}

export function validateSearchAttributeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > 64) {
    throw new Error("A search attribute name must be 1 to 64 characters long");
  }
  if (!/^[a-zA-Z0-9.,:\-_/@ ]+$/.test(name)) {
    throw new Error(
      "A search attribute name may contain letters, digits, spaces and . , : - _ / @ only",
    );
  }
  return name;
}

/** `team=payments, env=prod` → `{ team: "payments", env: "prod" }`, validated. */
export function parseTagList(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const key = (eq >= 0 ? item.slice(0, eq) : item).trim();
    const value = (eq >= 0 ? item.slice(eq + 1) : "").trim();
    for (const [what, text] of [
      ["key", key],
      ["value", value],
    ] as const) {
      if (!/^[a-z0-9._\-@]{1,63}$/.test(text)) {
        throw new Error(
          `Tag ${what} "${text}" must be 1 to 63 lowercase letters, digits, or . _ - @ (write tags as key=value)`,
        );
      }
    }
    if (key in out) throw new Error(`Tag key "${key}" appears twice`);
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_NAMESPACE_TAGS) {
    throw new Error(`A namespace can have at most ${MAX_NAMESPACE_TAGS} tags`);
  }
  return out;
}

export function validateHttpsUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("The codec server endpoint must be a full URL");
  }
  if (url.protocol !== "https:") throw new Error("The codec server endpoint must use https");
  return text;
}

export function validateNexusEndpointName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(name)) {
    throw new Error(
      "A Nexus endpoint name uses letters, digits and hyphens, starts with a letter and ends with a letter or digit",
    );
  }
  return name;
}

/** PEM text is sent base64-encoded; an already-encoded value is passed through. */
export function encodeCaCertificate(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (!text.includes("-----BEGIN")) return text.replace(/\s+/g, "");
  if (!text.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("The CA certificate must be PEM, starting with -----BEGIN CERTIFICATE-----");
  }
  const bytes = new TextEncoder().encode(`${text}\n`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
