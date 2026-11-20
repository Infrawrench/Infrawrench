/**
 * Saved migration estimates: storage. Only the inputs are kept (see
 * `db/migration-estimate-schema.ts` for why no figure is).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  MIGRATION_ESTIMATE_LIMITS,
  type MigrationEstimate,
  type MigrationEstimateInput,
  type MigrationEstimateSource,
  type MigrationRowOverride,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { migrationEstimates, services } from "../db/schema";

type Row = typeof migrationEstimates.$inferSelect;

/** Too many estimates for one org (HTTP 400). */
export class MigrationEstimateLimitError extends Error {
  constructor() {
    super(
      `An organization can keep ${MIGRATION_ESTIMATE_LIMITS.maxEstimatesPerOrg} migration ` +
        "estimates. Delete one first.",
    );
  }
}

function sourceOf(raw: unknown): MigrationEstimateSource {
  const value = raw as Partial<MigrationEstimateSource> | null;
  if (value?.kind === "service" && typeof value.serviceId === "string") {
    return { kind: "service", serviceId: value.serviceId };
  }
  const ids = (value as { resourceIds?: unknown } | null)?.resourceIds;
  return {
    kind: "resources",
    resourceIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  };
}

function overridesOf(raw: unknown): Record<string, MigrationRowOverride> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, MigrationRowOverride> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const entry: MigrationRowOverride = {};
    if (typeof v["resourceTypeId"] === "string") entry.resourceTypeId = v["resourceTypeId"];
    if (typeof v["sizeId"] === "string") entry.sizeId = v["sizeId"];
    if (entry.resourceTypeId || entry.sizeId) out[id] = entry;
  }
  return out;
}

function toWire(row: Row, sourceName: string | null): MigrationEstimate {
  return {
    id: row.id,
    name: row.name,
    source: sourceOf(row.source),
    sourceName,
    targetPluginId: row.targetPluginId,
    targetRegion: row.targetRegion,
    overrides: overridesOf(row.overrides),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function serviceNames(organizationId: string, rows: Row[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((r) => {
    const source = sourceOf(r.source);
    return source.kind === "service" ? [source.serviceId] : [];
  });
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.organizationId, organizationId), inArray(services.id, ids)));
  return new Map(found.map((s) => [s.id, s.name]));
}

function nameFor(row: Row, names: Map<string, string>): string | null {
  const source = sourceOf(row.source);
  return source.kind === "service" ? (names.get(source.serviceId) ?? null) : null;
}

/** Stored shape of an input: trimmed, de-duplicated, capped. */
function normalize(input: MigrationEstimateInput) {
  const source: MigrationEstimateSource =
    input.source.kind === "service"
      ? { kind: "service", serviceId: input.source.serviceId }
      : {
          kind: "resources",
          resourceIds: [...new Set(input.source.resourceIds)].slice(
            0,
            MIGRATION_ESTIMATE_LIMITS.maxResources,
          ),
        };
  const overrides = Object.fromEntries(
    Object.entries(overridesOf(input.overrides)).slice(0, MIGRATION_ESTIMATE_LIMITS.maxOverrides),
  );
  return {
    name: input.name.trim().slice(0, MIGRATION_ESTIMATE_LIMITS.maxNameLength),
    source,
    targetPluginId: input.targetPluginId,
    targetRegion: input.targetRegion?.trim() || null,
    overrides,
  };
}

export async function listMigrationEstimates(organizationId: string): Promise<MigrationEstimate[]> {
  const rows = await db
    .select()
    .from(migrationEstimates)
    .where(eq(migrationEstimates.organizationId, organizationId))
    .orderBy(desc(migrationEstimates.updatedAt));
  const names = await serviceNames(organizationId, rows);
  return rows.map((r) => toWire(r, nameFor(r, names)));
}

export async function getMigrationEstimate(
  organizationId: string,
  id: string,
): Promise<MigrationEstimate | null> {
  const [row] = await db
    .select()
    .from(migrationEstimates)
    .where(
      and(eq(migrationEstimates.organizationId, organizationId), eq(migrationEstimates.id, id)),
    )
    .limit(1);
  if (!row) return null;
  return toWire(row, nameFor(row, await serviceNames(organizationId, [row])));
}

export async function createMigrationEstimate(
  organizationId: string,
  input: MigrationEstimateInput,
  createdByUserId: string | null,
): Promise<MigrationEstimate> {
  const existing = await db
    .select({ id: migrationEstimates.id })
    .from(migrationEstimates)
    .where(eq(migrationEstimates.organizationId, organizationId));
  if (existing.length >= MIGRATION_ESTIMATE_LIMITS.maxEstimatesPerOrg) {
    throw new MigrationEstimateLimitError();
  }
  const [row] = await db
    .insert(migrationEstimates)
    .values({ id: randomUUID(), organizationId, ...normalize(input), createdByUserId })
    .returning();
  return toWire(row!, nameFor(row!, await serviceNames(organizationId, [row!])));
}

/** Full replace of the inputs. Null when not found. */
export async function updateMigrationEstimate(
  organizationId: string,
  id: string,
  input: MigrationEstimateInput,
): Promise<MigrationEstimate | null> {
  const [row] = await db
    .update(migrationEstimates)
    .set({ ...normalize(input), updatedAt: new Date() })
    .where(
      and(eq(migrationEstimates.organizationId, organizationId), eq(migrationEstimates.id, id)),
    )
    .returning();
  if (!row) return null;
  return toWire(row, nameFor(row, await serviceNames(organizationId, [row])));
}

export async function deleteMigrationEstimate(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(migrationEstimates)
    .where(
      and(eq(migrationEstimates.organizationId, organizationId), eq(migrationEstimates.id, id)),
    )
    .returning({ id: migrationEstimates.id });
  return deleted.length > 0;
}
