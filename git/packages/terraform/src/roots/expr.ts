/**
 * A small, safe evaluator for the HCL expressions a configuration estimate
 * needs: `count`, `for_each`, and attribute values set from literals,
 * variables with defaults and locals.
 *
 * It is an interpreter of a subset, never `eval`: literals, `var.*`,
 * `local.*`, the conditional, comparison, logic and arithmetic operators,
 * indexing, list and object constructors, string templates, and a short list
 * of pure built-in functions. Anything else (a resource's attribute, a data
 * source, `path.*`, a `for` expression, a function it does not know) is
 * {@link UNKNOWN}, which spreads through whatever uses it. Unknown is an
 * answer, not a failure: the caller says the value could not be read.
 *
 * Work is bounded: every evaluation has a step budget and a nesting limit, so
 * a hostile file costs a few milliseconds and an unknown.
 */

export const UNKNOWN: unique symbol = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

export type HclValue =
  | string
  | number
  | boolean
  | null
  | readonly HclValue[]
  | { readonly [key: string]: HclValue }
  | Unknown;

/** Where `var.*`, `local.*` and the per-instance names come from. */
export interface Scope {
  variable(name: string): HclValue;
  local(name: string): HclValue;
  /** `each.key` / `each.value`, when the instance is known. */
  readonly each?: { readonly key: HclValue; readonly value: HclValue } | undefined;
  /** `count.index`, when the instance is known. */
  readonly countIndex?: number | undefined;
}

export const EMPTY_SCOPE: Scope = { variable: () => UNKNOWN, local: () => UNKNOWN };

/** Steps one evaluation may take; a step is roughly a token. */
const MAX_STEPS = 20_000;
const MAX_DEPTH = 64;
/** The longest string or collection a value may be; past it the value is unknown. */
const MAX_STRING = 64 * 1024;
const MAX_ITEMS = 10_000;

class EvalError extends Error {}

export function isUnknown(value: HclValue): value is Unknown {
  return value === UNKNOWN;
}

function isObject(value: HclValue): value is { readonly [key: string]: HclValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value holds an unknown anywhere inside it. */
export function hasUnknown(value: HclValue, depth = 0): boolean {
  if (value === UNKNOWN) return true;
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => hasUnknown(item, depth + 1));
  if (isObject(value)) return Object.values(value).some((item) => hasUnknown(item, depth + 1));
  return false;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly parts: readonly (string | { readonly expr: string })[] }
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string }
  | { readonly kind: "opaque" };

const PUNCTUATION = [
  "...",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "=>",
  "?",
  ":",
  "<",
  ">",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  "=",
];

/** The index past a `${ }` or `%{ }` started at `i` (`source[i]` is `{`). */
function skipBraces(source: string, i: number): number {
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    const ch = source[j]!;
    if (ch === '"') {
      // A string inside a template: skip it whole, templates and all.
      j = skipQuoted(source, j) - 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  throw new EvalError("A template does not end");
}

/** The index past the quoted string starting at `i`. */
function skipQuoted(source: string, i: number): number {
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j]!;
    if (ch === "\\") j++;
    else if (ch === '"') return j + 1;
    else if ((ch === "$" || ch === "%") && source[j + 1] === "{" && source[j - 1] !== ch) {
      j = skipBraces(source, j + 1) - 1;
    }
  }
  throw new EvalError("A string does not end");
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

