/**
 * Savings events: the stored half of realized savings.
 *
 * An event is the fact of an action (what was done, when, to which resource,
 * and what it was projected to save) and nothing computed. Recording one also
 * drops an org-wide cost annotation on the action's day, in the same
 * transaction, so every cost chart shows where the saving began; the anomaly
 * acknowledgement arrangement, linked by one FK from the event's side.
 *
 * Automatic recording is **idempotent by `dedupe_key`**: the resize Apply
 * button and the sync that later observes the new size describe one action,
 * and the partial unique index makes the second writer a no-op.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import {
  savingsEventInputError,
  type SavingsEvent,
  type SavingsEventAnnotationInput,
  type SavingsEventInput,
  type SavingsEventKind,
  type SavingsEventSource,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, costAnnotations, costCentres, resources, savingsEvents } from "../db/schema";
import { extractRecordTags } from "@infrawrench/client-core";

export type SavingsEventRow = typeof savingsEvents.$inferSelect;

/** A caller mistake the API maps to a 400 (or the given status). */
export class SavingsEventError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "SavingsEventError";
  }
}

/** Upper bound on events one report reads: far beyond any real org's history. */
export const MAX_SAVINGS_EVENTS = 5000;

const ANNOTATION_MAX = 500;

/** The note an event leaves on cost charts. */
export function savingsAnnotationText(title: string): string {
  const text = `Saving: ${title}`;
  return text.length > ANNOTATION_MAX ? `${text.slice(0, ANNOTATION_MAX - 1)}…` : text;
}

export interface RecordSavingsEventInput {
  organizationId: string;
  kind: Exclude<SavingsEventKind, "commitment">;
  source: Exclude<SavingsEventSource, "derived">;
  title: string;
  note?: string | null;
  occurredOn: string;
  accountId?: string | null;
  pluginId?: string | null;
  resourceTypeId?: string | null;
  resourceId?: string | null;
  externalId?: string | null;
  resourceName?: string | null;
  tags?: Record<string, string> | null;
  projectedMonthlyAmount?: number | null;
  currency?: string | null;
  baselineDailyEstimate?: number | null;
  postDailyEstimate?: number | null;
  offFraction?: number | null;
  scheduleId?: string | null;
  dedupeKey?: string | null;
  createdByUserId?: string | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Record an automatic event plus its chart annotation. Returns the new id, or
 * null when the dedupe key says this action was already recorded.
 */
export async function recordSavingsEvent(input: RecordSavingsEventInput): Promise<string | null> {
  const id = randomUUID();
  const now = new Date();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(savingsEvents)
      .values({
        id,
        organizationId: input.organizationId,
        kind: input.kind,
        source: input.source,
        title: input.title.slice(0, 200),
        note: input.note ?? null,
        occurredOn: input.occurredOn,
        accountId: input.accountId ?? null,
        pluginId: input.pluginId ?? null,
        resourceTypeId: input.resourceTypeId ?? null,
        resourceId: input.resourceId ?? null,
        externalId: input.externalId ?? null,
        resourceName: input.resourceName ?? null,
        tags: input.tags ?? null,
        projectedMonthlyAmount: finiteOrNull(input.projectedMonthlyAmount),
        currency: input.currency ?? null,
        baselineDailyEstimate: finiteOrNull(input.baselineDailyEstimate),
        postDailyEstimate: finiteOrNull(input.postDailyEstimate),
        offFraction: finiteOrNull(input.offFraction),
        scheduleId: input.scheduleId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: savingsEvents.id });
    if (inserted.length === 0) return null;

    const annotationId = randomUUID();
    await tx.insert(costAnnotations).values({
      id: annotationId,
      organizationId: input.organizationId,
      costReportId: null,
      startDate: input.occurredOn,
      endDate: null,
      text: savingsAnnotationText(input.title),
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(savingsEvents)
      .set({ costAnnotationId: annotationId })
      .where(eq(savingsEvents.id, id));
    return id;
  });
}

/** Every event that had begun by `to`, newest first, bounded. */
export async function listSavingsEventRows(
  organizationId: string,
  to: string,
): Promise<SavingsEventRow[]> {
  return db
    .select()
    .from(savingsEvents)
    .where(and(eq(savingsEvents.organizationId, organizationId), lte(savingsEvents.occurredOn, to)))
    .orderBy(desc(savingsEvents.occurredOn), desc(savingsEvents.createdAt))
    .limit(MAX_SAVINGS_EVENTS);
}

export async function getSavingsEventRow(
  organizationId: string,
  id: string,
): Promise<SavingsEventRow | null> {
  const [row] = await db
    .select()
    .from(savingsEvents)
    .where(and(eq(savingsEvents.organizationId, organizationId), eq(savingsEvents.id, id)))
    .limit(1);
  return row ?? null;
}

/** The stored row as the wire shape (without anything computed). */
export function toSavingsEvent(row: SavingsEventRow, accountName: string | null): SavingsEvent {
  return {
    id: row.id,
    kind: row.kind as SavingsEventKind,
    source: row.source as SavingsEventSource,
    title: row.title,
    note: row.note,
    occurredOn: row.occurredOn,
    endedOn: row.endedOn,
    accountId: row.accountId,
    accountName,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    costCentreId: row.costCentreId,
    projectedMonthlyAmount: row.projectedMonthlyAmount,
    currency: row.currency,
    horizonMonths: row.horizonMonths,
    costAnnotationId: row.costAnnotationId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function accountNameFor(organizationId: string, accountId: string | null) {
  if (!accountId) return null;
  const [row] = await db
    .select({ displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, accountId)))
    .limit(1);
  return row?.displayName ?? null;
}

async function assertCostCentre(organizationId: string, costCentreId: string | null | undefined) {
  if (!costCentreId) return;
  const [row] = await db
    .select({ id: costCentres.id })
    .from(costCentres)
    .where(and(eq(costCentres.organizationId, organizationId), eq(costCentres.id, costCentreId)))
    .limit(1);
  if (!row) throw new SavingsEventError("That cost centre does not exist in this organization");
}

/**
 * The resource a manual entry links to, snapshotted the way automatic events
 * snapshot theirs. A soft-deleted resource is allowed on purpose: logging the
 * saving from a cleanup after the fact is the common case.
 */
async function resolveLinkedResource(organizationId: string, resourceId: string) {
  const [row] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      externalId: resources.externalId,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  if (!row) throw new SavingsEventError("That resource does not exist in this organization");
  return row;
}

function manualColumns(input: SavingsEventInput) {
  return {
    title: input.title.trim(),
    note: input.note?.trim() ? input.note.trim() : null,
    occurredOn: input.occurredOn,
    endedOn: input.endedOn ?? null,
    projectedMonthlyAmount: Number(input.projectedMonthlyAmount),
    currency: input.currency,
    costCentreId: input.costCentreId ?? null,
    horizonMonths: input.horizonMonths ?? null,
  };
}

async function linkColumns(organizationId: string, input: SavingsEventInput) {
  if (input.resourceId) {
    const r = await resolveLinkedResource(organizationId, input.resourceId);
    return {
      resourceId: r.id,
      accountId: r.accountId,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      externalId: r.externalId,
      resourceName: r.displayName,
      tags: extractRecordTags((r.fieldsJson ?? {}) as Record<string, unknown>),
    };
  }
  if (input.accountId) {
    const [a] = await db
      .select({ id: accounts.id, pluginId: accounts.pluginId })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, input.accountId)))
      .limit(1);
    if (!a) throw new SavingsEventError("That account does not exist in this organization");
    return {
      resourceId: null,
      accountId: a.id,
      pluginId: a.pluginId,
      resourceTypeId: null,
      externalId: null,
      resourceName: null,
      tags: null,
    };
  }
  return {
    resourceId: null,
    accountId: null,
    pluginId: null,
    resourceTypeId: null,
    externalId: null,
    resourceName: null,
    tags: null,
  };
}

