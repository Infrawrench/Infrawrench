/**
 * Row-level CRUD for declared incidents, their notes and their artefacts.
 *
 * Deliberately **side-effect free**: nothing in here opens a freeze, posts to
 * Slack or touches a status page. Composition lives one layer up, in web's
 * `services/incidents.ts`, so that the durable record of an incident can always
 * be written even when every integration it wanted to use is on fire. That
 * ordering — persist first, then attempt, then record the outcome — is the
 * whole partial-failure design, and it only works if this layer cannot fail for
 * an integration's reasons.
 *
 * (The other "incident" in this codebase is `provider_status_incidents`, a
 * provider's own status-page entry. See `status/match.ts`.)
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_LIMITS,
  type Incident,
  type IncidentArtifactKind,
  type IncidentArtifactStatus,
  type IncidentNote,
  type IncidentSeverity,
  type IncidentStatus,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { incidentArtifacts, incidentNotes, incidents, users } from "../db/schema";
import type { IncidentArtifactRow, IncidentRow } from "../db/incident-schema";

/** Input rejected at the boundary, with the status the route should return. */
export class IncidentInputError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "IncidentInputError";
    this.status = status;
  }
}

export interface IncidentCreateInput {
  title: string;
  severity?: IncidentSeverity | undefined;
  summary?: string | null | undefined;
  startedAt?: Date | undefined;
  affectedResourceIds?: string[] | undefined;
  affectedAccountIds?: string[] | undefined;
}

export interface IncidentUpdateInput {
  title?: string | undefined;
  severity?: IncidentSeverity | undefined;
  status?: IncidentStatus | undefined;
  summary?: string | null | undefined;
  affectedResourceIds?: string[] | undefined;
  affectedAccountIds?: string[] | undefined;
  issueUrl?: string | null | undefined;
}

function trimmedTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) throw new IncidentInputError("An incident needs a title.");
  if (title.length > INCIDENT_LIMITS.maxTitleLength) {
    throw new IncidentInputError(
      `The title must be ${INCIDENT_LIMITS.maxTitleLength} characters or fewer.`,
    );
  }
  return title;
}

function normalizeSummary(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const summary = String(raw).trim();
  if (!summary) return null;
  if (summary.length > INCIDENT_LIMITS.maxSummaryLength) {
    throw new IncidentInputError(
      `The summary must be ${INCIDENT_LIMITS.maxSummaryLength} characters or fewer.`,
    );
  }
  return summary;
}

/** Dedupe, drop blanks, and cap — an id list is user input like any other. */
function normalizeIds(raw: readonly string[] | undefined, max: number, what: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  if (seen.size > max) {
    throw new IncidentInputError(`At most ${max} ${what} can be named on one incident.`);
  }
  return Array.from(seen);
}

function isSeverity(value: unknown): value is IncidentSeverity {
  return value === "sev1" || value === "sev2" || value === "sev3" || value === "sev4";
}

function isStatus(value: unknown): value is IncidentStatus {
  return value === "open" || value === "mitigated" || value === "resolved";
}

export function parseIncidentSeverity(raw: unknown): IncidentSeverity | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isSeverity(raw)) throw new IncidentInputError(`Unknown severity "${String(raw)}".`);
  return raw;
}

export function parseIncidentStatus(raw: unknown): IncidentStatus | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isStatus(raw)) throw new IncidentInputError(`Unknown status "${String(raw)}".`);
  return raw;
}

