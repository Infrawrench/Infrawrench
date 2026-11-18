/**
 * Offboarding checklists: start one, rescan it, record what was done.
 *
 * A checklist is the sweep (`sweep.ts`) saved, so it can be worked through
 * over several days and handed to an auditor afterwards. Each row upserts on
 * a stable key, which is what makes a rescan safe: a row somebody already
 * dealt with keeps its outcome, a row that reappears is reopened, and an open
 * row a later scan no longer finds is marked `gone` (removed outside
 * Infrawrench) rather than silently dropped.
 *
 * A completed or cancelled checklist is frozen: it is evidence now, and a
 * rescan would rewrite it.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID as uuid } from "node:crypto";
import {
  initialMatchState,
  normalizeAliases,
  normalizeIdentityValue,
  OFFBOARDING_LIMITS,
  offboardingProgress,
  sortOffboardingItems,
  validateOffboardingIdentity,
  type Offboarding,
  type OffboardingActionId,
  type OffboardingCandidate,
  type OffboardingItem,
  type OffboardingItemKind,
  type OffboardingItemStatus,
  type OffboardingItemUpdate,
  type OffboardingMatchConfidence,
  type OffboardingMatchState,
  type OffboardingPreview,
  type OffboardingSource,
  type OffboardingStatus,
  type OffboardingSummary,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { offboardingItems, offboardings, organizationMembers, users } from "../db/schema";
import { sweepOffboarding } from "./sweep";

/** A refusal the route maps to a status code. */
export class OffboardingInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "OffboardingInputError";
  }
}

type OffboardingRow = typeof offboardings.$inferSelect;
type ItemRow = typeof offboardingItems.$inferSelect;

/** Who did something, for the row and the audit trail. */
export interface OffboardingActor {
  userId: string | null;
  name: string | null;
}

