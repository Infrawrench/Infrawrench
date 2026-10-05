/**
 * The pricing expression language: a small, sandboxed language for custom
 * billing rules.
 *
 * ```
 * if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1
 * if provider == "gcp" then max(cost, list_cost) else cost * 1.05
 * cost + usage * 0.002
 * ```
 *
 * ## What it is not
 *
 * It is not SQL and it is not JavaScript. Nothing a user writes is ever handed
 * to a database, to `eval`, to `Function`, or to any other interpreter. The
 * text is tokenized and parsed here into a small tree, the tree is type-checked
 * against a closed list of fields and functions, and evaluation is a recursive
 * walk over that tree in this file. The only things an expression can read are
 * the fields of one cost line ({@link PricingExpressionContext}), and the only
 * thing it can produce is one number.
 *
 * That closure is the security property, and it is structural rather than a
 * filter: there is no syntax for member access beyond `tag.<key>`, no syntax
 * for calling anything but the functions in {@link FUNCTIONS}, and tag lookups
 * go through a `Map`, so `tag.__proto__` or `tag.constructor` is just a tag
 * key nobody set and reads as the empty string.
 *
 * ## Bounds
 *
 * Every dimension a hostile input could grow is capped before it can cost
 * anything: source length ({@link PRICING_EXPRESSION_LIMITS.maxLength}), token
 * count, nesting depth (checked while parsing, so a thousand opening brackets
 * fail fast instead of overflowing the stack), node count, list length and
 * string length. Evaluation is a single pass over a tree whose size is
 * already bounded, with no loops and no recursion a user controls, so it
 * terminates in time linear in the expression's size.
 *
 * ## Semantics, stated once
 *
 * - The whole expression evaluates to the line's **new cost**. `if c then x`
 *   with no `else` leaves a line it does not match unchanged (`else cost`).
 * - `cost` is the line's running amount at this rule's position in the
 *   evaluation order, after every earlier rule. `collected` is what the
 *   provider charged, before any rule.
 * - `list_cost` is the provider's public on-demand price for the line when the
 *   provider reported one, and `collected` otherwise; `has_list_price` says
 *   which. Using `list_cost` blindly is therefore never worse than `collected`.
 * - Comparisons between strings are exact and case-sensitive. `lower()` exists
 *   for the cases where that is wrong.
 * - A result that is not a finite number (division by zero, overflow) is a
 *   **runtime error** for that line: the line keeps its previous cost and the
 *   error is reported, rather than an invoice line silently becoming zero or
 *   infinity.
 */

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export const PRICING_EXPRESSION_LIMITS = {
  /** Characters of source. A rule anyone can read fits comfortably. */
  maxLength: 2000,
  /** Tokens after lexing. */
  maxTokens: 600,
  /** Nesting depth of the parse tree. */
  maxDepth: 32,
  /** Nodes in the parse tree. */
  maxNodes: 400,
  /** Elements in one `[...]` list. */
  maxListLength: 200,
  /** Characters in one string literal. */
  maxStringLength: 256,
  /** Largest magnitude a result may have before it is treated as an error. */
  maxResultMagnitude: 1e12,
} as const;

/* ------------------------------------------------------------------ *
 * The vocabulary: fields and functions
 * ------------------------------------------------------------------ */

export type PricingValueType = "number" | "string" | "boolean";

/** One field an expression can read. */
export interface PricingExpressionField {
  name: string;
  type: PricingValueType;
  description: string;
}

/**
 * Every field an expression can read, in the order the editor lists them.
 * `tag.<key>` is the one parameterised field and is described separately.
 */
