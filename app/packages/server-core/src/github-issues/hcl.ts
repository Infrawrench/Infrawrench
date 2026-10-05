/**
 * The smallest HCL editor that can make the two mechanical changes an IaC
 * pull request carries: set one top-level attribute of a resource block to a
 * new literal, or delete a resource block outright.
 *
 * Not a parser, on purpose. A full HCL2 parser would be a new dependency for
 * two edits, and a pretty-printer would rewrite the user's formatting, which
 * turns a one-line review into a whole-file one. Instead a single scan marks
 * which characters are *code* (not inside a string, heredoc or comment) and
 * the brace depth at each, and the edits splice the original text. Anything
 * the scan cannot be sure of (an attribute set from an expression, a block
 * declared twice, a resource still referenced elsewhere) is refused with a
 * reason, never guessed at: the whole point of the feature is that the PR is
 * obviously right.
 */

export class HclEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HclEditError";
  }
}

interface Scan {
  /** True where the character is code rather than string/comment/heredoc. */
  code: Uint8Array;
  /** 0 code, 1 string or heredoc, 2 comment. */
  kind: Uint8Array;
  /** Brace depth *before* the character, counting `{`/`}` in code only. */
  depth: Int32Array;
}

/** Mark code characters and brace depth in one pass. */
export function scanHcl(src: string): Scan {
  const n = src.length;
  const code = new Uint8Array(n);
  const kind = new Uint8Array(n);
  const depth = new Int32Array(n);
  let d = 0;
  let i = 0;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    // Line comments.
    if (ch === "#" || (ch === "/" && next === "/")) {
      while (i < n && src[i] !== "\n") {
        depth[i] = d;
        kind[i] = 2;
        i++;
      }
      continue;
    }
    // Block comments.
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) {
        depth[i] = d;
        kind[i] = 2;
      }
      continue;
    }
    // Heredocs: <<ID or <<-ID, ending at a line holding only ID.
    if (ch === "<" && next === "<") {
      const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(src.slice(i, i + 80));
      if (m) {
        const id = m[1]!;
        const bodyStart = i + m[0].length;
        const re = new RegExp(`^[ \\t]*${id}[ \\t]*$`, "m");
        const rest = src.slice(bodyStart);
        const hit = re.exec(rest);
        const stop = hit ? bodyStart + hit.index + hit[0].length : n;
        for (; i < stop; i++) {
          depth[i] = d;
          kind[i] = 1;
        }
        continue;
      }
    }
    // Quoted strings, with escapes and `${ … }` interpolation (whose own
    // braces and nested strings must not count).
    if (ch === '"') {
      depth[i] = d;
      kind[i] = 1;
      i++;
      let interp = 0;
      while (i < n) {
        const c = src[i]!;
        depth[i] = d;
        kind[i] = 1;
        if (c === "\\") {
          depth[i + 1] = d;
          kind[i + 1] = 1;
          i += 2;
          continue;
        }
        if (interp === 0 && c === '"') {
          i++;
          break;
        }
        if (c === "$" && src[i + 1] === "{") {
          interp++;
          depth[i + 1] = d;
          kind[i + 1] = 1;
          i += 2;
          continue;
        }
        if (interp > 0 && c === "}") interp--;
        if (c === "\n" && interp === 0) {
          // An unterminated string: stop at the line end rather than
          // swallowing the rest of the file.
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    depth[i] = d;
    code[i] = 1;
    if (ch === "{") d++;
    else if (ch === "}") d = Math.max(0, d - 1);
    i++;
  }
  return { code, kind, depth };
}

export interface HclBlock {
  /** Offset of the start of the line the block header is on. */
  lineStart: number;
  /** Offset of the opening brace. */
  open: number;
  /** Offset of the matching closing brace. */
  close: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every top-level `resource "type" "name" {` block in `src`. */
export function findResourceBlocks(src: string, type: string, name: string): HclBlock[] {
  const scan = scanHcl(src);
  const re = new RegExp(
    `(^|\\n)([ \\t]*)resource[ \\t]+"${escapeRegex(type)}"[ \\t]+"${escapeRegex(name)}"[ \\t]*\\{`,
    "g",
  );
  const blocks: HclBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const keyword = m.index + m[1]!.length + m[2]!.length;
    if (!scan.code[keyword] || scan.depth[keyword] !== 0) continue;
    const open = m.index + m[0].length - 1;
    let close = -1;
    for (let i = open + 1; i < src.length; i++) {
      if (scan.code[i] && src[i] === "}" && scan.depth[i] === 1) {
        close = i;
        break;
      }
    }
    if (close === -1) throw new HclEditError(`The block for ${type}.${name} is not closed.`);
    blocks.push({ lineStart: m.index + m[1]!.length, open, close });
  }
  return blocks;
}

/** A top-level attribute line inside a block. */
interface AttributeLine {
  /** Offset where the value starts. */
  valueStart: number;
  /** Offset just past the value (before any trailing comment/whitespace). */
  valueEnd: number;
  raw: string;
}

function findAttribute(src: string, block: HclBlock, attr: string): AttributeLine | null {
  const scan = scanHcl(src);
  const re = new RegExp(`(^|\\n)[ \\t]*${escapeRegex(attr)}[ \\t]*=[ \\t]*`, "g");
  re.lastIndex = block.open;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const keyAt = m.index + m[1]!.length;
    if (keyAt > block.close) break;
    const nameAt = src.indexOf(attr, keyAt);
    if (!scan.code[nameAt] || scan.depth[nameAt] !== 1) continue;
    const valueStart = m.index + m[0].length;
    const lineEnd = src.indexOf("\n", valueStart);
    const end = lineEnd === -1 ? src.length : lineEnd;
    // The value runs to the line end, minus any trailing comment.
    let valueEnd = end;
    for (let i = valueStart; i < end; i++) {
      if (scan.kind[i] === 2) {
        valueEnd = i;
        break;
      }
    }
    while (valueEnd > valueStart && /\s/.test(src[valueEnd - 1]!)) valueEnd--;
    return { valueStart, valueEnd, raw: src.slice(valueStart, valueEnd) };
  }
  return null;
}

