/**
 * Cost export rows — CRUD, validation and credential handling, shared by the
 * web API and the poller pass.
 *
 * **The one rule this file exists to enforce: credentials only travel inward.**
 * {@link toCostExportView} is the only way a row becomes something a route may
 * return, and it has no branch that emits a secret — it carries
 * {@link CostExportRecord.credentialHint} instead. `loadCredentials` is
 * separate, is not reachable from any route, and is used only by the run loop.
 *
 * Encryption is the mechanism `twilio_settings`, `msteams_webhooks` and
 * `jira_integrations` already use: AES-256-GCM under `ENCRYPTION_MASTER_KEY`,
 * with a context AAD (`costExport:<exportId>:credentials`) binding the
 * ciphertext to its row so it cannot be moved to another org's export.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  COST_EXPORT_CADENCES,
  COST_EXPORT_DESTINATION_KINDS,
  COST_EXPORT_FORMATS,
  COST_DIMENSIONS,
  COST_CHARGE_TYPES,
  type CostExport,
  type CostExportCadence,
  type CostExportDestination,
  type CostExportFormat,
  type CostExportInput,
  type CostExportQuery,
  type CostExportStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costExports } from "../db/schema";
import { buildAad, decrypt, encrypt } from "../encryption";
import { isValidTimeZone } from "../digest/compose";
import { nextCostExportRunAt } from "./periods";

export type CostExportRecord = typeof costExports.$inferSelect;

/** Thrown for caller mistakes the API maps onto 400/404. */
export class CostExportInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "CostExportInputError";
  }
}

/** The decrypted credential bundle. Never leaves the server process. */
export type CostExportCredentials =
  { kind: "s3"; accessKeyId: string; secretAccessKey: string } | { kind: "http"; url: string };

/** Most exports an org may keep. Each one is scheduled work the poller runs. */
export const MAX_COST_EXPORTS_PER_ORG = 25;

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CostExportInputError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Trim, collapse slashes, and drop leading/trailing ones. `""` is allowed. */
export function normalizeKeyPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

function normalizeQuery(raw: unknown): CostExportQuery {
  const q = (raw ?? {}) as Partial<CostExportQuery>;
  const dimensions = Array.isArray(q.dimensions)
    ? q.dimensions.filter((d): d is (typeof COST_DIMENSIONS)[number] =>
        (COST_DIMENSIONS as readonly string[]).includes(d),
      )
    : [];
  const tagKeys = Array.isArray(q.tagKeys)
    ? q.tagKeys.filter((k): k is string => typeof k === "string" && k.length > 0).slice(0, 25)
    : [];
  const filters = Array.isArray(q.filters)
    ? q.filters.filter(
        (f) =>
          f &&
          (COST_DIMENSIONS as readonly string[]).includes(f.dimension) &&
          (f.op === "in" || f.op === "not_in") &&
          Array.isArray(f.values) &&
          f.values.length > 0,
      )
    : [];
  const chargeTypes = Array.isArray(q.chargeTypes)
    ? q.chargeTypes.filter((t) => (COST_CHARGE_TYPES as readonly string[]).includes(t))
    : undefined;

  return {
    version: 1,
    dimensions: [...new Set(dimensions)],
    tagKeys: [...new Set(tagKeys)],
    filters,
    ...(chargeTypes && chargeTypes.length > 0 ? { chargeTypes } : {}),
    ...(q.costBasis === "amortized" ? { costBasis: "amortized" as const } : {}),
  };
}

/**
 * Validate and normalise a destination.
 *
 * The HTTPS destination is deliberately *not* given the URL here: the URL is a
 * credential, so it lives in the encrypted bundle and only its host survives
 * into the non-secret config as {@link CostExportHttpDestination.urlHint}.
 */