export const PRICING_EXPRESSION_FIELDS: readonly PricingExpressionField[] = [
  {
    name: "cost",
    type: "number",
    description: "This line's amount so far, after every earlier rule.",
  },
  {
    name: "collected",
    type: "number",
    description: "What the provider charged for this line, before any rule.",
  },
  {
    name: "list_cost",
    type: "number",
    description:
      "The provider's public on-demand price for this line, or the collected amount when the provider reports none.",
  },
  {
    name: "has_list_price",
    type: "boolean",
    description: "Whether the provider reported a public price for this line.",
  },
  { name: "usage", type: "number", description: "The usage quantity behind this line." },
  { name: "unit", type: "string", description: "The unit of `usage`, e.g. Hrs or GB-Mo." },
  { name: "service", type: "string", description: "The provider's service name." },
  { name: "provider", type: "string", description: "The provider id, e.g. aws or gcp." },
  { name: "account", type: "string", description: "The cloud account's id." },
  { name: "account_name", type: "string", description: "The cloud account's display name." },
  { name: "region", type: "string", description: "The provider region." },
  {
    name: "charge_type",
    type: "string",
    description: "usage, commitment_covered_usage, credit, tax, and so on.",
  },
  { name: "currency", type: "string", description: "The line's currency, e.g. USD." },
  { name: "month", type: "string", description: "The calendar month, as YYYY-MM." },
  {
    name: "customer",
    type: "string",
    description: "The managed account (customer) being invoiced, or empty.",
  },
] as const;

const FIELD_TYPES = new Map<string, PricingValueType>(
  PRICING_EXPRESSION_FIELDS.map((f) => [f.name, f.type]),
);

interface FunctionSpec {
  /** Accepted argument types, or one type repeated for variadic functions. */
  args: PricingValueType[];
  variadic?: boolean;
  minArgs: number;
  maxArgs: number;
  returns: PricingValueType;
  description: string;
}

/** The complete set of callable functions. Nothing else can be called. */
export const PRICING_EXPRESSION_FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  min: {
    args: ["number"],
    variadic: true,
    minArgs: 2,
    maxArgs: 16,
    returns: "number",
    description: "The smallest of its arguments.",
  },
  max: {
    args: ["number"],
    variadic: true,
    minArgs: 2,
    maxArgs: 16,
    returns: "number",
    description: "The largest of its arguments.",
  },
  abs: {
    args: ["number"],
    minArgs: 1,
    maxArgs: 1,
    returns: "number",
    description: "The absolute value.",
  },
  round: {
    args: ["number", "number"],
    minArgs: 1,
    maxArgs: 2,
    returns: "number",
    description: "Round to a number of decimal places (default 2, at most 6).",
  },
  contains: {
    args: ["string", "string"],
    minArgs: 2,
    maxArgs: 2,
    returns: "boolean",
    description: "Whether the first string contains the second.",
  },
  starts_with: {
    args: ["string", "string"],
    minArgs: 2,
    maxArgs: 2,
    returns: "boolean",
    description: "Whether the first string starts with the second.",
  },
  ends_with: {
    args: ["string", "string"],
    minArgs: 2,
    maxArgs: 2,
    returns: "boolean",
    description: "Whether the first string ends with the second.",
  },
  lower: {
    args: ["string"],
    minArgs: 1,
    maxArgs: 1,
    returns: "string",
    description: "The string in lower case.",
  },
  has_tag: {
    args: ["string"],
    minArgs: 1,
    maxArgs: 1,
    returns: "boolean",
    description: "Whether the line carries the tag at all.",
  },
};

const FUNCTIONS = new Map(Object.entries(PRICING_EXPRESSION_FUNCTIONS));

const KEYWORDS = new Set(["if", "then", "else", "and", "or", "not", "in", "true", "false"]);

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * A parse or type error, with the zero-based character offset it was found
 * at. The message is a sentence a person can act on; the position lets an
 * editor point at the spot.
 */
