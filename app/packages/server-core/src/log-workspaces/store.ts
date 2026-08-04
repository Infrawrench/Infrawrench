/**
 * Log workspace saved queries — CRUD + validation shared by the web API and
 * the poller's alert pass.
 *
 * Validation and the search compiler come from `@infrawrench/client-core`
 * (`validateLogWorkspaceQuery`, `compileLogSearch`), the same functions the
 * workspace UI filters with — the server and the filter box can't disagree
 * about what "matches".
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  compileLogSearch,
  validateLogWorkspaceQuery,
  LOG_WORKSPACE_LIMITS,
  type LogStreamSelector,
  type LogWorkspaceQuery,
  type LogWorkspaceQueryListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { logWorkspaceQueries, resources } from "../db/schema";

export interface LogWorkspaceQueryRecord {
  id: string;
  organizationId: string;
  name: string;
  resources: LogStreamSelector[];
  search: string;
  alertEnabled: boolean;
  nextEvalAt: Date | null;
  lastEvalAt: Date | null;
  lastMatchAt: Date | null;
  lastAlertedAt: Date | null;
  lastEvalError: string | null;
  lastMatchSample: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LogWorkspaceQueryCreateInput {
  name: string;
  resources: LogStreamSelector[];
  search: string;
  alertEnabled?: boolean;
}

export interface LogWorkspaceQueryUpdateInput {
  name?: string;
  resources?: LogStreamSelector[];
  search?: string;
  alertEnabled?: boolean;
}

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class LogWorkspaceInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "LogWorkspaceInputError";
  }
}

/** Postgres unique-index conflict (23505), possibly wrapped by the ORM. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}

export function toWire(row: LogWorkspaceQueryRecord): LogWorkspaceQuery {
  return {
    id: row.id,
    name: row.name,
    resources: row.resources,
    search: row.search,
    alertEnabled: row.alertEnabled,
    lastEvalAt: row.lastEvalAt ? row.lastEvalAt.toISOString() : null,
    lastMatchAt: row.lastMatchAt ? row.lastMatchAt.toISOString() : null,
    lastAlertedAt: row.lastAlertedAt ? row.lastAlertedAt.toISOString() : null,
    lastEvalError: row.lastEvalError,
    lastMatchSample: row.lastMatchSample,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listLogWorkspaceRecords(
  organizationId: string,
): Promise<LogWorkspaceQueryRecord[]> {
  const rows = await db
    .select()
    .from(logWorkspaceQueries)
    .where(eq(logWorkspaceQueries.organizationId, organizationId))
    .orderBy(logWorkspaceQueries.createdAt);
  return rows as LogWorkspaceQueryRecord[];
}

export async function listLogWorkspaceQueries(
  organizationId: string,
): Promise<LogWorkspaceQueryListResponse> {
  const rows = await listLogWorkspaceRecords(organizationId);
  return { queries: rows.map(toWire) };
}

export async function getLogWorkspaceRecord(
  organizationId: string,
  queryId: string,
): Promise<LogWorkspaceQueryRecord | null> {
  const rows = await db
    .select()
    .from(logWorkspaceQueries)
    .where(
      and(
        eq(logWorkspaceQueries.organizationId, organizationId),
        eq(logWorkspaceQueries.id, queryId),
      ),
    )
    .limit(1);
  return (rows[0] as LogWorkspaceQueryRecord | undefined) ?? null;
}

/** Normalize selectors: keep only the wire keys, drop empty containers. */
function normalizeSelectors(selectors: LogStreamSelector[]): LogStreamSelector[] {
  return selectors.map((s) => ({
    resourceId: s.resourceId,
    accountId: s.accountId,
    pluginId: s.pluginId,
    resourceTypeId: s.resourceTypeId,
    ...(s.parentResourceId ? { parentResourceId: s.parentResourceId } : {}),
    ...(s.container ? { container: s.container } : {}),
  }));
}

/**
 * Verify every selector points at a live synced resource in this org whose
 * account matches. For a sidecar selector the peer resource is never a stored
 * row — the *parent* is what must resolve (its outputs mint the peer client's
 * credentials), so the same checks apply to `parentResourceId` instead.
 * Best-effort resource-name checks stay out of here — a resource deleted
 * later just shows as gone in the workspace.
 */
async function assertSelectorsResolve(
  organizationId: string,
  selectors: LogStreamSelector[],
): Promise<void> {
  const ids = [...new Set(selectors.map((s) => s.parentResourceId ?? s.resourceId))];
  const rows = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const selector of selectors) {
    const anchorId = selector.parentResourceId ?? selector.resourceId;
    const row = byId.get(anchorId);
    if (!row || row.deletedAt !== null) {
      throw new LogWorkspaceInputError(
        `Resource ${anchorId} was not found in this organization`,
        404,
      );
    }
    if (row.accountId !== selector.accountId) {
      throw new LogWorkspaceInputError(`Resource ${anchorId} does not belong to that account`);
    }
  }
}

/** `nextEvalAt` for a row's alert flag: due immediately when on, null when off. */
export function nextEvalColumns(alertEnabled: boolean, now?: number): { nextEvalAt: Date | null } {
  return { nextEvalAt: alertEnabled ? new Date(now ?? Date.now()) : null };
}

