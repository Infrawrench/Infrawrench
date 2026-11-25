/**
 * Just enough HCL to tell what a `.tf` file declares: its blocks, their labels
 * and their literal attributes. Nothing is evaluated and no expression is
 * understood; an attribute's value is kept as the text it was written as.
 *
 * It has to get one thing right, which is where a block ends, so it knows
 * comments, quoted strings with `${ }` templates in them, and heredocs: a `}`
 * inside any of those closes nothing.
 */

export type HclItem =
  | {
      readonly kind: "block";
      readonly type: string;
      readonly labels: readonly string[];
      /** The text between the block's braces. */
      readonly body: string;
    }
  | {
      readonly kind: "attribute";
      readonly name: string;
      /** The expression as written, trimmed. */
      readonly expression: string;
    };

export class HclSyntaxError extends Error {
  override readonly name = "HclSyntaxError";
}

const MAX_NESTING = 128;
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;

/** Index just past a `#`, `//` or block comment starting at `i`, or `i` when there is none. */
function skipComment(source: string, i: number): number {
  const two = source.slice(i, i + 2);
  if (source[i] === "#" || two === "//") {
    const end = source.indexOf("\n", i);
    return end === -1 ? source.length : end;
  }
  if (two === "/*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  return i;
}

/** Index just past the quoted string starting at `i` (`source[i]` is the quote). */
function skipString(source: string, i: number, depth: number): number {
  if (depth > MAX_NESTING) throw new HclSyntaxError("Templates are nested too deeply");
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === "\\") j += 2;
    else if (ch === '"') return j + 1;
    else if ((ch === "$" || ch === "%") && source[j + 1] === "{") {
      // `$${` is an escaped literal, not a template.
      if (source[j - 1] === ch) j += 2;
      else j = skipGroup(source, j + 1, depth + 1);
    } else if (ch === "\n") {
      throw new HclSyntaxError("A quoted string does not end on its line");
    } else j += 1;
  }
  throw new HclSyntaxError("A quoted string does not end");
}

/** Index just past a heredoc starting at `i` (`<<EOT` or `<<-EOT`), or `i` when it is not one. */
function skipHeredoc(source: string, i: number): number {
  const match = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(source.slice(i, i + 256));
  if (!match) return i;
  const marker = match[1]!;
  let lineStart = i + match[0].length;
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = source.length;
    if (source.slice(lineStart, lineEnd).trim() === marker) return lineEnd;
    if (lineEnd === source.length) break;
    lineStart = lineEnd + 1;
  }
  throw new HclSyntaxError(`The heredoc ${marker} does not end`);
}

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/** Index just past the bracketed group opening at `i`. */
function skipGroup(source: string, i: number, depth: number): number {
  if (depth > MAX_NESTING) throw new HclSyntaxError("Brackets are nested too deeply");
  const close = CLOSERS[source[i]!]!;
  let j = i + 1;
  while (j < source.length) {
    const next = skipTrivia(source, j, depth);
    if (next !== j) {
      j = next;
      continue;
    }
    const ch = source[j]!;
    if (ch === close) return j + 1;
    if (ch in CLOSERS) j = skipGroup(source, j, depth + 1);
    else j += 1;
  }
  throw new HclSyntaxError(`A ${source[i]} is never closed`);
}

/** Index past a comment, string or heredoc at `i`, or `i` when none starts there. */
function skipTrivia(source: string, i: number, depth: number): number {
  const ch = source[i];
  if (ch === "#" || ch === "/") return skipComment(source, i);
  if (ch === '"') return skipString(source, i, depth);
  if (ch === "<" && source[i + 1] === "<") return skipHeredoc(source, i);
  return i;
}

function readIdentifier(source: string, i: number): number {
  if (!IDENT_START.test(source[i] ?? "")) return i;
  let j = i + 1;
  while (j < source.length && IDENT_PART.test(source[j]!)) j += 1;
  return j;
}

function skipSpaces(source: string, i: number): number {
  let j = i;
  while (j < source.length && (source[j] === " " || source[j] === "\t")) j += 1;
  return j;
}

/** Index of the end of the expression starting at `i`: its line's end, outside any group. */
function expressionEnd(source: string, i: number): number {
  let j = i;
  while (j < source.length) {
    const next = skipTrivia(source, j, 0);
    if (next !== j) {
      // A `#` or `//` comment ends the expression with its line.
      if (source[j] === "#" || source.startsWith("//", j)) return j;
      j = next;
      continue;
    }
    const ch = source[j]!;
    if (ch === "\n") return j;
    if (ch in CLOSERS) j = skipGroup(source, j, 0);
    else j += 1;
  }
  return j;
}

/**
 * The blocks and attributes directly in `source`, which is a file or a
 * block's body. Throws {@link HclSyntaxError} when a string, heredoc or
 * bracket never closes.
 */
export function hclItems(source: string): HclItem[] {
  const items: HclItem[] = [];
  let i = 0;
  while (i < source.length) {
    const trivia = skipTrivia(source, i, 0);
    if (trivia !== i) {
      i = trivia;
      continue;
    }
    const identEnd = readIdentifier(source, i);
    if (identEnd === i) {
      i = source[i]! in CLOSERS ? skipGroup(source, i, 0) : i + 1;
      continue;
    }
    const name = source.slice(i, identEnd);
    let j = skipSpaces(source, identEnd);

    if (source[j] === "=" && source[j + 1] !== "=") {
      const end = expressionEnd(source, j + 1);
      items.push({ kind: "attribute", name, expression: source.slice(j + 1, end).trim() });
      i = end;
      continue;
    }

    const labels: string[] = [];
    for (;;) {
      if (source[j] === '"') {
        const end = skipString(source, j, 0);
        labels.push(source.slice(j + 1, end - 1));
        j = skipSpaces(source, end);
      } else {
        const end = readIdentifier(source, j);
        if (end === j) break;
        labels.push(source.slice(j, end));
        j = skipSpaces(source, end);
      }
    }
    if (source[j] === "{") {
      const end = skipGroup(source, j, 0);
      items.push({ kind: "block", type: name, labels, body: source.slice(j + 1, end - 1) });
      i = end;
    } else {
      // Not a block after all (a stray word): move on rather than guess.
      i = Math.max(j, identEnd);
    }
  }
  return items;
}

/** The value of an expression that is one plain quoted string, or null for anything else. */
export function literalString(expression: string): string | null {
  if (expression.length < 2 || !expression.startsWith('"') || !expression.endsWith('"')) {
    return null;
  }
  const inner = expression.slice(1, -1);
  if (/(^|[^$%])[$%]\{/.test(inner) || /(^|[^\\])(\\\\)*"/.test(inner)) return null;
  try {
    const parsed: unknown = JSON.parse(expression);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return inner;
  }
}
