/**
 * Record capacity runway readings from a sync.
 *
 * The sync already holds every value a declaration names: the lister's
 * `fields` and `resolvedOutputs` for the rows it just upserted. This copies
 * the declared usages and their limits into `resource_capacity_snapshots`,
 * one row per resource, usage and hour, so the runway's history costs no
 * provider call and no pass of its own.
 *
 * Metric usages (`capacityMetrics`) are not recorded here: their series is
 * already stored by the metrics writer, and the feed reads it from there.
 *
 * Never throws: a failed write loses an hour's reading, which the next sync
 * replaces, and must never fail the sync that carried it.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  capacityDeclarations,
  readCapacityNumber,
  resolveCapacityLimit,
  type CapacityDeclarationEntry,
  type HostPlugin,
  type ResourceInstance,
} from "@infrawrench/plugin-base";

import { chunksOf } from "../db/chunks";
import { db } from "../db/client";
import { resourceCapacitySnapshots } from "../db/schema";

const HOUR_MS = 60 * 60 * 1000;
const ROWS_PER_STATEMENT = 500;

/** A stored resource's values: its fields over its non-sensitive outputs. */
export function capacityValues(
  fields: Readonly<Record<string, unknown>> | undefined,
  outputs: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return { ...(outputs ?? {}), ...(fields ?? {}) };
}

/** Declared field and output usages per resource type of one plugin. */
export function storedDeclarationsByType(
  plugin: Pick<HostPlugin, "resourceTypes">,
): Map<string, CapacityDeclarationEntry[]> {
  const out = new Map<string, CapacityDeclarationEntry[]>();
  for (const type of plugin.resourceTypes) {
    const entries = capacityDeclarations(type).filter((d) => d.source !== "metric");
    if (entries.length > 0) out.set(type.id, entries);
  }
  return out;
}

export interface CapacityReading {
  resourceId: string;
  capacityKey: string;
  used: number;
  limit: number;
}

/**
 * The readings a set of synced resources carries. Pure, so the sync's write
 * and its test share one definition of "this resource has a usage".
 */
export function capacityReadings(
  plugin: Pick<HostPlugin, "resourceTypes">,
  rows: ReadonlyArray<
    Pick<ResourceInstance, "id" | "resourceTypeId" | "fields" | "resolvedOutputs">
  >,
): CapacityReading[] {
  const byType = storedDeclarationsByType(plugin);
  if (byType.size === 0) return [];
  const out: CapacityReading[] = [];
  for (const row of rows) {
    const entries = byType.get(row.resourceTypeId);
    if (!entries) continue;
    const values = capacityValues(row.fields, row.resolvedOutputs);
    for (const entry of entries) {
      const used = readCapacityNumber(values[entry.valueKey]);
      if (used === null) continue;
      const limit = resolveCapacityLimit(entry.declaration.limit, values);
      if (!limit) continue;
      out.push({
        resourceId: row.id,
        capacityKey: entry.key,
        used: Math.max(0, used),
        limit: limit.limit,
      });
    }
  }
  return out;
}

/**
 * Upsert this hour's reading for every declared usage the synced rows carry.
 * A later sync in the same hour overwrites the bucket, so the hour keeps its
 * latest value.
 */
export async function recordCapacitySnapshots(
  organizationId: string,
  accountId: string,
  plugin: Pick<HostPlugin, "resourceTypes" | "manifest">,
  rows: ReadonlyArray<
    Pick<ResourceInstance, "id" | "resourceTypeId" | "fields" | "resolvedOutputs">
  >,
  observedAt: Date = new Date(),
): Promise<void> {
  try {
    const readings = capacityReadings(plugin, rows);
    if (readings.length === 0) return;
    const bucket = new Date(Math.floor(observedAt.getTime() / HOUR_MS) * HOUR_MS);
    // A list can repeat a row; one statement cannot touch the same key twice.
    const unique = [
      ...new Map(readings.map((r) => [`${r.resourceId}\u0000${r.capacityKey}`, r])).values(),
    ];
    for (const batch of chunksOf(unique, ROWS_PER_STATEMENT)) {
      await db
        .insert(resourceCapacitySnapshots)
        .values(
          batch.map((r) => ({
            id: randomUUID(),
            organizationId,
            accountId,
            resourceId: r.resourceId,
            capacityKey: r.capacityKey,
            used: r.used,
            capacityLimit: r.limit,
            observedAt,
            bucket,
          })),
        )
        .onConflictDoUpdate({
          target: [
            resourceCapacitySnapshots.resourceId,
            resourceCapacitySnapshots.capacityKey,
            resourceCapacitySnapshots.bucket,
          ],
          set: {
            used: sql`excluded.used`,
            capacityLimit: sql`excluded.capacity_limit`,
            observedAt: sql`excluded.observed_at`,
          },
        });
    }
  } catch (err) {
    console.error(
      `[capacity] recording readings for ${plugin.manifest.id} account ${accountId} failed:`,
      err,
    );
  }
}