function normalizeDestination(raw: unknown, url: string | undefined): CostExportDestination {
  const d = (raw ?? {}) as Record<string, unknown>;
  const kind = requireOneOf(d["kind"], COST_EXPORT_DESTINATION_KINDS, "destination.kind");

  if (kind === "s3") {
    const bucket = String(d["bucket"] ?? "").trim();
    if (!bucket) throw new CostExportInputError("destination.bucket is required");
    if (!/^[a-z0-9][a-z0-9.\-_]{1,254}$/i.test(bucket)) {
      throw new CostExportInputError("destination.bucket is not a valid bucket name");
    }
    const endpoint = String(d["endpoint"] ?? "").trim();
    if (endpoint && !/^(https?:\/\/)?[a-z0-9.\-]+(:\d+)?$/i.test(endpoint)) {
      throw new CostExportInputError("destination.endpoint must be a host or https:// origin");
    }
    return {
      kind: "s3",
      bucket,
      prefix: normalizeKeyPrefix(String(d["prefix"] ?? "")),
      region: String(d["region"] ?? "").trim() || "us-east-1",
      endpoint,
      forcePathStyle: d["forcePathStyle"] === true,
    };
  }

  const method = d["method"] === "PUT" ? "PUT" : "POST";
  let urlHint = String(d["urlHint"] ?? "");
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CostExportInputError("url must be an absolute https:// URL");
    }
    if (parsed.protocol !== "https:") {
      // Org spend over plaintext HTTP is not a trade-off worth offering. There
      // is no localhost carve-out either: the poller runs in the cluster, so a
      // loopback destination could only ever mean a mistake.
      throw new CostExportInputError("url must use https");
    }
    urlHint = `${parsed.host}/…${url.slice(-4)}`;
  }
  if (!urlHint) throw new CostExportInputError("url is required for an HTTPS destination");
  return { kind: "http", method, urlHint };
}

function clampHour(raw: unknown): number {
  const n = Math.trunc(Number(raw ?? 4));
  if (!Number.isFinite(n) || n < 0 || n > 23) {
    throw new CostExportInputError("hour must be an integer between 0 and 23");
  }
  return n;
}

function clampRestatementDays(raw: unknown): number {
  const n = Math.trunc(Number(raw ?? 7));
  if (!Number.isFinite(n) || n < 0 || n > 90) {
    throw new CostExportInputError("restatementDays must be an integer between 0 and 90");
  }
  return n;
}

/** Everything a create/update writes, after validation. */
interface NormalizedInput {
  name: string;
  format: CostExportFormat;
  query: CostExportQuery;
  cadence: CostExportCadence;
  hour: number;
  timezone: string;
  restatementDays: number;
  enabled: boolean;
  destination: CostExportDestination;
}

function normalizeInput(input: CostExportInput): NormalizedInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new CostExportInputError("name is required");
  if (name.length > 120) throw new CostExportInputError("name must be 120 characters or fewer");

  const timezone = String(input.timezone ?? "UTC").trim() || "UTC";
  if (!isValidTimeZone(timezone)) {
    throw new CostExportInputError(`timezone "${timezone}" is not a known IANA zone`);
  }

  return {
    name,
    format: requireOneOf(input.format, COST_EXPORT_FORMATS, "format"),
    query: normalizeQuery(input.query),
    cadence: requireOneOf(input.cadence, COST_EXPORT_CADENCES, "cadence"),
    hour: clampHour(input.hour),
    timezone,
    restatementDays: clampRestatementDays(input.restatementDays),
    enabled: input.enabled !== false,
    destination: normalizeDestination(input.destination, input.url),
  };
}

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

function credentialAad(exportId: string): string {
  return buildAad("costExport", exportId, "credentials");
}

/** Redacted marker: enough to tell two credentials apart, useless as a secret. */
function hintFor(creds: CostExportCredentials): string {
  if (creds.kind === "s3") {
    const id = creds.accessKeyId;
    return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : `…${id.slice(-4)}`;
  }
  try {
    return `${new URL(creds.url).host}/…${creds.url.slice(-4)}`;
  } catch {
    return `…${creds.url.slice(-4)}`;
  }
}

/**
 * Pull the credential bundle out of the input, or `null` when the caller
 * omitted it — which the update path reads as "keep what is stored", the same
 * contract the Jira and Twilio settings use for a blank password field.
 */
