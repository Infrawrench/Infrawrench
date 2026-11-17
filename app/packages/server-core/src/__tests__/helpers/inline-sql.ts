/**
 * A captured Postgres statement with its parameters written back in as
 * literals, for assertions that read better against the SQL a person would
 * write than against `$7`. Test-only: the quoting is just enough to make the
 * text unambiguous (strings single-quoted with `'` doubled), not an escaper
 * anything should send to a server.
 */
export function inlineSql(query: { sql: string; params: readonly unknown[] }): string {
  return query.sql.replace(/\$(\d+)/g, (match, n: string) => {
    const index = Number(n) - 1;
    if (index < 0 || index >= query.params.length) return match;
    return literal(query.params[index]);
  });
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