/** The caller, named for the row and the audit trail. */
export async function loadOffboardingActor(userId: string | null): Promise<OffboardingActor> {
  if (!userId) return { userId: null, name: null };
  const [row] = await db
    .select({ name: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { userId, name: row?.name ?? row?.email ?? null };
}

/** Members who can take something over: anybody in the organization. */
export async function listOffboardingMembers(
  organizationId: string,
): Promise<{ userId: string; name: string | null; email: string }[]> {
  const rows = await db
    .select({ userId: users.id, name: users.displayName, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId));
  return rows.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function toItem(row: ItemRow): OffboardingItem {
  return {
    id: row.id,
    kind: row.kind as OffboardingItemKind,
    title: row.title,
    detail: row.detail,
    pluginId: row.pluginId,
    providerName: row.providerName,
    accountId: row.accountId,
    accountName: row.accountName,
    resourceId: row.resourceId,
    resourceTypeId: row.resourceTypeId,
    confidence: row.confidence as OffboardingMatchConfidence,
    matchReason: row.matchReason,
    matchState: row.matchState as OffboardingMatchState,
    actions: row.actions as OffboardingActionId[],
    status: row.status as OffboardingItemStatus,
    resolution: row.resolution,
    lastError: row.lastError,
    note: row.note,
    resolvedByName: row.resolvedByName,
    resolvedAt: iso(row.resolvedAt),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function toSummary(row: OffboardingRow, items: readonly ItemRow[]): OffboardingSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.subjectName,
    userId: row.subjectUserId,
    aliases: row.aliases,
    status: row.status as OffboardingStatus,
    source: row.source as OffboardingSource,
    sourceDetail: row.sourceDetail,
    startedByName: row.startedByName,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
    lastScannedAt: iso(row.lastScannedAt),
    scanTruncated: row.scanTruncated,
    progress: offboardingProgress(
      items.map((i) => ({
        status: i.status as OffboardingItemStatus,
        matchState: i.matchState as OffboardingMatchState,
      })),
    ),
  };
}

async function offboardingRow(organizationId: string, id: string): Promise<OffboardingRow | null> {
  const [row] = await db
    .select()
    .from(offboardings)
    .where(and(eq(offboardings.organizationId, organizationId), eq(offboardings.id, id)))
    .limit(1);
  return row ?? null;
}

async function itemRows(offboardingId: string): Promise<ItemRow[]> {
  return db
    .select()
    .from(offboardingItems)
    .where(eq(offboardingItems.offboardingId, offboardingId));
}

/** Every checklist in the organization, newest first, with its progress. */
export async function listOffboardings(organizationId: string): Promise<OffboardingSummary[]> {
  const rows = await db
    .select()
    .from(offboardings)
    .where(eq(offboardings.organizationId, organizationId))
    .orderBy(desc(offboardings.createdAt));
  if (rows.length === 0) return [];
  const items = await db
    .select()
    .from(offboardingItems)
    .where(
      inArray(
        offboardingItems.offboardingId,
        rows.map((r) => r.id),
      ),
    );
  const byOffboarding = new Map<string, ItemRow[]>();
  for (const item of items) {
    const list = byOffboarding.get(item.offboardingId) ?? [];
    list.push(item);
    byOffboarding.set(item.offboardingId, list);
  }
  return rows.map((row) => toSummary(row, byOffboarding.get(row.id) ?? []));
}

export async function getOffboarding(
  organizationId: string,
  id: string,
): Promise<Offboarding | null> {
  const row = await offboardingRow(organizationId, id);
  if (!row) return null;
  const items = await itemRows(row.id);
  return { ...toSummary(row, items), items: sortOffboardingItems(items.map(toItem)) };
}

/** One row with the server-only `ref` the actions need. */
export async function getOffboardingItemRow(
  organizationId: string,
  offboardingId: string,
  itemId: string,
): Promise<{ offboarding: OffboardingRow; item: ItemRow } | null> {
  const offboarding = await offboardingRow(organizationId, offboardingId);
  if (!offboarding) return null;
  const [item] = await db
    .select()
    .from(offboardingItems)
    .where(and(eq(offboardingItems.offboardingId, offboardingId), eq(offboardingItems.id, itemId)))
    .limit(1);
  return item ? { offboarding, item } : null;
}

function cleanIdentity(email: string, aliases: readonly string[] | undefined) {
  const normalizedEmail = normalizeIdentityValue(email);
  const cleaned = normalizeAliases(aliases ?? [], normalizedEmail);
  const problem = validateOffboardingIdentity(normalizedEmail, cleaned);
  if (problem) throw new OffboardingInputError(problem);
  return { email: normalizedEmail, aliases: cleaned };
}

function cleanNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > OFFBOARDING_LIMITS.maxNoteLength) {
    throw new OffboardingInputError(
      `A note may be at most ${OFFBOARDING_LIMITS.maxNoteLength} characters.`,
    );
  }
  return trimmed || null;
}

/** What the sweep would find for a person, without saving anything. */
export async function previewOffboarding(
  organizationId: string,
  input: { email: string; aliases?: readonly string[] },
): Promise<OffboardingPreview> {
  const identity = cleanIdentity(input.email, input.aliases);
  const result = await sweepOffboarding(organizationId, identity);
  return {
    ...identity,
    candidates: result.candidates.map(({ ref: _ref, ...rest }) => rest),
    scanTruncated: result.truncated,
  };
}

export interface StartOffboardingInput {
  email: string;
  aliases?: readonly string[];
  note?: string | null;
  source?: OffboardingSource;
  sourceDetail?: string | null;
}

/**
 * Start (or rejoin) the checklist for a person. A second start for somebody
 * already being offboarded lands on the open checklist, merging any new
 * aliases, so a directory event that arrives twice and an admin who clicks
 * Start the same morning share one record.
 */
export async function startOffboarding(
  organizationId: string,
  input: StartOffboardingInput,
  actor: OffboardingActor | null,
): Promise<{ offboarding: Offboarding; created: boolean }> {
  const identity = cleanIdentity(input.email, input.aliases);
  const note = cleanNote(input.note);

  const [existing] = await db
    .select()
    .from(offboardings)
    .where(
      and(
        eq(offboardings.organizationId, organizationId),
        eq(offboardings.email, identity.email),
        eq(offboardings.status, "open"),
      ),
    )
    .limit(1);
  if (existing) {
    const merged = normalizeAliases([...existing.aliases, ...identity.aliases], identity.email);
    if (merged.length !== existing.aliases.length) {
      await db
        .update(offboardings)
        .set({ aliases: merged, updatedAt: new Date() })
        .where(eq(offboardings.id, existing.id));
    }
    return { offboarding: await rescanOffboarding(organizationId, existing.id), created: false };
  }

  const id = uuid();
  try {
    await db.insert(offboardings).values({
      id,
      organizationId,
      email: identity.email,
      aliases: identity.aliases,
      status: "open",
      source: input.source ?? "manual",
      sourceDetail: input.sourceDetail ?? null,
      note: note ?? null,
      startedByUserId: actor?.userId ?? null,
      startedByName: actor?.name ?? null,
    });
  } catch (err) {
    // Two starts racing: the partial unique index lets one through, and the
    // loser joins the winner's checklist.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("offboardings_org_open_email_unique")) {
      return startOffboarding(organizationId, input, actor);
    }
    throw err;
  }
  return { offboarding: await rescanOffboarding(organizationId, id), created: true };
}

