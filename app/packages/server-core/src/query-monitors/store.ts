/**
 * Query monitors — CRUD, and the one-off "run it now" the editor previews with.
 *
 * Validation comes from `@infrawrench/client-core` (`validateQueryMonitor`,
 * `monitorSqlProblem`), the same functions the editor enforces, so the form and
 * the server cannot disagree about what a monitor may run.
 *
 * **The read-only guard is re-checked on every execution, not only on save.**
 * A row can reach this table by a route that predates the guard, by a restore,
 * or by an operator editing the database — and the thing being defended against
 * is an unattended scheduled write with the account's credentials, so the check
 * belongs where the statement is executed rather than where it is stored.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  QUERY_MONITOR_LIMITS,
  monitorSqlProblem,
  readMonitorValue,
  validateQueryMonitor,
  type QueryMonitor,
  type QueryMonitorInput,
  type QueryMonitorMode,
  type QueryMonitorTargetAccount,
} from "@infrawrench/client-core";

import {
  evaluatePeerIntegrationUnreachable,
  type PeerPluginIntegration,
  type ResourceTypeDefinition,
} from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { queryMonitors } from "../db/query-monitor-schema";
import { getOrgAccountClient } from "../org-accounts";
import { buildPeerPluginClient, filterVisiblePeerIntegrations } from "../peer-clients";
import { getPlugin } from "../plugin-loader";
import { rewriteConnectionForTunnel } from "../tunnel-resolver";
import { sqlDrivers } from "../drivers";

export class QueryMonitorInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "QueryMonitorInputError";
    this.status = status;
  }
}

function selectMonitors() {
  return db
    .select({
      id: queryMonitors.id,
      name: queryMonitors.name,
      description: queryMonitors.description,
      accountId: queryMonitors.accountId,
      accountName: accounts.displayName,
      resourceId: queryMonitors.resourceId,
      resourceTypeId: queryMonitors.resourceTypeId,
      resourceName: resources.displayName,
      sql: queryMonitors.sql,
      mode: queryMonitors.mode,
      operator: queryMonitors.operator,
      threshold: queryMonitors.threshold,
      intervalMinutes: queryMonitors.intervalMinutes,
      consecutiveBreaches: queryMonitors.consecutiveBreaches,
      enabled: queryMonitors.enabled,
      state: queryMonitors.state,
      lastValue: queryMonitors.lastValue,
      lastRunAt: queryMonitors.lastRunAt,
      lastError: queryMonitors.lastError,
      breachStreak: queryMonitors.breachStreak,
      lastAlertedAt: queryMonitors.lastAlertedAt,
      createdByUserId: queryMonitors.createdByUserId,
      createdAt: queryMonitors.createdAt,
      updatedAt: queryMonitors.updatedAt,
    })
    .from(queryMonitors)
    .leftJoin(accounts, eq(accounts.id, queryMonitors.accountId))
    .leftJoin(resources, eq(resources.id, queryMonitors.resourceId));
}

type MonitorRow = Awaited<ReturnType<ReturnType<typeof selectMonitors>["execute"]>>[number];

function toWire(row: MonitorRow): QueryMonitor {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    accountId: row.accountId,
    accountName: row.accountName,
    resourceId: row.resourceId,
    resourceTypeId: row.resourceTypeId,
    resourceName: row.resourceName,
    sql: row.sql,
    mode: row.mode,
    operator: row.operator,
    threshold: row.threshold,
    intervalMinutes: row.intervalMinutes,
    consecutiveBreaches: row.consecutiveBreaches,
    enabled: row.enabled,
    state: row.state,
    lastValue: row.lastValue,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastError: row.lastError,
    breachStreak: row.breachStreak,
    lastAlertedAt: row.lastAlertedAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listQueryMonitors(organizationId: string): Promise<QueryMonitor[]> {
  const rows = await selectMonitors()
    .where(eq(queryMonitors.organizationId, organizationId))
    .orderBy(asc(queryMonitors.name));
  return rows.map(toWire);
}

/**
 * What a resource type must declare for its instances to be offered as monitor
 * targets: a per-resource SQL driver, or a REST query API (`supportsRestQuery`,
 * the BigQuery/Spanner shape). Exported for the targets test.
 *
 * This is the *own-declaration* check only — a type with neither can still
 * qualify through {@link sqlPeerIntegrationsOf}, the peer-integration shape.
 */
