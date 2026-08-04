/**
 * Synthetic probe rows — CRUD + normalization shared by the web API and the
 * poller pass.
 *
 * Input limits come from `@infrawrench/client-core` (`PROBE_LIMITS`,
 * `normalizeProbeUrl`), the same values the editor UIs clamp with — the
 * server and the form can't disagree about what a valid interval is (the
 * `schedules/store.ts` stance).
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  PROBE_DEFAULTS,
  PROBE_LIMITS,
  clampProbeNumber,
  normalizeProbeMethod,
  normalizeProbeUrl,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { resources, syntheticProbes } from "../db/schema";

export type ProbeRecord = typeof syntheticProbes.$inferSelect;

export interface ProbeCreateInput {
  name: string;
  url: string;
  method?: string | undefined;
  intervalSeconds?: number | undefined;
  timeoutMs?: number | undefined;
  failureThreshold?: number | undefined;
  enabled?: boolean | undefined;
  /** Linked resource identity; validated against the org's resources when set. */
  resourceId?: string | null | undefined;
  accountId?: string | null | undefined;
  pluginId?: string | null | undefined;
  resourceTypeId?: string | null | undefined;
  outputKey?: string | null | undefined;
}

export interface ProbeUpdateInput {
  name?: string | undefined;
  url?: string | undefined;
  method?: string | undefined;
  intervalSeconds?: number | undefined;
  timeoutMs?: number | undefined;
  failureThreshold?: number | undefined;
  enabled?: boolean | undefined;
}

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class ProbeInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ProbeInputError";
  }
}

function normalizedUrl(raw: string): string {
  const parsed = normalizeProbeUrl(raw);
  if ("error" in parsed) throw new ProbeInputError(parsed.error);
  return parsed.url;
}

function clampInterval(raw: unknown): number {
  return clampProbeNumber(
    raw,
    PROBE_DEFAULTS.intervalSeconds,
    PROBE_LIMITS.minIntervalSeconds,
    PROBE_LIMITS.maxIntervalSeconds,
  );
}

function clampTimeout(raw: unknown): number {
  return clampProbeNumber(
    raw,
    PROBE_DEFAULTS.timeoutMs,
    PROBE_LIMITS.minTimeoutMs,
    PROBE_LIMITS.maxTimeoutMs,
  );
}

function clampThreshold(raw: unknown): number {
  return clampProbeNumber(
    raw,
    PROBE_DEFAULTS.failureThreshold,
    PROBE_LIMITS.minFailureThreshold,
    PROBE_LIMITS.maxFailureThreshold,
  );
}

export async function listProbeRecords(organizationId: string): Promise<ProbeRecord[]> {
  return db
    .select()
    .from(syntheticProbes)
    .where(eq(syntheticProbes.organizationId, organizationId))
    .orderBy(syntheticProbes.createdAt);
}