export type HclLiteral = { kind: "string"; value: string } | { kind: "number"; value: number };

/** Parse a raw attribute value as a plain literal, or null for any expression. */
export function parseLiteral(raw: string): HclLiteral | null {
  const t = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "number", value: Number(t) };
  const m = /^"((?:[^"\\$]|\\.|\$(?!\{))*)"$/.exec(t);
  if (!m) return null;
  return { kind: "string", value: JSON.parse(`"${m[1]!.replace(/\$\$\{/g, "${")}"`) as string };
}

/** Render a literal the way HCL wants it (`${` must be escaped as `$${`). */
export function renderLiteral(lit: HclLiteral): string {
  if (lit.kind === "number") return String(lit.value);
  return JSON.stringify(lit.value).replace(/\$\{/g, "$${");
}

export interface SetAttributeResult {
  text: string;
  previous: HclLiteral;
}

/**
 * Set `attr` in the single `resource "type" "name"` block to `value`. Refuses
 * when the block is missing or declared twice, when the attribute is absent
 * (its value would be a provider default we cannot see), or when it is set
 * from an expression rather than a literal (the change belongs wherever that
 * expression's value is defined, which is not mechanical).
 */
export function setResourceAttribute(
  src: string,
  type: string,
  name: string,
  attr: string,
  value: HclLiteral,
): SetAttributeResult {
  const blocks = findResourceBlocks(src, type, name);
  if (blocks.length === 0) throw new HclEditError(`No ${type}.${name} block in this file.`);
  if (blocks.length > 1) throw new HclEditError(`${type}.${name} is declared more than once.`);
  const block = blocks[0]!;
  const line = findAttribute(src, block, attr);
  if (!line) {
    throw new HclEditError(
      `${type}.${name} does not set ${attr} explicitly, so there is no line to change.`,
    );
  }
  const previous = parseLiteral(line.raw);
  if (!previous) {
    throw new HclEditError(
      `${attr} on ${type}.${name} is set from an expression (${line.raw.trim().slice(0, 80)}), so the change belongs where that value is defined.`,
    );
  }
  const text = src.slice(0, line.valueStart) + renderLiteral(value) + src.slice(line.valueEnd);
  return { text, previous };
}

/**
 * Delete the single `resource "type" "name"` block, including its header line
 * and one blank line after it. Comments directly above the block stay: they
 * may describe more than this resource.
 */
export function removeResourceBlock(src: string, type: string, name: string): string {
  const blocks = findResourceBlocks(src, type, name);
  if (blocks.length === 0) throw new HclEditError(`No ${type}.${name} block in this file.`);
  if (blocks.length > 1) throw new HclEditError(`${type}.${name} is declared more than once.`);
  const block = blocks[0]!;
  let end = src.indexOf("\n", block.close);
  end = end === -1 ? src.length : end + 1;
  // Swallow one following blank line so the gap does not double.
  const blank = /^[ \t]*\r?\n/.exec(src.slice(end));
  if (blank) end += blank[0].length;
  return src.slice(0, block.lineStart) + src.slice(end);
}

/** Whether `type.name` is referenced in code anywhere in `src` outside `skip`. */
export function referencesResource(
  src: string,
  type: string,
  name: string,
  skip?: { from: number; to: number },
): boolean {
  const scan = scanHcl(src);
  const re = new RegExp(`(^|[^A-Za-z0-9_.])${escapeRegex(type)}\\.${escapeRegex(name)}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[1]!.length;
    if (skip && at >= skip.from && at <= skip.to) continue;
    // References also appear inside interpolations, which the scan marks as
    // string; count those too, but never comments.
    if (scan.kind[at] !== 2) return true;
  }
  return false;
}

/**
 * A unified diff of one file's single contiguous change, with three lines of
 * context. Enough for a preview and a PR description; GitHub renders the real
 * diff from the commit.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx);
  const toB = Math.min(b.length - 1, endB + ctx);
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  lines.push(`@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`);
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i]}`);
  return lines.join("\n");
}
