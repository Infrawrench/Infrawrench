/**
 * Custom cost sources: named providers of spend Infrawrench has no plugin for,
 * filled by uploading files (CSV or FOCUS) from Settings or the CLI.
 *
 * The file is parsed on the client (`client-core/src/custom-costs.ts`) into
 * aggregated daily rows; this module owns everything after that:
 *
 * - **Sources** are config objects (create, rename, delete). A source's rows
 *   carry `plugin_id = custom:<id>`, so each source is its own value in the
 *   provider dimension and every cost report, filter, budget and allocation
 *   rule treats it like any collected provider. The label is looked up at read
 *   time (`web/src/services/cost-query.ts`), which is what makes a rename free.
 * - **Uploads** are a three-call sequence: create (declares the range, decides
 *   append vs replace), rows (chunks of up to 5,000), complete. Each row goes
 *   through the same validator as `POST /costs/rows` (`cost-ingest.ts`) with
 *   the upload's id stamped into a reserved tag, which is how deleting an
 *   upload finds exactly its rows.
 * - **Replace is applied at complete**, never at create: an upload that dies
 *   halfway leaves the spend it meant to replace where it was, and shows in the
 *   history as `uploading` so it can be deleted.
 *
 * Removal of any kind (an upload, a replaced range, a whole source) writes
 * tombstones through `clickhouse/custom-cost-store.ts`.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  CUSTOM_COST_FORMATS,
  CUSTOM_COST_LIMITS,
  CUSTOM_COST_UPLOAD_MODES,
  overlappingCustomCostUploads,
  type CustomCostFormat,
  type CustomCostSource,
  type CustomCostSourceInput,
  type CustomCostUpload,
  type CustomCostUploadMode,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { users } from "../db/core-schema";
import { customCostSources, customCostUploads } from "../db/schema";
import { insertCostRows } from "../clickhouse/cost-writers";
import {
  getCustomCostUploadHoldings,
  tombstoneCustomCostRows,
} from "../clickhouse/custom-cost-store";
import { CostIngestError, validateCostRows, type IngestCostRow } from "./cost-ingest";
import { CUSTOM_COST_UPLOAD_TAG, customCostAccountId, customCostPluginId } from "./custom-cost-ids";

export { CostIngestError };

/** A request the API should refuse with a 400 and this message. */
export class CustomCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomCostError";
  }
}

/**
 * The declared range overlaps uploads that still hold rows and the caller did
 * not say whether to append or replace. The API maps this onto a 409 carrying
 * the overlapping uploads, so a client can show them and ask.
 */
export class CustomCostOverlapError extends Error {
  constructor(public readonly overlapping: CustomCostUpload[]) {
    super(
      `This range overlaps ${overlapping.length} earlier upload(s). Choose "append" to add to that spend or "replace" to supersede it.`,
    );
    this.name = "CustomCostOverlapError";
  }
}

const CURRENCY = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const VIA = ["web", "desktop", "cli", "api"] as const;

function isRealDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

// ─── Sources ────────────────────────────────────────────────────────────────

