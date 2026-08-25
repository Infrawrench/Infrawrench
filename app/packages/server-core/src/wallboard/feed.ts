/**
 * Assemble the wallboard from what is true right now.
 *
 * Four sources: declared incidents, synthetic probes, query monitors and
 * account sync health. Every one of them is a read of a table this product
 * already keeps, and every one is guarded independently — a wallboard that goes
 * blank because one query threw is a television showing nothing to a room that
 * was relying on it.
 *
 * A source belongs here once the table it reads exists — the query monitors
 * source arrives in the same change as `query_monitors` itself for that reason.
 * An earlier attempt to read it ahead of its migration, tolerating the absence,
 * put "Could not read: query monitors" on every wall in the building instead:
 * a guard cannot tell a missing table from a broken query, and should not try.
 *
 * **A source that fails is named on the screen and makes the wall amber.** The
 * alternative — swallowing the error and rendering the remaining sources green
 * — is the single worst thing this feature could do: a wall actively telling a
 * room that everything is fine because a query failed.
 *
 * There is deliberately no history, no trend and no breakdown here. A wallboard
 * may only show things somebody would cross a room to look at; everything else
 * belongs on the page they open when they get there.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  QUERY_MONITOR_OPERATOR_LABELS,
  WALLBOARD_LIMITS,
  wallboardStatus,
  type WallboardFailureLine,
  type WallboardIncidentLine,
  type WallboardResponse,
  type WallboardTile,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, incidents, pagingIncidents, queryMonitors, syntheticProbes } from "../db/schema";

export interface WallboardOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
}

interface SourceResult<T> {
  value: T;
  failed: boolean;
}

/** "4213 > 1000" — what the monitor saw, against what it watches for. */
function describeBreach(monitor: {
  mode: "scalar" | "rowCount";
  operator: keyof typeof QUERY_MONITOR_OPERATOR_LABELS;
  threshold: number;
  lastValue: number | null;
}): string {
  const comparison = `${QUERY_MONITOR_OPERATOR_LABELS[monitor.operator]} ${monitor.threshold}`;
  if (monitor.lastValue === null) {
    return `${monitor.mode === "rowCount" ? "row count" : "value"} ${comparison}`;
  }
  return `${monitor.lastValue} ${comparison}`;
}

/**
 * Run one source, returning a fallback and a flag rather than throwing.
 *
 * The flag is what reaches the screen — see the module note on why a silent
 * fallback would be the worst possible behaviour here.
 */
