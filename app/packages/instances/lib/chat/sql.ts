/**
 * The checks a chat query passes before it is sent to the warehouse. The
 * read-only token is the real boundary; these turn obvious mistakes into
 * messages the model can act on.
 */

const STATEMENT =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(select|with|describe|desc|show|explain)\b/i;

export class QueryError extends Error {}

/** The statement as it will be sent, or a `QueryError` saying why not. */
export function checkSql(raw: string): string {
  const sql = raw.trim().replace(/;+\s*$/, "");
  if (!sql) throw new QueryError("The query is empty.");
  if (sql.length > 20_000) throw new QueryError("The query is too long.");
  if (!STATEMENT.test(sql)) {
    throw new QueryError("Only SELECT, WITH, DESCRIBE, SHOW and EXPLAIN queries can run.");
  }
  if (/;\s*\S/.test(sql.replace(/'(?:[^'\\]|\\.)*'/g, "''"))) {
    throw new QueryError("Send one statement at a time.");
  }
  if (/\bFORMAT\s+[A-Za-z]+\s*$/i.test(sql)) {
    throw new QueryError("Leave out FORMAT; results come back as JSON.");
  }
  if (/\bSETTINGS\b/i.test(sql)) {
    throw new QueryError("SETTINGS cannot be changed on this read-only connection.");
  }
  return sql;
}
