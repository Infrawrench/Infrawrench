/**
 * Guard for the read-only SQL path (`SqlNodeDriver.queryReadOnly`).
 *
 * A read-only transaction only protects the statements that run inside it,
 * so a second statement smuggled in after a `;` (`COMMIT; DROP TABLE ...`)
 * would escape it on any protocol that accepts several statements per call.
 *
 * This is deliberately cruder than a lexer: it rejects every `;` except
 * trailing ones, including a `;` inside a string literal or a comment. A real
 * tokenizer would have to agree with each engine on backslash escapes, `#`
 * and `--x` comments, nested and `/*!` comments and dollar quoting, and any
 * place it disagrees is a place a second statement can hide. A read query that
 * needs a literal semicolon is rare and can spell it `chr(59)` / `CHAR(59)`.
 */
export function isSingleSqlStatement(sql: string): boolean {
  const body = sql.replace(/[\s;]+$/, "");
  return body.trim() !== "" && !body.includes(";");
}

/** Throws when {@link isSingleSqlStatement} rejects `sql`. */
export function assertSingleSqlStatement(sql: string): void {
  if (!isSingleSqlStatement(sql)) {
    throw new Error(
      "Read-only queries must be a single SQL statement with no ';' except at the end " +
        "(not even inside a string or comment).",
    );
  }
}
