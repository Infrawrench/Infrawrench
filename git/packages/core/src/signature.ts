/** The person lines of commits and tags: `Name <email> 1700000000 +0100`. */
import type { Signature } from "./types";

function formatTimezone(offset: number): string {
  // `-0000` (a real convention: "time zone unknown") is negative zero, which `< 0` misses.
  const negative = offset < 0 || Object.is(offset, -0);
  const minutes = Math.abs(offset);
  const hours = Math.floor(minutes / 60);
  return `${negative ? "-" : "+"}${String(hours).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
}

function parseTimezone(text: string): number {
  const match = /^([+-]?)(\d+)$/.exec(text);
  if (!match) return 0;
  const digits = Number(match[2]);
  const minutes = Math.floor(digits / 100) * 60 + (digits % 100);
  return match[1] === "-" ? -minutes : minutes;
}

function canonical(signature: Signature): string {
  return `${signature.name} <${signature.email}> ${signature.timestamp} ${formatTimezone(signature.timezoneOffset)}`;
}

function sameFields(a: Signature, b: Signature): boolean {
  return (
    a.name === b.name &&
    a.email === b.email &&
    a.timestamp === b.timestamp &&
    Object.is(a.timezoneOffset, b.timezoneOffset)
  );
}

/**
 * Parses a person line. It never throws: history holds lines with no email,
 * no date or a mangled timezone, and a forge still has to show those
 * commits. Whatever does not fit the usual shape is kept in `raw`.
 */
export function parseSignature(line: string): Signature {
  const open = line.indexOf("<");
  const close = open < 0 ? -1 : line.indexOf(">", open + 1);
  if (close < 0) return { name: line, email: "", timestamp: 0, timezoneOffset: 0, raw: line };
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const timestamp = /^-?\d+$/.test(rest[0] ?? "") ? Number(rest[0]) : 0;
  const parsed: Signature = {
    name: line.slice(0, open).trimEnd(),
    email: line.slice(open + 1, close),
    timestamp: Number.isSafeInteger(timestamp) ? timestamp : 0,
    timezoneOffset: parseTimezone(rest[1] ?? ""),
  };
  return canonical(parsed) === line ? parsed : { ...parsed, raw: line };
}

/** The line for a signature, without the `author ` prefix or the newline. */
export function formatSignature(signature: Signature): string {
  if (signature.raw !== undefined && sameFields(parseSignature(signature.raw), signature)) {
    return signature.raw;
  }
  return canonical(signature);
}

/** The signature's moment as a `Date`. The timezone only says how the author's clock read. */
export function signatureDate(signature: Signature): Date {
  return new Date(signature.timestamp * 1000);
}