export async function getProbeRecord(
  organizationId: string,
  probeId: string,
): Promise<ProbeRecord | null> {
  const rows = await db
    .select()
    .from(syntheticProbes)
    .where(and(eq(syntheticProbes.organizationId, organizationId), eq(syntheticProbes.id, probeId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create a probe. The URL is validated and normalized; numeric inputs are
 * clamped into `PROBE_LIMITS` rather than rejected (an interval of 30 becomes
 * 60 — the floor exists to protect the shared proxy, not to fail forms). A
 * linked resource, when given, must exist in this org — the link is advisory
 * (the probe outlives the resource) but must at least start out true.
 */
export async function createProbeRecord(
  organizationId: string,
  input: ProbeCreateInput,
  createdByUserId?: string,
): Promise<ProbeRecord> {
  const name = input.name?.trim();
  if (!name) throw new ProbeInputError("A name is required");
  const url = normalizedUrl(input.url ?? "");

  let link: Pick<ProbeRecord, "accountId" | "resourceId" | "pluginId" | "resourceTypeId"> = {
    accountId: null,
    resourceId: null,
    pluginId: null,
    resourceTypeId: null,
  };
  if (input.resourceId) {
    const [resource] = await db
      .select({
        id: resources.id,
        accountId: resources.accountId,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), eq(resources.id, input.resourceId)))
      .limit(1);
    if (!resource) throw new ProbeInputError("Linked resource not found in this organization", 404);
    link = {
      accountId: resource.accountId,
      resourceId: resource.id,
      pluginId: resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
    };
  }

  const now = new Date();
  const row: typeof syntheticProbes.$inferInsert = {
    id: randomUUID(),
    organizationId,
    name,
    url,
    method: normalizeProbeMethod(input.method),
    intervalSeconds: clampInterval(input.intervalSeconds),
    timeoutMs: clampTimeout(input.timeoutMs),
    failureThreshold: clampThreshold(input.failureThreshold),
    enabled: input.enabled ?? true,
    ...link,
    outputKey: input.resourceId ? input.outputKey?.trim() || null : null,
    consecutiveFailures: 0,
    status: "unknown",
    // Null = due now: the first result lands within one poller tick.
    nextProbeAt: null,
    createdByUserId: createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // The per-org limit check and the insert run under an org-scoped advisory
  // lock so two concurrent creates can't both pass the count (the
  // `resource_schedules` stance).
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`synthetic_probes:${organizationId}`}))`,
    );
    const count = await tx
      .select({ id: syntheticProbes.id })
      .from(syntheticProbes)
      .where(eq(syntheticProbes.organizationId, organizationId));
    if (count.length >= PROBE_LIMITS.maxPerOrg) {
      throw new ProbeInputError(`Organizations are limited to ${PROBE_LIMITS.maxPerOrg} probes`);
    }
    await tx.insert(syntheticProbes).values(row);
  });
  return (await getProbeRecord(organizationId, row.id))!;
}

/**
 * Update settings and/or the enable toggle. A URL or method change resets the
 * probe's state to "unknown" — the history belongs to the old endpoint — and
 * any change that re-enables or retimes the probe clears the lease so the new
 * cadence starts from the next tick.
 */
export async function updateProbeRecord(
  organizationId: string,
  probeId: string,
  patch: ProbeUpdateInput,
): Promise<ProbeRecord> {
  const existing = await getProbeRecord(organizationId, probeId);
  if (!existing) throw new ProbeInputError("Probe not found", 404);

  const set: Partial<typeof syntheticProbes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ProbeInputError("A name is required");
    set.name = name;
  }
  const targetChanged =
    (patch.url !== undefined && normalizedUrl(patch.url) !== existing.url) ||
    (patch.method !== undefined && normalizeProbeMethod(patch.method) !== existing.method);
  if (patch.url !== undefined) set.url = normalizedUrl(patch.url);
  if (patch.method !== undefined) set.method = normalizeProbeMethod(patch.method);
  if (patch.intervalSeconds !== undefined)
    set.intervalSeconds = clampInterval(patch.intervalSeconds);
  if (patch.timeoutMs !== undefined) set.timeoutMs = clampTimeout(patch.timeoutMs);
  if (patch.failureThreshold !== undefined) {
    set.failureThreshold = clampThreshold(patch.failureThreshold);
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  if (targetChanged) {
    set.status = "unknown";
    set.consecutiveFailures = 0;
    set.lastStatusCode = null;
    set.lastLatencyMs = null;
    set.lastError = null;
    set.lastStateChangeAt = null;
  }
  const reenabled = patch.enabled === true && !existing.enabled;
  const retimed = patch.intervalSeconds !== undefined || targetChanged;
  if (reenabled || retimed) set.nextProbeAt = null; // due now

  await db
    .update(syntheticProbes)
    .set(set)
    .where(
      and(eq(syntheticProbes.organizationId, organizationId), eq(syntheticProbes.id, probeId)),
    );
  return (await getProbeRecord(organizationId, probeId))!;
}

export async function deleteProbeRecord(
  organizationId: string,
  probeId: string,
): Promise<ProbeRecord> {
  const existing = await getProbeRecord(organizationId, probeId);
  if (!existing) throw new ProbeInputError("Probe not found", 404);
  await db
    .delete(syntheticProbes)
    .where(
      and(eq(syntheticProbes.organizationId, organizationId), eq(syntheticProbes.id, probeId)),
    );
  return existing;
}
