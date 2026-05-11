// Defense-in-depth guards for db_select / db_execute. A compromised renderer
// can still reach any user-owned table — the surface is narrowed, not removed.
import { z } from "zod";

export const MAX_SQL_BYTES = 16 * 1024;
export const MAX_PARAMS = 256;

// ATTACH/DETACH open other on-disk DBs; PRAGMA flips session auth state;
// VACUUM is DoS-shaped I/O; LOAD_EXTENSION can load native code (sql.js
// blocks it but defense in depth).
const BANNED_LEADING_KEYWORDS = new Set(["ATTACH", "DETACH", "PRAGMA", "VACUUM", "LOAD_EXTENSION"]);

// Mutations to these tables emit an audit-log entry.
const AUDIT_TABLES = new Set(["accounts", "ssh_keys", "ssh_tunnel_configs", "cloud_sync_state"]);

const ParamSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array),
]);

// Skips whitespace, `-- line` comments, and `/* block */` comments.
function skipLeadingWhitespaceAndComments(sql: string, from: number): number {
  let i = from;
  while (i < sql.length) {
    const c = sql[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
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

// True when a top-level `;` is followed by anything meaningful. Handles
// single-quoted strings (with `''`), double-quoted/backtick/bracketed
// identifiers, and SQL comments.
function findExtraStatement(sql: string): boolean {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
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
    if (c === "`") {
      i++;
      while (i < sql.length && sql[i] !== "`") i++;
      if (i < sql.length) i++;
      continue;
    }
    if (c === "[") {
      i++;
      while (i < sql.length && sql[i] !== "]") i++;
      if (i < sql.length) i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
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
    if (c === ";") {
      const next = skipLeadingWhitespaceAndComments(sql, i + 1);
      if (next < sql.length) return true;
      return false;
    }
    i++;
  }
  return false;
}

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
  // sqlite measures the limit in UTF-8 bytes, not JS chars.
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
    const result = ParamSchema.safeParse(v);
    if (!result.success) {
      throw new Error(`db guard: params[${i}] has unsupported type`);
    }
  }
  return arr;
}

// INSERT/UPDATE/DELETE against an AUDIT_TABLES row → `{ op, table }`, else null.
export function classifyMutation(sql: string): { op: string; table: string } | null {
  const kw = firstKeyword(sql);
  if (!kw) return null;
  if (kw !== "INSERT" && kw !== "UPDATE" && kw !== "DELETE") return null;
  const start = skipLeadingWhitespaceAndComments(sql, 0);
  const rest = sql.slice(start);
  const tokens = rest
    .replace(/[()`"\[\]]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  tokens.shift();
  // Skip "OR REPLACE"/"OR IGNORE"/"INTO"/"FROM" to land on the table name.
  const skipWords = new Set(["OR", "REPLACE", "IGNORE", "INTO", "FROM"]);
  while (tokens.length > 0 && skipWords.has(tokens[0]!.toUpperCase())) {
    tokens.shift();
  }
  const table = tokens[0]?.toLowerCase();
  if (!table) return null;
  if (!AUDIT_TABLES.has(table)) return null;
  return { op: kw, table };
}