/** ISO-or-nothing; an unparseable timestamp is a 400, never a silent `now`. */
export function parseIncidentTimestamp(raw: unknown, field: string): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) {
    throw new IncidentInputError(`\`${field}\` is not a valid timestamp.`);
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Wire assembly
 * ------------------------------------------------------------------ */

function artifactToWire(row: IncidentArtifactRow) {
  return {
    id: row.id,
    kind: row.kind as IncidentArtifactKind,
    status: row.status as IncidentArtifactStatus,
    label: row.label,
    refId: row.refId,
    refSecondary: row.refSecondary,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function incidentToWire(
  row: IncidentRow,
  artifacts: IncidentArtifactRow[],
  declaredByName: string | null,
  noteCount: number,
): Incident {
  return {
    id: row.id,
    title: row.title,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    startedAt: row.startedAt.toISOString(),
    mitigatedAt: row.mitigatedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    declaredByUserId: row.declaredByUserId,
    declaredByName,
    resolvedByUserId: row.resolvedByUserId,
    affectedResourceIds: row.affectedResourceIds ?? [],
    affectedAccountIds: row.affectedAccountIds ?? [],
    issueUrl: row.issueUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    artifacts: artifacts.map(artifactToWire),
    noteCount,
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface ListIncidentsOptions {
  status?: IncidentStatus | undefined;
  limit?: number | undefined;
}

/**
 * The org's incidents, newest first, each with its artefacts. One extra query
 * for artefacts and one for declarer names rather than N — a list of fifty
 * incidents is three round trips.
 */
export async function listIncidentRecords(
  organizationId: string,
  options: ListIncidentsOptions = {},
): Promise<Incident[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const rows = await db
    .select()
    .from(incidents)
    .where(
      options.status
        ? and(eq(incidents.organizationId, organizationId), eq(incidents.status, options.status))
        : eq(incidents.organizationId, organizationId),
    )
    .orderBy(desc(incidents.startedAt))
    .limit(limit);
  if (rows.length === 0) return [];
  return hydrate(rows);
}

async function hydrate(rows: IncidentRow[]): Promise<Incident[]> {
  const ids = rows.map((row) => row.id);
  const [artifactRows, noteRows, declarerNames] = await Promise.all([
    db.select().from(incidentArtifacts).where(inArray(incidentArtifacts.incidentId, ids)),
    db
      .select({ id: incidentNotes.id, incidentId: incidentNotes.incidentId })
      .from(incidentNotes)
      .where(inArray(incidentNotes.incidentId, ids)),
    lookupUserNames(rows.map((row) => row.declaredByUserId)),
  ]);

  const artifactsById = new Map<string, IncidentArtifactRow[]>();
  for (const artifact of artifactRows) {
    const list = artifactsById.get(artifact.incidentId);
    if (list) list.push(artifact);
    else artifactsById.set(artifact.incidentId, [artifact]);
  }
  const noteCounts = new Map<string, number>();
  for (const note of noteRows) {
    noteCounts.set(note.incidentId, (noteCounts.get(note.incidentId) ?? 0) + 1);
  }

  return rows.map((row) =>
    incidentToWire(
      row,
      artifactsById.get(row.id) ?? [],
      row.declaredByUserId ? (declarerNames.get(row.declaredByUserId) ?? null) : null,
      noteCounts.get(row.id) ?? 0,
    ),
  );
}

async function lookupUserNames(
  userIds: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.id, row.displayName ?? row.email ?? row.id);
  return map;
}

/** One incident with its artefacts, or null when it is not this org's. */
export async function getIncidentRecord(
  organizationId: string,
  incidentId: string,
): Promise<Incident | null> {
  const rows = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await hydrate([row]))[0] ?? null;
}

/** The raw row, for callers that need `Date`s rather than ISO strings. */
export async function getIncidentRow(
  organizationId: string,
  incidentId: string,
): Promise<IncidentRow | null> {
  const rows = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listIncidentNoteRecords(incidentId: string): Promise<IncidentNote[]> {
  const rows = await db
    .select({
      id: incidentNotes.id,
      body: incidentNotes.body,
      authorUserId: incidentNotes.authorUserId,
      occurredAt: incidentNotes.occurredAt,
      createdAt: incidentNotes.createdAt,
      authorName: users.displayName,
      authorEmail: users.email,
    })
    .from(incidentNotes)
    .leftJoin(users, eq(users.id, incidentNotes.authorUserId))
    .where(eq(incidentNotes.incidentId, incidentId))
    .orderBy(incidentNotes.occurredAt);
  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    authorUserId: row.authorUserId,
    authorName: row.authorName ?? row.authorEmail ?? null,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Persist the incident. This is the call that must succeed before any artefact
 * is attempted — everything else about a declaration is recoverable, and this
 * is not.
 */
export async function createIncidentRecord(
  organizationId: string,
  input: IncidentCreateInput,
  declaredByUserId: string | null,
): Promise<Incident> {
  const row = {
    id: randomUUID(),
    organizationId,
    title: trimmedTitle(input.title),
    severity: input.severity ?? DEFAULT_INCIDENT_SEVERITY,
    status: "open" as const,
    summary: normalizeSummary(input.summary),
    startedAt: input.startedAt ?? new Date(),
    mitigatedAt: null,
    resolvedAt: null,
    declaredByUserId,
    resolvedByUserId: null,
    affectedResourceIds: normalizeIds(
      input.affectedResourceIds,
      INCIDENT_LIMITS.maxAffectedResources,
      "resources",
    ),
    affectedAccountIds: normalizeIds(
      input.affectedAccountIds,
      INCIDENT_LIMITS.maxAffectedAccounts,
      "accounts",
    ),
    issueUrl: null,
  };
  const inserted = await db.insert(incidents).values(row).returning();
  const created = inserted[0];
  if (!created) throw new IncidentInputError("The incident could not be recorded.", 409);
  return (await hydrate([created]))[0]!;
}

/**
 * Apply a patch. Status transitions stamp their timestamps here and nowhere
 * else, so `mitigatedAt`/`resolvedAt` cannot disagree with `status`.
 *
 * Two rules that are easy to get wrong and matter for the postmortem's
 * arithmetic: resolving an incident that was never marked mitigated back-fills
 * `mitigatedAt` from `resolvedAt` (impact demonstrably stopped no later than
 * resolution), and reopening clears both stamps rather than leaving a resolved
 * timestamp on an open incident.
 */
export async function updateIncidentRecord(
  organizationId: string,
  incidentId: string,
  input: IncidentUpdateInput,
  actingUserId: string | null,
  now: Date = new Date(),
): Promise<Incident | null> {
  const existing = await getIncidentRow(organizationId, incidentId);
  if (!existing) return null;

  const patch: Partial<typeof incidents.$inferInsert> = { updatedAt: now };
  if (input.title !== undefined) patch.title = trimmedTitle(input.title);
  if (input.severity !== undefined) patch.severity = input.severity;
  if (input.summary !== undefined) patch.summary = normalizeSummary(input.summary);
  if (input.issueUrl !== undefined) {
    patch.issueUrl = input.issueUrl ? String(input.issueUrl).trim() || null : null;
  }
  if (input.affectedResourceIds !== undefined) {
    patch.affectedResourceIds = normalizeIds(
      input.affectedResourceIds,
      INCIDENT_LIMITS.maxAffectedResources,
      "resources",
    );
  }
  if (input.affectedAccountIds !== undefined) {
    patch.affectedAccountIds = normalizeIds(
      input.affectedAccountIds,
      INCIDENT_LIMITS.maxAffectedAccounts,
      "accounts",
    );
  }

  if (input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    if (input.status === "mitigated") {
      patch.mitigatedAt = existing.mitigatedAt ?? now;
      patch.resolvedAt = null;
      patch.resolvedByUserId = null;
    } else if (input.status === "resolved") {
      patch.resolvedAt = existing.resolvedAt ?? now;
      patch.mitigatedAt = existing.mitigatedAt ?? patch.resolvedAt;
      patch.resolvedByUserId = actingUserId;
    } else {
      patch.mitigatedAt = null;
      patch.resolvedAt = null;
      patch.resolvedByUserId = null;
    }
  }

  await db
    .update(incidents)
    .set(patch)
    .where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, organizationId)));
  return getIncidentRecord(organizationId, incidentId);
}

export async function deleteIncidentRecord(
  organizationId: string,
  incidentId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(incidents)
    .where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, organizationId)))
    .returning({ id: incidents.id });
  return deleted.length > 0;
}