/** A quoted string at `i` as literal parts and template expressions. */
function readString(source: string, i: number): { token: Token; end: number } {
  const parts: (string | { expr: string })[] = [];
  let text = "";
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === '"') {
      if (text !== "") parts.push(text);
      return { token: { kind: "string", parts }, end: j + 1 };
    }
    if (ch === "\\") {
      const next = source[j + 1] ?? "";
      if (next === "u" || next === "U") {
        const width = next === "u" ? 4 : 8;
        const hex = source.slice(j + 2, j + 2 + width);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) {
          throw new EvalError("A bad escape");
        }
        text += String.fromCodePoint(Number.parseInt(hex, 16));
        j += 2 + width;
        continue;
      }
      text += ESCAPES[next] ?? next;
      j += 2;
      continue;
    }
    if ((ch === "$" || ch === "%") && source[j + 1] === "{") {
      if (source[j + 2] === undefined) throw new EvalError("A template does not end");
      // `$${` and `%%{` are the literal characters.
      if (source[j - 1] === ch && text.endsWith(ch)) {
        text += "{";
        j += 2;
        continue;
      }
      const end = skipBraces(source, j + 1);
      if (text !== "") parts.push(text);
      text = "";
      // A directive (`%{ if }`) is not something this reads.
      parts.push(ch === "%" ? { expr: "" } : { expr: source.slice(j + 2, end - 1) });
      j = end;
      continue;
    }
    text += ch;
    j++;
  }
  throw new EvalError("A string does not end");
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#" || source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "<" && source[i + 1] === "<") {
      // A heredoc: its text is not something this reads.
      const match = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(source.slice(i, i + 256));
      if (match) {
        const marker = match[1]!;
        let lineStart = i + match[0].length;
        let end = source.length;
        while (lineStart < source.length) {
          let lineEnd = source.indexOf("\n", lineStart);
          if (lineEnd === -1) lineEnd = source.length;
          if (source.slice(lineStart, lineEnd).trim() === marker) {
            end = lineEnd;
            break;
          }
          lineStart = lineEnd + 1;
        }
        tokens.push({ kind: "opaque" });
        i = end;
        continue;
      }
    }
    if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i, i + 64))!;
      tokens.push({ kind: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      // As HCL scans it: a dash inside a name is part of it (`a-b` is one name).
      while (j < source.length && /[A-Za-z0-9_-]/.test(source[j]!)) j++;
      tokens.push({ kind: "ident", value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      const { token, end } = readString(source, i);
      tokens.push(token);
      i = end;
      continue;
    }
    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (!punct) throw new EvalError(`Unexpected ${JSON.stringify(ch)}`);
    tokens.push({ kind: "punct", value: punct });
    i += punct.length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Evaluation, straight from the tokens (no tree is kept)
// ---------------------------------------------------------------------------

type Fn = (args: HclValue[]) => HclValue;

function num(value: HclValue): number | Unknown {
  if (value === UNKNOWN) return UNKNOWN;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (typeof value === "boolean") throw new EvalError("A number was expected");
  throw new EvalError("A number was expected");
}

function bool(value: HclValue): boolean | Unknown {
  if (value === UNKNOWN) return UNKNOWN;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new EvalError("A bool was expected");
}

function str(value: HclValue): string | Unknown {
  if (value === UNKNOWN) return UNKNOWN;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new EvalError("A string was expected");
}

function list(value: HclValue): readonly HclValue[] | Unknown {
  if (value === UNKNOWN) return UNKNOWN;
  if (Array.isArray(value)) return value;
  throw new EvalError("A list was expected");
}

function equal(a: HclValue, b: HclValue): boolean | Unknown {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (hasUnknown(a) || hasUnknown(b)) return UNKNOWN;
  return JSON.stringify(a) === JSON.stringify(b);
}

const FUNCTIONS: Record<string, Fn> = {
  length: ([value]) => {
    if (value === UNKNOWN || value === undefined) return UNKNOWN;
    if (typeof value === "string") return [...value].length;
    if (Array.isArray(value)) return value.length;
    if (isObject(value)) return Object.keys(value).length;
    throw new EvalError("length of what");
  },
  toset: ([value]) => {
    const items = list(value ?? UNKNOWN);
    if (items === UNKNOWN) return UNKNOWN;
    if (items.some((item) => hasUnknown(item))) return UNKNOWN;
    const seen = new Map<string, HclValue>();
    for (const item of items) seen.set(JSON.stringify(item), item);
    return [...seen.values()];
  },
  tolist: ([value]) => list(value ?? UNKNOWN),
  tomap: ([value]) => {
    if (value === UNKNOWN || value === undefined) return UNKNOWN;
    if (isObject(value)) return value;
    throw new EvalError("tomap of what");
  },
  keys: ([value]) => {
    if (value === UNKNOWN || value === undefined) return UNKNOWN;
    if (isObject(value)) return Object.keys(value).sort();
    throw new EvalError("keys of what");
  },
  values: ([value]) => {
    if (value === UNKNOWN || value === undefined) return UNKNOWN;
    if (isObject(value)) {
      return Object.keys(value)
        .sort()
        .map((key) => value[key]!);
    }
    throw new EvalError("values of what");
  },
  lookup: ([map, key, fallback]) => {
    if (map === UNKNOWN || key === UNKNOWN || map === undefined || key === undefined) {
      return UNKNOWN;
    }
    const name = str(key);
    if (name === UNKNOWN) return UNKNOWN;
    if (!isObject(map)) throw new EvalError("lookup in what");
    if (name in map) return map[name]!;
    if (fallback === undefined) throw new EvalError("No such key");
    return fallback;
  },
  coalesce: (args) => {
    for (const arg of args) {
      if (arg === UNKNOWN) return UNKNOWN;
      if (arg !== null && arg !== "") return arg;
    }
    throw new EvalError("Nothing to coalesce");
  },
  concat: (args) => {
    const out: HclValue[] = [];
    for (const arg of args) {
      const items = list(arg);
      if (items === UNKNOWN) return UNKNOWN;
      out.push(...items);
    }
    return out;
  },
  merge: (args) => {
    const out: Record<string, HclValue> = {};
    for (const arg of args) {
      if (arg === UNKNOWN) return UNKNOWN;
      if (arg === null) continue;
      if (!isObject(arg)) throw new EvalError("merge of what");
      Object.assign(out, arg);
    }
    return out;
  },
  contains: ([items, value]) => {
    const all = list(items ?? UNKNOWN);
    if (all === UNKNOWN || value === undefined) return UNKNOWN;
    let unknown = false;
    for (const item of all) {
      const same = equal(item, value);
      if (same === true) return true;
      if (same === UNKNOWN) unknown = true;
    }
    return unknown ? UNKNOWN : false;
  },
  max: (args) => {
    const numbers = args.map(num);
    if (numbers.some((n) => n === UNKNOWN)) return UNKNOWN;
    return Math.max(...(numbers as number[]));
  },
  min: (args) => {
    const numbers = args.map(num);
    if (numbers.some((n) => n === UNKNOWN)) return UNKNOWN;
    return Math.min(...(numbers as number[]));
  },
  abs: ([value]) => {
    const n = num(value ?? UNKNOWN);
    return n === UNKNOWN ? UNKNOWN : Math.abs(n);
  },
  ceil: ([value]) => {
    const n = num(value ?? UNKNOWN);
    return n === UNKNOWN ? UNKNOWN : Math.ceil(n);
  },
  floor: ([value]) => {
    const n = num(value ?? UNKNOWN);
    return n === UNKNOWN ? UNKNOWN : Math.floor(n);
  },
  lower: ([value]) => {
    const s = str(value ?? UNKNOWN);
    return s === UNKNOWN ? UNKNOWN : s.toLowerCase();
  },
  upper: ([value]) => {
    const s = str(value ?? UNKNOWN);
    return s === UNKNOWN ? UNKNOWN : s.toUpperCase();
  },
  trimspace: ([value]) => {
    const s = str(value ?? UNKNOWN);
    return s === UNKNOWN ? UNKNOWN : s.trim();
  },
  tostring: ([value]) => str(value ?? UNKNOWN),
  tonumber: ([value]) => num(value ?? UNKNOWN),
  tobool: ([value]) => bool(value ?? UNKNOWN),
  element: ([items, index]) => {
    const all = list(items ?? UNKNOWN);
    const i = num(index ?? UNKNOWN);
    if (all === UNKNOWN || i === UNKNOWN) return UNKNOWN;
    if (all.length === 0) throw new EvalError("element of nothing");
    return all[((Math.floor(i) % all.length) + all.length) % all.length]!;
  },
  join: ([separator, items]) => {
    const sep = str(separator ?? UNKNOWN);
    const all = list(items ?? UNKNOWN);
    if (sep === UNKNOWN || all === UNKNOWN) return UNKNOWN;
    const parts = all.map(str);
    if (parts.some((part) => part === UNKNOWN)) return UNKNOWN;
    return parts.join(sep);
  },
  split: ([separator, value]) => {
    const sep = str(separator ?? UNKNOWN);
    const s = str(value ?? UNKNOWN);
    if (sep === UNKNOWN || s === UNKNOWN) return UNKNOWN;
    return s.split(sep);
  },
  distinct: ([items]) => FUNCTIONS["toset"]!([items ?? UNKNOWN]),
  compact: ([items]) => {
    const all = list(items ?? UNKNOWN);
    if (all === UNKNOWN) return UNKNOWN;
    if (all.some((item) => item === UNKNOWN)) return UNKNOWN;
    return all.filter((item) => item !== null && item !== "");
  },
  flatten: ([items]) => {
    const all = list(items ?? UNKNOWN);
    if (all === UNKNOWN) return UNKNOWN;
    const out: HclValue[] = [];
    const walk = (value: HclValue, depth: number) => {
      if (depth > MAX_DEPTH) throw new EvalError("Too deep");
      if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
      else out.push(value);
    };
    walk(all, 0);
    return out.some((item) => item === UNKNOWN) ? UNKNOWN : out;
  },
  startswith: ([value, prefix]) => {
    const s = str(value ?? UNKNOWN);
    const p = str(prefix ?? UNKNOWN);
    return s === UNKNOWN || p === UNKNOWN ? UNKNOWN : s.startsWith(p);
  },
  endswith: ([value, suffix]) => {
    const s = str(value ?? UNKNOWN);
    const p = str(suffix ?? UNKNOWN);
    return s === UNKNOWN || p === UNKNOWN ? UNKNOWN : s.endsWith(p);
  },
};

class Evaluator {
  private pos = 0;
  private steps = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly scope: Scope,
  ) {}

  run(): HclValue {
    const value = this.expression();
    if (this.pos !== this.tokens.length) throw new EvalError("Trailing text");
    return value;
  }

  private step(): void {
    this.steps++;
    if (this.steps > MAX_STEPS) throw new EvalError("Too much work");
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === "punct" && token.value === value;
  }

  private take(value: string): void {
    if (!this.isPunct(value)) throw new EvalError(`Expected ${value}`);
    this.pos++;
  }

  private nested<T>(work: () => T): T {
    this.depth++;
    if (this.depth > MAX_DEPTH) throw new EvalError("Too deeply nested");
    try {
      return work();
    } finally {
      this.depth--;
    }
  }

  private expression(): HclValue {
    return this.nested(() => {
      const condition = this.or();
      if (!this.isPunct("?")) return condition;
      this.pos++;
      const whenTrue = this.expression();
      this.take(":");
      const whenFalse = this.expression();
      const test = bool(condition);
      if (test === UNKNOWN) {
        return equal(whenTrue, whenFalse) === true ? whenTrue : UNKNOWN;
      }
      return test ? whenTrue : whenFalse;
    });
  }

  private or(): HclValue {
    let left = this.and();
    while (this.isPunct("||")) {
      this.pos++;
      const right = this.and();
      const a = bool(left);
      const b = bool(right);
      left = a === true || b === true ? true : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : false;
    }
    return left;
  }

  private and(): HclValue {
    let left = this.equality();
    while (this.isPunct("&&")) {
      this.pos++;
      const right = this.equality();
      const a = bool(left);
      const b = bool(right);
      left = a === false || b === false ? false : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : true;
    }
    return left;
  }

  private equality(): HclValue {
    let left = this.comparison();
    while (this.isPunct("==") || this.isPunct("!=")) {
      const negate = this.isPunct("!=");
      this.pos++;
      const same = equal(left, this.comparison());
      left = same === UNKNOWN ? UNKNOWN : negate ? !same : same;
    }
    return left;
  }

  private comparison(): HclValue {
    let left = this.additive();
    for (;;) {
      const op = (["<=", ">=", "<", ">"] as const).find((p) => this.isPunct(p));
      if (!op) return left;
      this.pos++;
      const a = num(left);
      const b = num(this.additive());
      if (a === UNKNOWN || b === UNKNOWN) left = UNKNOWN;
      else left = op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
    }
  }

  private additive(): HclValue {
    let left = this.multiplicative();
    while (this.isPunct("+") || this.isPunct("-")) {
      const plus = this.isPunct("+");
      this.pos++;
      const a = num(left);
      const b = num(this.multiplicative());
      left = a === UNKNOWN || b === UNKNOWN ? UNKNOWN : plus ? a + b : a - b;
    }
    return left;
  }

  private multiplicative(): HclValue {
    let left = this.unary();
    for (;;) {
      const op = (["*", "/", "%"] as const).find((p) => this.isPunct(p));
      if (!op) return left;
      this.pos++;
      const a = num(left);
      const b = num(this.unary());
      if (a === UNKNOWN || b === UNKNOWN) left = UNKNOWN;
      else if (op !== "*" && b === 0) throw new EvalError("Division by zero");
      else left = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
  }

  private unary(): HclValue {
    this.step();
    if (this.isPunct("!")) {
      this.pos++;
      const value = bool(this.nested(() => this.unary()));
      return value === UNKNOWN ? UNKNOWN : !value;
    }
    if (this.isPunct("-")) {
      this.pos++;
      const value = num(this.nested(() => this.unary()));
      return value === UNKNOWN ? UNKNOWN : -value;
    }
    return this.postfix();
  }

  private postfix(): HclValue {
    let value = this.primary();
    for (;;) {
      this.step();
      if (this.isPunct(".")) {
        this.pos++;
        const next = this.peek();
        if (next?.kind === "ident") {
          this.pos++;
          value = this.index(value, next.value);
        } else if (next?.kind === "number") {
          this.pos++;
          value = this.index(value, next.value);
        } else if (this.isPunct("*")) {
          // A splat: which elements' attributes, Terraform decides.
          this.pos++;
          value = UNKNOWN;
        } else throw new EvalError("Expected a name");
      } else if (this.isPunct("[")) {
        this.pos++;
        if (this.isPunct("*")) {
          this.pos++;
          this.take("]");
          value = UNKNOWN;
          continue;
        }
        const key = this.expression();
        this.take("]");
        value = this.index(value, key);
      } else return value;
    }
  }

  private index(value: HclValue, key: HclValue): HclValue {
    if (value === UNKNOWN || key === UNKNOWN) return UNKNOWN;
    if (Array.isArray(value)) {
      const i = num(key);
      if (i === UNKNOWN) return UNKNOWN;
      const item = value[i];
      if (item === undefined) throw new EvalError("No such element");
      return item;
    }
    if (isObject(value)) {
      const name = str(key);
      if (name === UNKNOWN) return UNKNOWN;
      if (!(name in value)) throw new EvalError("No such attribute");
      return value[name]!;
    }
    throw new EvalError("Indexing what");
  }

  private template(token: Extract<Token, { kind: "string" }>): HclValue {
    let out = "";
    for (const part of token.parts) {
      if (typeof part === "string") out += part;
      else {
        if (part.expr.trim() === "") return UNKNOWN;
        const inner = evaluateTokens(tokenize(part.expr.replace(/^~|~$/g, "")), this.scope);
        const piece = str(inner);
        if (piece === UNKNOWN) return UNKNOWN;
        out += piece;
      }
      if (out.length > MAX_STRING) return UNKNOWN;
    }
    return out;
  }

  private primary(): HclValue {
    this.step();
    const token = this.peek();
    if (!token) throw new EvalError("An expression was expected");
    this.pos++;
    switch (token.kind) {
      case "number":
        return token.value;
      case "string":
        return this.template(token);
      case "opaque":
        return UNKNOWN;
      case "ident":
        return this.name(token.value);
      case "punct":
        break;
    }
    if (token.value === "(") {
      const value = this.expression();
      this.take(")");
      return value;
    }
    if (token.value === "[") return this.tuple();
    if (token.value === "{") return this.object();
    throw new EvalError(`Unexpected ${token.value}`);
  }

  private name(word: string): HclValue {
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (this.isPunct("(")) return this.call(word);
    if (this.isPunct(":") && this.isPunct(":", 1)) {
      // A provider-defined function (`provider::aws::arn_parse`): unknown.
      this.skipCall();
      return UNKNOWN;
    }
    const attribute = (): string | null => {
      if (!this.isPunct(".")) return null;
      const next = this.peek(1);
      if (next?.kind !== "ident") return null;
      this.pos += 2;
      return next.value;
    };
    switch (word) {
      case "var": {
        const name = attribute();
        return name === null ? UNKNOWN : this.scope.variable(name);
      }
      case "local": {
        const name = attribute();
        return name === null ? UNKNOWN : this.scope.local(name);
      }
      case "each": {
        const name = attribute();
        const each = this.scope.each;
        if (!each) return UNKNOWN;
        return name === "key" ? each.key : name === "value" ? each.value : UNKNOWN;
      }
      case "count": {
        const name = attribute();
        return name === "index" && this.scope.countIndex !== undefined
          ? this.scope.countIndex
          : UNKNOWN;
      }
      default:
        // `path.*`, `terraform.*`, resources, data sources, modules: what a run decides.
        return UNKNOWN;
    }
  }

  private skipCall(): void {
    while (this.pos < this.tokens.length && !this.isPunct("(")) this.pos++;
    if (this.isPunct("(")) this.skipGroup("(", ")");
  }

  private skipGroup(open: string, close: string): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      this.step();
      if (this.isPunct(open)) depth++;
      else if (this.isPunct(close)) {
        depth--;
        if (depth === 0) {
          this.pos++;
          return;
        }
      }
      this.pos++;
    }
    throw new EvalError(`A ${open} is never closed`);
  }

  private call(name: string): HclValue {
    this.take("(");
    const args: HclValue[] = [];
    let expanded = false;
    // `try` and `can` turn an error in their arguments into an answer.
    const guarded = name === "try" || name === "can";
    const errors: boolean[] = [];
    while (!this.isPunct(")")) {
      if (guarded) {
        const start = this.pos;
        try {
          args.push(this.expression());
          errors.push(false);
        } catch (error) {
          if (!(error instanceof EvalError) || error.message === "Too much work") throw error;
          this.pos = start;
          this.skipArgument();
          args.push(UNKNOWN);
          errors.push(true);
        }
      } else args.push(this.expression());
      if (this.isPunct("...")) {
        this.pos++;
        expanded = true;
      }
      if (this.isPunct(",")) this.pos++;
      else break;
    }
    this.take(")");
    if (expanded) return UNKNOWN;
    if (name === "try") {
      for (const [i, arg] of args.entries()) {
        if (errors[i]) continue;
        // An unknown might have been an error in a run: nothing after it can be chosen.
        return arg;
      }
      throw new EvalError("No argument of try worked");
    }
    if (name === "can") {
      if (errors[0]) return false;
      return args[0] === UNKNOWN ? UNKNOWN : true;
    }
    const fn = FUNCTIONS[name];
    if (!fn) return UNKNOWN;
    const value = fn(args);
    if (Array.isArray(value) && value.length > MAX_ITEMS) return UNKNOWN;
    if (typeof value === "string" && value.length > MAX_STRING) return UNKNOWN;
    return value;
  }

  /** Moves past one argument of a call, to the `,` or `)` that ends it. */
  private skipArgument(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      this.step();
      const token = this.peek()!;
      if (token.kind === "punct") {
        if (token.value === "(" || token.value === "[" || token.value === "{") depth++;
        else if (token.value === ")" || token.value === "]" || token.value === "}") {
          if (depth === 0) return;
          depth--;
        } else if (token.value === "," && depth === 0) return;
      }
      this.pos++;
    }
  }

  private tuple(): HclValue {
    if (this.peek()?.kind === "ident" && (this.peek() as { value: string }).value === "for") {
      this.pos--;
      this.skipGroup("[", "]");
      return UNKNOWN;
    }
    const items: HclValue[] = [];
    while (!this.isPunct("]")) {
      items.push(this.expression());
      if (items.length > MAX_ITEMS) throw new EvalError("Too many items");
      if (this.isPunct(",")) this.pos++;
      else break;
    }
    this.take("]");
    return items;
  }

  private object(): HclValue {
    if (this.peek()?.kind === "ident" && (this.peek() as { value: string }).value === "for") {
      this.pos--;
      this.skipGroup("{", "}");
      return UNKNOWN;
    }
    const out: Record<string, HclValue> = {};
    let unknownKey = false;
    while (!this.isPunct("}")) {
      let key: HclValue;
      const token = this.peek();
      const next = this.peek(1);
      if (
        token?.kind === "ident" &&
        next?.kind === "punct" &&
        (next.value === "=" || next.value === ":")
      ) {
        key = token.value;
        this.pos++;
      } else key = this.expression();
      if (this.isPunct("=") || this.isPunct(":")) this.pos++;
      else throw new EvalError("Expected = in an object");
      const value = this.expression();
      const name = key === UNKNOWN ? UNKNOWN : str(key);
      if (name === UNKNOWN) unknownKey = true;
      else out[name] = value;
      if (Object.keys(out).length > MAX_ITEMS) throw new EvalError("Too many items");
      if (this.isPunct(",")) this.pos++;
    }
    this.take("}");
    return unknownKey ? UNKNOWN : out;
  }
}

function evaluateTokens(tokens: readonly Token[], scope: Scope): HclValue {
  return new Evaluator(tokens, scope).run();
}

/**
 * The value of an expression as written in a file, in `scope`. Anything it
 * cannot read, anything that would fail in Terraform, and anything over the
 * budget is {@link UNKNOWN}. Never throws.
 */
export function evaluate(expression: string, scope: Scope = EMPTY_SCOPE): HclValue {
  try {
    return evaluateTokens(tokenize(expression), scope);
  } catch {
    return UNKNOWN;
  }
}

/** A plain JSON value (from a `.tf.json` file or a `.tfvars.json`) as an HCL value. */
export function fromJson(value: unknown, depth = 0): HclValue {
  if (depth > MAX_DEPTH) return UNKNOWN;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNKNOWN;
  if (Array.isArray(value)) return value.map((item) => fromJson(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, HclValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = fromJson(item, depth + 1);
    }
    return out;
  }
  return UNKNOWN;
}
