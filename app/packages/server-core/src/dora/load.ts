/**
 * Gathering for DORA metrics: every source read in one place, then handed to
 * the pure engine in `client-core/src/dora.ts`.
 *
 * Reads Postgres only (deploy events, Infrafile runs, declared incidents,
 * resource changes, commit times, ownership) and calls no plugin code, so the
 * routes that use it are safe on the edge.
 */
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  analyzeDora,
  buildDoraReport,
  scopeDoraAnalysis,
  type DoraAnalysis,
  type DoraBucketSize,
  type DoraChange,
  type DoraDeployEvent,
  type DoraIncidentInput,
  type DoraReport,
  type DoraResourceChangeInput,
  type DoraRestore,
  type DoraScopeFilter,
  type DoraScopeValue,
  type DoraSettingsView,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import {
  deployEvents,
  deploymentRuns,
  doraCommitTimes,
  incidents,
  resourceChanges,
} from "../db/schema";
import { listDoraScopeDimensions, type DoraScopeSubject } from "./dimensions";
import { getDoraSettings } from "./settings";
import { normalizeRepository } from "./repository";

/** Hard caps per source, so a pathological org cannot make one report unbounded. */
export const DORA_LOAD_LIMIT = 20_000;
export const DORA_MAX_RANGE_DAYS = 366;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface DoraWindow {
  from: Date;
  to: Date;
}

interface LoadedInputs {
  settings: DoraSettingsView;
  events: DoraDeployEvent[];
  incidents: DoraIncidentInput[];
  resourceChanges: DoraResourceChangeInput[];
}

/**
 * Load everything a report over `[from, to)` needs: the window, the same-length
 * period before it (the deltas), and one failure window before that, so a
 * change just before the previous period can still be blamed.
 */
async function loadInputs(organizationId: string, window: DoraWindow): Promise<LoadedInputs> {
  const settings = await getDoraSettings(organizationId);
  const span = window.to.getTime() - window.from.getTime();
  const loadFrom = new Date(window.from.getTime() - span - settings.failureWindowHours * HOUR_MS);
  const loadTo = window.to;

  const [eventRows, runRows, incidentRows, changeRows] = await Promise.all([
    db
      .select()
      .from(deployEvents)
      .where(
        and(
          eq(deployEvents.organizationId, organizationId),
          gte(deployEvents.deployedAt, loadFrom),
          lt(deployEvents.deployedAt, loadTo),
        ),
      )
      .orderBy(desc(deployEvents.deployedAt))
      .limit(DORA_LOAD_LIMIT),
    db
      .select({
        id: deploymentRuns.id,
        env: deploymentRuns.env,
        repo: deploymentRuns.repo,
        gitSha: deploymentRuns.gitSha,
        status: deploymentRuns.status,
        startedAt: deploymentRuns.startedAt,
        finishedAt: deploymentRuns.finishedAt,
      })
      .from(deploymentRuns)
      .where(
        and(
          eq(deploymentRuns.organizationId, organizationId),
          gte(deploymentRuns.startedAt, loadFrom),
          lt(deploymentRuns.startedAt, loadTo),
        ),
      )
      .orderBy(desc(deploymentRuns.startedAt))
      .limit(DORA_LOAD_LIMIT),
    db
      .select({
        id: incidents.id,
        title: incidents.title,
        severity: incidents.severity,
        startedAt: incidents.startedAt,
        resolvedAt: incidents.resolvedAt,
        affectedResourceIds: incidents.affectedResourceIds,
        affectedAccountIds: incidents.affectedAccountIds,
      })
      .from(incidents)
      .where(
        and(
          eq(incidents.organizationId, organizationId),
          lt(incidents.startedAt, loadTo),
          or(gte(incidents.startedAt, loadFrom), gte(incidents.resolvedAt, loadFrom)),
        ),
      )
      .limit(DORA_LOAD_LIMIT),
    settings.includeResourceChanges
      ? db
          .select({
            id: resourceChanges.id,
            resourceId: resourceChanges.resourceId,
            accountId: resourceChanges.accountId,
            pluginId: resourceChanges.pluginId,
            displayName: resourceChanges.displayName,
            changeKind: resourceChanges.changeKind,
            createdAt: resourceChanges.createdAt,
            revertedAt: resourceChanges.revertedAt,
          })
          .from(resourceChanges)
          .where(
            and(
              eq(resourceChanges.organizationId, organizationId),
              gte(resourceChanges.createdAt, loadFrom),
              lt(resourceChanges.createdAt, loadTo),
              // Sleep/wake schedule transitions are the product acting on a
              // plan, not a change anybody shipped.
              isNull(resourceChanges.origin),
            ),
          )
          .orderBy(desc(resourceChanges.createdAt))
          .limit(DORA_LOAD_LIMIT)
      : Promise.resolve([]),
  ]);

  const events: DoraDeployEvent[] = [
    ...eventRows.map((r): DoraDeployEvent => ({
      id: r.id,
      source: r.source,
      kind: r.kind,
      name: r.name,
      environment: r.environment,
      repository: r.repository,
      commitSha: r.commitSha,
      commitAt: r.commitAt?.toISOString() ?? null,
      deployedAt: r.deployedAt.toISOString(),
      status: r.status,
      isRollback: r.isRollback,
      accountId: r.accountId,
      pluginId: r.pluginId,
      resourceId: r.resourceId,
      targetResourceId: r.targetResourceId,
      url: r.url,
      scope: {},
    })),
    ...runRows.map((r): DoraDeployEvent => ({
      id: r.id,
      source: "infrafile",
      kind: "deployment",
      name: r.repo ?? r.env,
      environment: r.env,
      repository: normalizeRepository(r.repo),
      commitSha: r.gitSha,
      commitAt: null,
      deployedAt: (r.finishedAt ?? r.startedAt).toISOString(),
      status: infrafileStatus(r.status),
      isRollback: false,
      accountId: null,
      pluginId: null,
      resourceId: null,
      targetResourceId: null,
      url: null,
      scope: {},
    })),
  ];

  await attachCommitTimes(organizationId, events);

  return {
    settings,
    events,
    incidents: incidentRows.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      startedAt: r.startedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      affectedResourceIds: r.affectedResourceIds ?? [],
      affectedAccountIds: r.affectedAccountIds ?? [],
    })),
    resourceChanges: changeRows.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      accountId: r.accountId,
      pluginId: r.pluginId,
      displayName: r.displayName,
      changeKind: r.changeKind,
      at: r.createdAt.toISOString(),
      revertedAt: r.revertedAt?.toISOString() ?? null,
      scope: {},
    })),
  };
}