function credentialsFromInput(input: CostExportInput): CostExportCredentials | null {
  if (input.destination?.kind === "s3") {
    const accessKeyId = input.accessKeyId?.trim();
    const secretAccessKey = input.secretAccessKey?.trim();
    if (!accessKeyId && !secretAccessKey) return null;
    if (!accessKeyId || !secretAccessKey) {
      throw new CostExportInputError("accessKeyId and secretAccessKey must be supplied together");
    }
    return { kind: "s3", accessKeyId, secretAccessKey };
  }
  const url = input.url?.trim();
  if (!url) return null;
  return { kind: "http", url };
}

/**
 * Decrypt an export's credentials. **Server-side callers only** — nothing that
 * can reach an HTTP response may call this. Returns null when none are stored
 * or when decryption fails (a rotated master key, a corrupted row); the run
 * loop turns that into a visible `lastError` rather than a crash.
 */
export async function loadCredentials(
  row: CostExportRecord,
): Promise<CostExportCredentials | null> {
  if (!row.encryptedCredentials || !row.credentialsIv) return null;
  try {
    const plain = await decrypt(row.encryptedCredentials, row.credentialsIv, credentialAad(row.id));
    const parsed = JSON.parse(plain) as CostExportCredentials;
    if (parsed?.kind === "s3" || parsed?.kind === "http") return parsed;
    return null;
  } catch (err) {
    console.error(`[cost-export] failed to decrypt credentials for ${row.id}:`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

/**
 * Row → the wire shape. The only function a route should use to build a
 * response, because it is the only one that provably omits the ciphertext, the
 * IV and the plaintext alike.
 */
export function toCostExportView(row: CostExportRecord): CostExport {
  return {
    id: row.id,
    name: row.name,
    format: row.format as CostExportFormat,
    query: row.query as unknown as CostExportQuery,
    cadence: row.cadence as CostExportCadence,
    hour: row.hour,
    timezone: row.timezone,
    restatementDays: row.restatementDays,
    enabled: row.enabled,
    destination: row.destination as unknown as CostExportDestination,
    hasCredentials: !!row.encryptedCredentials,
    credentialHint: row.credentialHint,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus as CostExportStatus,
    lastError: row.lastError,
    lastObjectCount: row.lastObjectCount,
    lastRowCount: row.lastRowCount,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

export async function listCostExports(organizationId: string): Promise<CostExport[]> {
  const rows = await db
    .select()
    .from(costExports)
    .where(and(eq(costExports.organizationId, organizationId), isNull(costExports.deletedAt)))
    .orderBy(costExports.createdAt);
  return rows.map(toCostExportView);
}

/** Raw row (credentials still encrypted) — for the run loop and internal callers. */
export async function getCostExportRow(
  organizationId: string,
  id: string,
): Promise<CostExportRecord | null> {
  const [row] = await db
    .select()
    .from(costExports)
    .where(
      and(
        eq(costExports.organizationId, organizationId),
        eq(costExports.id, id),
        isNull(costExports.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCostExport(
  organizationId: string,
  id: string,
): Promise<CostExport | null> {
  const row = await getCostExportRow(organizationId, id);
  return row ? toCostExportView(row) : null;
}

export async function createCostExport(
  organizationId: string,
  input: CostExportInput,
  userId: string | null,
): Promise<CostExport> {
  const normalized = normalizeInput(input);
  const creds = credentialsFromInput(input);
  if (!creds) {
    throw new CostExportInputError(
      normalized.destination.kind === "s3"
        ? "accessKeyId and secretAccessKey are required to create an S3 export"
        : "url is required to create an HTTPS export",
    );
  }

  const [existingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(costExports)
    .where(and(eq(costExports.organizationId, organizationId), isNull(costExports.deletedAt)));
  if ((existingCount?.count ?? 0) >= MAX_COST_EXPORTS_PER_ORG) {
    throw new CostExportInputError(
      `An organization may keep ${MAX_COST_EXPORTS_PER_ORG} cost exports; delete one first`,
    );
  }

  const id = randomUUID();
  const enc = await encrypt(JSON.stringify(creds), credentialAad(id));
  const now = new Date();

  const [row] = await db
    .insert(costExports)
    .values({
      id,
      organizationId,
      name: normalized.name,
      format: normalized.format,
      query: normalized.query as unknown as Record<string, unknown>,
      cadence: normalized.cadence,
      hour: normalized.hour,
      timezone: normalized.timezone,
      restatementDays: normalized.restatementDays,
      enabled: normalized.enabled,
      destinationKind: normalized.destination.kind,
      destination: normalized.destination as unknown as Record<string, unknown>,
      encryptedCredentials: enc.ciphertext,
      credentialsIv: enc.iv,
      credentialHint: hintFor(creds),
      lastStatus: "pending",
      nextRunAt: normalized.enabled
        ? nextCostExportRunAt(normalized.cadence, normalized.hour, normalized.timezone, now)
        : null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return toCostExportView(row!);
}

export async function updateCostExport(
  organizationId: string,
  id: string,
  input: CostExportInput,
): Promise<CostExport | null> {
  const existing = await getCostExportRow(organizationId, id);
  if (!existing) return null;

  const normalized = normalizeInput(input);
  const creds = credentialsFromInput(input);
  if (!creds && !existing.encryptedCredentials) {
    throw new CostExportInputError("This export has no stored credentials; supply them");
  }
  // A destination that changed kind cannot keep the old credentials — an S3
  // key pair is not a URL. Rejecting is better than silently running with a
  // credential that cannot possibly match the new destination.
  if (!creds && existing.destinationKind !== normalized.destination.kind) {
    throw new CostExportInputError(
      "Changing the destination type requires supplying new credentials",
    );
  }

  const enc = creds ? await encrypt(JSON.stringify(creds), credentialAad(id)) : null;
  const now = new Date();

  const [row] = await db
    .update(costExports)
    .set({
      name: normalized.name,
      format: normalized.format,
      query: normalized.query as unknown as Record<string, unknown>,
      cadence: normalized.cadence,
      hour: normalized.hour,
      timezone: normalized.timezone,
      restatementDays: normalized.restatementDays,
      enabled: normalized.enabled,
      destinationKind: normalized.destination.kind,
      destination: normalized.destination as unknown as Record<string, unknown>,
      ...(enc && creds
        ? {
            encryptedCredentials: enc.ciphertext,
            credentialsIv: enc.iv,
            credentialHint: hintFor(creds),
          }
        : {}),
      // Reschedule from now: the user just changed when this should fire, and
      // leaving the old lease in place would run it on the old schedule once.
      nextRunAt: normalized.enabled
        ? nextCostExportRunAt(normalized.cadence, normalized.hour, normalized.timezone, now)
        : null,
      updatedAt: now,
    })
    .where(and(eq(costExports.organizationId, organizationId), eq(costExports.id, id)))
    .returning();

  return row ? toCostExportView(row) : null;
}

/** Soft delete. Nulls `nextRunAt` too, so the claim can never see it again. */
export async function deleteCostExport(organizationId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(costExports)
    .set({ deletedAt: new Date(), nextRunAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(costExports.organizationId, organizationId),
        eq(costExports.id, id),
        isNull(costExports.deletedAt),
      ),
    )
    .returning({ id: costExports.id });
  return !!row;
}

/** Record the outcome of a run and set the next fire time. */
export async function recordCostExportRun(
  id: string,
  outcome: {
    status: CostExportStatus;
    error: string | null;
    objectCount: number | null;
    rowCount: number | null;
    nextRunAt: Date | null;
  },
): Promise<void> {
  await db
    .update(costExports)
    .set({
      lastRunAt: new Date(),
      lastStatus: outcome.status,
      lastError: outcome.error,
      lastObjectCount: outcome.objectCount,
      lastRowCount: outcome.rowCount,
      nextRunAt: outcome.nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(costExports.id, id));
}
