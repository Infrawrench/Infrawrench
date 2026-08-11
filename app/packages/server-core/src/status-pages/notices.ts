/**
 * Written updates on a public status page — "we know, we're on it".
 *
 * A status page was a purely derived view until incident mode: every word on it
 * came from probe state and uptime rollups, so the one thing a visitor actually
 * arrives for — a sentence from a human — had nowhere to live. A notice is that
 * sentence.
 *
 * The file is separate from `store.ts` for the reason the whole feature is
 * built the way it is: the public assembler in `store.ts` must keep writing the
 * anonymous payload **from scratch**, and a notice is one more thing it names
 * explicitly rather than one more field that leaks in by omission. What a
 * visitor may learn from a notice is exactly: title, body, state, started and
 * resolved times, and which components on *this page* are affected. Not the
 * incident id, not who declared it, not the org.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { PublicStatusNotice } from "@infrawrench/client-core";

import { db } from "../db/client";
import {
  STATUS_PAGE_NOTICE_LIMIT,
  STATUS_PAGE_NOTICE_RETENTION_DAYS,
  statusPageComponents,
  statusPageNotices,
  statusPages,
} from "../db/schema";
import type { StatusPageNoticeRow } from "../db/incident-schema";

export type StatusNoticeState = "investigating" | "identified" | "monitoring" | "resolved";

export interface CreateStatusNoticeInput {
  organizationId: string;
  statusPageId: string;
  title: string;
  body?: string | null;
  state?: StatusNoticeState;
  /** Component ids on this page; unknown ids are dropped, not rejected. */
  affectedComponentIds?: readonly string[];
  incidentId?: string | null;
  startedAt?: Date;
}

/** Thrown when the page is not this org's, so callers can 404 rather than 500. */
export class StatusNoticeError extends Error {
  readonly status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = "StatusNoticeError";
    this.status = status;
  }
}

/**
 * Post a notice, scoped to the org that owns the page.
 *
 * Component ids are filtered against the page's own components rather than
 * trusted: an id from another page would otherwise be stored and rendered as
 * "affected" on a page it does not belong to.
 */
export async function createStatusPageNotice(
  input: CreateStatusNoticeInput,
): Promise<StatusPageNoticeRow> {
  const [page] = await db
    .select({ id: statusPages.id })
    .from(statusPages)
    .where(
      and(
        eq(statusPages.id, input.statusPageId),
        eq(statusPages.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  if (!page) throw new StatusNoticeError("That status page does not exist.", 404);

  const title = input.title.trim();
  if (!title) throw new StatusNoticeError("A notice needs a title.");

  let componentIds: string[] = [];
  const requested = (input.affectedComponentIds ?? []).filter(Boolean);
  if (requested.length > 0) {
    const rows = await db
      .select({ id: statusPageComponents.id })
      .from(statusPageComponents)
      .where(
        and(
          eq(statusPageComponents.statusPageId, page.id),
          inArray(statusPageComponents.id, Array.from(new Set(requested))),
        ),
      );
    componentIds = rows.map((row) => row.id);
  }

  const now = new Date();
  const row = {
    id: randomUUID(),
    statusPageId: page.id,
    incidentId: input.incidentId ?? null,
    title,
    body: input.body?.trim() || null,
    state: input.state ?? ("investigating" as const),
    affectedComponentIds: componentIds,
    startedAt: input.startedAt ?? now,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.insert(statusPageNotices).values(row).returning();
  const created = inserted[0];
  if (!created) throw new StatusNoticeError("The notice could not be posted.");
  return created;
}

/** Move a notice on (investigating → identified → monitoring → resolved). */
export async function updateStatusPageNotice(
  noticeId: string,
  patch: { title?: string; body?: string | null; state?: StatusNoticeState },
): Promise<StatusPageNoticeRow | null> {
  const now = new Date();
  const set: Partial<typeof statusPageNotices.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.body !== undefined) set.body = patch.body?.trim() || null;
  if (patch.state !== undefined) {
    set.state = patch.state;
    // Resolving stamps the time; un-resolving clears it, so the pair can never
    // say "resolved" with no when, or carry a stale when after a reopen.
    set.resolvedAt = patch.state === "resolved" ? now : null;
  }
  const updated = await db
    .update(statusPageNotices)
    .set(set)
    .where(eq(statusPageNotices.id, noticeId))
    .returning();
  return updated[0] ?? null;
}

/** Close a notice — used by the incident resolve path. Idempotent. */
export async function resolveStatusPageNotice(
  noticeId: string,
  resolutionText?: string | null,
): Promise<StatusPageNoticeRow | null> {
  const now = new Date();
  const updated = await db
    .update(statusPageNotices)
    .set({
      state: "resolved",
      resolvedAt: now,
      updatedAt: now,
      ...(resolutionText ? { body: resolutionText.trim() } : {}),
    })
    .where(eq(statusPageNotices.id, noticeId))
    .returning();
  return updated[0] ?? null;
}

export async function listStatusPageNoticeRows(
  statusPageId: string,
): Promise<StatusPageNoticeRow[]> {
  return db
    .select()
    .from(statusPageNotices)
    .where(eq(statusPageNotices.statusPageId, statusPageId))
    .orderBy(desc(statusPageNotices.startedAt))
    .limit(50);
}

/**
 * The notices a public page should carry: everything unresolved, plus anything
 * resolved inside the retention window so a visitor arriving the morning after
 * still sees what happened.
 *
 * Written from scratch into {@link PublicStatusNotice} — never by narrowing the
 * row — for the same reason the rest of the public payload is.
 */
export async function getPublicStatusNotices(
  statusPageId: string,
  now: Date = new Date(),
): Promise<PublicStatusNotice[]> {
  const cutoff = new Date(now.getTime() - STATUS_PAGE_NOTICE_RETENTION_DAYS * 86_400_000);
  const rows = await db
    .select()
    .from(statusPageNotices)
    .where(
      and(
        eq(statusPageNotices.statusPageId, statusPageId),
        or(isNull(statusPageNotices.resolvedAt), gte(statusPageNotices.resolvedAt, cutoff)),
      ),
    )
    .orderBy(desc(statusPageNotices.startedAt))
    .limit(STATUS_PAGE_NOTICE_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    state: row.state,
    affectedComponentIds: row.affectedComponentIds ?? [],
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