function sourceToWire(
  row: typeof customCostSources.$inferSelect,
  stats?: { uploadCount: number; lastUploadAt: Date | null },
): CustomCostSource {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultCurrency: row.defaultCurrency,
    pluginId: customCostPluginId(row.id),
    uploadCount: stats?.uploadCount ?? 0,
    lastUploadAt: stats?.lastUploadAt ? stats.lastUploadAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeSourceInput(input: CustomCostSourceInput): {
  name: string;
  description: string | null;
  defaultCurrency: string | null;
} {
  const name = input.name.trim();
  if (!name) throw new CustomCostError("A custom cost source needs a name.");
  if (name.length > CUSTOM_COST_LIMITS.maxNameLength) {
    throw new CustomCostError(`Names are at most ${CUSTOM_COST_LIMITS.maxNameLength} characters.`);
  }
  const description = input.description?.trim() || null;
  if (description && description.length > CUSTOM_COST_LIMITS.maxDescriptionLength) {
    throw new CustomCostError(
      `Descriptions are at most ${CUSTOM_COST_LIMITS.maxDescriptionLength} characters.`,
    );
  }
  const defaultCurrency = input.defaultCurrency?.trim().toUpperCase() || null;
  if (defaultCurrency && !CURRENCY.test(defaultCurrency)) {
    throw new CustomCostError("The default currency must be a 3-letter ISO code.");
  }
  return { name, description, defaultCurrency };
}

async function assertNameFree(organizationId: string, name: string, exceptId?: string) {
  const clash = await db
    .select({ id: customCostSources.id })
    .from(customCostSources)
    .where(
      and(
        eq(customCostSources.organizationId, organizationId),
        sql`lower(${customCostSources.name}) = ${name.toLowerCase()}`,
      ),
    );
  if (clash.some((c) => c.id !== exceptId)) {
    throw new CustomCostError(`A custom cost source named "${name}" already exists.`);
  }
}

/** Every source in the org, name-sorted, with its upload count and latest upload. */
export async function listCustomCostSources(organizationId: string): Promise<CustomCostSource[]> {
  const [rows, stats] = await Promise.all([
    db
      .select()
      .from(customCostSources)
      .where(eq(customCostSources.organizationId, organizationId))
      .orderBy(customCostSources.name),
    db
      .select({
        sourceId: customCostUploads.sourceId,
        uploadCount: count(),
        lastUploadAt: max(customCostUploads.createdAt),
      })
      .from(customCostUploads)
      .where(eq(customCostUploads.organizationId, organizationId))
      .groupBy(customCostUploads.sourceId),
  ]);
  const bySource = new Map(stats.map((s) => [s.sourceId, s]));
  return rows.map((row) => {
    const s = bySource.get(row.id);
    return sourceToWire(row, {
      uploadCount: Number(s?.uploadCount ?? 0),
      lastUploadAt: s?.lastUploadAt ?? null,
    });
  });
}

export async function getCustomCostSource(
  organizationId: string,
  id: string,
): Promise<CustomCostSource | null> {
  const all = await listCustomCostSources(organizationId);
  return all.find((s) => s.id === id) ?? null;
}

/** `custom:<id>` → source name, for labelling the provider and account dimensions. */
export async function customCostSourceNames(organizationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: customCostSources.id, name: customCostSources.name })
    .from(customCostSources)
    .where(eq(customCostSources.organizationId, organizationId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function createCustomCostSource(
  organizationId: string,
  input: CustomCostSourceInput,
  userId: string | null,
): Promise<CustomCostSource> {
  const values = normalizeSourceInput(input);
  await assertNameFree(organizationId, values.name);
  const [row] = await db
    .insert(customCostSources)
    .values({ id: randomUUID(), organizationId, ...values, createdByUserId: userId })
    .returning();
  return sourceToWire(row!);
}

export async function updateCustomCostSource(
  organizationId: string,
  id: string,
  input: CustomCostSourceInput,
): Promise<CustomCostSource | null> {
  const values = normalizeSourceInput(input);
  await assertNameFree(organizationId, values.name, id);
  const [row] = await db
    .update(customCostSources)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(customCostSources.organizationId, organizationId), eq(customCostSources.id, id)))
    .returning();
  if (!row) return null;
  return getCustomCostSource(organizationId, row.id);
}

/**
 * Delete a source and every row it holds. The rows are zeroed first: once the
 * source row is gone nothing could find them again to remove them.
 */
export async function deleteCustomCostSource(
  organizationId: string,
  id: string,
): Promise<{ deleted: boolean; zeroedRows: number }> {
  const [existing] = await db
    .select({ id: customCostSources.id })
    .from(customCostSources)
    .where(and(eq(customCostSources.organizationId, organizationId), eq(customCostSources.id, id)));
  if (!existing) return { deleted: false, zeroedRows: 0 };
  const { zeroed } = await tombstoneCustomCostRows({
    organizationId,
    pluginId: customCostPluginId(id),
  });
  await db
    .delete(customCostSources)
    .where(and(eq(customCostSources.organizationId, organizationId), eq(customCostSources.id, id)));
  return { deleted: true, zeroedRows: zeroed };
}

// ─── Uploads ────────────────────────────────────────────────────────────────

type UploadRow = typeof customCostUploads.$inferSelect;