function infrafileStatus(s: string): DoraDeployEvent["status"] {
  if (s === "success") return "success";
  if (s === "failure") return "failure";
  if (s === "canceled") return "canceled";
  return "in_progress";
}

/** Fill `commitAt` from resolved commit times where the source did not carry it. */
async function attachCommitTimes(organizationId: string, events: DoraDeployEvent[]): Promise<void> {
  const wanted = events.filter((e) => !e.commitAt && e.repository && e.commitSha);
  if (wanted.length === 0) return;
  const repos = [...new Set(wanted.map((e) => e.repository!))];
  const shas = [...new Set(wanted.map((e) => e.commitSha!))];
  const rows = await db
    .select({
      repository: doraCommitTimes.repository,
      commitSha: doraCommitTimes.commitSha,
      committedAt: doraCommitTimes.committedAt,
    })
    .from(doraCommitTimes)
    .where(
      and(
        eq(doraCommitTimes.organizationId, organizationId),
        inArray(doraCommitTimes.repository, repos),
        inArray(doraCommitTimes.commitSha, shas),
      ),
    );
  const times = new Map(
    rows
      .filter((r) => r.committedAt)
      .map((r) => [`${r.repository}\u0000${r.commitSha}`, r.committedAt!.toISOString()]),
  );
  for (const e of wanted) {
    const t = times.get(`${e.repository}\u0000${e.commitSha}`);
    if (t) e.commitAt = t;
  }
}

/** Resolve every registered dimension for every subject, in place. */
async function attachScopes(
  organizationId: string,
  events: DoraDeployEvent[],
  changes: DoraResourceChangeInput[],
): Promise<void> {
  const subjects: DoraScopeSubject[] = [
    ...events.map((e) => ({
      id: e.id,
      type: "deploy" as const,
      environment: e.environment,
      repository: e.repository,
      accountId: e.accountId,
      pluginId: e.pluginId,
      resourceId: e.resourceId,
      targetResourceId: e.targetResourceId,
    })),
    ...changes.map((c) => ({
      id: c.id,
      type: "resource_change" as const,
      environment: null,
      repository: null,
      accountId: c.accountId,
      pluginId: c.pluginId,
      resourceId: c.resourceId,
      targetResourceId: null,
    })),
  ];
  const scopes = new Map<string, Record<string, DoraScopeValue | null>>();
  for (const s of subjects) scopes.set(s.id, {});
  await Promise.all(
    listDoraScopeDimensions().map(async (d) => {
      let values: Map<string, DoraScopeValue | null>;
      try {
        values = await d.resolve(organizationId, subjects);
      } catch (err) {
        // One dimension failing costs that column, not the report.
        console.error(`[dora] scope dimension ${d.id} failed:`, err);
        return;
      }
      for (const [id, v] of values) {
        const rec = scopes.get(id);
        if (rec) rec[d.id] = v;
      }
    }),
  );
  for (const e of events) e.scope = scopes.get(e.id) ?? {};
  for (const c of changes) c.scope = scopes.get(c.id) ?? {};
}