export function isSqlTargetType(typeDef: {
  resourceSqlDriver?: unknown;
  supportsRestQuery?: boolean | undefined;
}): boolean {
  return Boolean(typeDef.resourceSqlDriver ?? typeDef.supportsRestQuery);
}

/**
 * The third way a resource can be a SQL target: a peer integration onto a
 * plugin that *is* a SQL driver. A Neon database maps its connection string
 * onto the `postgres` plugin, an RDS instance onto `postgres`/`mysql`, an
 * Azure SQL database onto `mssql` — none of them declare `resourceSqlDriver`,
 * because the SQL editor reaches them through the peer tab. The monitor picker
 * and runner must reach them the same way, or a whole class of managed
 * databases silently cannot be monitored.
 *
 * This is the static half: the peer plugin declares `manifest.sqlDriver`, the
 * driver is one this host ships, and the integration maps something onto the
 * driver's `credentialKey`. Per-resource gates (`showWhen`, `requiresFields`,
 * `unreachableWhen`) need the resource's fields and are applied by callers via
 * {@link visibleSqlPeerIntegrations}. Exported for the targets test.
 */
export async function sqlPeerIntegrationsOf(
  typeDef: Pick<ResourceTypeDefinition, "peerIntegrations">,
): Promise<PeerPluginIntegration[]> {
  const candidates: PeerPluginIntegration[] = [];
  for (const integration of typeDef.peerIntegrations ?? []) {
    const peer = await getPlugin(integration.pluginId);
    const peerSql = peer?.plugin.manifest.sqlDriver;
    if (!peerSql || !sqlDrivers.has(peerSql.driver)) continue;
    if (!integration.credentialMappings.some((m) => m.credentialKey === peerSql.credentialKey)) {
      continue;
    }
    candidates.push(integration);
  }
  return candidates;
}

/**
 * The subset of a type's SQL peer integrations a specific resource's fields
 * let through — the same `showWhen`/`requiresFields` filtering the peer tabs
 * apply (an engine-gated DO cluster running Redis has a `postgres` integration
 * declared but not visible), minus any the provider marked unreachable from
 * here (private-IP-only Cloud SQL).
 */
function visibleSqlPeerIntegrations(
  candidates: PeerPluginIntegration[],
  fields: Record<string, unknown> | undefined,
): PeerPluginIntegration[] {
  return filterVisiblePeerIntegrations(candidates, fields).filter(
    (i) => !evaluatePeerIntegrationUnreachable(i, fields),
  );
}

/**
 * The accounts and resources a monitor's query can actually run against —
 * what the editor's target picker shows.
 *
 * Derived from static plugin metadata rather than by instantiating clients:
 * `manifest.sqlDriver` marks an account-level connection, and a resource
 * qualifies when its type passes {@link isSqlTargetType} or carries a SQL
 * peer integration its synced fields let through ({@link sqlPeerIntegrationsOf}
 * — the Neon/RDS/Cloud SQL shape). Accounts with none of these are omitted
 * entirely — offering them would only manufacture "That account has no SQL
 * driver" runs.
 */
