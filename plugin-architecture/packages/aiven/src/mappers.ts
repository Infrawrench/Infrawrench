import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";
import type {
  AvBillingGroup,
  AvComponent,
  AvConnector,
  AvIntegration,
  AvMetric,
  AvPeering,
  AvPool,
  AvProject,
  AvService,
  AvServiceUser,
  AvTopic,
  AvVpc,
} from "./types.js";

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    clean[k] = v;
  }
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "aiven",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: typeof fields["createdAt"] === "string" ? fields["createdAt"] : now,
    updatedAt: now,
  };
}

/** Split `a/b/c` external ids; the last part may itself contain slashes (Kafka topic names cannot). */
export function parts(externalId: string, count: number): string[] {
  const segs = externalId.split("/");
  if (segs.length < count) throw new Error(`Aiven plugin: malformed resource id "${externalId}"`);
  return [...segs.slice(0, count - 1), segs.slice(count - 1).join("/")];
}

const tagString = (tags: Record<string, string> | undefined) =>
  Object.entries(tags ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export function mapProject(accountId: string, p: AvProject): ResourceInstance {
  const name = p.project_name ?? "";
  return instance(accountId, T.project, name, name, {
    name,
    defaultCloud: p.default_cloud,
    billingGroupId: p.billing_group_id,
    billingGroupName: p.billing_group_name,
    organizationId: p.organization_id,
    estimatedBalance: num(p.estimated_balance),
    paymentMethod: p.payment_method,
    techEmails: (p.tech_emails ?? [])
      .map((e) => e.email)
      .filter(Boolean)
      .join(", "),
    tags: tagString(p.tags),
    trialExpires: p.trial_expiration_time,
  });
}

/** The Kafka SASL endpoint, when SASL is enabled on the service. */
export function kafkaSaslComponent(svc: AvService): AvComponent | undefined {
  return (svc.components ?? []).find(
    (c) =>
      c.component === "kafka" &&
      c.kafka_authentication_method === "sasl" &&
      (c.route ?? "dynamic") !== "privatelink",
  );
}

export function serviceVersion(svc: AvService): string | undefined {
  const uc = svc.user_config ?? {};
  for (const key of Object.keys(uc)) {
    if (/_version$/.test(key) && typeof uc[key] === "string") return uc[key] as string;
  }
  const meta = svc.metadata ?? {};
  for (const key of [
    "service_version",
    "pg_version",
    "mysql_version",
    "kafka_version",
    "opensearch_version",
  ]) {
    if (typeof meta[key] === "string") return meta[key] as string;
  }
  return undefined;
}

export function mapService(accountId: string, project: string, svc: AvService): ResourceInstance {
  const name = svc.service_name ?? "";
  const params = svc.service_uri_params ?? {};
  const sasl = svc.service_type === "kafka" ? kafkaSaslComponent(svc) : undefined;
  return instance(
    accountId,
    T.service,
    `${project}/${name}`,
    name,
    {
      name,
      project,
      serviceType: svc.service_type,
      plan: svc.plan,
      cloud: svc.cloud_name,
      cloudDescription: svc.cloud_description,
      state: svc.state,
      version: serviceVersion(svc),
      nodeCount: svc.node_count,
      cpuPerNode: svc.node_cpu_count,
      memoryMbPerNode: svc.node_memory_mb,
      diskSpaceMb: svc.disk_space_mb,
      terminationProtection: svc.termination_protection,
      maintenanceDow: svc.maintenance?.dow,
      maintenanceTime: svc.maintenance?.time,
      pendingMaintenance: svc.maintenance?.updates?.length,
      projectVpcId: svc.project_vpc_id ?? undefined,
      host: params["host"],
      port: num(params["port"]),
      kafkaSasl: sasl?.host ? `${sasl.host}:${sasl.port ?? ""}` : undefined,
      integrations: svc.service_integrations?.length,
      tags: tagString(svc.tags),
      createdAt: svc.create_time,
    },
    { typeId: T.project, externalId: project },
  );
}

/**
 * Admin connection string for a service. Aiven's own `service_uri` is used
 * as-is except for Kafka, whose URI is a bare `host:port` for client
 * certificates; with SASL on, a `kafka://` URL in the Kafka plugin's format
 * (SCRAM-SHA-256, TLS, CA inlined as base64 `ssl_ca`) is built instead.
 */
export function serviceConnectionString(svc: AvService, caPem: string | undefined): string {
  if (svc.service_type === "kafka") {
    const sasl = kafkaSaslComponent(svc);
    if (!sasl?.host) return "";
    const admin = (svc.users ?? []).find((u) => u.type === "primary") ?? svc.users?.[0];
    const q = new URLSearchParams({
      sasl: "scram-sha-256",
      user: admin?.username ?? "avnadmin",
      password: admin?.password ?? "",
      ssl: "true",
    });
    if (caPem) q.set("ssl_ca", utf8ToBase64(caPem));
    return `kafka://${sasl.host}:${sasl.port ?? ""}?${q.toString()}`;
  }
  return svc.service_uri ?? "";
}

export function mapUser(
  accountId: string,
  project: string,
  service: string,
  u: AvServiceUser,
  serviceType?: string,
): ResourceInstance {
  const username = u.username ?? "";
  return instance(
    accountId,
    T.user,
    `${project}/${service}/${username}`,
    username,
    {
      username,
      project,
      serviceName: service,
      serviceType,
      type: u.type,
      authentication: u.authentication,
      certExpires: u.access_cert_not_valid_after_time,
      passwordUpdated: u.password_updated_time,
    },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapDatabase(
  accountId: string,
  project: string,
  service: string,
  db: string,
  serviceType?: string,
): ResourceInstance {
  return instance(
    accountId,
    T.database,
    `${project}/${service}/${db}`,
    db,
    { name: db, project, serviceName: service, serviceType },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapPool(
  accountId: string,
  project: string,
  service: string,
  p: AvPool,
): ResourceInstance {
  const name = p.pool_name ?? "";
  return instance(
    accountId,
    T.pool,
    `${project}/${service}/${name}`,
    name,
    {
      name,
      project,
      serviceName: service,
      database: p.database,
      username: p.username,
      poolMode: p.pool_mode,
      poolSize: p.pool_size,
    },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapTopic(
  accountId: string,
  project: string,
  service: string,
  t: AvTopic,
): ResourceInstance {
  const name = t.topic_name ?? "";
  return instance(
    accountId,
    T.topic,
    `${project}/${service}/${name}`,
    name,
    {
      name,
      project,
      serviceName: service,
      partitions: t.partitions,
      replication: t.replication,
      retentionHours: t.retention_hours,
      minInsyncReplicas: t.min_insync_replicas,
      cleanupPolicy: t.cleanup_policy,
      state: t.state,
      description: t.topic_description,
    },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapAcl(
  accountId: string,
  project: string,
  service: string,
  a: { id?: string; permission?: string; topic?: string; username?: string },
): ResourceInstance {
  const id = a.id ?? "";
  return instance(
    accountId,
    T.acl,
    `${project}/${service}/${id}`,
    `${a.username ?? "*"} → ${a.topic ?? "*"} (${a.permission ?? ""})`,
    {
      username: a.username,
      topic: a.topic,
      permission: a.permission,
      project,
      serviceName: service,
    },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapConnector(
  accountId: string,
  project: string,
  service: string,
  c: AvConnector,
  state?: string,
): ResourceInstance {
  const name = c.name ?? "";
  return instance(
    accountId,
    T.connector,
    `${project}/${service}/${name}`,
    name,
    {
      name,
      project,
      serviceName: service,
      connectorClass: c.config?.["connector.class"] ?? c.plugin?.class,
      pluginTitle: c.plugin?.title,
      direction: c.plugin?.type,
      state,
      tasks: c.tasks?.length,
    },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapSubject(
  accountId: string,
  project: string,
  service: string,
  subject: string,
): ResourceInstance {
  return instance(
    accountId,
    T.subject,
    `${project}/${service}/${subject}`,
    subject,
    { name: subject, project, serviceName: service },
    { typeId: T.service, externalId: `${project}/${service}` },
  );
}

export function mapIntegration(
  accountId: string,
  project: string,
  i: AvIntegration,
): ResourceInstance {
  const id = i.service_integration_id ?? "";
  const source = i.source_service ?? i.source_endpoint;
  const dest = i.dest_service ?? i.dest_endpoint;
  return instance(
    accountId,
    T.integration,
    `${project}/${id}`,
    `${i.integration_type ?? "integration"}: ${source ?? "?"} → ${dest ?? "?"}`,
    {
      integrationType: i.integration_type,
      project,
      source,
      destination: dest,
      enabled: i.enabled,
      active: i.active,
    },
    { typeId: T.project, externalId: project },
  );
}

export function mapVpc(accountId: string, project: string, v: AvVpc): ResourceInstance {
  const id = v.project_vpc_id ?? "";
  return instance(
    accountId,
    T.vpc,
    `${project}/${id}`,
    `${v.cloud_name ?? "vpc"} ${v.network_cidr ?? ""}`.trim(),
    {
      cloud: v.cloud_name,
      project,
      networkCidr: v.network_cidr,
      state: v.state,
      peerings: v.peering_connections?.length,
      createdAt: v.create_time,
    },
    { typeId: T.project, externalId: project },
  );
}

/** Peering ids: `{project}/{vpcId}/{account}/{vpc}[/{region or resource group}]`. */
export function peeringId(project: string, vpcId: string, p: AvPeering): string {
  const extra = p.peer_resource_group
    ? `rg:${p.peer_resource_group}`
    : p.peer_region
      ? `region:${p.peer_region}`
      : "";
  return [
    project,
    vpcId,
    p.peer_cloud_account ?? "",
    p.peer_vpc ?? "",
    ...(extra ? [extra] : []),
  ].join("/");
}

export function mapPeering(
  accountId: string,
  project: string,
  vpcId: string,
  p: AvPeering,
): ResourceInstance {
  return instance(
    accountId,
    T.peering,
    peeringId(project, vpcId, p),
    `${p.peer_cloud_account ?? ""} / ${p.peer_vpc ?? ""}`,
    {
      peerCloudAccount: p.peer_cloud_account,
      peerVpc: p.peer_vpc,
      peerRegion: p.peer_region ?? undefined,
      peerResourceGroup: p.peer_resource_group ?? undefined,
      state: p.state,
      stateMessage: p.state_info?.message,
      cidrs: (p.user_peer_network_cidrs ?? []).join(", "),
      project,
      vpcId,
      createdAt: p.create_time,
    },
    { typeId: T.vpc, externalId: `${project}/${vpcId}` },
  );
}

export function mapBillingGroup(accountId: string, b: AvBillingGroup): ResourceInstance {
  const id = b.billing_group_id ?? "";
  return instance(accountId, T.billingGroup, id, b.billing_group_name ?? id, {
    name: b.billing_group_name,
    currency: b.billing_currency,
    paymentMethod: b.payment_method ?? b.billing_type,
    estimatedBalance: num(b.estimated_balance_usd),
    organization: b.account_name,
    billingEmails: (b.billing_emails ?? [])
      .map((e) => e.email)
      .filter(Boolean)
      .join(", "),
  });
}

function cellValue(cell: unknown): unknown {
  if (cell && typeof cell === "object" && "v" in (cell as Record<string, unknown>)) {
    return (cell as { v?: unknown }).v;
  }
  return cell;
}

/** Google Charts timestamps: ISO strings, epoch numbers or `Date(y,m,d,h,mi,s)` (month 0-based). */
export function parseChartTime(raw: unknown): number {
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw !== "string") return NaN;
  const m = /^Date\((\d+),(\d+),(\d+)(?:,(\d+))?(?:,(\d+))?(?:,(\d+))?\)$/.exec(
    raw.replace(/\s+/g, ""),
  );
  if (m) {
    return Date.UTC(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    );
  }
  return Date.parse(raw);
}

/**
 * Aiven returns metrics as Google Charts DataTables keyed by metric:
 * `{ cpu_usage: { data: { cols: [time, node1, node2…], rows: [...] }, hints: { title } } }`.
 * Each node is a column. Percentages (and load) are averaged across nodes;
 * everything else (network, bytes, counts) is summed.
 */
export function chartsToSeries(metrics: Record<string, AvMetric> | undefined): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const [key, metric] of Object.entries(metrics ?? {})) {
    const cols = metric?.data?.cols ?? [];
    const rows = metric?.data?.rows ?? [];
    if (cols.length < 2 || rows.length === 0) continue;
    const title = metric.hints?.title ?? key.replace(/_/g, " ");
    const average =
      /%|percent|usage|load/i.test(`${key} ${title}`) && !/bytes|net_|disk_?io/i.test(key);
    const points: Array<{ timestamp: number; value: number }> = [];
    for (const row of rows) {
      const cells = Array.isArray(row) ? row : (row?.c ?? []);
      const ts = parseChartTime(cellValue(cells[0]));
      if (!Number.isFinite(ts)) continue;
      const values = cells
        .slice(1)
        .map((c) => Number(cellValue(c)))
        .filter((v) => Number.isFinite(v));
      if (!values.length) continue;
      const total = values.reduce((a, b) => a + b, 0);
      points.push({
        timestamp: ts,
        value: Math.round((average ? total / values.length : total) * 1000) / 1000,
      });
    }
    if (!points.length) continue;
    points.sort((a, b) => a.timestamp - b.timestamp);
    const unit = /%/.test(title) ? "%" : undefined;
    out.push({ label: title, ...(unit ? { unit } : {}), points });
  }
  return out;
}
