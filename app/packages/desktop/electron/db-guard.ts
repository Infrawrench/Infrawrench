/**
 * Runtime guards for the renderer-facing `db_select` / `db_execute` IPC
 * channels. The bundled renderer JS is the only thing the typed preload
 * allowlist lets reach these channels, but a renderer-side XSS would still
 * gain arbitrary SQL access against the local sql.js database. These guards
 * narrow the surface defensively.
 *
 * Residual risk: even with these guards, a compromised renderer can still
 * issue any SELECT/INSERT/UPDATE/DELETE on user-owned tables and exfiltrate
 * or tamper with encrypted blobs — the surface is narrowed, not eliminated.
 * The remaining mitigation is moving SQL to typed main-process operations,
 * which is tracked as a separate task.
 */
import { z } from "zod";

export const MAX_SQL_BYTES = 16 * 1024; // 16 KiB
export const MAX_PARAMS = 256;

// Statements whose first keyword we refuse outright. They either open access
// to other DBs on disk (ATTACH/DETACH), change session-level auth state
// (PRAGMA can flip e.g. auth_user / foreign_keys), cause DoS-shaped I/O
// (VACUUM), or load native code (LOAD_EXTENSION — sql.js can't actually do
// this, but we defend in depth).
const BANNED_LEADING_KEYWORDS = new Set(["ATTACH", "DETACH", "PRAGMA", "VACUUM", "LOAD_EXTENSION"]);

// Tables that hold sensitive material; mutations get an audit-log entry.
const AUDIT_TABLES = new Set(["accounts", "ssh_keys", "ssh_tunnel_configs", "cloud_sync_state"]);

const ParamSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array),
]);

/**
 * Strip leading whitespace and SQL comments (`-- line` and `/* block *\/`).
 * Returns the offset of the first non-skippable character.
 */
function skipLeadingWhitespaceAndComments(sql: string, from: number): number {
  let i = from;
  while (i < sql.length) {
    const c = sql[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      // line comment
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < sql.length) i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Count top-level semicolons in `sql` and return whether anything meaningful
 * appears after a semicolon. Handles single-quoted strings (with `''` escapes),
 * double-quoted identifiers (with `""` escapes), backtick identifiers,
 * `[bracketed]` identifiers, `--` line comments, and `/* ... *\/` block
 * comments.
 */
function findExtraStatement(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    // Single-quoted string literal
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            // escaped quote
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Double-quoted identifier
    if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Backtick identifier
    if (c === "`") {
      i++;
      while (i < sql.length && sql[i] !== "`") i++;
      if (i < sql.length) i++;
      continue;
    }
    // Bracketed identifier
    if (c === "[") {
      i++;
      while (i < sql.length && sql[i] !== "]") i++;
      if (i < sql.length) i++;
      continue;
    }
    // Line comment
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < sql.length) i += 2;
      continue;
    }
    if (c === ";") {
      // Anything meaningful after this `;`?
      const next = skipLeadingWhitespaceAndComments(sql, i + 1);
      if (next < sql.length) return true;
      return false;
    }
    i++;
  }
  return false;
}

/**
 * Find the first SQL keyword token (uppercased) after skipping leading
 * whitespace/comments. Returns null if none.
 */
export function firstKeyword(sql: string): string | null {
  const start = skipLeadingWhitespaceAndComments(sql, 0);
  let i = start;
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      i++;
      continue;
    }
    break;
  }
  if (i === start) return null;
  return sql.slice(start, i).toUpperCase();
}

export function validateSql(sql: string): void {
  if (typeof sql !== "string") {
    throw new Error("db guard: sql must be a string");
  }
  if (sql.length === 0) {
    throw new Error("db guard: sql is empty");
  }
  // Byte length, not character length — UTF-8 is what sqlite sees.
  const byteLength = Buffer.byteLength(sql, "utf8");
  if (byteLength > MAX_SQL_BYTES) {
    throw new Error(`db guard: sql exceeds ${MAX_SQL_BYTES} byte cap (${byteLength})`);
  }
  if (findExtraStatement(sql)) {
    throw new Error("db guard: multi-statement SQL is not allowed");
  }
  const kw = firstKeyword(sql);
  if (kw && BANNED_LEADING_KEYWORDS.has(kw)) {
    throw new Error(`db guard: statement type "${kw}" is not allowed`);
  }
}

export function validateParams(params: unknown[] | undefined): unknown[] {
  const arr = params ?? [];
  if (!Array.isArray(arr)) {
    throw new Error("db guard: params must be an array");
  }
  if (arr.length > MAX_PARAMS) {
    throw new Error(`db guard: params exceeds ${MAX_PARAMS} entries (${arr.length})`);
  }
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    // Node Buffers are instances of Uint8Array, so the Zod schema accepts them.
    const result = ParamSchema.safeParse(v);
    if (!result.success) {
      throw new Error(`db guard: params[${i}] has unsupported type`);
    }
  }
  return arr;
}

/**
 * For `db_execute`: detect INSERT/UPDATE/DELETE against audit-worthy tables
 * and return an `{ op, table }` descriptor so the caller can log. Returns
 * null when no audit log is warranted (or when we can't statically tell —
 * we err on the side of logging).
 */
export function classifyMutation(sql: string): { op: string; table: string } | null {
  const kw = firstKeyword(sql);
  if (!kw) return null;
  if (kw !== "INSERT" && kw !== "UPDATE" && kw !== "DELETE") return null;
  // Strip comments/whitespace, then find the table name after the leading
  // keyword (for INSERT we need to skip "INTO" and any "OR REPLACE"/"OR
  // IGNORE" modifiers; for DELETE we skip "FROM").
  const start = skipLeadingWhitespaceAndComments(sql, 0);
  const rest = sql.slice(start);
  const tokens = rest
    .replace(/[()`"\[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Drop leading keyword
  tokens.shift();
  // Skip any combination of OR/REPLACE/IGNORE/INTO/FROM
  const skipWords = new Set(["OR", "REPLACE", "IGNORE", "INTO", "FROM"]);
  while (tokens.length > 0 && skipWords.has(tokens[0]!.toUpperCase())) {
    tokens.shift();
  }
  const table = tokens[0]?.toLowerCase();
  if (!table) return null;
  if (!AUDIT_TABLES.has(table)) return null;
  return { op: kw, table };
}