/** Upsert the sweep's rows onto the checklist. */
async function syncItems(
  row: OffboardingRow,
  candidates: readonly OffboardingCandidate[],
  now: Date,
): Promise<void> {
  const existing = await itemRows(row.id);
  const byKey = new Map(existing.map((item) => [item.itemKey, item]));
  const seen = new Set<string>();

  for (const candidate of candidates) {
    seen.add(candidate.key);
    const current = byKey.get(candidate.key);
    const fields = {
      kind: candidate.kind,
      title: candidate.title,
      detail: candidate.detail,
      pluginId: candidate.pluginId,
      providerName: candidate.providerName,
      accountId: candidate.accountId,
      accountName: candidate.accountName,
      resourceId: candidate.resourceId,
      resourceTypeId: candidate.resourceTypeId,
      confidence: candidate.confidence,
      matchReason: candidate.matchReason,
      actions: candidate.actions,
      ref: candidate.ref,
      lastSeenAt: now,
      updatedAt: now,
    };
    if (!current) {
      await db
        .insert(offboardingItems)
        .values({
          id: uuid(),
          offboardingId: row.id,
          organizationId: row.organizationId,
          itemKey: candidate.key,
          matchState: initialMatchState(candidate.confidence),
          status: "open",
          firstSeenAt: now,
          ...fields,
        })
        .onConflictDoNothing();
      continue;
    }
    await db
      .update(offboardingItems)
      .set({
        ...fields,
        // A match that firmed up (an alias was added) no longer needs a person
        // to vouch for it.
        ...(current.matchState === "unconfirmed" && candidate.confidence !== "possible"
          ? { matchState: "matched" }
          : {}),
        // Back again after a scan had missed it: open work once more.
        ...(current.status === "gone"
          ? { status: "open", resolution: null, resolvedAt: null, resolvedByName: null }
          : {}),
      })
      .where(eq(offboardingItems.id, current.id));
  }

  const vanished = existing.filter(
    (item) => !seen.has(item.itemKey) && (item.status === "open" || item.status === "failed"),
  );
  if (vanished.length > 0) {
    await db
      .update(offboardingItems)
      .set({
        status: "gone",
        resolution: "gone",
        resolvedAt: now,
        resolvedByUserId: null,
        resolvedByName: null,
        updatedAt: now,
      })
      .where(
        inArray(
          offboardingItems.id,
          vanished.map((item) => item.id),
        ),
      );
  }
}

/** Sweep again and fold the result into the checklist. */
export async function rescanOffboarding(organizationId: string, id: string): Promise<Offboarding> {
  const row = await offboardingRow(organizationId, id);
  if (!row) throw new OffboardingInputError("Offboarding not found", 404);
  if (row.status === "open") {
    const now = new Date();
    const result = await sweepOffboarding(organizationId, {
      email: row.email,
      aliases: row.aliases,
      name: row.subjectName,
    });
    await syncItems(row, result.candidates, now);
    await db
      .update(offboardings)
      .set({
        subjectUserId: result.subject.primaryUserId ?? row.subjectUserId,
        subjectName: result.subject.name ?? row.subjectName,
        lastScannedAt: now,
        scanTruncated: result.truncated,
        updatedAt: now,
      })
      .where(eq(offboardings.id, row.id));
  }
  const fresh = await getOffboarding(organizationId, id);
  if (!fresh) throw new OffboardingInputError("Offboarding not found", 404);
  return fresh;
}

export interface OffboardingPatch {
  aliases?: readonly string[];
  note?: string | null;
  status?: OffboardingStatus;
}