export async function createLogWorkspaceRecord(
  organizationId: string,
  input: LogWorkspaceQueryCreateInput,
  createdByUserId?: string,
): Promise<LogWorkspaceQueryRecord> {
  const name = input.name.trim();
  const validationError = validateLogWorkspaceQuery({
    name,
    resources: input.resources,
    search: input.search,
  });
  if (validationError) throw new LogWorkspaceInputError(validationError);
  const alertEnabled = input.alertEnabled ?? false;
  if (alertEnabled && compileLogSearch(input.search).matchAll) {
    throw new LogWorkspaceInputError(
      "Alerting requires a non-empty search expression — an empty query matches every line",
    );
  }
  await assertSelectorsResolve(organizationId, input.resources);

  const now = new Date();
  const row = {
    id: randomUUID(),
    organizationId,
    name,
    resources: normalizeSelectors(input.resources),
    search: input.search,
    alertEnabled,
    ...nextEvalColumns(alertEnabled, now.getTime()),
    createdByUserId: createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // The duplicate-name check, the per-org limit and the insert run in one
  // transaction under an org-scoped advisory lock, so two concurrent creates
  // can't both pass the checks. The unique index on (organization_id, name)
  // is the hard backstop — a conflict surfaces as the same 409 the pre-check
  // gives, never as a raw database error.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`log_workspace_queries:${organizationId}`}))`,
      );
      const existing = await tx
        .select({ id: logWorkspaceQueries.id })
        .from(logWorkspaceQueries)
        .where(
          and(
            eq(logWorkspaceQueries.organizationId, organizationId),
            eq(logWorkspaceQueries.name, name),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new LogWorkspaceInputError(
          "A saved query with this name already exists — pick another name or update it",
          409,
        );
      }

      const count = await tx
        .select({ id: logWorkspaceQueries.id })
        .from(logWorkspaceQueries)
        .where(eq(logWorkspaceQueries.organizationId, organizationId));
      if (count.length >= LOG_WORKSPACE_LIMITS.maxPerOrg) {
        throw new LogWorkspaceInputError(
          `Organizations are limited to ${LOG_WORKSPACE_LIMITS.maxPerOrg} saved log queries`,
        );
      }

      await tx.insert(logWorkspaceQueries).values(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new LogWorkspaceInputError(
        "A saved query with this name already exists — pick another name or update it",
        409,
      );
    }
    throw error;
  }
  return (await getLogWorkspaceRecord(organizationId, row.id))!;
}

/**
 * Update name/resources/search and/or toggle the alert. Changing the search
 * or the resource set (or turning the alert on) makes the query due for a
 * fresh evaluation immediately and clears stale evaluation state; turning
 * the alert off clears `nextEvalAt` so the pass never claims it.
 */
export async function updateLogWorkspaceRecord(
  organizationId: string,
  queryId: string,
  patch: LogWorkspaceQueryUpdateInput,
): Promise<LogWorkspaceQueryRecord> {
  const existing = await getLogWorkspaceRecord(organizationId, queryId);
  if (!existing) throw new LogWorkspaceInputError("Saved query not found", 404);

  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  const selectors = patch.resources ?? existing.resources;
  const search = patch.search ?? existing.search;
  const alertEnabled = patch.alertEnabled ?? existing.alertEnabled;

  const validationError = validateLogWorkspaceQuery({ name, resources: selectors, search });
  if (validationError) throw new LogWorkspaceInputError(validationError);
  if (alertEnabled && compileLogSearch(search).matchAll) {
    throw new LogWorkspaceInputError(
      "Alerting requires a non-empty search expression — an empty query matches every line",
    );
  }
  if (patch.resources !== undefined) {
    await assertSelectorsResolve(organizationId, patch.resources);
  }

  const queryChanged = patch.resources !== undefined || patch.search !== undefined;
  const alertTurnedOn = alertEnabled && !existing.alertEnabled;

  try {
    await db
      .update(logWorkspaceQueries)
      .set({
        name,
        resources: normalizeSelectors(selectors),
        search,
        alertEnabled,
        ...(alertEnabled
          ? queryChanged || alertTurnedOn
            ? nextEvalColumns(true)
            : {}
          : { nextEvalAt: null }),
        ...(queryChanged
          ? { lastEvalError: null, lastMatchSample: null, lastMatchAt: null, lastEvalAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(logWorkspaceQueries.organizationId, organizationId),
          eq(logWorkspaceQueries.id, queryId),
        ),
      );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new LogWorkspaceInputError(
        "A saved query with this name already exists — pick another name or update it",
        409,
      );
    }
    throw error;
  }
  return (await getLogWorkspaceRecord(organizationId, queryId))!;
}

export async function deleteLogWorkspaceRecord(
  organizationId: string,
  queryId: string,
): Promise<LogWorkspaceQueryRecord> {
  const existing = await getLogWorkspaceRecord(organizationId, queryId);
  if (!existing) throw new LogWorkspaceInputError("Saved query not found", 404);
  await db
    .delete(logWorkspaceQueries)
    .where(
      and(
        eq(logWorkspaceQueries.organizationId, organizationId),
        eq(logWorkspaceQueries.id, queryId),
      ),
    );
  return existing;
}