/** Log a saving by hand. */
export async function createManualSavingsEvent(
  organizationId: string,
  input: SavingsEventInput,
  userId: string | null,
): Promise<SavingsEvent> {
  const error = savingsEventInputError(input);
  if (error) throw new SavingsEventError(error);
  await assertCostCentre(organizationId, input.costCentreId);
  const link = await linkColumns(organizationId, input);
  const cols = manualColumns(input);
  const id = randomUUID();
  const annotationId = randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(costAnnotations).values({
      id: annotationId,
      organizationId,
      costReportId: null,
      startDate: cols.occurredOn,
      endDate: null,
      text: savingsAnnotationText(cols.title),
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(savingsEvents).values({
      id,
      organizationId,
      kind: "manual",
      source: "manual",
      ...cols,
      ...link,
      costAnnotationId: annotationId,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
  });
  const row = (await getSavingsEventRow(organizationId, id))!;
  return toSavingsEvent(row, await accountNameFor(organizationId, row.accountId));
}

/**
 * Edit a manual entry: everything about it is the author's claim, so all of
 * it is editable. The chart note follows the title and the day.
 */
export async function updateManualSavingsEvent(
  organizationId: string,
  id: string,
  input: SavingsEventInput,
): Promise<SavingsEvent> {
  const existing = await getSavingsEventRow(organizationId, id);
  if (!existing) throw new SavingsEventError("Saving not found", 404);
  if (existing.kind !== "manual") {
    throw new SavingsEventError(
      "Only manual entries can be rewritten; an automatic saving takes a note, a cost centre, a horizon and an end date",
    );
  }
  const error = savingsEventInputError(input);
  if (error) throw new SavingsEventError(error);
  await assertCostCentre(organizationId, input.costCentreId);
  const link = await linkColumns(organizationId, input);
  const cols = manualColumns(input);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(savingsEvents)
      .set({ ...cols, ...link, updatedAt: now })
      .where(and(eq(savingsEvents.organizationId, organizationId), eq(savingsEvents.id, id)));
    if (existing.costAnnotationId) {
      await tx
        .update(costAnnotations)
        .set({
          text: savingsAnnotationText(cols.title),
          startDate: cols.occurredOn,
          updatedAt: now,
        })
        .where(eq(costAnnotations.id, existing.costAnnotationId));
    }
  });
  const row = (await getSavingsEventRow(organizationId, id))!;
  return toSavingsEvent(row, await accountNameFor(organizationId, row.accountId));
}

