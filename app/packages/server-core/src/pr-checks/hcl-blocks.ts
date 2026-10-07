/**
 * Read the top-level blocks of one `.tf` file well enough to say which
 * resources a pull request adds, edits or removes, and with which literal
 * values.
 *
 * Built on the same one-pass scan the IaC pull-request editor uses
 * (`github-issues/hcl.ts`), for the same reason: a full HCL2 parser is a new
 * dependency, and the check needs far less than one. It records, per
 * `resource "type" "name"` block, every top-level attribute's raw text and,
 * when the value is a plain literal (string, number, bool, or a map of
 * string literals like `tags`), its value. Anything else is an
 * `expression`: kept verbatim so a change to it is still a change, but never
 * evaluated. Nested blocks (`root_block_device { … }`) are kept as raw text
 * for the same reason.
 *
 * `moved { from = … to = … }` blocks are read too, so a rename shows up as
 * the edit Terraform will plan rather than a destroy plus a create.
 */
import { parseLiteral, scanHcl } from "../github-issues/hcl.js";

export type HclAttributeValue =
  | { kind: "string"; value: string; raw: string }
  | { kind: "number"; value: number; raw: string }
  | { kind: "bool"; value: boolean; raw: string }
  | { kind: "map"; entries: Record<string, string>; raw: string }
  | { kind: "expression"; raw: string };

export interface HclResourceBlock {
  type: string;
  name: string;
  /** `type.name`. */
  address: string;
  /** 1-based line of the block header. */
  line: number;
  attributes: Record<string, HclAttributeValue>;
  /** Nested block name → whitespace-normalised raw text (joined when repeated). */
  nestedBlocks: Record<string, string>;
}

export interface HclMove {
  from: string;
  to: string;
}

export interface ParsedHclFile {
  resources: HclResourceBlock[];
  moves: HclMove[];
  /** `module "name"` blocks: recognised, not analysed. */
  modules: Array<{ name: string; line: number }>;
  /** Problems worth a warning, one sentence each. */
  errors: string[];
}