export class PricingExpressionError extends Error {
  override readonly name = "PricingExpressionError";

  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * Lexer
 * ------------------------------------------------------------------ */

type TokenKind = "number" | "string" | "ident" | "keyword" | "op" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">="]);
const ONE_CHAR_OPS = new Set(["<", ">", "+", "-", "*", "/", "(", ")", "[", "]", ",", "."]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string, pos: number) => {
    tokens.push({ kind, value, pos });
    if (tokens.length > PRICING_EXPRESSION_LIMITS.maxTokens) {
      throw new PricingExpressionError(
        `An expression can have at most ${PRICING_EXPRESSION_LIMITS.maxTokens} tokens.`,
        pos,
      );
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      const text = m![0];
      if (isIdentStart(source[i + text.length] ?? "")) {
        throw new PricingExpressionError(`"${text}${source[i + text.length]}" is not a number.`, i);
      }
      push("number", text, i);
      i += text.length;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      let value = "";
      i++;
      for (;;) {
        if (i >= source.length) {
          throw new PricingExpressionError("This string is never closed.", start);
        }
        const c = source[i]!;
        if (c === quote) {
          i++;
          break;
        }
        if (c === "\\") {
          const next = source[i + 1];
          if (next === quote || next === "\\") {
            value += next;
            i += 2;
            continue;
          }
          throw new PricingExpressionError(
            `Only \\${quote} and \\\\ can be escaped inside a string.`,
            i,
          );
        }
        if (c === "\n" || c === "\r") {
          throw new PricingExpressionError("A string cannot span lines.", start);
        }
        value += c;
        i++;
        if (value.length > PRICING_EXPRESSION_LIMITS.maxStringLength) {
          throw new PricingExpressionError(
            `A string can be at most ${PRICING_EXPRESSION_LIMITS.maxStringLength} characters.`,
            start,
          );
        }
      }
      push("string", value, start);
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      const word = source.slice(start, i);
      push(KEYWORDS.has(word) ? "keyword" : "ident", word, start);
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("op", two, i);
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      push("op", ch, i);
      i++;
      continue;
    }
    if (ch === "=") {
      throw new PricingExpressionError('Use "==" to compare, not "=".', i);
    }
    if (two === "&&" || two === "||") {
      throw new PricingExpressionError(
        `Use "${two === "&&" ? "and" : "or"}" instead of "${two}".`,
        i,
      );
    }
    if (ch === "!") {
      throw new PricingExpressionError('Use "not" instead of "!".', i);
    }
    throw new PricingExpressionError(`"${ch}" is not allowed in a pricing expression.`, i);
  }
  tokens.push({ kind: "eof", value: "", pos: source.length });
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Parse tree
 * ------------------------------------------------------------------ */

export type PricingExpressionNode =
  | { type: "number"; value: number; pos: number }
  | { type: "string"; value: string; pos: number }
  | { type: "boolean"; value: boolean; pos: number }
  | { type: "field"; name: string; pos: number }
  | { type: "tag"; key: string; pos: number }
  | { type: "list"; items: PricingExpressionNode[]; pos: number }
  | { type: "unary"; op: "-" | "not"; operand: PricingExpressionNode; pos: number }
  | {
      type: "binary";
      op: "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
      left: PricingExpressionNode;
      right: PricingExpressionNode;
      pos: number;
    }
  | {
      type: "in";
      negated: boolean;
      value: PricingExpressionNode;
      list: PricingExpressionNode;
      pos: number;
    }
  | {
      type: "if";
      condition: PricingExpressionNode;
      then: PricingExpressionNode;
      /** Null at the top level means "else cost". Nested `if`s must say. */
      otherwise: PricingExpressionNode | null;
      pos: number;
    }
  | { type: "call"; name: string; args: PricingExpressionNode[]; pos: number };