export async function listQueryMonitorTargets(
  organizationId: string,
): Promise<QueryMonitorTargetAccount[]> {
  const accountRows = await db
    .select({ id: accounts.id, name: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .orderBy(asc(accounts.displayName));
  const resourceRows = await db
    .select({
      id: resources.id,
      name: resources.displayName,
      accountId: resources.accountId,
      resourceTypeId: resources.resourceTypeId,
      // The peer-integration gates (engine checks, "must have a public
      // endpoint") read fields, so the synced field bag rides along.
      fields: resources.fieldsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)))
    .orderBy(asc(resources.displayName));

  const targets: QueryMonitorTargetAccount[] = [];
  const peerCandidates = new Map<ResourceTypeDefinition, PeerPluginIntegration[]>();
  for (const account of accountRows) {
    const loaded = await getPlugin(account.pluginId);
    if (!loaded) continue;
    const types = new Map(loaded.plugin.resourceTypes.map((t) => [t.id, t]));
    const accountSql = Boolean(loaded.plugin.manifest.sqlDriver);
    const accountResources: QueryMonitorTargetAccount["resources"] = [];
    for (const resource of resourceRows) {
      if (resource.accountId !== account.id) continue;
      const typeDef = types.get(resource.resourceTypeId);
      if (!typeDef) continue;
      let qualifies = isSqlTargetType(typeDef);
      if (!qualifies) {
        let candidates = peerCandidates.get(typeDef);
        if (!candidates) {
          candidates = await sqlPeerIntegrationsOf(typeDef);
          peerCandidates.set(typeDef, candidates);
        }
        const fields = (resource.fields ?? undefined) as Record<string, unknown> | undefined;
        qualifies = visibleSqlPeerIntegrations(candidates, fields).length > 0;
      }
      if (!qualifies) continue;
      accountResources.push({
        id: resource.id,
        name: resource.name,
        resourceTypeId: resource.resourceTypeId,
        typeName: typeDef.displayName,
      });
    }
    if (accountSql || accountResources.length > 0) {
      targets.push({ id: account.id, name: account.name, accountSql, resources: accountResources });
    }
  }
  return targets;
}

/**
 * Resolve and validate a monitor's resource scope against the synced rows.
 *
 * The row's stored type is authoritative — the caller's `resourceTypeId` is
 * replaced by it, which removes the id/type-mismatch failure class instead of
 * reporting it (and lets an API caller omit the type entirely). Returns the
 * type id to store, or the caller's value untouched for an account-level
 * monitor, so the both-or-neither validation still bites on a bare type id.
 */
async function resolveMonitorResourceType(
  organizationId: string,
  accountId: string,
  resourceId: string | null,
  resourceTypeId: string | null,
): Promise<string | null> {
  if (!resourceId) return resourceTypeId;
  const [resource] = await db
    .select({ accountId: resources.accountId, resourceTypeId: resources.resourceTypeId })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  if (!resource) throw new QueryMonitorInputError("No such resource.", 404);
  if (resource.accountId !== accountId) {
    throw new QueryMonitorInputError("That resource belongs to a different account.");
  }
  return resource.resourceTypeId;
}

export async function getQueryMonitor(
  organizationId: string,
  monitorId: string,
): Promise<QueryMonitor | null> {
  const rows = await selectMonitors()
    .where(and(eq(queryMonitors.organizationId, organizationId), eq(queryMonitors.id, monitorId)))
    .limit(1);
  return rows[0] ? toWire(rows[0]) : null;
}

export async function createQueryMonitor(
  organizationId: string,
  input: QueryMonitorInput,
  userId: string | null,
): Promise<QueryMonitor> {
  const normalized: QueryMonitorInput = {
    ...input,
    resourceTypeId: await resolveMonitorResourceType(
      organizationId,
      input.accountId,
      input.resourceId ?? null,
      input.resourceTypeId ?? null,
    ),
  };
  const problem = validateQueryMonitor(normalized);
  if (problem) throw new QueryMonitorInputError(problem);

  const existing = await db
    .select({ id: queryMonitors.id })
    .from(queryMonitors)
    .where(eq(queryMonitors.organizationId, organizationId));
  if (existing.length >= QUERY_MONITOR_LIMITS.maxPerOrg) {
    throw new QueryMonitorInputError(
      `An organization may have ${QUERY_MONITOR_LIMITS.maxPerOrg} query monitors.`,
    );
  }
  // The account must be this org's — a monitor is executed with its
  // credentials, so an id from elsewhere would be a credential-use primitive.
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, input.accountId)))
    .limit(1);
  if (!account) throw new QueryMonitorInputError("No such account.", 404);

  const id = randomUUID();
  try {
    await db.insert(queryMonitors).values({
      id,
      organizationId,
      accountId: normalized.accountId,
      resourceId: normalized.resourceId ?? null,
      resourceTypeId: normalized.resourceTypeId ?? null,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      sql: input.sql,
      mode: input.mode,
      operator: input.operator,
      threshold: input.threshold,
      intervalMinutes: input.intervalMinutes,
      consecutiveBreaches: input.consecutiveBreaches ?? 1,
      enabled: input.enabled ?? true,
      createdByUserId: userId,
    });
  } catch (err) {
    throw asNameConflict(err, input.name.trim());
  }
  const created = await getQueryMonitor(organizationId, id);
  if (!created) throw new Error("Failed to create the monitor");
  return created;
}

