import type { ResourceTypeDefinition } from "./resource.js";
import type { DetailViewSchema, KVItem } from "./schema.js";

/**
 * Convert a camelCase or kebab-case key to a human-readable title.
 * Examples: "instanceId" → "Instance ID", "publicIp" → "Public IP",
 * "ec2-instance" → "EC2 Instance"
 */
export function camelToTitle(key: string): string {
  if (key.includes("-")) {
    return key
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\b(id|ip|url|uri|dns|ssl|tls|cpu|ram|vpc|arn|ami)\b/gi, (m) => m.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Build labeled KVItems for a resource's fields using labels from the type definition.
 * Falls back to camelToTitle for keys not found in the definition.
 */
export function labeledFieldItems(
  fields: Record<string, string | number | boolean>,
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
): KVItem[] {
  const typeDef = resourceTypes.find((rt) => rt.id === resourceTypeId);
  const labelMap = new Map(typeDef?.fields.map((f) => [f.key, f.label]) ?? []);
  return Object.entries(fields)
    .filter(([, v]) => v !== "" && v !== undefined)
    .map(([key, value]) => ({
      key: labelMap.get(key) ?? camelToTitle(key),
      value: String(value),
    }));
}

/**
 * Build labeled KVItems for a resource's resolved outputs using labels from the type definition.
 * Falls back to camelToTitle for keys not found in the definition.
 */
export function labeledOutputItems(
  resolvedOutputs: Record<string, string>,
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
): KVItem[] {
  const typeDef = resourceTypes.find((rt) => rt.id === resourceTypeId);
  const labelMap = new Map(typeDef?.outputs.map((o) => [o.key, o.label]) ?? []);
  const hiddenKeys = new Set(
    typeDef?.outputs.filter((o) => o.hidden === true).map((o) => o.key) ?? [],
  );
  return Object.entries(resolvedOutputs)
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, value]) => ({
      key: labelMap.get(key) ?? camelToTitle(key),
      value: String(value),
      copyable: true,
    }));
}

/** The separator a detail subtitle joins its parts with, app-wide. */
const SUBTITLE_SEPARATOR = " · ";

/**
 * Join the parts of a detail subtitle, dropping the ones that are not there.
 *
 * Almost every plugin builds its subtitle as "type name, then where it lives"
 * — and writes it as a template literal with a `?? ""` on the tail. That reads
 * fine until a resource type does not carry the field: a DigitalOcean project
 * has no region, so `${typeName} · ${fields.region ?? ""}` renders as
 * "Project ·", a separator pointing at nothing. The same shape appears for a
 * Postgres role with no database, a Vercel resource with no slug, and a Fly
 * app with no region, so the fix belongs here rather than at each call site.
 *
 * Empty and whitespace-only parts are dropped, as are `null` and `undefined`,
 * which is what lets a caller pass `fields["region"]` straight in. `0` and
 * `false` are kept — they are values a field can legitimately hold, and a
 * subtitle that silently omits "0 replicas" is a different kind of wrong.
 *
 * Returns `""` when nothing survives; `DetailViewSchema.subtitle` is optional
 * and the renderers all guard on truthiness, so an empty string draws no line
 * at all rather than an empty one.
 */
export function joinSubtitle(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  return parts
    .map((part) => (part === null || part === undefined ? "" : String(part).trim()))
    .filter((part) => part !== "")
    .join(SUBTITLE_SEPARATOR);
}

/**
 * True when the host will fetch metric series for this resource type.
 *
 * Mirrors, exactly, the condition the hosts use to decide whether to call
 * `fetchMetricSeries` (`web/src/api/routes/resource-detail.ts`, the desktop
 * loaders, the poller): the type's own `supportsMetrics`, **or** a peer
 * integration that exposes its metrics to the parent. The second half is easy
 * to forget — a managed-Kubernetes type usually has no series of its own and
 * gets all of them from the Kubernetes peer, so it leaves `supportsMetrics`
 * unset and would read as "no metrics" to anything that only checks the flag.
 */
export function resourceTypeHasMetrics(typeDef: ResourceTypeDefinition | undefined): boolean {
  if (!typeDef) return false;
  return (
    typeDef.supportsMetrics === true ||
    (typeDef.peerIntegrations ?? []).some((i) => i.exposeMetricsToParent === true)
  );
}

/**
 * Declare the Metrics tab on a rendered detail view whenever the resource
 * type actually has metrics behind it.
 *
 * The host renders the tab off `DetailViewSchema.metricsCapability` alone, but
 * it *fetches* off the resource type's `supportsMetrics` (and peer metrics)
 * declaration. Those are two separate statements of the same fact, and every
 * time they disagreed the result was the same silent bug: the fetch fires, the
 * series come back, and there is no tab to put them in. Deriving one from the
 * other here is what keeps them from drifting — a plugin calls this once at
 * the end of `renderDetail` and the tab follows the declaration forever after.
 *
 * A renderer that already set `metricsCapability` itself wins: some views want
 * a different default window than the plugin's, and one that deliberately set
 * it should not have it overwritten.
 *
 * `defaultTimeRangeMs` should be the window the plugin's own
 * `fetchMetricSeries` defaults to when the host asks without a range — it is
 * what the chart's time-range label is derived from, so a wrong value is a
 * chart that lies about what it is showing. Omit it when the series are an
 * instantaneous snapshot rather than a window. It is also ignored for a
 * peer-only type (one with no `supportsMetrics` of its own), because there the
 * window belongs to the peer's fetcher and this plugin does not know it.
 */
export function withMetricsCapability(
  schema: DetailViewSchema,
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
  defaultTimeRangeMs?: number,
): DetailViewSchema {
  if (schema.metricsCapability) return schema;
  const typeDef = resourceTypes.find((rt) => rt.id === resourceTypeId);
  if (!resourceTypeHasMetrics(typeDef)) return schema;
  const ownWindow = typeDef?.supportsMetrics === true ? defaultTimeRangeMs : undefined;
  return {
    ...schema,
    metricsCapability: ownWindow === undefined ? {} : { defaultTimeRangeMs: ownWindow },
  };
}

/**
 * Look up a resource type's displayName by its ID.
 * Falls back to camelToTitle of the ID if not found.
 */
export function resourceTypeDisplayName(
  resourceTypes: ResourceTypeDefinition[],
  resourceTypeId: string,
): string {
  return (
    resourceTypes.find((rt) => rt.id === resourceTypeId)?.displayName ??
    camelToTitle(resourceTypeId)
  );
}
