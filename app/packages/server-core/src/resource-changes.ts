import { randomUUID } from "node:crypto";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { db } from "./db/client";
import { resourceChanges } from "./db/schema";

/**
 * Diffing for the change timeline / drift feed.
 *
 * The functions here are deliberately generic: they compare the host's stored
 * resource record (displayName + fieldsJson + outputsJson) against the freshly
 * fetched snapshot. No provider-specific knowledge belongs here — a plugin
 * that wants richer field shapes changes what it returns from `listResources`,
 * and the diff follows automatically.
 */

export interface ResourceFieldChange {
  /** Top-level field key. Output keys are prefixed `outputs.`. */
  field: string;
  from: unknown;
  to: unknown;
}

/** The columns of a prior `resources` row the differ needs. */
export interface PriorResourceSnapshot {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  deletedAt: Date | null;
}

export interface ResourceChangeEvent {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  changeKind: "created" | "updated" | "deleted";
  diff: ResourceFieldChange[];
}

/**
 * JSON.stringify with recursively sorted object keys, so two structurally
 * equal objects serialize identically regardless of key insertion order
 * (jsonb round-trips through Postgres don't preserve it).
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>).sort();
      for (const k of keys) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

/**
 * Diff a prior stored record against a freshly fetched snapshot, using the
 * same merge semantics as the sync upsert: keys the lister stopped returning
 * survive in the DB (user-supplied values), so they must not read as removed
 * here — the effective "after" is `{ ...prior, ...fetched }`.
 */
export function diffResourceRecords(
  prior: PriorResourceSnapshot,
  next: ResourceInstance,
): ResourceFieldChange[] {
  const changes: ResourceFieldChange[] = [];

  if (prior.displayName !== next.displayName) {
    changes.push({ field: "displayName", from: prior.displayName, to: next.displayName });
  }

  const diffBags = (
    before: Record<string, unknown>,
    incoming: Record<string, unknown>,
    prefix: string,
  ) => {
    // Merge like the upsert does — incoming keys win, missing keys survive —
    // then compare per key. Only keys present in `incoming` can change.
    for (const key of Object.keys(incoming)) {
      const beforeValue = before[key];
      const afterValue = incoming[key];
      if (!valuesEqual(beforeValue, afterValue)) {
        changes.push({ field: `${prefix}${key}`, from: beforeValue ?? null, to: afterValue });
      }
    }
  };

  diffBags(prior.fieldsJson ?? {}, next.fields ?? {}, "");
  diffBags(prior.outputsJson ?? {}, next.resolvedOutputs ?? {}, "outputs.");

  return changes;
}

export interface ComputeChangeEventsArgs {
  /** Stored rows for the account (or the type being synced), loaded before the upserts ran. */
  prior: PriorResourceSnapshot[];
  /** The freshly fetched resources that are about to be (or were just) upserted. */
  fetched: ResourceInstance[];
  /**
   * Resource type ids whose list call succeeded this cycle. Only these may
   * produce "deleted" events — a failed type's absence is a transient error,
   * not a disappearance (mirrors the soft-delete rule in sync-resources).
   */
  deletableTypeIds: string[];
}

/** Pure event computation — no I/O, unit-testable. */
export function computeResourceChangeEvents({
  prior,
  fetched,
  deletableTypeIds,
}: ComputeChangeEventsArgs): ResourceChangeEvent[] {
  const priorById = new Map<string, PriorResourceSnapshot>();
  for (const row of prior) priorById.set(row.id, row);

  const deletableTypes = new Set(deletableTypeIds);
  const liveIds = new Set<string>();
  const events: ResourceChangeEvent[] = [];

  for (const r of fetched) {
    liveIds.add(r.id);
    const before = priorById.get(r.id);
    if (!before || before.deletedAt !== null) {
      // Brand new, or reappeared after being soft-deleted.
      events.push({
        resourceId: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        displayName: r.displayName,
        changeKind: "created",
        diff: [],
      });
      continue;
    }
    const diff = diffResourceRecords(before, r);
    if (diff.length > 0) {
      events.push({
        resourceId: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        displayName: r.displayName,
        changeKind: "updated",
        diff,
      });
    }
  }

  for (const row of prior) {
    if (row.deletedAt !== null) continue;
    if (!deletableTypes.has(row.resourceTypeId)) continue;
    if (liveIds.has(row.id)) continue;
    events.push({
      resourceId: row.id,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      displayName: row.displayName,
      changeKind: "deleted",
      diff: [],
    });
  }

  return events;
}

const INSERT_CHUNK_SIZE = 200;

/** Persist computed events. Callers wrap this so a write failure never breaks a poll cycle. */
export async function recordResourceChanges(
  organizationId: string,
  accountId: string,
  events: ResourceChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const now = new Date();
  for (let i = 0; i < events.length; i += INSERT_CHUNK_SIZE) {
    const chunk = events.slice(i, i + INSERT_CHUNK_SIZE);
    await db.insert(resourceChanges).values(
      chunk.map((e) => ({
        id: randomUUID(),
        organizationId,
        accountId,
        resourceId: e.resourceId,
        pluginId: e.pluginId,
        resourceTypeId: e.resourceTypeId,
        displayName: e.displayName,
        changeKind: e.changeKind,
        diff: e.diff,
        createdAt: now,
      })),
    );
  }
}
