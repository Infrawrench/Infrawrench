/**
 * SLO rows: CRUD, source validation and the wire assembly shared by the web
 * API, the wallboard and org config as code.
 *
 * Validation is `validateSloInput` from client-core, the same function the
 * editors run, so the form and the API reject the same inputs with the same
 * words. Unlike probes, out-of-range numbers are **rejected rather than
 * clamped**: a target that silently became something else is a promise about
 * reliability nobody made.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  SLO_DEFAULTS,
  SLO_LIMITS,
  deriveSloStatus,
  normalizeSloSource,
  sloBudgetTotalMinutes,
  validateSloInput,
  type Slo,
  type SloInput,
  type SloWindowDays,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { resources, slos, syntheticProbes } from "../db/schema";

export type SloRecord = typeof slos.$inferSelect;

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class SloInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "SloInputError";
  }
}

/** Fill a partial body from defaults (create) or the stored row (update). */
export function sloInputFrom(body: Partial<SloInput>, base?: SloRecord): SloInput {
  const pick = <K extends keyof SloInput>(key: K, fallback: SloInput[K]): SloInput[K] =>
    body[key] !== undefined ? (body[key] as SloInput[K]) : fallback;
  return {
    name: pick("name", base?.name ?? ""),
    description: pick("description", base?.description ?? null),
    sliKind: pick("sliKind", base?.sliKind ?? "probe_availability"),
    probeId: pick("probeId", base?.probeId ?? null),
    latencyThresholdMs: pick(
      "latencyThresholdMs",
      base?.latencyThresholdMs ??
        (body.sliKind === "probe_latency" ? SLO_DEFAULTS.latencyThresholdMs : null),
    ),
    resourceId: pick("resourceId", base?.resourceId ?? null),
    metricKey: pick("metricKey", base?.metricKey ?? null),
    comparator: pick("comparator", base?.comparator ?? null),
    threshold: pick("threshold", base?.threshold ?? null),
    targetPercent: pick("targetPercent", base?.targetPercent ?? SLO_DEFAULTS.targetPercent),
    windowDays: pick("windowDays", (base?.windowDays as SloWindowDays) ?? SLO_DEFAULTS.windowDays),
    alertsEnabled: pick("alertsEnabled", base?.alertsEnabled ?? SLO_DEFAULTS.alertsEnabled),
    suggestFreeze: pick("suggestFreeze", base?.suggestFreeze ?? SLO_DEFAULTS.suggestFreeze),
    enabled: pick("enabled", base?.enabled ?? true),
  };
}

/** The source must exist in this org when it is written; later it may disappear. */
async function assertSourceExists(organizationId: string, input: SloInput): Promise<void> {
  if (input.probeId) {
    const [probe] = await db
      .select({ id: syntheticProbes.id })
      .from(syntheticProbes)
      .where(
        and(
          eq(syntheticProbes.organizationId, organizationId),
          eq(syntheticProbes.id, input.probeId),
        ),
      )
      .limit(1);
    if (!probe) throw new SloInputError("Probe not found in this organization", 404);
  }
  if (input.resourceId) {
    const [resource] = await db
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          eq(resources.id, input.resourceId),
          isNull(resources.deletedAt),
        ),
      )
      .limit(1);
    if (!resource) throw new SloInputError("Resource not found in this organization", 404);
  }
}

