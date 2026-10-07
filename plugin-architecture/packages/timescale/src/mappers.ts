import type { ResourceInstance } from "@infrawrench/plugin-base";
import { sizeId } from "./catalog.js";
import { T } from "./resource-types.js";
import type {
  TgAllowList,
  TgBackup,
  TgExporter,
  TgPeering,
  TgProject,
  TgReadReplicaSet,
  TgService,
  TgVpc,
} from "./types.js";

type Fields = Record<string, string | number | boolean>;

/** Drop undefined/null/empty values so absent data renders as absent. */
export function compact(fields: Record<string, string | number | boolean | null | undefined>) {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "timescale",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Split a composite external id (`project/service/...`) into its parts. */
export function splitExternalId(externalId: string, parts: number): string[] {
  const out = externalId.split("/");
  if (out.length !== parts || out.some((p) => !p)) {
    throw new Error(`Tiger Cloud plugin: malformed id "${externalId}"`);
  }
  return out;
}

export function mapProject(
  accountId: string,
  p: TgProject,
  serviceCount?: number,
  planType?: string,
): ResourceInstance {
  return instance(
    accountId,
    T.project,
    p.id,
    p.name ?? p.id,
    compact({ name: p.name ?? p.id, projectId: p.id, services: serviceCount, planType }),
  );
}

/** The primary node's spec: the first resource carrying one. */
export function serviceSpec(s: TgService) {
  return s.resources?.find((r) => r.spec)?.spec ?? {};
}

export function mapService(
  accountId: string,
  s: TgService,
  extra: { backupRetentionDays?: number | undefined } = {},
): ResourceInstance {
  const spec = serviceSpec(s);
  const ha = s.ha_replicas?.replica_count ?? 0;
  const sync = s.ha_replicas?.sync_replica_count ?? 0;
  const vpc = s.vpc_endpoint ?? s.vpcEndpoint;
  const pooler = s.connection_pooler?.endpoint;
  const forkedFrom =
    s.forked_from?.service_id && s.forked_from.project_id === s.project_id
      ? s.forked_from.service_id
      : undefined;
  return instance(
    accountId,
    T.service,
    `${s.project_id}/${s.service_id}`,
    s.name ?? s.service_id,
    compact({
      name: s.name ?? s.service_id,
      serviceId: s.service_id,
      projectId: s.project_id,
      region: s.region_code,
      serviceType: s.service_type,
      status: s.status,
      computeSize: sizeId(spec.cpu_millis, spec.memory_gbs),
      cpuMillis: spec.cpu_millis,
      vcpus: spec.cpu_millis !== undefined ? spec.cpu_millis / 1000 : undefined,
      memoryGb: spec.memory_gbs,
      environment: s.metadata?.environment,
      haReplicas: String(ha),
      syncReplicas: String(sync),
      nodeCount: 1 + ha,
      poolerEnabled: !!pooler?.host,
      dataTiering: s.data_tiering?.enabled ?? false,
      backupRetentionDays: extra.backupRetentionDays,
      host: s.endpoint?.host,
      port: s.endpoint?.port,
      poolerHost: pooler?.host,
      poolerPort: pooler?.port,
      vpcId: vpc?.vpc_id,
      vpcHost: vpc?.host,
      forkedFrom,
      metricExporterId: s.metric_exporter_id,
      logExporterId: s.log_exporter_id,
      memoryUsedMb: s.metrics?.memory_mb ?? undefined,
      storageUsedMb: s.metrics?.storage_mb ?? undefined,
      cpuUsedMillis: s.metrics?.milli_cpu ?? undefined,
      readReplicaSets: s.read_replica_sets?.length ?? 0,
      // Tiger Cloud backs up every service on a schedule; there is no way to
      // turn it off, which is what the backup-coverage view needs to know.
      automatedBackups: true,
      createdAt: s.created,
    }),
    { typeId: T.project, externalId: s.project_id },
  );
}

export function mapReplica(accountId: string, s: TgService, r: TgReadReplicaSet): ResourceInstance {
  return instance(
    accountId,
    T.replica,
    `${s.project_id}/${s.service_id}/${r.id}`,
    r.name ?? r.id,
    compact({
      name: r.name ?? r.id,
      serviceId: s.service_id,
      projectId: s.project_id,
      region: s.region_code,
      status: r.status,
      nodes: r.nodes,
      computeSize: sizeId(r.cpu_millis, r.memory_gbs),
      vcpus: r.cpu_millis !== undefined ? r.cpu_millis / 1000 : undefined,
      environment: r.metadata?.environment,
      poolerEnabled: !!r.connection_pooler?.endpoint?.host,
      host: r.endpoint?.host,
      port: r.endpoint?.port,
      poolerHost: r.connection_pooler?.endpoint?.host,
    }),
    { typeId: T.service, externalId: `${s.project_id}/${s.service_id}` },
  );
}

export function mapVpc(accountId: string, projectId: string, v: TgVpc): ResourceInstance {
  return instance(
    accountId,
    T.vpc,
    `${projectId}/${v.id}`,
    v.name ?? v.id,
    compact({
      name: v.name ?? v.id,
      vpcId: v.id,
      projectId,
      cidr: v.cidr,
      region: v.region_code,
    }),
    { typeId: T.project, externalId: projectId },
  );
}

export function mapPeering(
  accountId: string,
  projectId: string,
  vpcId: string,
  p: TgPeering,
): ResourceInstance {
  return instance(
    accountId,
    T.peering,
    `${projectId}/${vpcId}/${p.id}`,
    p.peer_vpc_id ? `${p.peer_vpc_id} (${p.peer_account_id ?? "?"})` : p.id,
    compact({
      peerAccountId: p.peer_account_id,
      peerVpcId: p.peer_vpc_id,
      peerRegion: p.peer_region_code,
      vpcId,
      projectId,
      provisionedId: p.provisioned_id,
      status: p.status,
      errorMessage: p.error_message,
    }),
    { typeId: T.vpc, externalId: `${projectId}/${vpcId}` },
  );
}

export function mapExporter(
  accountId: string,
  projectId: string,
  e: TgExporter,
  attached: string[],
): ResourceInstance {
  const c = e.config ?? {};
  const creds = c.credentials;
  return instance(
    accountId,
    T.exporter,
    `${projectId}/${e.exporter_id}`,
    e.name ?? e.exporter_id,
    compact({
      name: e.name ?? e.exporter_id,
      exporterType: e.type,
      region: e.region_code,
      projectId,
      includePgMetrics: c.include_pg_metrics,
      datadogSite: c.site,
      logGroup: c.log_group_name,
      logStream: c.log_stream_name,
      awsRegion: c.aws_region,
      namespace: c.namespace,
      awsAuth: creds?.type
        ? creds.type === "IAM_ROLE"
          ? `IAM role ${creds.aws_role_arn ?? ""}`.trim()
          : `Access key ${creds.aws_access_key ?? ""}`.trim()
        : undefined,
      prometheusUser: c.username,
      prometheusEndpoint: c.endpoint,
      attachedServices: attached.join(", "),
      createdAt: e.created,
    }),
    { typeId: T.project, externalId: projectId },
  );
}

export function mapAllowList(
  accountId: string,
  projectId: string,
  a: TgAllowList,
): ResourceInstance {
  return instance(
    accountId,
    T.allowList,
    `${projectId}/${a.allow_list_id}`,
    a.description || a.allow_list_id,
    compact({
      description: a.description,
      cidrBlocks: (a.cidr_blocks ?? []).join(", "),
      projectId,
      createdAt: a.created_at,
    }),
    { typeId: T.project, externalId: projectId },
  );
}

export function mapBackup(accountId: string, s: TgService, b: TgBackup): ResourceInstance {
  const svc = `${s.project_id}/${s.service_id}`;
  return instance(
    accountId,
    T.backup,
    `${svc}/${b.label}`,
    `${s.name ?? s.service_id} · ${b.label}`,
    compact({
      label: b.label,
      backupType: b.type,
      serviceId: s.service_id,
      sourceKey: svc,
      projectId: s.project_id,
      createdAt: b.started_at,
      finishedAt: b.finished_at,
      durationSeconds: b.duration_seconds,
      sizeBytes: b.size_bytes,
      regions: (b.regions ?? [])
        .map((r) => `${r.region_code ?? "?"}${r.status ? ` (${r.status.toLowerCase()})` : ""}`)
        .join(", "),
    }),
    { typeId: T.service, externalId: svc },
  );
}

/** `postgresql://user:pass@host:port/db?sslmode=require`, the URI tiger-cli builds. */
export function postgresUri(
  host: string,
  port: number | string,
  user: string,
  password: string | null | undefined,
  database: string,
): string {
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `postgresql://${auth}@${host}:${port}/${database}?sslmode=require`;
}