export async function addIncidentNoteRecord(
  incidentId: string,
  body: string,
  authorUserId: string | null,
  occurredAt?: Date,
): Promise<IncidentNote> {
  const text = body.trim();
  if (!text) throw new IncidentInputError("A note needs something in it.");
  if (text.length > INCIDENT_LIMITS.maxNoteLength) {
    throw new IncidentInputError(
      `A note must be ${INCIDENT_LIMITS.maxNoteLength} characters or fewer.`,
    );
  }
  const id = randomUUID();
  await db.insert(incidentNotes).values({
    id,
    incidentId,
    body: text,
    authorUserId,
    occurredAt: occurredAt ?? new Date(),
  });
  const notes = await listIncidentNoteRecords(incidentId);
  const created = notes.find((note) => note.id === id);
  if (!created) throw new IncidentInputError("The note could not be recorded.", 409);
  return created;
}

export async function deleteIncidentNoteRecord(
  incidentId: string,
  noteId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(incidentNotes)
    .where(and(eq(incidentNotes.id, noteId), eq(incidentNotes.incidentId, incidentId)))
    .returning({ id: incidentNotes.id });
  return deleted.length > 0;
}

/* ------------------------------------------------------------------ *
 * Artefacts
 * ------------------------------------------------------------------ */

export interface ArtifactRecordInput {
  kind: IncidentArtifactKind;
  status: IncidentArtifactStatus;
  label?: string | null;
  refId?: string | null;
  refSecondary?: string | null;
  error?: string | null;
}