function uploadToWire(
  row: UploadRow,
  user: { id: string; name: string | null; email: string | null } | null,
): CustomCostUpload {
  return {
    id: row.id,
    sourceId: row.sourceId,
    fileName: row.fileName,
    format: row.format as CustomCostFormat,
    mode: row.mode as CustomCostUploadMode,
    status: row.status as CustomCostUpload["status"],
    fromDate: row.fromDate,
    toDate: row.toDate,
    rowCount: row.rowCount,
    totals: row.totals ?? {},
    uploadedBy: user,
    via: row.via as CustomCostUpload["via"],
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

async function loadUploads(
  organizationId: string,
  where: ReturnType<typeof and>,
): Promise<CustomCostUpload[]> {
  const rows = await db
    .select({
      upload: customCostUploads,
      userId: users.id,
      userName: users.displayName,
      userEmail: users.email,
    })
    .from(customCostUploads)
    .leftJoin(users, eq(users.id, customCostUploads.uploadedByUserId))
    .where(and(eq(customCostUploads.organizationId, organizationId), where))
    .orderBy(desc(customCostUploads.createdAt));
  return rows.map((r) =>
    uploadToWire(
      r.upload,
      r.userId ? { id: r.userId, name: r.userName ?? null, email: r.userEmail ?? null } : null,
    ),
  );
}

/** A source's upload history, newest first. */
export async function listCustomCostUploads(
  organizationId: string,
  sourceId: string,
): Promise<CustomCostUpload[]> {
  return loadUploads(organizationId, and(eq(customCostUploads.sourceId, sourceId)));
}

async function getUpload(
  organizationId: string,
  sourceId: string,
  uploadId: string,
): Promise<CustomCostUpload | null> {
  const [upload] = await loadUploads(
    organizationId,
    and(eq(customCostUploads.sourceId, sourceId), eq(customCostUploads.id, uploadId)),
  );
  return upload ?? null;
}

export interface CreateCustomCostUploadInput {
  fileName?: string | null | undefined;
  format: string;
  mode?: string | undefined;
  via?: string | undefined;
  fromDate: string;
  toDate: string;
}

/**
 * Open an upload. Refuses (with {@link CustomCostOverlapError}) when the range
 * overlaps uploads that still hold rows and no mode was given.
 */
export async function createCustomCostUpload(
  organizationId: string,
  sourceId: string,
  input: CreateCustomCostUploadInput,
  userId: string | null,
): Promise<CustomCostUpload | null> {
  const [source] = await db
    .select({ id: customCostSources.id })
    .from(customCostSources)
    .where(
      and(eq(customCostSources.organizationId, organizationId), eq(customCostSources.id, sourceId)),
    );
  if (!source) return null;

  if (!(CUSTOM_COST_FORMATS as readonly string[]).includes(input.format)) {
    throw new CustomCostError(`format must be one of ${CUSTOM_COST_FORMATS.join(", ")}.`);
  }
  if (
    input.mode !== undefined &&
    !(CUSTOM_COST_UPLOAD_MODES as readonly string[]).includes(input.mode)
  ) {
    throw new CustomCostError(`mode must be one of ${CUSTOM_COST_UPLOAD_MODES.join(", ")}.`);
  }
  const via = input.via ?? "api";
  if (!(VIA as readonly string[]).includes(via)) {
    throw new CustomCostError(`via must be one of ${VIA.join(", ")}.`);
  }
  if (!isRealDay(input.fromDate) || !isRealDay(input.toDate)) {
    throw new CustomCostError("fromDate and toDate must be YYYY-MM-DD dates.");
  }
  if (input.fromDate > input.toDate) {
    throw new CustomCostError("fromDate must not be after toDate.");
  }
  const spanDays =
    (Date.parse(`${input.toDate}T00:00:00Z`) - Date.parse(`${input.fromDate}T00:00:00Z`)) /
    86_400_000;
  if (spanDays + 1 > CUSTOM_COST_LIMITS.maxSpanDays) {
    throw new CustomCostError(
      `One upload covers at most ${CUSTOM_COST_LIMITS.maxSpanDays} days. Split the file by date.`,
    );
  }
  const fileName = input.fileName?.trim() || null;
  if (fileName && fileName.length > CUSTOM_COST_LIMITS.maxFileNameLength) {
    throw new CustomCostError(
      `File names are at most ${CUSTOM_COST_LIMITS.maxFileNameLength} characters.`,
    );
  }

  if (input.mode === undefined) {
    const existing = await listCustomCostUploads(organizationId, sourceId);
    const overlapping = overlappingCustomCostUploads(existing, input.fromDate, input.toDate);
    if (overlapping.length > 0) throw new CustomCostOverlapError(overlapping);
  }

  const id = randomUUID();
  await db.insert(customCostUploads).values({
    id,
    organizationId,
    sourceId,
    fileName,
    format: input.format,
    mode: input.mode ?? "append",
    status: "uploading",
    fromDate: input.fromDate,
    toDate: input.toDate,
    uploadedByUserId: userId,
    via,
  });
  return getUpload(organizationId, sourceId, id);
}

async function requireUploading(
  organizationId: string,
  sourceId: string,
  uploadId: string,
): Promise<UploadRow | null> {
  const [row] = await db
    .select()
    .from(customCostUploads)
    .where(
      and(
        eq(customCostUploads.organizationId, organizationId),
        eq(customCostUploads.sourceId, sourceId),
        eq(customCostUploads.id, uploadId),
      ),
    );
  if (!row) return null;
  if (row.status !== "uploading") {
    throw new CustomCostError("This upload is already complete; start a new upload to add rows.");
  }
  return row;
}

/** Append a chunk of rows to an open upload. */
export async function appendCustomCostRows(
  organizationId: string,
  sourceId: string,
  uploadId: string,
  rows: IngestCostRow[],
): Promise<{ written: number } | null> {
  const upload = await requireUploading(organizationId, sourceId, uploadId);
  if (!upload) return null;
  if (upload.rowCount + rows.length > CUSTOM_COST_LIMITS.maxRowsPerUpload) {
    throw new CustomCostError(
      `An upload holds at most ${CUSTOM_COST_LIMITS.maxRowsPerUpload} rows. Split the file by date.`,
    );
  }

  // The upload tag rides in `tags`, so it is added *after* validation (which
  // rejects reserved keys from the caller) by the ingest source's own tag.
  const mapped = await validateCostRows({
    organizationId,
    rows,
    source: {
      pluginId: customCostPluginId(sourceId),
      tag: { key: CUSTOM_COST_UPLOAD_TAG, value: uploadId },
      fallbackAccountId: customCostAccountId(sourceId),
      subAccountId: (sub) => customCostAccountId(sourceId, sub),
      allowAttribution: true,
      dateRange: { from: upload.fromDate, to: upload.toDate },
      errorPrefix: "custom-cost-sources/uploads",
      maxRows: CUSTOM_COST_LIMITS.maxRowsPerChunk,
    },
  });
  await insertCostRows(mapped);
  await db
    .update(customCostUploads)
    .set({ rowCount: sql`${customCostUploads.rowCount} + ${mapped.length}` })
    .where(eq(customCostUploads.id, uploadId));
  return { written: mapped.length };
}

/**
 * Write recomputed holdings back onto upload rows. An upload left holding
 * nothing after a replace is `replaced`; one still open stays `uploading`.
 */
async function refreshHoldings(organizationId: string, sourceId: string, uploadIds: string[]) {
  if (uploadIds.length === 0) return;
  const holdings = await getCustomCostUploadHoldings(
    organizationId,
    customCostPluginId(sourceId),
    uploadIds,
  );
  const current = await db
    .select({ id: customCostUploads.id, status: customCostUploads.status })
    .from(customCostUploads)
    .where(
      and(
        eq(customCostUploads.organizationId, organizationId),
        inArray(customCostUploads.id, uploadIds),
      ),
    );
  for (const row of current) {
    const h = holdings.get(row.id);
    if (!h) continue;
    await db
      .update(customCostUploads)
      .set({
        rowCount: h.rowCount,
        totals: h.totals,
        ...(h.fromDate && h.toDate ? { fromDate: h.fromDate, toDate: h.toDate } : {}),
        ...(h.rowCount === 0 && row.status === "complete" ? { status: "replaced" } : {}),
      })
      .where(eq(customCostUploads.id, row.id));
  }
}

/**
 * Finish an upload: apply `replace` (zero this source's rows from every other
 * upload in the declared range), then record what the upload holds.
 */
export async function completeCustomCostUpload(
  organizationId: string,
  sourceId: string,
  uploadId: string,
): Promise<{ upload: CustomCostUpload; replacedRows: number } | null> {
  const upload = await requireUploading(organizationId, sourceId, uploadId);
  if (!upload) return null;

  let replacedRows = 0;
  let affected: string[] = [];
  if (upload.mode === "replace") {
    const result = await tombstoneCustomCostRows({
      organizationId,
      pluginId: customCostPluginId(sourceId),
      from: upload.fromDate,
      to: upload.toDate,
      excludeUploadId: uploadId,
    });
    replacedRows = result.zeroed;
    affected = result.uploadIds;
  }

  await db
    .update(customCostUploads)
    .set({ status: "complete", completedAt: new Date() })
    .where(eq(customCostUploads.id, uploadId));
  await refreshHoldings(organizationId, sourceId, [uploadId, ...affected]);

  const fresh = await getUpload(organizationId, sourceId, uploadId);
  return fresh ? { upload: fresh, replacedRows } : null;
}

/** Delete an upload and zero every row it wrote. */
export async function deleteCustomCostUpload(
  organizationId: string,
  sourceId: string,
  uploadId: string,
): Promise<{ deleted: boolean; zeroedRows: number }> {
  const upload = await getUpload(organizationId, sourceId, uploadId);
  if (!upload) return { deleted: false, zeroedRows: 0 };
  const { zeroed } = await tombstoneCustomCostRows({
    organizationId,
    pluginId: customCostPluginId(sourceId),
    uploadId,
  });
  await db
    .delete(customCostUploads)
    .where(
      and(eq(customCostUploads.organizationId, organizationId), eq(customCostUploads.id, uploadId)),
    );
  return { deleted: true, zeroedRows: zeroed };
}