function validated(input: SloInput): SloInput {
  const problem = validateSloInput(input);
  if (problem) throw new SloInputError(problem);
  return {
    ...input,
    ...normalizeSloSource(input),
    name: input.name.trim(),
    description: input.description?.trim() || null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code;
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

export async function listSloRecords(organizationId: string): Promise<SloRecord[]> {
  return db
    .select()
    .from(slos)
    .where(eq(slos.organizationId, organizationId))
    .orderBy(slos.createdAt, slos.id);
}

export async function getSloRecord(
  organizationId: string,
  sloId: string,
): Promise<SloRecord | null> {
  const rows = await db
    .select()
    .from(slos)
    .where(and(eq(slos.organizationId, organizationId), eq(slos.id, sloId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createSloRecord(
  organizationId: string,
  body: Partial<SloInput>,
  createdByUserId?: string,
): Promise<SloRecord> {
  const input = validated(sloInputFrom(body));
  await assertSourceExists(organizationId, input);
  const now = new Date();
  const id = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`slos:${organizationId}`}))`);
      const existing = await tx
        .select({ id: slos.id })
        .from(slos)
        .where(eq(slos.organizationId, organizationId));
      if (existing.length >= SLO_LIMITS.maxPerOrg) {
        throw new SloInputError(`Organizations are limited to ${SLO_LIMITS.maxPerOrg} SLOs`);
      }
      await tx.insert(slos).values({
        id,
        organizationId,
        ...input,
        nextEvalAt: null,
        createdByUserId: createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new SloInputError("An SLO with that name already exists", 409);
    }
    throw err;
  }
  return (await getSloRecord(organizationId, id))!;
}

/**
 * Update settings. A change to what is measured (source, target or window)
 * resets the snapshot and the alert state: the stored numbers answered a
 * different question, and carrying the alert level forward would either page
 * on the first pass of an objective nobody has seen evaluated or stay silent
 * about one that is already failing.
 */
export async function updateSloRecord(
  organizationId: string,
  sloId: string,
  body: Partial<SloInput>,
): Promise<SloRecord> {
  const existing = await getSloRecord(organizationId, sloId);
  if (!existing) throw new SloInputError("SLO not found", 404);
  const input = validated(sloInputFrom(body, existing));
  if (input.probeId !== existing.probeId || input.resourceId !== existing.resourceId) {
    await assertSourceExists(organizationId, input);
  }

  const measurementChanged =
    input.sliKind !== existing.sliKind ||
    input.probeId !== existing.probeId ||
    input.latencyThresholdMs !== existing.latencyThresholdMs ||
    input.resourceId !== existing.resourceId ||
    input.metricKey !== existing.metricKey ||
    input.comparator !== existing.comparator ||
    input.threshold !== existing.threshold ||
    input.targetPercent !== existing.targetPercent ||
    input.windowDays !== existing.windowDays;

  const set: Partial<typeof slos.$inferInsert> = { ...input, updatedAt: new Date() };
  if (measurementChanged) {
    Object.assign(set, {
      sli: null,
      goodEvents: 0,
      totalEvents: 0,
      budgetRemaining: null,
      burnRates: {},
      burnAlert: "none",
      burnAlertChangedAt: null,
      exhaustedAt: null,
      lastError: null,
      lastEvalAt: null,
    });
  }
  if (measurementChanged || (input.enabled && !existing.enabled)) set.nextEvalAt = null;

  try {
    await db
      .update(slos)
      .set(set)
      .where(and(eq(slos.organizationId, organizationId), eq(slos.id, sloId)));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new SloInputError("An SLO with that name already exists", 409);
    }
    throw err;
  }
  return (await getSloRecord(organizationId, sloId))!;
}

export async function deleteSloRecord(organizationId: string, sloId: string): Promise<SloRecord> {
  const existing = await getSloRecord(organizationId, sloId);
  if (!existing) throw new SloInputError("SLO not found", 404);
  await db.delete(slos).where(and(eq(slos.organizationId, organizationId), eq(slos.id, sloId)));
  return existing;
}

/** Display labels for the sources of many SLOs, in two reads. */
export async function loadSloSourceLabels(
  organizationId: string,
  rows: readonly SloRecord[],
): Promise<{
  probes: Map<string, { name: string }>;
  resources: Map<
    string,
    { displayName: string; accountId: string; pluginId: string; resourceTypeId: string }
  >;
}> {
  const probeIds = [...new Set(rows.map((r) => r.probeId).filter((v): v is string => !!v))];
  const resourceIds = [...new Set(rows.map((r) => r.resourceId).filter((v): v is string => !!v))];
  const probeRows = probeIds.length
    ? await db
        .select({ id: syntheticProbes.id, name: syntheticProbes.name })
        .from(syntheticProbes)
        .where(
          and(
            eq(syntheticProbes.organizationId, organizationId),
            inArray(syntheticProbes.id, probeIds),
          ),
        )
    : [];
  const resourceRows = resourceIds.length
    ? await db
        .select({
          id: resources.id,
          displayName: resources.displayName,
          accountId: resources.accountId,
          pluginId: resources.pluginId,
          resourceTypeId: resources.resourceTypeId,
        })
        .from(resources)
        .where(
          and(
            eq(resources.organizationId, organizationId),
            inArray(resources.id, resourceIds),
            isNull(resources.deletedAt),
          ),
        )
    : [];
  return {
    probes: new Map(probeRows.map((p) => [p.id, { name: p.name }])),
    resources: new Map(resourceRows.map((r) => [r.id, r])),
  };
}

/** Row → wire shape (`Slo` in client-core). */
export function sloToWire(
  row: SloRecord,
  labels: Awaited<ReturnType<typeof loadSloSourceLabels>>,
): Slo {
  const probe = row.probeId ? labels.probes.get(row.probeId) : undefined;
  const resource = row.resourceId ? labels.resources.get(row.resourceId) : undefined;
  const budgetTotalMinutes = sloBudgetTotalMinutes(row.targetPercent, row.windowDays);
  const snapshot = {
    sli: row.sli,
    budgetRemaining: row.budgetRemaining,
    burnAlert: row.burnAlert,
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sliKind: row.sliKind,
    probeId: row.probeId,
    probeName: probe?.name ?? null,
    latencyThresholdMs: row.latencyThresholdMs,
    resourceId: row.resourceId,
    resourceName: resource?.displayName ?? null,
    accountId: resource?.accountId ?? null,
    pluginId: resource?.pluginId ?? null,
    resourceTypeId: resource?.resourceTypeId ?? null,
    metricKey: row.metricKey,
    comparator: row.comparator,
    threshold: row.threshold,
    targetPercent: row.targetPercent,
    windowDays: row.windowDays as SloWindowDays,
    alertsEnabled: row.alertsEnabled,
    suggestFreeze: row.suggestFreeze,
    enabled: row.enabled,
    status: row.enabled ? deriveSloStatus(snapshot) : "unknown",
    sli: row.sli,
    goodEvents: row.goodEvents,
    totalEvents: row.totalEvents,
    budgetRemaining: row.budgetRemaining,
    budgetTotalMinutes,
    budgetRemainingMinutes:
      row.budgetRemaining === null ? null : row.budgetRemaining * budgetTotalMinutes,
    burnRates: row.burnRates ?? {},
    burnAlert: row.burnAlert,
    exhaustedAt: row.exhaustedAt?.toISOString() ?? null,
    lastEvalAt: row.lastEvalAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every SLO in the org in wire shape: the list endpoint, the wallboard and the widget. */
export async function listSlosWire(organizationId: string): Promise<Slo[]> {
  const rows = await listSloRecords(organizationId);
  const labels = await loadSloSourceLabels(organizationId, rows);
  return rows.map((row) => sloToWire(row, labels));
}
