/** In-memory cache of live pg connections, keyed by accountId.
 *  Populated by the dashboard auto-connect and the resource detail page.
 *  Lets the detail page start pre-connected when navigating from the dashboard.
 */

export interface PgSession {
  connectionString: string;
  /** Full __tables__ JSON (columns + PKs). Present once the detail page has connected. */
  tablesJson?: string | undefined;
}

const sessions = new Map<string, PgSession>();

export function getPgSession(accountId: string): PgSession | undefined {
  return sessions.get(accountId);
}

export function setPgSession(accountId: string, data: PgSession): void {
  const existing = sessions.get(accountId);
  sessions.set(accountId, { ...existing, ...data });
}
