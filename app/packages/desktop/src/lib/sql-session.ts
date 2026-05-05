/**
 * In-memory cache of live SQL connections, keyed by accountId.
 * Populated by dashboard auto-connect and the resource detail page.
 * Lets the detail page start pre-connected when navigating from the dashboard.
 */
interface SqlSession {
  connectionString: string;
  /** Serialised SqlTableMeta[]. Present once introspection has run. */
  tablesJson?: string | undefined;
}

const sessions = new Map<string, SqlSession>();

export function getSqlSession(accountId: string): SqlSession | undefined {
  return sessions.get(accountId);
}

export function setSqlSession(
  accountId: string,
  data: Partial<SqlSession> & Pick<SqlSession, "connectionString">,
): void {
  const existing = sessions.get(accountId);
  sessions.set(accountId, { ...existing, ...data });
}