const HEADER =
  /(^|\n)([ \t]*)(resource|module|moved)\b[ \t]*(?:"([^"\n]*)"[ \t]*)?(?:"([^"\n]*)"[ \t]*)?\{/g;

/** Collapse whitespace so reformatting is not a change. */
export function normalizeHcl(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Parse a raw value into a literal, a string-literal map, or an expression. */
export function parseAttributeValue(raw: string): HclAttributeValue {
  const t = raw.trim();
  if (t === "true" || t === "false") return { kind: "bool", value: t === "true", raw: t };
  const lit = parseLiteral(t);
  if (lit) {
    return lit.kind === "number"
      ? { kind: "number", value: lit.value, raw: t }
      : { kind: "string", value: lit.value, raw: t };
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    const body = t.slice(1, -1);
    const entries: Record<string, string> = {};
    // One entry per line or comma. Any entry that is not `key = "literal"`
    // makes the whole map an expression: a half-read tag map would report a
    // present tag as missing.
    const parts = body
      .split(/\n|,/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("//"));
    for (const part of parts) {
      const m = /^(?:"([^"\\]*)"|([A-Za-z_][A-Za-z0-9_.:/-]*))\s*[=:]\s*(.+)$/.exec(part);
      if (!m) return { kind: "expression", raw: t };
      const value = parseLiteral(m[3]!.trim());
      if (!value) return { kind: "expression", raw: t };
      entries[m[1] ?? m[2]!] = String(value.value);
    }
    return { kind: "map", entries, raw: t };
  }
  return { kind: "expression", raw: t };
}

/**
 * The end of a value starting at `start`: the first newline in code where
 * every bracket opened inside the value has closed. Heredocs and strings are
 * skipped by the scan, so their newlines never end a value.
 */
function valueEnd(
  src: string,
  start: number,
  limit: number,
  scan: ReturnType<typeof scanHcl>,
): number {
  let balance = 0;
  for (let i = start; i < limit; i++) {
    const ch = src[i]!;
    if (scan.kind[i] === 1) continue;
    if (scan.kind[i] === 2) {
      // A comment runs to the line end; the newline after it still ends the value.
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") balance++;
    else if (ch === "}" || ch === "]" || ch === ")") balance--;
    else if (ch === "\n" && balance <= 0) return i;
  }
  return limit;
}

function stripTrailingComment(
  src: string,
  from: number,
  to: number,
  scan: ReturnType<typeof scanHcl>,
) {
  let end = to;
  // Only a comment that starts at bracket depth zero on the last line is
  // trailing; comments inside a multi-line map stay in the raw text.
  const lastLine = src.lastIndexOf("\n", to - 1);
  for (let i = Math.max(from, lastLine + 1); i < to; i++) {
    if (scan.kind[i] === 2) {
      end = i;
      break;
    }
  }
  return src.slice(from, end).trim();
}

function parseBody(
  src: string,
  open: number,
  close: number,
  scan: ReturnType<typeof scanHcl>,
): { attributes: Record<string, HclAttributeValue>; nestedBlocks: Record<string, string> } {
  const attributes: Record<string, HclAttributeValue> = {};
  const nestedBlocks: Record<string, string> = {};
  const depth = scan.depth[open + 1] ?? 1;
  let i = open + 1;
  while (i < close) {
    // Skip to the next code character at this block's own depth.
    if (scan.code[i] !== 1 || /\s/.test(src[i]!) || scan.depth[i] !== depth) {
      i++;
      continue;
    }
    const rest = src.slice(i, close);
    const attr = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=(?!=)[ \t]*/.exec(rest);
    if (attr) {
      const start = i + attr[0].length;
      const end = valueEnd(src, start, close, scan);
      attributes[attr[1]!] = parseAttributeValue(stripTrailingComment(src, start, end, scan));
      i = end + 1;
      continue;
    }
    const block = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*(?:"[^"\n]*"[ \t]*)*\{/.exec(rest);
    if (block) {
      const blockOpen = i + block[0].length - 1;
      let blockClose = close;
      for (let j = blockOpen + 1; j < close; j++) {
        if (scan.code[j] && src[j] === "}" && scan.depth[j] === depth + 1) {
          blockClose = j;
          break;
        }
      }
      const raw = normalizeHcl(src.slice(i, blockClose + 1));
      const name = block[1]!;
      nestedBlocks[name] = nestedBlocks[name] ? `${nestedBlocks[name]} ${raw}` : raw;
      i = blockClose + 1;
      continue;
    }
    // Something we do not recognise (a stray token): skip the line.
    const nl = src.indexOf("\n", i);
    i = nl === -1 || nl > close ? close : nl + 1;
  }
  return { attributes, nestedBlocks };
}

/** Parse one `.tf` file's top-level resource, module and moved blocks. */
export function parseHclFile(src: string): ParsedHclFile {
  const out: ParsedHclFile = { resources: [], moves: [], modules: [], errors: [] };
  const scan = scanHcl(src);
  const seen = new Set<string>();
  HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER.exec(src)) !== null) {
    const keywordAt = m.index + m[1]!.length + m[2]!.length;
    if (!scan.code[keywordAt] || scan.depth[keywordAt] !== 0) continue;
    const open = m.index + m[0].length - 1;
    let close = -1;
    for (let i = open + 1; i < src.length; i++) {
      if (scan.code[i] && src[i] === "}" && scan.depth[i] === 1) {
        close = i;
        break;
      }
    }
    const line = lineOf(src, keywordAt);
    if (close === -1) {
      out.errors.push(`The block on line ${line} is not closed.`);
      break;
    }
    const keyword = m[3]!;
    if (keyword === "module") {
      if (m[4]) out.modules.push({ name: m[4], line });
    } else if (keyword === "moved") {
      const { attributes } = parseBody(src, open, close, scan);
      const from = attributes["from"]?.raw;
      const to = attributes["to"]?.raw;
      if (from && to) out.moves.push({ from: from.trim(), to: to.trim() });
    } else if (m[4] && m[5]) {
      const address = `${m[4]}.${m[5]}`;
      if (seen.has(address)) {
        out.errors.push(`${address} is declared more than once.`);
      } else {
        seen.add(address);
        const body = parseBody(src, open, close, scan);
        out.resources.push({ type: m[4], name: m[5], address, line, ...body });
      }
    }
    HEADER.lastIndex = close + 1;
  }
  return out;
}

/** Literal attributes only, as plain values. */
export function literalAttributes(
  block: HclResourceBlock,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(block.attributes)) {
    if (value.kind === "string" || value.kind === "number" || value.kind === "bool") {
      out[key] = value.value;
    }
  }
  return out;
}

/**
 * How many instances a block declares: its literal `count`, 1 without one,
 * and null when it uses `for_each` or a computed count (unknown until plan).
 */
export function blockCount(block: HclResourceBlock): number | null {
  if (block.attributes["for_each"]) return null;
  const count = block.attributes["count"];
  if (!count) return 1;
  return count.kind === "number" && Number.isInteger(count.value) && count.value >= 0
    ? count.value
    : null;
}

/** Top-level attributes and nested blocks whose text differs between two versions. */
export function changedAttributes(before: HclResourceBlock, after: HclResourceBlock): string[] {
  const keys = new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = before.attributes[key];
    const b = after.attributes[key];
    if (!a || !b || normalizeHcl(a.raw) !== normalizeHcl(b.raw)) changed.push(key);
  }
  const blocks = new Set([...Object.keys(before.nestedBlocks), ...Object.keys(after.nestedBlocks)]);
  for (const key of blocks) {
    if (before.nestedBlocks[key] !== after.nestedBlocks[key]) changed.push(key);
  }
  return changed.sort();
}