export async function updateQueryMonitor(
  organizationId: string,
  monitorId: string,
  patch: Partial<QueryMonitorInput>,
): Promise<QueryMonitor> {
  const current = await getQueryMonitor(organizationId, monitorId);
  if (!current) throw new QueryMonitorInputError("No such monitor.", 404);

  const accountId = patch.accountId ?? current.accountId;
  const resourceId = patch.resourceId !== undefined ? patch.resourceId : current.resourceId;
  const merged: QueryMonitorInput = {
    name: patch.name ?? current.name,
    description: patch.description !== undefined ? patch.description : current.description,
    accountId,
    resourceId,
    resourceTypeId: await resolveMonitorResourceType(
      organizationId,
      accountId,
      resourceId ?? null,
      (patch.resourceTypeId !== undefined ? patch.resourceTypeId : current.resourceTypeId) ?? null,
    ),
    sql: patch.sql ?? current.sql,
    mode: patch.mode ?? current.mode,
    operator: patch.operator ?? current.operator,
    threshold: patch.threshold ?? current.threshold,
    intervalMinutes: patch.intervalMinutes ?? current.intervalMinutes,
    consecutiveBreaches: patch.consecutiveBreaches ?? current.consecutiveBreaches,
    enabled: patch.enabled ?? current.enabled,
  };
  const problem = validateQueryMonitor(merged);
  if (problem) throw new QueryMonitorInputError(problem);

  // Editing the query, the threshold or the interval re-arms the monitor: the
  // stored streak was accumulated against a different question, and carrying it
  // forward would fire an alert on the first run of a rule nobody has tested.
  const rearm =
    merged.sql !== current.sql ||
    merged.threshold !== current.threshold ||
    merged.operator !== current.operator ||
    merged.mode !== current.mode;

  try {
    await db
      .update(queryMonitors)
      .set({
        accountId: merged.accountId,
        resourceId: merged.resourceId ?? null,
        resourceTypeId: merged.resourceTypeId ?? null,
        name: merged.name.trim(),
        description: merged.description?.trim() || null,
        sql: merged.sql,
        mode: merged.mode,
        operator: merged.operator,
        threshold: merged.threshold,
        intervalMinutes: merged.intervalMinutes,
        consecutiveBreaches: merged.consecutiveBreaches ?? 1,
        enabled: merged.enabled ?? true,
        ...(rearm ? { breachStreak: 0, state: "unknown" as const, lastValue: null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(queryMonitors.organizationId, organizationId), eq(queryMonitors.id, monitorId)),
      );
  } catch (err) {
    throw asNameConflict(err, merged.name.trim());
  }

  const updated = await getQueryMonitor(organizationId, monitorId);
  if (!updated) throw new QueryMonitorInputError("No such monitor.", 404);
  return updated;
}

export async function deleteQueryMonitor(
  organizationId: string,
  monitorId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(queryMonitors)
    .where(and(eq(queryMonitors.organizationId, organizationId), eq(queryMonitors.id, monitorId)))
    .returning({ id: queryMonitors.id });
  return deleted.length > 0;
}

function asNameConflict(err: unknown, name: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("query_monitors_org_name_unique")) {
    return new QueryMonitorInputError(`A monitor called "${name}" already exists.`, 409);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface MonitorQueryResult {
  value: number | null;
  error: string | null;
  durationMs: number;
  /** Rows the query returned, capped — the editor's preview shows them. */
  rows: Record<string, unknown>[];
}

const MAX_PREVIEW_ROWS = 20;

/**
 * Run one monitor's query against its account.
 *
 * Mirrors the connection paths the SQL editor resolves — a REST-based
 * `executeQuery`, a per-resource driver, a SQL peer integration (the Neon /
 * RDS / Cloud SQL shape, which the editor reaches through the peer tab), and
 * the account-level driver — because a monitor must be able to watch anything
 * the editor can query. It lives here rather than in the web route so the
 * poller, which has no HTTP context, runs exactly the same resolution.
 *
 * Never throws: a failed query is an outcome (`unknown`), not an exception, and
 * the pass that calls this must not be able to fail a poller tick.
 */
export async function runMonitorQuery(
  organizationId: string,
  monitor: {
    accountId: string;
    resourceId?: string | null;
    resourceTypeId?: string | null;
    sql: string;
    mode: QueryMonitorMode;
  },
): Promise<MonitorQueryResult> {
  const started = Date.now();
  const empty = { value: null, rows: [] as Record<string, unknown>[] };

  // Re-checked here, not merely on save. See the module note.
  const guard = monitorSqlProblem(monitor.sql);
  if (guard) {
    return { ...empty, error: guard, durationMs: 0 };
  }

  try {
    const ctx = await getOrgAccountClient(monitor.accountId, organizationId);
    if (!ctx) return { ...empty, error: "The account is no longer connected.", durationMs: 0 };
    const { client, plugin, credentials } = ctx;

    let rows: Record<string, unknown>[] | null = null;

    if (monitor.resourceId && client.executeQuery) {
      const result = await client.executeQuery(monitor.resourceId, monitor.accountId, monitor.sql);
      rows = (result as { rows?: Record<string, unknown>[] }).rows ?? [];
    } else if (monitor.resourceId && monitor.resourceTypeId) {
      const typeDef = plugin.resourceTypes.find((t) => t.id === monitor.resourceTypeId);
      const rtDriver = typeDef?.resourceSqlDriver;
      if (rtDriver) {
        const driver = sqlDrivers.get(rtDriver.driver);
        if (!driver) {
          return { ...empty, error: `Unknown SQL driver: ${rtDriver.driver}`, durationMs: 0 };
        }
        let connection = await client.resolveOutput(
          monitor.resourceTypeId,
          monitor.resourceId,
          rtDriver.connectionStringOutputKey,
          monitor.accountId,
        );
        connection = await rewriteConnectionForTunnel(monitor.accountId, connection);
        rows = (await driver.query(connection, monitor.sql)) as Record<string, unknown>[];
      } else if (typeDef) {
        // A database reached through a peer integration — the target the
        // picker offered via sqlPeerIntegrationsOf. Resolve the peer plugin's
        // credentials from the parent resource's outputs (running the
        // credential rewriters, exactly as the peer tab does) and run the
        // peer's account-level driver on them.
        const candidates = await sqlPeerIntegrationsOf(typeDef);
        if (candidates.length === 0) {
          return { ...empty, error: "That resource type has no SQL driver.", durationMs: 0 };
        }
        const instance = await client
          .getResource(monitor.resourceTypeId, monitor.resourceId, monitor.accountId)
          .catch(() => null);
        // The visibility gates read fields; when the provider can't produce
        // the live instance, fall back to the synced row so a transient
        // provider error surfaces as a query failure, not a vanished target.
        let fields = instance?.fields as Record<string, unknown> | undefined;
        if (!fields) {
          const [row] = await db
            .select({ fields: resources.fieldsJson })
            .from(resources)
            .where(
              and(
                eq(resources.organizationId, organizationId),
                eq(resources.id, monitor.resourceId),
              ),
            )
            .limit(1);
          fields = (row?.fields ?? undefined) as Record<string, unknown> | undefined;
        }
        const integration = filterVisiblePeerIntegrations(candidates, fields)[0];
        if (!integration) {
          return { ...empty, error: "That resource has no SQL surface.", durationMs: 0 };
        }
        const guidance = evaluatePeerIntegrationUnreachable(integration, fields);
        if (guidance) {
          return { ...empty, error: guidance.title, durationMs: 0 };
        }
        const built = await buildPeerPluginClient({
          parentClient: client,
          parentPluginId: plugin.manifest.id,
          parentResourceTypeId: monitor.resourceTypeId,
          parentResourceId: monitor.resourceId,
          parentResource: instance,
          integration,
          accountId: monitor.accountId,
          organizationId,
        });
        const peerSql = built?.plugin.manifest.sqlDriver;
        if (!built || !peerSql) {
          return {
            ...empty,
            error: `The ${integration.pluginId} plugin is not available.`,
            durationMs: 0,
          };
        }
        const driver = sqlDrivers.get(peerSql.driver);
        if (!driver) {
          return { ...empty, error: `Unknown SQL driver: ${peerSql.driver}`, durationMs: 0 };
        }
        let connection = built.credentials[peerSql.credentialKey] ?? "";
        connection = await rewriteConnectionForTunnel(monitor.accountId, connection);
        const caCert = peerSql.caCertKey ? (built.credentials[peerSql.caCertKey] ?? "") : "";
        rows = (await driver.query(
          connection,
          monitor.sql,
          caCert ? { caCert } : undefined,
        )) as Record<string, unknown>[];
      } else {
        return { ...empty, error: "That resource type has no SQL driver.", durationMs: 0 };
      }
    } else if (plugin.manifest.sqlDriver) {
      const driver = sqlDrivers.get(plugin.manifest.sqlDriver.driver);
      if (!driver) {
        return {
          ...empty,
          error: `Unknown SQL driver: ${plugin.manifest.sqlDriver.driver}`,
          durationMs: 0,
        };
      }
      let connection = credentials[plugin.manifest.sqlDriver.credentialKey] ?? "";
      connection = await rewriteConnectionForTunnel(monitor.accountId, connection);
      const caCert = plugin.manifest.sqlDriver.caCertKey
        ? (credentials[plugin.manifest.sqlDriver.caCertKey] ?? "")
        : "";
      rows = (await driver.query(
        connection,
        monitor.sql,
        caCert ? { caCert } : undefined,
      )) as Record<string, unknown>[];
    }

    if (rows === null) {
      return { ...empty, error: "That account has no SQL driver.", durationMs: 0 };
    }

    return {
      value: readMonitorValue(rows, monitor.mode),
      error: null,
      durationMs: Date.now() - started,
      rows: rows.slice(0, MAX_PREVIEW_ROWS),
    };
  } catch (err) {
    // The driver's message is passed through: "relation does not exist" is the
    // single most useful thing this feature can tell somebody, and replacing it
    // with a generic failure would make every broken monitor look alike.
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

/** Bump `next_run_at` forward, used after a manual run so the schedule holds. */
export async function rescheduleMonitor(monitorId: string, intervalMinutes: number): Promise<void> {
  await db
    .update(queryMonitors)
    .set({ nextRunAt: sql`now() + make_interval(mins => ${intervalMinutes})` })
    .where(eq(queryMonitors.id, monitorId));
}