class Parser {
  private index = 0;
  private depth = 0;
  private nodes = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const t = this.tokens[this.index]!;
    if (t.kind !== "eof") this.index++;
    return t;
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === value;
  }

  private isKeyword(value: string): boolean {
    const t = this.peek();
    return t.kind === "keyword" && t.value === value;
  }

  private expectOp(value: string, what: string): Token {
    const t = this.peek();
    if (t.kind === "op" && t.value === value) return this.next();
    throw new PricingExpressionError(`Expected ${what} ${describeToken(t)}.`, t.pos);
  }

  private node<T extends PricingExpressionNode>(n: T): T {
    this.nodes++;
    if (this.nodes > PRICING_EXPRESSION_LIMITS.maxNodes) {
      throw new PricingExpressionError(
        `This expression is too large; keep it under ${PRICING_EXPRESSION_LIMITS.maxNodes} terms.`,
        n.pos,
      );
    }
    return n;
  }

  private enter(pos: number): void {
    this.depth++;
    if (this.depth > PRICING_EXPRESSION_LIMITS.maxDepth) {
      throw new PricingExpressionError(
        `This expression nests more than ${PRICING_EXPRESSION_LIMITS.maxDepth} levels deep.`,
        pos,
      );
    }
  }

  private leave(): void {
    this.depth--;
  }

  parseRoot(): PricingExpressionNode {
    const t = this.peek();
    if (t.kind === "eof") throw new PricingExpressionError("The expression is empty.", 0);
    let root: PricingExpressionNode;
    if (this.isKeyword("if")) root = this.parseIf(true);
    else root = this.parseExpr();
    const end = this.peek();
    if (end.kind !== "eof") {
      throw new PricingExpressionError(
        `Unexpected ${describeToken(end)}; the expression should have ended.`,
        end.pos,
      );
    }
    return root;
  }

  /** `if c then x [else y]`. `else` is optional only at the top level. */
  private parseIf(topLevel: boolean): PricingExpressionNode {
    const start = this.next();
    this.enter(start.pos);
    const condition = this.parseExpr();
    if (!this.isKeyword("then")) {
      throw new PricingExpressionError(
        `Expected "then" ${describeToken(this.peek())}.`,
        this.peek().pos,
      );
    }
    this.next();
    const then = this.isKeyword("if") ? this.parseIf(false) : this.parseExpr();
    let otherwise: PricingExpressionNode | null = null;
    if (this.isKeyword("else")) {
      this.next();
      otherwise = this.isKeyword("if") ? this.parseIf(topLevel) : this.parseExpr();
    } else if (!topLevel) {
      throw new PricingExpressionError(
        'An "if" inside another expression needs an "else", so it always has a value.',
        start.pos,
      );
    }
    this.leave();
    return this.node({ type: "if", condition, then, otherwise, pos: start.pos });
  }

  private parseExpr(): PricingExpressionNode {
    return this.parseOr();
  }

  private parseOr(): PricingExpressionNode {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      const t = this.next();
      this.enter(t.pos);
      const right = this.parseAnd();
      this.leave();
      left = this.node({ type: "binary", op: "or", left, right, pos: t.pos });
    }
    return left;
  }

  private parseAnd(): PricingExpressionNode {
    let left = this.parseNot();
    while (this.isKeyword("and")) {
      const t = this.next();
      this.enter(t.pos);
      const right = this.parseNot();
      this.leave();
      left = this.node({ type: "binary", op: "and", left, right, pos: t.pos });
    }
    return left;
  }

  private parseNot(): PricingExpressionNode {
    if (this.isKeyword("not")) {
      const t = this.next();
      this.enter(t.pos);
      const operand = this.parseNot();
      this.leave();
      return this.node({ type: "unary", op: "not", operand, pos: t.pos });
    }
    return this.parseComparison();
  }

  private parseComparison(): PricingExpressionNode {
    const left = this.parseSum();
    const t = this.peek();
    if (t.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.value)) {
      this.next();
      const right = this.parseSum();
      const node = this.node({
        type: "binary",
        op: t.value as "==",
        left,
        right,
        pos: t.pos,
      });
      const after = this.peek();
      if (after.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(after.value)) {
        throw new PricingExpressionError(
          'Comparisons cannot be chained; join them with "and".',
          after.pos,
        );
      }
      return node;
    }
    if (this.isKeyword("in")) {
      this.next();
      const list = this.parseSum();
      return this.node({ type: "in", negated: false, value: left, list, pos: t.pos });
    }
    if (this.isKeyword("not") && this.tokens[this.index + 1]?.value === "in") {
      this.next();
      this.next();
      const list = this.parseSum();
      return this.node({ type: "in", negated: true, value: left, list, pos: t.pos });
    }
    return left;
  }

  private parseSum(): PricingExpressionNode {
    let left = this.parseProduct();
    while (this.isOp("+") || this.isOp("-")) {
      const t = this.next();
      const right = this.parseProduct();
      left = this.node({ type: "binary", op: t.value as "+", left, right, pos: t.pos });
    }
    return left;
  }

  private parseProduct(): PricingExpressionNode {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const t = this.next();
      const right = this.parseUnary();
      left = this.node({ type: "binary", op: t.value as "*", left, right, pos: t.pos });
    }
    return left;
  }

  private parseUnary(): PricingExpressionNode {
    if (this.isOp("-")) {
      const t = this.next();
      this.enter(t.pos);
      const operand = this.parseUnary();
      this.leave();
      return this.node({ type: "unary", op: "-", operand, pos: t.pos });
    }
    return this.parsePrimary();
  }

  private parsePrimary(): PricingExpressionNode {
    const t = this.peek();

    if (t.kind === "number") {
      this.next();
      const value = Number(t.value);
      if (!Number.isFinite(value)) {
        throw new PricingExpressionError(`${t.value} is too large a number.`, t.pos);
      }
      return this.node({ type: "number", value, pos: t.pos });
    }
    if (t.kind === "string") {
      this.next();
      return this.node({ type: "string", value: t.value, pos: t.pos });
    }
    if (t.kind === "keyword" && (t.value === "true" || t.value === "false")) {
      this.next();
      return this.node({ type: "boolean", value: t.value === "true", pos: t.pos });
    }
    if (t.kind === "keyword" && t.value === "if") {
      return this.parseIf(false);
    }
    if (this.isOp("(")) {
      this.next();
      this.enter(t.pos);
      const inner = this.parseExpr();
      this.leave();
      this.expectOp(")", 'a closing ")"');
      return inner;
    }
    if (this.isOp("[")) {
      this.next();
      this.enter(t.pos);
      const items: PricingExpressionNode[] = [];
      if (!this.isOp("]")) {
        for (;;) {
          items.push(this.parseSum());
          if (items.length > PRICING_EXPRESSION_LIMITS.maxListLength) {
            throw new PricingExpressionError(
              `A list can hold at most ${PRICING_EXPRESSION_LIMITS.maxListLength} values.`,
              t.pos,
            );
          }
          if (this.isOp(",")) {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expectOp("]", 'a closing "]"');
      this.leave();
      return this.node({ type: "list", items, pos: t.pos });
    }
    if (t.kind === "ident") {
      this.next();
      if (t.value === "tag") {
        if (this.isOp(".")) {
          this.next();
          const key = this.peek();
          if (key.kind !== "ident" && key.kind !== "keyword") {
            throw new PricingExpressionError(
              `Expected a tag key after "tag." ${describeToken(key)}.`,
              key.pos,
            );
          }
          this.next();
          return this.node({ type: "tag", key: key.value, pos: t.pos });
        }
        if (this.isOp("[")) {
          this.next();
          const key = this.peek();
          if (key.kind !== "string") {
            throw new PricingExpressionError(
              'Write a tag key with special characters as tag["key-name"], with a quoted key.',
              key.pos,
            );
          }
          this.next();
          this.expectOp("]", 'a closing "]"');
          return this.node({ type: "tag", key: key.value, pos: t.pos });
        }
        throw new PricingExpressionError('Read a tag as tag.name or tag["name"].', t.pos);
      }
      if (this.isOp("(")) {
        const spec = FUNCTIONS.get(t.value);
        if (!spec) {
          throw new PricingExpressionError(
            `"${t.value}" is not a function. Available: ${[...FUNCTIONS.keys()].join(", ")}.`,
            t.pos,
          );
        }
        this.next();
        this.enter(t.pos);
        const args: PricingExpressionNode[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            args.push(this.parseExpr());
            if (args.length > spec.maxArgs) break;
            if (this.isOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectOp(")", 'a closing ")"');
        this.leave();
        if (args.length < spec.minArgs || args.length > spec.maxArgs) {
          const range =
            spec.minArgs === spec.maxArgs
              ? `${spec.minArgs}`
              : `${spec.minArgs} to ${spec.maxArgs}`;
          throw new PricingExpressionError(
            `${t.value}() takes ${range} argument${spec.maxArgs === 1 ? "" : "s"}, not ${args.length}.`,
            t.pos,
          );
        }
        return this.node({ type: "call", name: t.value, args, pos: t.pos });
      }
      if (!FIELD_TYPES.has(t.value)) {
        throw new PricingExpressionError(
          `"${t.value}" is not a field. Available: ${[...FIELD_TYPES.keys()].join(", ")}, tag.<key>.`,
          t.pos,
        );
      }
      return this.node({ type: "field", name: t.value, pos: t.pos });
    }
    if (t.kind === "eof") {
      throw new PricingExpressionError("The expression ends too early.", t.pos);
    }
    throw new PricingExpressionError(`Unexpected ${describeToken(t)}.`, t.pos);
  }
}

function describeToken(t: Token): string {
  switch (t.kind) {
    case "eof":
      return "at the end of the expression";
    case "string":
      return `but found the string "${t.value}"`;
    default:
      return `but found "${t.value}"`;
  }
}

/* ------------------------------------------------------------------ *
 * Type checking
 * ------------------------------------------------------------------ */

type CheckedType = PricingValueType | "list<number>" | "list<string>" | "list<empty>";

function typeName(t: CheckedType): string {
  switch (t) {
    case "number":
      return "a number";
    case "string":
      return "text";
    case "boolean":
      return "true/false";
    default:
      return "a list";
  }
}

function check(node: PricingExpressionNode): CheckedType {
  switch (node.type) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "field":
      return FIELD_TYPES.get(node.name)!;
    case "tag":
      return "string";
    case "list": {
      if (node.items.length === 0) return "list<empty>";
      const first = check(node.items[0]!);
      if (first !== "number" && first !== "string") {
        throw new PricingExpressionError("A list can hold only numbers or text.", node.pos);
      }
      for (const item of node.items) {
        if (check(item) !== first) {
          throw new PricingExpressionError(
            "Every value in a list must be the same kind: all numbers or all text.",
            item.pos,
          );
        }
      }
      return first === "number" ? "list<number>" : "list<string>";
    }
    case "unary": {
      const t = check(node.operand);
      if (node.op === "-" && t !== "number") {
        throw new PricingExpressionError(`"-" needs a number, not ${typeName(t)}.`, node.pos);
      }
      if (node.op === "not" && t !== "boolean") {
        throw new PricingExpressionError(`"not" needs a condition, not ${typeName(t)}.`, node.pos);
      }
      return node.op === "-" ? "number" : "boolean";
    }
    case "binary": {
      const l = check(node.left);
      const r = check(node.right);
      switch (node.op) {
        case "+":
        case "-":
        case "*":
        case "/":
          if (l !== "number" || r !== "number") {
            throw new PricingExpressionError(
              `"${node.op}" works on numbers, not ${typeName(l === "number" ? r : l)}.`,
              node.pos,
            );
          }
          return "number";
        case "<":
        case "<=":
        case ">":
        case ">=":
          if (l !== "number" || r !== "number") {
            throw new PricingExpressionError(
              `"${node.op}" compares numbers, not ${typeName(l === "number" ? r : l)}.`,
              node.pos,
            );
          }
          return "boolean";
        case "==":
        case "!=":
          if (l !== r || l.startsWith("list")) {
            throw new PricingExpressionError(
              `Cannot compare ${typeName(l)} with ${typeName(r)}.`,
              node.pos,
            );
          }
          return "boolean";
        case "and":
        case "or":
          if (l !== "boolean" || r !== "boolean") {
            throw new PricingExpressionError(
              `"${node.op}" joins conditions, not ${typeName(l === "boolean" ? r : l)}.`,
              node.pos,
            );
          }
          return "boolean";
      }
      break;
    }
    case "in": {
      if (node.list.type !== "list") {
        throw new PricingExpressionError(
          '"in" needs a list in brackets, e.g. ["a", "b"].',
          node.pos,
        );
      }
      const v = check(node.value);
      const list = check(node.list);
      if (v !== "number" && v !== "string") {
        throw new PricingExpressionError(
          `"in" checks a number or text, not ${typeName(v)}.`,
          node.pos,
        );
      }
      if (list !== "list<empty>" && list !== `list<${v}>`) {
        throw new PricingExpressionError(
          `The list holds a different kind of value than ${typeName(v)}.`,
          node.pos,
        );
      }
      return "boolean";
    }
    case "if": {
      const c = check(node.condition);
      if (c !== "boolean") {
        throw new PricingExpressionError(
          `The condition after "if" must be true or false, not ${typeName(c)}.`,
          node.condition.pos,
        );
      }
      const t = check(node.then);
      const e = node.otherwise ? check(node.otherwise) : "number";
      if (t !== e) {
        throw new PricingExpressionError(
          `Both branches of an "if" must give the same kind of value (${typeName(t)} and ${typeName(e)}).`,
          node.pos,
        );
      }
      return t;
    }
    case "call": {
      const spec = FUNCTIONS.get(node.name)!;
      node.args.forEach((arg, i) => {
        const expected = spec.variadic ? spec.args[0]! : spec.args[i]!;
        const actual = check(arg);
        if (actual !== expected) {
          throw new PricingExpressionError(
            `Argument ${i + 1} of ${node.name}() must be ${typeName(expected)}, not ${typeName(actual)}.`,
            arg.pos,
          );
        }
      });
      return spec.returns;
    }
  }
  throw new PricingExpressionError("Unrecognised expression.", 0);
}

/* ------------------------------------------------------------------ *
 * Public API: compile
 * ------------------------------------------------------------------ */

/** A parsed, type-checked expression, ready to evaluate. */
export interface CompiledPricingExpression {
  source: string;
  root: PricingExpressionNode;
  /** Tag keys the expression reads; the query groups by exactly these. */
  tagKeys: string[];
  /** Fields the expression reads. */
  fields: string[];
}

function collectRefs(node: PricingExpressionNode, tags: Set<string>, fields: Set<string>): void {
  switch (node.type) {
    case "tag":
      tags.add(node.key);
      return;
    case "field":
      fields.add(node.name);
      return;
    case "list":
      node.items.forEach((n) => collectRefs(n, tags, fields));
      return;
    case "unary":
      collectRefs(node.operand, tags, fields);
      return;
    case "binary":
      collectRefs(node.left, tags, fields);
      collectRefs(node.right, tags, fields);
      return;
    case "in":
      collectRefs(node.value, tags, fields);
      collectRefs(node.list, tags, fields);
      return;
    case "if":
      collectRefs(node.condition, tags, fields);
      collectRefs(node.then, tags, fields);
      if (node.otherwise) collectRefs(node.otherwise, tags, fields);
      return;
    case "call":
      node.args.forEach((n) => collectRefs(n, tags, fields));
      if (node.name === "has_tag" && node.args[0]?.type === "string") tags.add(node.args[0].value);
      return;
    default:
      return;
  }
}

/**
 * Parse and type-check an expression. Throws {@link PricingExpressionError}
 * with a position on anything it refuses.
 */
export function compilePricingExpression(source: string): CompiledPricingExpression {
  if (typeof source !== "string") throw new PricingExpressionError("The expression is empty.", 0);
  if (source.length > PRICING_EXPRESSION_LIMITS.maxLength) {
    throw new PricingExpressionError(
      `An expression can be at most ${PRICING_EXPRESSION_LIMITS.maxLength} characters.`,
      PRICING_EXPRESSION_LIMITS.maxLength,
    );
  }
  const root = new Parser(tokenize(source)).parseRoot();
  const type = check(root);
  if (type !== "number") {
    throw new PricingExpressionError(
      `The expression must give the line's new cost (a number), but it gives ${typeName(type)}. ` +
        'Write "if <condition> then <cost>" to change only some lines.',
      0,
    );
  }
  const tags = new Set<string>();
  const fields = new Set<string>();
  collectRefs(root, tags, fields);
  return { source, root, tagKeys: [...tags].sort(), fields: [...fields].sort() };
}

/**
 * Why an expression cannot be saved, or null when it is fine: the shape the
 * billing-rule validator and an editor both want.
 */
export function pricingExpressionError(
  source: string,
): { message: string; position: number } | null {
  try {
    compilePricingExpression(source);
    return null;
  } catch (e) {
    if (e instanceof PricingExpressionError) return { message: e.message, position: e.position };
    return { message: "This expression could not be read.", position: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/** The one cost line an expression is evaluated against. */
export interface PricingExpressionContext {
  cost: number;
  collected: number;
  /** Null when the provider reported no public price for the line. */
  listCost: number | null;
  usage: number;
  unit: string;
  service: string;
  provider: string;
  account: string;
  accountName: string;
  region: string;
  chargeType: string;
  currency: string;
  month: string;
  customer: string;
  /** Tag key → value, for the keys the expression reads. Absent means untagged. */
  tags: ReadonlyMap<string, string>;
}

/** A line the expression could not price; it keeps its previous cost. */
export class PricingExpressionRuntimeError extends Error {
  override readonly name = "PricingExpressionRuntimeError";
}

type Value = number | string | boolean | Value[];

function fieldValue(name: string, ctx: PricingExpressionContext): Value {
  switch (name) {
    case "cost":
      return ctx.cost;
    case "collected":
      return ctx.collected;
    case "list_cost":
      return ctx.listCost ?? ctx.collected;
    case "has_list_price":
      return ctx.listCost !== null;
    case "usage":
      return ctx.usage;
    case "unit":
      return ctx.unit;
    case "service":
      return ctx.service;
    case "provider":
      return ctx.provider;
    case "account":
      return ctx.account;
    case "account_name":
      return ctx.accountName;
    case "region":
      return ctx.region;
    case "charge_type":
      return ctx.chargeType;
    case "currency":
      return ctx.currency;
    case "month":
      return ctx.month;
    case "customer":
      return ctx.customer;
  }
  throw new PricingExpressionRuntimeError(`Unknown field ${name}.`);
}

function num(v: Value): number {
  return v as number;
}

function evaluate(node: PricingExpressionNode, ctx: PricingExpressionContext): Value {
  switch (node.type) {
    case "number":
    case "string":
    case "boolean":
      return node.value;
    case "field":
      return fieldValue(node.name, ctx);
    case "tag":
      return ctx.tags.get(node.key) ?? "";
    case "list":
      return node.items.map((n) => evaluate(n, ctx));
    case "unary": {
      const v = evaluate(node.operand, ctx);
      return node.op === "-" ? -num(v) : !v;
    }
    case "binary": {
      if (node.op === "and")
        return Boolean(evaluate(node.left, ctx)) && Boolean(evaluate(node.right, ctx));
      if (node.op === "or")
        return Boolean(evaluate(node.left, ctx)) || Boolean(evaluate(node.right, ctx));
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      switch (node.op) {
        case "+":
          return num(l) + num(r);
        case "-":
          return num(l) - num(r);
        case "*":
          return num(l) * num(r);
        case "/":
          if (num(r) === 0) throw new PricingExpressionRuntimeError("Division by zero.");
          return num(l) / num(r);
        case "==":
          return l === r;
        case "!=":
          return l !== r;
        case "<":
          return num(l) < num(r);
        case "<=":
          return num(l) <= num(r);
        case ">":
          return num(l) > num(r);
        case ">=":
          return num(l) >= num(r);
      }
      break;
    }
    case "in": {
      const v = evaluate(node.value, ctx);
      const list = evaluate(node.list, ctx) as Value[];
      const found = list.includes(v);
      return node.negated ? !found : found;
    }
    case "if":
      if (evaluate(node.condition, ctx)) return evaluate(node.then, ctx);
      return node.otherwise ? evaluate(node.otherwise, ctx) : ctx.cost;
    case "call": {
      const args = node.args.map((a) => evaluate(a, ctx));
      switch (node.name) {
        case "min":
          return Math.min(...(args as number[]));
        case "max":
          return Math.max(...(args as number[]));
        case "abs":
          return Math.abs(num(args[0]!));
        case "round": {
          const digits = args.length > 1 ? Math.trunc(num(args[1]!)) : 2;
          if (digits < 0 || digits > 6) {
            throw new PricingExpressionRuntimeError(
              "round() keeps between 0 and 6 decimal places.",
            );
          }
          const f = 10 ** digits;
          return Math.round(num(args[0]!) * f) / f;
        }
        case "contains":
          return (args[0] as string).includes(args[1] as string);
        case "starts_with":
          return (args[0] as string).startsWith(args[1] as string);
        case "ends_with":
          return (args[0] as string).endsWith(args[1] as string);
        case "lower":
          return (args[0] as string).toLowerCase();
        case "has_tag":
          return ctx.tags.has(args[0] as string);
      }
    }
  }
  throw new PricingExpressionRuntimeError("Unrecognised expression.");
}

/**
 * The line's new cost. Throws {@link PricingExpressionRuntimeError} when the
 * result is not a finite number within bounds; the caller keeps the line's
 * previous cost and reports the error.
 */
export function evaluatePricingExpression(
  compiled: CompiledPricingExpression,
  ctx: PricingExpressionContext,
): number {
  const result = evaluate(compiled.root, ctx);
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new PricingExpressionRuntimeError("The expression did not give a finite number.");
  }
  if (Math.abs(result) > PRICING_EXPRESSION_LIMITS.maxResultMagnitude) {
    throw new PricingExpressionRuntimeError("The expression gave an implausibly large amount.");
  }
  return result;
}
