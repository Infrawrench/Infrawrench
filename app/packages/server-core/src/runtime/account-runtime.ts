/**
 * Which runtime an account's work belongs to.
 *
 * An account belongs on the Node gateway when it is bound to a bastion agent
 * (the agent's connection lives in a Node process), when it has an SSH tunnel
 * (opening one needs ssh2 and a local listener), or when work for it has
 * already hit a Node-only code path on the edge (`requires_gateway`, set by
 * {@link markAccountRequiresGateway}). Everything else runs on the edge.
 *
 * Nothing here knows about plugins. A Postgres or Docker account gets flagged
 * the first time the edge poller lists it, because the driver it reaches is a
 * gateway-only stub there; an AWS account never does. That keeps plugin
 * knowledge inside the plugins (their manifests and drivers), not in a list.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { accounts } from "../db/schema";

/**
 * What a poller instance claims. `all` is a single process doing everything
 * (local development, self-hosting, and production until the edge poller is
 * live); `edge` and `gateway` are the two halves of the split.
 */
export type PollScope = "all" | "edge" | "gateway";

export function parsePollScope(value: string | undefined): PollScope {
  return value === "edge" || value === "gateway" ? value : "all";
}

/**
 * The predicate, over an `accounts` row, that is true when the account's work
 * must run on the gateway. Shared by the claim queries and
 * {@link accountNeedsGateway} so the two can never disagree. `alias` is how
 * the query names the accounts table; a fixed union rather than a string so it
 * can be spliced in raw.
 */
function needsGateway(alias: "accounts" | "a"): SQL {
  const t = sql.raw(alias);
  return sql`(
    ${t}.requires_gateway
    OR ${t}.bastion_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM ssh_tunnel_configs t WHERE t.account_id = ${t}.id)
  )`;
}

/**
 * A claim-query condition restricting accounts to `scope`, starting with
 * ` AND`. Empty for `all`, so a single-process deployment's queries are
 * exactly what they were before the split.
 */
export function accountScopeCondition(scope: PollScope, alias: "accounts" | "a" = "accounts"): SQL {
  if (scope === "edge") return sql` AND NOT ${needsGateway(alias)}`;
  if (scope === "gateway") return sql` AND ${needsGateway(alias)}`;
  return sql``;
}

/**
 * Record that this account's work needs the gateway. Idempotent; also clears
 * the resource-poll lease so the gateway poller picks the account up on its
 * next tick instead of after the lease runs out.
 */
export async function markAccountRequiresGateway(accountId: string, reason: string): Promise<void> {
  needsGatewayCache.set(accountId, { value: true, at: Date.now() });
  await db
    .update(accounts)
    .set({ requiresGateway: true, gatewayReason: reason.slice(0, 500), nextPollAt: null })
    .where(eq(accounts.id, accountId));
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 5_000;
const needsGatewayCache = new Map<string, { value: boolean; at: number }>();

/**
 * Whether requests about this account should be served by the gateway. Read
 * by the edge router on every account-scoped request, so answers are cached
 * per isolate for {@link CACHE_TTL_MS}; a bastion bound a moment ago is picked
 * up within that window, and until then the request still works (it reaches
 * the gateway through the edge's gateway-only fallback). Unknown ids answer
 * `false`: the route's own lookup will 404 them.
 */
export async function accountNeedsGateway(accountId: string): Promise<boolean> {
  const cached = needsGatewayCache.get(accountId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const rows = await db.execute(
    sql`SELECT ${needsGateway("accounts")} AS needs FROM accounts WHERE accounts.id = ${accountId} LIMIT 1`,
  );
  const first = Array.from(rows as Iterable<Record<string, unknown>>)[0];
  const value = first?.["needs"] === true;
  if (needsGatewayCache.size >= CACHE_MAX) needsGatewayCache.clear();
  needsGatewayCache.set(accountId, { value, at: Date.now() });
  return value;
}

/** Test-only. */
export function resetAccountRuntimeCacheForTests(): void {
  needsGatewayCache.clear();
}