/**
 * Add context to any event. The facts of an automatic event (what was done,
 * when, the projection) are what was observed and stay put; the reading of it
 * (a note, which team it belongs to, how long to count it, when it stopped
 * applying) is a person's to give.
 */
export async function annotateSavingsEvent(
  organizationId: string,
  id: string,
  input: SavingsEventAnnotationInput,
): Promise<SavingsEvent> {
  const existing = await getSavingsEventRow(organizationId, id);
  if (!existing) throw new SavingsEventError("Saving not found", 404);
  await assertCostCentre(organizationId, input.costCentreId);
  if (input.endedOn && input.endedOn < existing.occurredOn) {
    throw new SavingsEventError("The end date is before the saving started");
  }
  const patch: Partial<typeof savingsEvents.$inferInsert> = { updatedAt: new Date() };
  if (input.note !== undefined) patch.note = input.note?.trim() ? input.note.trim() : null;
  if (input.costCentreId !== undefined) patch.costCentreId = input.costCentreId;
  if (input.horizonMonths !== undefined) patch.horizonMonths = input.horizonMonths;
  if (input.endedOn !== undefined) patch.endedOn = input.endedOn;
  await db
    .update(savingsEvents)
    .set(patch)
    .where(and(eq(savingsEvents.organizationId, organizationId), eq(savingsEvents.id, id)));
  const row = (await getSavingsEventRow(organizationId, id))!;
  return toSavingsEvent(row, await accountNameFor(organizationId, row.accountId));
}

/**
 * Remove an event (a manual entry withdrawn, or an automatic one that was not
 * really a saving) and the chart note it left, which would otherwise mark a
 * saving the report no longer counts.
 */
export async function deleteSavingsEvent(
  organizationId: string,
  id: string,
): Promise<SavingsEventRow> {
  const existing = await getSavingsEventRow(organizationId, id);
  if (!existing) throw new SavingsEventError("Saving not found", 404);
  await db.transaction(async (tx) => {
    await tx
      .delete(savingsEvents)
      .where(and(eq(savingsEvents.organizationId, organizationId), eq(savingsEvents.id, id)));
    if (existing.costAnnotationId) {
      await tx
        .delete(costAnnotations)
        .where(
          and(
            eq(costAnnotations.organizationId, organizationId),
            eq(costAnnotations.id, existing.costAnnotationId),
          ),
        );
    }
  });
  return existing;
}

/** Close every open event for a schedule (paused, retimed or deleted). */
export async function endOpenScheduleSavings(
  organizationId: string,
  scheduleId: string,
  endedOn: string,
): Promise<void> {
  await db
    .update(savingsEvents)
    .set({ endedOn, updatedAt: new Date() })
    .where(
      and(
        eq(savingsEvents.organizationId, organizationId),
        eq(savingsEvents.scheduleId, scheduleId),
        isNull(savingsEvents.endedOn),
      ),
    );
}

/**
 * Before opening a new stretch for a schedule: is one already open, or did a
 * stretch with the same timing end since `sinceDay`? A pause and resume within
 * a day or so reopens that stretch rather than minting a second event (and a
 * second chart note) for what a reader sees as one schedule.
 */
export async function resumeScheduleSaving(
  organizationId: string,
  scheduleId: string,
  offFraction: number,
  sinceDay: string,
): Promise<"open" | "reopened" | "none"> {
  const rows = await db
    .select({
      id: savingsEvents.id,
      endedOn: savingsEvents.endedOn,
      offFraction: savingsEvents.offFraction,
    })
    .from(savingsEvents)
    .where(
      and(
        eq(savingsEvents.organizationId, organizationId),
        eq(savingsEvents.scheduleId, scheduleId),
      ),
    );
  if (rows.some((r) => r.endedOn === null)) return "open";
  const recent = rows.find(
    (r) =>
      r.endedOn !== null &&
      r.endedOn >= sinceDay &&
      r.offFraction !== null &&
      Math.abs(r.offFraction - offFraction) < 1e-6,
  );
  if (!recent) return "none";
  await db
    .update(savingsEvents)
    .set({ endedOn: null, updatedAt: new Date() })
    .where(eq(savingsEvents.id, recent.id));
  return "reopened";
}

/** Account display names for a set of ids, in one read. */
export async function accountNamesFor(
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, { displayName: string; pluginId: string }>> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, ids)));
  return new Map(rows.map((r) => [r.id, { displayName: r.displayName, pluginId: r.pluginId }]));
}
