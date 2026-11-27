/** Text as lines over the original bytes, and the test for "is this text at all". */
import { decodeLatin1, decodeText } from "@infrawrench/git-core";

/** How many leading bytes git looks at to decide a blob is binary. */
const BINARY_SNIFF_BYTES = 8000;

/** Git's rule: a NUL in the first 8000 bytes makes a blob binary. */
export function isBinary(data: Uint8Array): boolean {
  const end = Math.min(data.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (data[i] === 0) return true;
  return false;
}

/**
 * A file cut into lines without copying it. Line `i` is the bytes from
 * `starts[i]` to `starts[i + 1]`, its newline included; only the last line
 * can lack one.
 */
export interface Lines {
  readonly data: Uint8Array;
  readonly starts: Uint32Array;
  readonly count: number;
}

export function splitLines(data: Uint8Array): Lines {
  let count = 0;
  for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, at + 1)) count++;
  if (data.length > 0 && data[data.length - 1] !== 0x0a) count++;
  const starts = new Uint32Array(count + 1);
  let line = 0;
  let from = 0;
  while (from < data.length) {
    starts[line++] = from;
    const newline = data.indexOf(0x0a, from);
    from = newline < 0 ? data.length : newline + 1;
  }
  starts[count] = data.length;
  return { data, starts, count };
}

/** The bytes of lines `from` up to `to`, as a view. */
export function lineBytes(lines: Lines, from: number, to = from + 1): Uint8Array {
  return lines.data.subarray(lines.starts[from]!, lines.starts[to]!);
}

/** True when the line ends in a newline, which every line but possibly the last does. */
export function hasNewline(lines: Lines, index: number): boolean {
  const end = lines.starts[index + 1]!;
  return end > lines.starts[index]! && lines.data[end - 1] === 0x0a;
}

/** A line as text for display: UTF-8 with replacement characters, no trailing newline. */
export function lineText(lines: Lines, index: number): string {
  const end = lines.starts[index + 1]! - (hasNewline(lines, index) ? 1 : 0);
  return decodeText(lines.data.subarray(lines.starts[index]!, end));
}

export function sameLine(a: Lines, i: number, b: Lines, j: number): boolean {
  const startA = a.starts[i]!;
  const startB = b.starts[j]!;
  const length = a.starts[i + 1]! - startA;
  if (b.starts[j + 1]! - startB !== length) return false;
  for (let k = 0; k < length; k++) if (a.data[startA + k] !== b.data[startB + k]) return false;
  return true;
}

/** What whitespace a comparison overlooks: git's `-w`, `-b` and `--ignore-space-at-eol`. */
export type IgnoreWhitespace = "none" | "all" | "change" | "eol";

function normalize(line: string, mode: IgnoreWhitespace): string {
  switch (mode) {
    case "all":
      return line.replace(/[ \t\n\v\f\r]+/g, "");
    case "change":
      return line.replace(/[ \t\n\v\f\r]+$/, "").replace(/[ \t\n\v\f\r]+/g, " ");
    case "eol":
      return line.replace(/[ \t\n\v\f\r]+$/, "");
    case "none":
      return line;
  }
}

/**
 * Gives every line of a range a number that is equal exactly when the lines
 * are equal (under the whitespace rule), numbering both files from one
 * table. Everything after this compares integers.
 */
export function classifyLines(
  a: Lines,
  aFrom: number,
  aCount: number,
  b: Lines,
  bFrom: number,
  bCount: number,
  ignore: IgnoreWhitespace,
): { ha1: Int32Array; ha2: Int32Array; classes: number } {
  const table = new Map<string, number>();
  const classify = (lines: Lines, from: number, count: number): Int32Array => {
    const out = new Int32Array(count);
    if (count === 0) return out;
    const base = lines.starts[from]!;
    // One byte per character keeps any byte sequence distinct, valid UTF-8 or not.
    const text = decodeLatin1(lines.data.subarray(base, lines.starts[from + count]!));
    for (let i = 0; i < count; i++) {
      let key = text.slice(lines.starts[from + i]! - base, lines.starts[from + i + 1]! - base);
      if (ignore !== "none") key = normalize(key, ignore);
      let id = table.get(key);
      if (id === undefined) {
        id = table.size;
        table.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  const ha1 = classify(a, aFrom, aCount);
  const ha2 = classify(b, bFrom, bCount);
  return { ha1, ha2, classes: table.size };
}
