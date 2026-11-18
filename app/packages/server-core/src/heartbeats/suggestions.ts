/**
 * Scheduled resources a heartbeat can watch, mined from synced resources.
 *
 * Which fields hold a schedule is plugin knowledge, declared on the field
 * (`schedule: "cron"`, plus `schedule: "timezone"` on the zone's field when
 * the provider keeps one), so this module knows no provider: it asks the
 * loaded resource types which (plugin, type) pairs flag a schedule, reads only
 * those resources, and normalises each value with client-core's
 * `normalizeProviderSchedule`. A cheap Postgres read over stored fields (the
 * probe suggestions stance): no plugin clients, no credentials, no provider
 * calls. It runs on the edge, where `loadPlugins` is the metadata registry.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { normalizeProviderSchedule, type HeartbeatSuggestion } from "@infrawrench/client-core";
import { db } from "../db/client";
import { heartbeats, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";

const MAX_SUGGESTIONS = 300;

interface ScheduleKeys {
  /** Fields and outputs flagged `schedule: "cron"`, in declaration order. */
  cron: { key: string; from: "fields" | "outputs" }[];
  timezone: { key: string; from: "fields" | "outputs" } | null;
}

/** `${pluginId}/${resourceTypeId}` → its flagged keys, for every type that flags one. */
export async function scheduledResourceTypes(): Promise<Map<string, ScheduleKeys>> {
  const out = new Map<string, ScheduleKeys>();
  for (const { plugin } of await loadPlugins()) {
    for (const type of plugin.resourceTypes) {
      const keys: ScheduleKeys = { cron: [], timezone: null };
      for (const field of type.fields ?? []) {
        if (field.schedule === "cron") keys.cron.push({ key: field.key, from: "fields" });
        if (field.schedule === "timezone") keys.timezone ??= { key: field.key, from: "fields" };
      }
      for (const output of type.outputs ?? []) {
        if (output.schedule === "cron") keys.cron.push({ key: output.key, from: "outputs" });
        if (output.schedule === "timezone") keys.timezone ??= { key: output.key, from: "outputs" };
      }
      if (keys.cron.length > 0) out.set(`${plugin.manifest.id}/${type.id}`, keys);
    }
  }
  return out;
}

/** Whether a resource type flags a schedule: the gate on "Watch with a heartbeat". */
export async function isScheduledResourceType(
  pluginId: string,
  resourceTypeId: string,
): Promise<boolean> {
  return (await scheduledResourceTypes()).has(`${pluginId}/${resourceTypeId}`);
}

/**
 * Every scheduled resource in the org (or just `resourceId`), with its
 * schedule read and the heartbeats already watching it.
 */
export async function listHeartbeatSuggestions(
  organizationId: string,
  options: { resourceId?: string } = {},
): Promise<HeartbeatSuggestion[]> {
  const types = await scheduledResourceTypes();
  if (types.size === 0) return [];
  const pairs = [...types.keys()].map((k) => {
    const [pluginId = "", ...rest] = k.split("/");
    return { pluginId, resourceTypeId: rest.join("/") };
  });
  const byPlugin = new Map<string, string[]>();
  for (const { pluginId, resourceTypeId } of pairs) {
    byPlugin.set(pluginId, [...(byPlugin.get(pluginId) ?? []), resourceTypeId]);
  }
  const typeFilter = or(
    ...[...byPlugin].map(([pluginId, typeIds]) =>
      and(eq(resources.pluginId, pluginId), inArray(resources.resourceTypeId, typeIds)),
    ),
  );

  const [rows, watching] = await Promise.all([
    db
      .select({
        id: resources.id,
        displayName: resources.displayName,
        accountId: resources.accountId,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        fieldsJson: resources.fieldsJson,
        outputsJson: resources.outputsJson,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          typeFilter,
          ...(options.resourceId ? [eq(resources.id, options.resourceId)] : []),
        ),
      )
      .limit(MAX_SUGGESTIONS * 2),
    db
      .select({ id: heartbeats.id, resourceId: heartbeats.resourceId })
      .from(heartbeats)
      .where(eq(heartbeats.organizationId, organizationId)),
  ]);

  const watchedBy = new Map<string, string[]>();
  for (const h of watching) {
    if (!h.resourceId) continue;
    watchedBy.set(h.resourceId, [...(watchedBy.get(h.resourceId) ?? []), h.id]);
  }

  const suggestions: HeartbeatSuggestion[] = [];
  for (const row of rows) {
    const keys = types.get(`${row.pluginId}/${row.resourceTypeId}`);
    if (!keys) continue;
    const read = (k: { key: string; from: "fields" | "outputs" }) =>
      (k.from === "fields" ? row.fieldsJson : row.outputsJson)?.[k.key];
    const zone = keys.timezone ? read(keys.timezone) : undefined;
    for (const k of keys.cron) {
      const value = read(k);
      if (typeof value !== "string" || !value.trim()) continue;
      suggestions.push({
        resourceId: row.id,
        displayName: row.displayName,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: row.accountId,
        fieldKey: k.key,
        rawSchedule: value.trim(),
        schedule: normalizeProviderSchedule(value, zone),
        watchedBy: watchedBy.get(row.id) ?? [],
      });
      // One schedule per resource: the first flagged field with a value.
      break;
    }
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return suggestions;
}