async function guard<T>(
  name: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<SourceResult<T>> {
  try {
    return { value: await run(), failed: false };
  } catch (err) {
    console.error(`[wallboard] source ${name} failed:`, err);
    return { value: fallback, failed: true };
  }
}

export async function getWallboard(
  organizationId: string,
  options: WallboardOptions = {},
): Promise<WallboardResponse> {
  const now = options.now ?? Date.now();

  const [incidentResult, probeResult, monitorResult, accountResult] = await Promise.all([
    guard("incidents", [] as WallboardIncidentLine[], async () => {
      const rows = await db
        .select({
          id: incidents.id,
          title: incidents.title,
          severity: incidents.severity,
          status: incidents.status,
          startedAt: incidents.startedAt,
        })
        .from(incidents)
        .where(and(eq(incidents.organizationId, organizationId), isNull(incidents.resolvedAt)))
        .orderBy(desc(incidents.startedAt))
        .limit(WALLBOARD_LIMITS.maxLines);
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        severity: row.severity,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
      }));
    }),

    guard("probes", { down: [] as WallboardFailureLine[], total: 0 }, async () => {
      const rows = await db
        .select({
          id: syntheticProbes.id,
          name: syntheticProbes.name,
          status: syntheticProbes.status,
          lastError: syntheticProbes.lastError,
          lastStateChangeAt: syntheticProbes.lastStateChangeAt,
        })
        .from(syntheticProbes)
        .where(
          and(
            eq(syntheticProbes.organizationId, organizationId),
            eq(syntheticProbes.enabled, true),
          ),
        );
      return {
        // `unknown` is not down. A probe that has never run has not failed, and
        // putting it on the wall as a failure would make a freshly created
        // probe look like an outage.
        down: rows
          .filter((row) => row.status === "down")
          .slice(0, WALLBOARD_LIMITS.maxLines)
          .map((row) => ({
            id: `probe:${row.id}`,
            label: row.name,
            detail: row.lastError ?? "not responding",
            since: row.lastStateChangeAt?.toISOString() ?? null,
          })),
        total: rows.length,
      };
    }),

    // Query monitors: what the data says, which is the half of an incident no
    // metric reports. Both states that mean "not fine" go on the wall — a
    // monitor that is breaching, and one whose query failed, because a monitor
    // that cannot run has told the room nothing and rendering that as green is
    // exactly the lie this feature exists to avoid. A monitor that has never
    // run has not failed, the same rule the probes follow.
    guard(
      "monitors",
      { lines: [] as WallboardFailureLine[], breaching: 0, silent: 0 },
      async () => {
        const rows = await db
          .select({
            id: queryMonitors.id,
            name: queryMonitors.name,
            state: queryMonitors.state,
            mode: queryMonitors.mode,
            operator: queryMonitors.operator,
            threshold: queryMonitors.threshold,
            lastValue: queryMonitors.lastValue,
            lastError: queryMonitors.lastError,
            lastRunAt: queryMonitors.lastRunAt,
          })
          .from(queryMonitors)
          .where(
            and(eq(queryMonitors.organizationId, organizationId), eq(queryMonitors.enabled, true)),
          )
          .orderBy(desc(queryMonitors.lastRunAt));

        const breaching = rows.filter((row) => row.state === "breaching");
        const silent = rows.filter(
          (row) => row.state === "unknown" && row.lastRunAt !== null && row.lastError !== null,
        );
        return {
          lines: [...breaching, ...silent].slice(0, WALLBOARD_LIMITS.maxLines).map((row) => ({
            id: `monitor:${row.id}`,
            label: row.name,
            detail:
              row.state === "breaching" ? describeBreach(row) : (row.lastError ?? "did not run"),
            // The breach's own start is not kept — a monitor stores its last
            // outcome, not a history — and inventing one from the streak would
            // put a number on the wall that nothing backs.
            since: null,
          })),
          breaching: breaching.length,
          silent: silent.length,
        };
      },
    ),

    // Sync health comes from the *paging* incidents rather than from a column
    // on the account, because that is the signal the org already gets woken up
    // by: a wall that disagreed with the pager about whether an account is
    // broken would be worse than no wall.
    guard("accounts", { broken: [] as WallboardFailureLine[], total: 0 }, async () => {
      const [liveAccounts, open] = await Promise.all([
        db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
        db
          .select({
            id: pagingIncidents.id,
            accountId: pagingIncidents.accountId,
            resourceTypeId: pagingIncidents.resourceTypeId,
            openedAt: pagingIncidents.openedAt,
            displayName: accounts.displayName,
          })
          .from(pagingIncidents)
          .innerJoin(accounts, eq(accounts.id, pagingIncidents.accountId))
          .where(
            and(
              eq(pagingIncidents.organizationId, organizationId),
              isNull(pagingIncidents.closedAt),
              isNull(accounts.deletedAt),
            ),
          )
          .orderBy(desc(pagingIncidents.openedAt))
          .limit(WALLBOARD_LIMITS.maxLines),
      ]);
      return {
        broken: open.map((row) => ({
          id: `sync:${row.id}`,
          label: row.displayName,
          detail: `${row.resourceTypeId} not syncing`,
          since: row.openedAt.toISOString(),
        })),
        total: liveAccounts.length,
      };
    }),
  ]);

  const failedSources = [
    ...(incidentResult.failed ? ["incidents"] : []),
    ...(probeResult.failed ? ["probes"] : []),
    ...(monitorResult.failed ? ["query monitors"] : []),
    ...(accountResult.failed ? ["accounts"] : []),
  ];

  const failures = [
    ...probeResult.value.down,
    ...monitorResult.value.lines,
    ...accountResult.value.broken,
  ].slice(0, WALLBOARD_LIMITS.maxLines);

  const status = wallboardStatus({
    incidents: incidentResult.value,
    failures,
    failedSources,
    probesDown: probeResult.value.down.length,
  });

  const tiles: WallboardTile[] = [
    {
      id: "incidents",
      label: "Open incidents",
      value: String(incidentResult.value.length),
      detail: incidentResult.failed ? "could not be read" : null,
      status: incidentResult.failed
        ? "degraded"
        : incidentResult.value.length === 0
          ? "ok"
          : "degraded",
    },
    {
      id: "probes",
      label: "Probes up",
      // A ratio rather than a failure count: "18/19" is legible at four metres
      // and says how big the estate is at the same time.
      value: `${probeResult.value.total - probeResult.value.down.length}/${probeResult.value.total}`,
      detail: probeResult.failed ? "could not be read" : null,
      status: probeResult.failed ? "degraded" : probeResult.value.down.length > 0 ? "down" : "ok",
    },
    {
      id: "monitors",
      label: "Monitors breaching",
      value: String(monitorResult.value.breaching),
      // A monitor that cannot run is not breaching and is not fine either, so
      // it is counted under the number rather than folded into it.
      detail: monitorResult.failed
        ? "could not be read"
        : monitorResult.value.silent > 0
          ? `${monitorResult.value.silent} not reporting`
          : null,
      status:
        monitorResult.failed || monitorResult.value.breaching > 0 || monitorResult.value.silent > 0
          ? "degraded"
          : "ok",
    },
    {
      id: "accounts",
      label: "Accounts syncing",
      // The denominator is accounts and the numerator subtracts *incidents*,
      // so an account with two broken resource types reads as more than one
      // problem — which is what it is, and what the pager already says.
      value: `${Math.max(0, accountResult.value.total - accountResult.value.broken.length)}/${accountResult.value.total}`,
      detail: accountResult.failed ? "could not be read" : null,
      status: accountResult.failed
        ? "degraded"
        : accountResult.value.broken.length > 0
          ? "degraded"
          : "ok",
    },
  ];

  return {
    status,
    tiles,
    incidents: incidentResult.value,
    failures,
    failedSources,
    generatedAt: new Date(now).toISOString(),
  };
}
