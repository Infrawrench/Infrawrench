/** API responses → `ResourceInstance`s. */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  EcBudget,
  EcCostsOverview,
  EcDeployment,
  EcExtension,
  EcOrganization,
  EcProject,
  EcServerlessTrafficFilter,
  EcTopologyElement,
  EcTrafficRuleset,
} from "./types.js";

export const PLUGIN_ID = "elastic-cloud";
export const CONSOLE_URL = "https://cloud.elastic.co";

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

const join = (list: Array<string | number | undefined> | null | undefined): string =>
  (list ?? []).filter((v) => v !== undefined && v !== "").join(", ");

const round2 = (n: number) => Math.round(n * 100) / 100;

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "team:search, env:prod" → [{key, value}]; a bare word becomes a key with an empty value. */
export function parseTags(value: string | undefined): Array<{ key: string; value: string }> {
  return splitList(value).map((pair) => {
    const i = pair.indexOf(":");
    return i < 0
      ? { key: pair, value: "" }
      : { key: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
  });
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export function mapOrganization(
  accountId: string,
  org: EcOrganization,
  overview?: EcCostsOverview,
): ResourceInstance {
  const id = org.id ?? "";
  const remaining = overview?.balance?.remaining;
  return instance(
    accountId,
    "organization",
    id,
    org.name ?? id,
    {
      name: org.name ?? id,
      organizationId: id,
      monthToDate:
        typeof overview?.costs?.total === "number" ? round2(overview.costs.total) : undefined,
      hourlyRate: typeof overview?.hourly_rate === "number" ? overview.hourly_rate : undefined,
      prepaidRemaining: typeof remaining === "number" ? remaining : undefined,
      billingContacts: join(org.billing_contacts),
    },
    { organizationId: id },
  );
}

// ---------------------------------------------------------------------------
// Hosted deployments
// ---------------------------------------------------------------------------

/** The topology element that holds the hot tier (`hot_content`, or `data_hot` roles). */
export function hotTier(topology: EcTopologyElement[] | undefined): EcTopologyElement | undefined {
  const list = topology ?? [];
  return (
    list.find((t) => t.id === "hot_content") ??
    list.find((t) => (t.node_roles ?? []).includes("data_hot")) ??
    list.find((t) => (t.size?.value ?? 0) > 0)
  );
}

export function deploymentStatus(d: EcDeployment): string {
  const es = d.resources?.elasticsearch?.[0]?.info;
  if (es?.plan_info?.pending) return "reconfiguring";
  return es?.status ?? (d.healthy === false ? "unhealthy" : "");
}

export function mapDeployment(accountId: string, d: EcDeployment): ResourceInstance {
  const id = d.id ?? "";
  const es = d.resources?.elasticsearch?.[0];
  const kb = d.resources?.kibana?.[0];
  const plan = es?.info?.plan_info?.current?.plan;
  const topology = plan?.cluster_topology ?? [];
  const hot = hotTier(topology);
  const totalMb = topology.reduce(
    (sum, t) =>
      sum + (t.size?.resource === "memory" ? (t.size.value ?? 0) * (t.zone_count ?? 1) : 0),
    0,
  );
  const meta = es?.info?.metadata;
  const esEndpoint = meta?.aliased_url ?? meta?.service_url;
  const kibanaUrl = kb?.info?.metadata?.aliased_url ?? kb?.info?.metadata?.service_url;
  const tags = (d.metadata?.tags ?? [])
    .filter((t) => t.key)
    .map((t) => (t.value ? `${t.key}:${t.value}` : String(t.key)));
  return instance(
    accountId,
    "deployment",
    id,
    d.name ?? id,
    {
      name: d.name ?? "",
      tags: tags.join(", "),
      hotSizeGb:
        hot?.size?.resource === "memory" && hot.size.value
          ? round2(hot.size.value / 1024)
          : undefined,
      hotZones: hot?.zone_count !== undefined ? String(hot.zone_count) : undefined,
      version: plan?.elasticsearch?.version,
      region: es?.region ?? es?.info?.region,
      status: deploymentStatus(d),
      healthy: d.healthy,
      alias: d.alias,
      template: plan?.deployment_template?.id,
      totalMemoryGb: totalMb > 0 ? round2(totalMb / 1024) : undefined,
      autoscaling: d.settings?.autoscaling_enabled ?? plan?.autoscaling_enabled,
      solution: d.settings?.solution_type,
      trafficFilterIds: join(d.settings?.traffic_filter_settings?.rulesets),
      esEndpoint,
      kibanaUrl,
      deploymentId: id,
      // Kept for actions and the detail view.
      esRefId: es?.ref_id,
      kibanaRefId: kb?.ref_id,
      cloudId: meta?.cloud_id,
      topologyJson: topology.length
        ? JSON.stringify(
            topology
              .filter((t) => (t.size?.value ?? 0) > 0)
              .map((t) => ({
                id: t.id,
                size: t.size?.value,
                resource: t.size?.resource,
                zones: t.zone_count,
                instanceConfiguration: t.instance_configuration_id,
                autoscalingMax: t.autoscaling_max?.value,
              })),
          )
        : undefined,
      instancesJson: es?.info?.topology?.instances?.length
        ? JSON.stringify(
            es.info.topology.instances.map((i) => ({
              name: i.instance_name,
              zone: i.zone,
              healthy: i.healthy,
              capacityMb: i.memory?.instance_capacity,
              memoryPressure: i.memory?.memory_pressure,
              diskUsedMb: i.disk?.disk_space_used,
              diskAvailableMb: i.disk?.disk_space_available,
            })),
          )
        : undefined,
    },
    {
      esEndpoint,
      kibanaUrl,
      cloudId: meta?.cloud_id,
      deploymentId: id,
    },
  );
}

// ---------------------------------------------------------------------------
// Serverless projects
// ---------------------------------------------------------------------------

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  elasticsearch: "Elasticsearch",
  observability: "Observability",
  security: "Security",
  vectordb: "Vector Database",
};

/** External id of a project: `{type}/{id}`, because every project route is typed. */
export function projectExternalId(type: string, id: string): string {
  return `${type}/${id}`;
}

export function parseProjectExternalId(externalId: string): { type: string; id: string } {
  const i = externalId.indexOf("/");
  return i < 0
    ? { type: "elasticsearch", id: externalId }
    : { type: externalId.slice(0, i), id: externalId.slice(i + 1) };
}

export function mapProject(
  accountId: string,
  type: string,
  p: EcProject,
  phase?: string,
): ResourceInstance {
  const id = p.id ?? "";
  const tier =
    p.product_tier ??
    join(
      (p.product_types ?? []).map((t) =>
        [t.product_line, t.product_tier].filter(Boolean).join(" "),
      ),
    );
  const tags = Object.entries(p.metadata?.tags ?? {}).map(([k, v]) => (v ? `${k}:${v}` : k));
  const esEndpoint = p.endpoints?.["elasticsearch"];
  const kibanaUrl = p.endpoints?.["kibana"];
  return instance(
    accountId,
    "project",
    projectExternalId(type, id),
    p.name ?? id,
    {
      name: p.name ?? "",
      searchPower: p.search_lake?.search_power,
      tags: tags.join(", "),
      projectType: PROJECT_TYPE_LABELS[type] ?? type,
      region: p.region_id,
      phase: phase ?? (p.metadata?.suspended_at ? "suspended" : undefined),
      alias: p.alias,
      optimizedFor: p.optimized_for,
      productTier: tier,
      esEndpoint,
      kibanaUrl,
      trafficFilterIds: join((p.traffic_filters ?? []).map((t) => t.id)),
      suspendedReason: p.metadata?.suspended_reason,
      createdAt: p.metadata?.created_at,
      projectId: id,
      typeId: type,
      cloudId: p.cloud_id,
      boostWindow: p.search_lake?.boost_window,
      apmEndpoint: p.endpoints?.["apm"],
      ingestEndpoint: p.endpoints?.["ingest"],
      organizationId: p.metadata?.organization_id,
    },
    {
      esEndpoint,
      kibanaUrl,
      cloudId: p.cloud_id,
      username: "admin",
      projectId: id,
    },
  );
}

// ---------------------------------------------------------------------------
// Traffic filters
// ---------------------------------------------------------------------------

/** One display string per rule: the source, endpoint or egress target it allows. */
export function ruleSources(rules: EcTrafficRuleset["rules"]): string[] {
  return (rules ?? [])
    .map(
      (r) =>
        r.source ??
        r.azure_endpoint_name ??
        r.remote_cluster_id ??
        (r.egress_rule?.target ? `egress ${r.egress_rule.target}` : undefined),
    )
    .filter((s): s is string => Boolean(s));
}

export function mapTrafficFilter(accountId: string, r: EcTrafficRuleset): ResourceInstance {
  const id = r.id ?? "";
  const deployments = (r.associations ?? [])
    .filter((a) => a.entity_type === "deployment" && a.id)
    .map((a) => a.id as string);
  return instance(
    accountId,
    "traffic-filter",
    id,
    r.name ?? id,
    {
      name: r.name ?? "",
      description: r.description,
      sources: ruleSources(r.rules).join(", "),
      includeByDefault: r.include_by_default ?? false,
      filterType: r.type,
      region: r.region,
      deploymentIds: deployments.join(", "),
      associationCount:
        r.total_associations ?? (r.associations ? r.associations.length : undefined),
      rulesJson: JSON.stringify(r.rules ?? []),
    },
    { rulesetId: id },
  );
}

export function mapServerlessTrafficFilter(
  accountId: string,
  t: EcServerlessTrafficFilter,
): ResourceInstance {
  const id = t.id ?? "";
  return instance(
    accountId,
    "serverless-traffic-filter",
    id,
    t.name ?? id,
    {
      name: t.name ?? "",
      description: t.description,
      sources: ruleSources(t.rules).join(", "),
      includeByDefault: t.include_by_default ?? false,
      filterType: t.type,
      region: t.region,
      rulesJson: JSON.stringify(t.rules ?? []),
    },
    { filterId: id },
  );
}

// ---------------------------------------------------------------------------
// Extensions and budgets
// ---------------------------------------------------------------------------

export function mapExtension(accountId: string, e: EcExtension): ResourceInstance {
  const id = e.id ?? "";
  return instance(
    accountId,
    "extension",
    id,
    e.name ?? id,
    {
      name: e.name ?? "",
      description: e.description,
      version: e.version,
      downloadUrl: e.download_url,
      extensionType: e.extension_type,
      sizeBytes: e.file_metadata?.size,
      lastModified: e.file_metadata?.last_modified_date,
      deploymentIds: join(e.deployments),
    },
    { extensionId: id, url: e.url },
  );
}

/** External id of a budget: `{organizationId}/{budgetId}`. */
export function parseBudgetExternalId(externalId: string): { orgId: string; budgetId: string } {
  const i = externalId.lastIndexOf("/");
  return { orgId: externalId.slice(0, i), budgetId: externalId.slice(i + 1) };
}

export function mapBudget(
  accountId: string,
  orgId: string,
  b: EcBudget,
  instanceNames: Map<string, string> = new Map(),
): ResourceInstance {
  const id = String(b.id ?? "");
  const thresholds = (b.alerts ?? [])
    .filter((a) => a.threshold_type === "percentage" && typeof a.threshold === "number")
    .map((a) => a.threshold as number)
    .sort((x, y) => x - y);
  const lastExceeded = (b.alerts ?? [])
    .map((a) => a.last_exceeded_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();
  const scopeIds = b.scope_values ?? [];
  const label =
    b.name ||
    (b.scope_type === "cloud_resource"
      ? `Budget for ${scopeIds.map((s) => instanceNames.get(s) ?? s).join(", ")}`
      : "Organization budget");
  return instance(
    accountId,
    "budget",
    `${orgId}/${id}`,
    label,
    {
      name: b.name,
      amount: b.amount,
      alertThresholds: thresholds.join(", "),
      active: b.active,
      scope: b.scope_type === "cloud_resource" ? "Deployments and projects" : "Organization",
      scopeIds: b.scope_type === "cloud_resource" ? scopeIds.join(", ") : undefined,
      recipients: join(b.recipient_group),
      lastExceededAt: lastExceeded,
      organizationId: orgId,
      createdAt: b.created_at,
      period: b.period,
      alertsJson: JSON.stringify(b.alerts ?? []),
      scopeType: b.scope_type,
      scopeValuesJson: JSON.stringify(scopeIds),
      recipientsJson: JSON.stringify(b.recipient_group ?? []),
    },
    { budgetId: id },
  );
}
