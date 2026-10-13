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
import { realtimeEnabled } from "../realtime/client";
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
  const cached = runtimeCache.get(accountId);
  runtimeCache.set(accountId, {
    needsGateway: true,
    needsSession: cached?.needsSession ?? false,
    at: Date.now(),
  });
  await db
    .update(accounts)
    .set({ requiresGateway: true, gatewayReason: reason.slice(0, 500), nextPollAt: null })
    .where(eq(accounts.id, accountId));
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 5_000;
interface AccountRuntime {
  needsGateway: boolean;
  needsSession: boolean;
  at: number;
}
const runtimeCache = new Map<string, AccountRuntime>();

/**
 * Where an account's requests belong, cached per isolate or process for
 * {@link CACHE_TTL_MS}; a bastion bound a moment ago is picked up within that
 * window, and until then the request still works (it is handed on through the
 * gateway-only fallback). Unknown ids answer `false` to both: the route's own
 * lookup will 404 them.
 */
async function accountRuntime(accountId: string): Promise<AccountRuntime> {
  const cached = runtimeCache.get(accountId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const rows = await db.execute(
    sql`SELECT ${needsGateway("accounts")} AS needs, accounts.bastion_id IS NOT NULL AS session
        FROM accounts WHERE accounts.id = ${accountId} LIMIT 1`,
  );
  const first = Array.from(rows as Iterable<Record<string, unknown>>)[0];
  const value: AccountRuntime = {
    needsGateway: first?.["needs"] === true,
    // With the realtime relay the agent is reachable from any Node runtime
    // (realtime/protocol.ts), so a bastion no longer pins the session gateway.
    needsSession: first?.["session"] === true && !realtimeEnabled(),
    at: Date.now(),
  };
  if (runtimeCache.size >= CACHE_MAX) runtimeCache.clear();
  runtimeCache.set(accountId, value);
  return value;
}

/**
 * Whether requests about this account should be served by Node rather than
 * the edge. Read by the edge router on every account-scoped request.
 */
export async function accountNeedsGateway(accountId: string): Promise<boolean> {
  return (await accountRuntime(accountId)).needsGateway;
}

/**
 * Whether requests about this account need the long-lived session gateway
 * specifically, rather than any Node runtime: true when it is bound to a
 * bastion and the realtime relay is off, so its agent connection lives in one
 * session gateway process. With the relay every Node runtime reaches the agent. SSH
 * tunnels do not count; any Node process can open one for the duration of a
 * request, as the poller always has. Read by the edge router to choose
 * between the Lambda gateway and the session gateway.
 */
export async function accountNeedsSession(accountId: string): Promise<boolean> {
  return (await accountRuntime(accountId)).needsSession;
}

/** Test-only. */
export function resetAccountRuntimeCacheForTests(): void {
  runtimeCache.clear();
}