/** Edit aliases or the note, or complete, cancel or reopen the checklist. */
export async function updateOffboarding(
  organizationId: string,
  id: string,
  patch: OffboardingPatch,
): Promise<Offboarding> {
  const row = await offboardingRow(organizationId, id);
  if (!row) throw new OffboardingInputError("Offboarding not found", 404);
  const now = new Date();
  const set: Partial<typeof offboardings.$inferInsert> = { updatedAt: now };
  let rescan = false;

  if (patch.aliases !== undefined) {
    if (row.status !== "open") {
      throw new OffboardingInputError("Reopen the offboarding before changing its aliases.", 409);
    }
    set.aliases = cleanIdentity(row.email, patch.aliases).aliases;
    rescan = true;
  }
  const note = cleanNote(patch.note);
  if (note !== undefined) set.note = note;
  if (patch.status !== undefined && patch.status !== row.status) {
    if (patch.status === "open") {
      const [other] = await db
        .select({ id: offboardings.id })
        .from(offboardings)
        .where(
          and(
            eq(offboardings.organizationId, organizationId),
            eq(offboardings.email, row.email),
            eq(offboardings.status, "open"),
          ),
        )
        .limit(1);
      if (other) {
        throw new OffboardingInputError(
          "Another offboarding for this person is already open.",
          409,
        );
      }
      set.completedAt = null;
      rescan = true;
    } else {
      set.completedAt = now;
    }
    set.status = patch.status;
  }

  await db.update(offboardings).set(set).where(eq(offboardings.id, row.id));
  if (rescan) return rescanOffboarding(organizationId, id);
  const fresh = await getOffboarding(organizationId, id);
  if (!fresh) throw new OffboardingInputError("Offboarding not found", 404);
  return fresh;
}

/** Confirm or reject a match, mark a row done or skipped by hand, or reopen it. */
export async function updateOffboardingItem(
  organizationId: string,
  offboardingId: string,
  itemId: string,
  patch: OffboardingItemUpdate,
  actor: OffboardingActor,
): Promise<OffboardingItem> {
  const found = await getOffboardingItemRow(organizationId, offboardingId, itemId);
  if (!found) throw new OffboardingInputError("Item not found", 404);
  if (found.offboarding.status !== "open") {
    throw new OffboardingInputError("This offboarding is closed; reopen it to change it.", 409);
  }
  const now = new Date();
  const set: Partial<typeof offboardingItems.$inferInsert> = { updatedAt: now };
  if (patch.matchState !== undefined) {
    if (found.item.confidence !== "possible" && patch.matchState !== "rejected") {
      throw new OffboardingInputError("Only a possible match needs confirming.");
    }
    set.matchState = patch.matchState;
  }
  if (patch.status !== undefined) {
    if (patch.status === "open") {
      Object.assign(set, {
        status: "open",
        resolution: null,
        resolvedAt: null,
        resolvedByUserId: null,
        resolvedByName: null,
      });
    } else {
      Object.assign(set, {
        status: patch.status,
        resolution: "manual",
        resolvedAt: now,
        resolvedByUserId: actor.userId,
        resolvedByName: actor.name,
        lastError: null,
      });
    }
  }
  const note = cleanNote(patch.note);
  if (note !== undefined) set.note = note;
  const [updated] = await db
    .update(offboardingItems)
    .set(set)
    .where(eq(offboardingItems.id, found.item.id))
    .returning();
  await db.update(offboardings).set({ updatedAt: now }).where(eq(offboardings.id, offboardingId));
  return toItem(updated ?? found.item);
}

/** Record what an action did to a row. */
export async function recordItemOutcome(
  itemId: string,
  outcome: { ok: true; action: OffboardingActionId } | { ok: false; error: string },
  actor: OffboardingActor,
): Promise<OffboardingItem | null> {
  const now = new Date();
  const [updated] = await db
    .update(offboardingItems)
    .set(
      outcome.ok
        ? {
            status: "done",
            resolution: outcome.action,
            resolvedAt: now,
            resolvedByUserId: actor.userId,
            resolvedByName: actor.name,
            lastError: null,
            updatedAt: now,
          }
        : { status: "failed", lastError: outcome.error.slice(0, 2000), updatedAt: now },
    )
    .where(eq(offboardingItems.id, itemId))
    .returning();
  return updated ? toItem(updated) : null;
}