export interface DoraReportQuery extends DoraWindow {
  bucket?: DoraBucketSize;
  filter?: DoraScopeFilter | null;
  groupBy?: string;
}

export class DoraQueryError extends Error {
  readonly status = 400 as const;
}

/** Validate a window: ordered, not in the future by more than a day, at most a year. */
export function checkDoraWindow(window: DoraWindow): void {
  const span = window.to.getTime() - window.from.getTime();
  if (!Number.isFinite(span) || span <= 0) throw new DoraQueryError("from must be before to");
  if (span > DORA_MAX_RANGE_DAYS * DAY_MS) {
    throw new DoraQueryError(`The range is at most ${DORA_MAX_RANGE_DAYS} days`);
  }
}

function checkDimension(id: string | undefined): void {
  if (id === undefined) return;
  if (!listDoraScopeDimensions().some((d) => d.id === id)) {
    throw new DoraQueryError(
      `Unknown dimension "${id}"; one of ${listDoraScopeDimensions()
        .map((d) => d.id)
        .join(", ")}`,
    );
  }
}

async function loadAnalysis(
  organizationId: string,
  window: DoraWindow,
): Promise<{ inputs: LoadedInputs; analysis: DoraAnalysis }> {
  const inputs = await loadInputs(organizationId, window);
  await attachScopes(organizationId, inputs.events, inputs.resourceChanges);
  return { inputs, analysis: analyzeDora(inputs) };
}

export async function getDoraReport(
  organizationId: string,
  query: DoraReportQuery,
): Promise<DoraReport> {
  checkDoraWindow(query);
  checkDimension(query.filter?.dimension);
  checkDimension(query.groupBy);
  const span = query.to.getTime() - query.from.getTime();
  const bucket = query.bucket ?? (span > 45 * DAY_MS ? "week" : "day");
  const inputs = await loadInputs(organizationId, query);
  await attachScopes(organizationId, inputs.events, inputs.resourceChanges);
  return buildDoraReport({
    ...inputs,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    bucket,
    filter: query.filter ?? null,
    groupBy: query.groupBy ?? "environment",
    dimensions: listDoraScopeDimensions().map((d) => ({ id: d.id, label: d.label })),
    settingsView: inputs.settings,
  });
}

export const DORA_DRILL_LIMIT = 500;

/** The drill-down: production changes in the window, newest first. */
export async function listDoraChanges(
  organizationId: string,
  query: DoraWindow & { filter?: DoraScopeFilter | null; failedOnly?: boolean },
): Promise<{ changes: DoraChange[]; truncated: boolean }> {
  checkDoraWindow(query);
  checkDimension(query.filter?.dimension);
  const { analysis } = await loadAnalysis(organizationId, query);
  const scoped = scopeDoraAnalysis(analysis, query.filter ?? null);
  const fromMs = query.from.getTime();
  const toMs = query.to.getTime();
  const rows = scoped.changes
    .filter((c) => {
      const t = Date.parse(c.at);
      return t >= fromMs && t < toMs && (!query.failedOnly || c.failure !== null);
    })
    .reverse();
  return { changes: rows.slice(0, DORA_DRILL_LIMIT), truncated: rows.length > DORA_DRILL_LIMIT };
}

/** Recoveries completed in the window, newest first. */
export async function listDoraRestores(
  organizationId: string,
  query: DoraWindow & { filter?: DoraScopeFilter | null },
): Promise<DoraRestore[]> {
  checkDoraWindow(query);
  checkDimension(query.filter?.dimension);
  const { analysis } = await loadAnalysis(organizationId, query);
  const scoped = scopeDoraAnalysis(analysis, query.filter ?? null);
  const fromMs = query.from.getTime();
  const toMs = query.to.getTime();
  return scoped.restores
    .filter((r) => {
      const t = Date.parse(r.restoredAt);
      return t >= fromMs && t < toMs;
    })
    .reverse()
    .slice(0, DORA_DRILL_LIMIT);
}

/** Delete deploy events older than the retention, for the poller's retention pass. */
export async function pruneDeployEvents(olderThanDays = 400): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS);
  const res = await db
    .delete(deployEvents)
    .where(lt(deployEvents.deployedAt, cutoff))
    .returning({ id: deployEvents.id });
  await db.delete(doraCommitTimes).where(lt(doraCommitTimes.checkedAt, cutoff));
  return res.length;
}