/**
 * Write (or overwrite) the artefact of this kind for this incident.
 *
 * Upsert rather than insert because retrying a failed Slack post should replace
 * the failure, not queue a second row beside it — the unique index on
 * (incident, kind) is what makes "did this incident open a freeze?" a
 * single-row question at resolve time.
 */
export async function recordIncidentArtifact(
  incidentId: string,
  input: ArtifactRecordInput,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(incidentArtifacts)
    .values({
      id: randomUUID(),
      incidentId,
      kind: input.kind,
      status: input.status,
      label: input.label ?? null,
      refId: input.refId ?? null,
      refSecondary: input.refSecondary ?? null,
      error: input.error ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [incidentArtifacts.incidentId, incidentArtifacts.kind],
      set: {
        status: input.status,
        label: input.label ?? null,
        refId: input.refId ?? null,
        refSecondary: input.refSecondary ?? null,
        error: input.error ?? null,
        updatedAt: now,
      },
    });
}

/** Mark an artefact closed (freeze lifted, notice resolved). No-op if absent. */
export async function closeIncidentArtifact(
  incidentId: string,
  kind: IncidentArtifactKind,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(incidentArtifacts)
    .set({ status: "closed", updatedAt: now })
    .where(and(eq(incidentArtifacts.incidentId, incidentId), eq(incidentArtifacts.kind, kind)));
}

/** Record that closing an artefact failed, without losing what it referenced. */
export async function markIncidentArtifactError(
  incidentId: string,
  kind: IncidentArtifactKind,
  error: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(incidentArtifacts)
    .set({ error, updatedAt: now })
    .where(and(eq(incidentArtifacts.incidentId, incidentId), eq(incidentArtifacts.kind, kind)));
}

export async function getIncidentArtifact(
  incidentId: string,
  kind: IncidentArtifactKind,
): Promise<IncidentArtifactRow | null> {
  const rows = await db
    .select()
    .from(incidentArtifacts)
    .where(and(eq(incidentArtifacts.incidentId, incidentId), eq(incidentArtifacts.kind, kind)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listIncidentArtifacts(incidentId: string): Promise<IncidentArtifactRow[]> {
  return db.select().from(incidentArtifacts).where(eq(incidentArtifacts.incidentId, incidentId));
}
