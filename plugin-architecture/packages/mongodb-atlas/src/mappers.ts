import type { ResourceInstance } from "@infrawrench/plugin-base";
import { isDedicatedTier, tierSpec } from "./tiers.js";

/** Raw API shapes, narrowed to what the mappers read. */

export interface AtlasGroup {
  id?: string;
  name?: string;
  orgId?: string;
  clusterCount?: number;
  created?: string;
  tags?: Array<{ key?: string; value?: string }>;
}

interface HardwareSpec {
  instanceSize?: string;
  effectiveInstanceSize?: string;
  nodeCount?: number;
  diskSizeGB?: number;
  diskIOPS?: number;
}

interface RegionConfig {
  providerName?: string;
  backingProviderName?: string;
  regionName?: string;
  priority?: number;
  electableSpecs?: HardwareSpec;
  effectiveElectableSpecs?: HardwareSpec;
  readOnlySpecs?: HardwareSpec;
  analyticsSpecs?: HardwareSpec;
  autoScaling?: {
    compute?: {
      enabled?: boolean;
      scaleDownEnabled?: boolean;
      minInstanceSize?: string;
      maxInstanceSize?: string;
    };
    diskGB?: { enabled?: boolean };
  };
}

export interface AtlasCluster {
  id?: string;
  name?: string;
  groupId?: string;
  clusterType?: string;
  stateName?: string;
  paused?: boolean;
  mongoDBVersion?: string;
  backupEnabled?: boolean;
  pitEnabled?: boolean;
  terminationProtectionEnabled?: boolean;
  createDate?: string;
  connectionStrings?: { standard?: string; standardSrv?: string };
  replicationSpecs?: Array<{ id?: string; zoneName?: string; regionConfigs?: RegionConfig[] }>;
  tags?: Array<{ key?: string; value?: string }>;
}

export interface AtlasFlexCluster {
  id?: string;
  name?: string;
  groupId?: string;
  stateName?: string;
  mongoDBVersion?: string;
  terminationProtectionEnabled?: boolean;
  createDate?: string;
  backupSettings?: { enabled?: boolean };
  connectionStrings?: { standard?: string; standardSrv?: string };
  providerSettings?: { backingProviderName?: string; regionName?: string; diskSizeGB?: number };
  tags?: Array<{ key?: string; value?: string }>;
}

export interface AtlasServerless {
  id?: string;
  name?: string;
  groupId?: string;
  stateName?: string;
  mongoDBVersion?: string;
  terminationProtectionEnabled?: boolean;
  createDate?: string;
  connectionStrings?: { standardSrv?: string };
  providerSettings?: { backingProviderName?: string; regionName?: string };
}

export interface AtlasDatabaseUser {
  username?: string;
  databaseName?: string;
  groupId?: string;
  description?: string;
  deleteAfterDate?: string;
  awsIAMType?: string;
  ldapAuthType?: string;
  oidcAuthType?: string;
  x509Type?: string;
  roles?: Array<{ roleName?: string; databaseName?: string; collectionName?: string }>;
  scopes?: Array<{ name?: string; type?: string }>;
}

export interface AtlasAccessEntry {
  groupId?: string;
  ipAddress?: string;
  cidrBlock?: string;
  awsSecurityGroup?: string;
  comment?: string;
  deleteAfterDate?: string;
}

export interface AtlasSnapshot {
  id?: string;
  description?: string;
  snapshotType?: string;
  frequencyType?: string;
  status?: string;
  createdAt?: string;
  expiresAt?: string;
  storageSizeBytes?: number;
  mongodVersion?: string;
}

export interface AtlasBackupSchedule {
  clusterName?: string;
  referenceHourOfDay?: number;
  referenceMinuteOfHour?: number;
  restoreWindowDays?: number;
  nextSnapshot?: string;
  autoExportEnabled?: boolean;
  copySettings?: Array<{ cloudProvider?: string; regionName?: string }>;
  policies?: Array<{
    id?: string;
    policyItems?: Array<{
      frequencyType?: string;
      frequencyInterval?: number;
      retentionUnit?: string;
      retentionValue?: number;
    }>;
  }>;
}

export interface AtlasAlert {
  id?: string;
  groupId?: string;
  alertConfigId?: string;
  eventTypeName?: string;
  status?: string;
  severity?: string;
  metricName?: string;
  currentValue?: { number?: number; units?: string };
  hostnameAndPort?: string;
  replicaSetName?: string;
  clusterName?: string;
  created?: string;
  resolved?: string;
  acknowledgedUntil?: string;
  acknowledgingUsername?: string;
}

export interface AtlasAlertConfig {
  id?: string;
  groupId?: string;
  eventTypeName?: string;
  enabled?: boolean;
  updated?: string;
  metricThreshold?: {
    metricName?: string;
    operator?: string;
    threshold?: number;
    units?: string;
    mode?: string;
  };
  threshold?: { operator?: string; threshold?: number; units?: string };
  matchers?: Array<{ fieldName?: string; operator?: string; value?: string }>;
  notifications?: Array<{ typeName?: string; intervalMin?: number; delayMin?: number }>;
}

export interface AtlasSearchIndex {
  indexID?: string;
  name?: string;
  type?: string;
  database?: string;
  collectionName?: string;
  status?: string;
  queryable?: boolean;
}

export interface AtlasOnlineArchive {
  _id?: string;
  clusterName?: string;
  dbName?: string;
  collName?: string;
  state?: string;
  paused?: boolean;
  criteria?: { type?: string; dateField?: string; expireAfterDays?: number; query?: string };
  dataExpirationRule?: { expireAfterDays?: number };
  schedule?: { type?: string };
}

export interface AtlasEndpointService {
  id?: string;
  cloudProvider?: string;
  regionName?: string;
  status?: string;
  errorMessage?: string;
  endpointServiceName?: string;
  serviceAttachmentNames?: string[];
  privateLinkServiceName?: string;
  interfaceEndpoints?: string[];
  privateEndpoints?: string[];
  endpointGroupNames?: string[];
}

// ---------------------------------------------------------------------------

export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined>,
  opts: { outputs?: Record<string, string>; parentResourceId?: string } = {},
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    clean[k] = v;
  }
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.outputs ?? {})) if (v) outputs[k] = v;
  const now = new Date().toISOString();
  return {
    id: resourceId(accountId, typeId, externalId),
    pluginId: "mongodb-atlas",
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: outputs,
    secretStates: [],
    externalId,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function tagString(tags: Array<{ key?: string; value?: string }> | undefined): string {
  return (tags ?? [])
    .filter((t) => t.key)
    .map((t) => `${t.key}=${t.value ?? ""}`)
    .join(", ");
}

export interface ProjectRef {
  groupId: string;
  projectName: string;
}

const projectParent = (accountId: string, groupId: string) =>
  resourceId(accountId, "project", groupId);
const clusterParent = (accountId: string, groupId: string, cluster: string) =>
  resourceId(accountId, "cluster", `${groupId}/${cluster}`);

/** Split a path-shaped external id into its fixed leading parts and the rest. */
export function splitId(externalId: string, fixed: number): string[] {
  const parts = externalId.split("/");
  if (parts.length <= fixed) return parts;
  return [...parts.slice(0, fixed), parts.slice(fixed).join("/")];
}

export function mapOrganization(
  accountId: string,
  org: { id: string; name: string },
  extra: { pendingTotal?: number; projectCount?: number } = {},
): ResourceInstance {
  return instance(
    accountId,
    "organization",
    org.id,
    org.name,
    {
      name: org.name,
      orgId: org.id,
      pendingTotal: extra.pendingTotal,
      projectCount: extra.projectCount,
    },
    { outputs: { orgId: org.id } },
  );
}

export function mapProject(accountId: string, g: AtlasGroup): ResourceInstance {
  const id = g.id ?? "";
  return instance(
    accountId,
    "project",
    id,
    g.name ?? id,
    {
      name: g.name,
      groupId: id,
      orgId: g.orgId,
      clusterCount: g.clusterCount,
      created: g.created,
      tags: tagString(g.tags),
    },
    { outputs: { groupId: id } },
  );
}

/** Region configs of the first shard, highest election priority first. */
function primaryRegionConfigs(c: AtlasCluster): RegionConfig[] {
  const configs = c.replicationSpecs?.[0]?.regionConfigs ?? [];
  return [...configs].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/** The provider a cluster really runs on (`TENANT` clusters name their backing cloud). */
export function clusterProvider(c: AtlasCluster): string {
  const rc = primaryRegionConfigs(c)[0];
  if (!rc) return "";
  if (rc.providerName === "TENANT") return rc.backingProviderName ?? "";
  return rc.providerName ?? "";
}

/** True for clusters `/clusters` returns that are listed under their own type. */
export function isListedElsewhere(c: AtlasCluster): boolean {
  const name = primaryRegionConfigs(c)[0]?.providerName ?? "";
  return name === "FLEX" || name === "SERVERLESS";
}

export function clusterTier(c: AtlasCluster): string {
  const rc = primaryRegionConfigs(c)[0];
  return (
    rc?.effectiveElectableSpecs?.instanceSize ??
    rc?.electableSpecs?.effectiveInstanceSize ??
    rc?.electableSpecs?.instanceSize ??
    ""
  );
}

/** AWS-style region id (`us-east-1`) for the carbon estimate; empty for other clouds. */
function carbonRegion(provider: string, regionName: string): string {
  if (provider !== "AWS" || !regionName) return "";
  return regionName.toLowerCase().replace(/_/g, "-");
}

export function mapCluster(
  accountId: string,
  c: AtlasCluster,
  project: ProjectRef,
): ResourceInstance {
  const name = c.name ?? "";
  const configs = primaryRegionConfigs(c);
  const rc = configs[0];
  const provider = clusterProvider(c);
  const tier = clusterTier(c);
  const nodeCount = configs.reduce((n, r) => n + (r.electableSpecs?.nodeCount ?? 0), 0);
  const spec = tierSpec(tier);
  const compute = rc?.autoScaling?.compute;
  const regionName = rc?.regionName ?? "";
  return instance(
    accountId,
    "cluster",
    `${project.groupId}/${name}`,
    name,
    {
      name,
      instanceSize: tier,
      diskSizeGB: rc?.electableSpecs?.diskSizeGB,
      autoScalingCompute: compute?.enabled ?? false,
      autoScalingDisk: rc?.autoScaling?.diskGB?.enabled ?? false,
      terminationProtectionEnabled: c.terminationProtectionEnabled ?? false,
      stateName: c.stateName,
      paused: c.paused ?? false,
      clusterType: c.clusterType,
      provider,
      region: regionName,
      regions: configs
        .map((r) => r.regionName ?? "")
        .filter(Boolean)
        .join(", "),
      mongoDBVersion: c.mongoDBVersion,
      nodeCount: nodeCount || undefined,
      shardCount: c.replicationSpecs?.length,
      minInstanceSize: compute?.enabled ? compute.minInstanceSize : undefined,
      maxInstanceSize: compute?.enabled ? compute.maxInstanceSize : undefined,
      backupEnabled: c.backupEnabled ?? false,
      pitEnabled: c.pitEnabled ?? false,
      standardSrv: c.connectionStrings?.standardSrv,
      createDate: c.createDate,
      clusterId: c.id,
      tags: tagString(c.tags),
      dedicated: isDedicatedTier(tier),
      vcpus: spec?.vcpus,
      cloudRegion: carbonRegion(provider, regionName),
      ...project,
    },
    {
      outputs: {
        standardSrv: c.connectionStrings?.standardSrv ?? "",
        standard: c.connectionStrings?.standard ?? "",
      },
      parentResourceId: projectParent(accountId, project.groupId),
    },
  );
}

export function mapFlexCluster(
  accountId: string,
  c: AtlasFlexCluster,
  project: ProjectRef,
): ResourceInstance {
  const name = c.name ?? "";
  return instance(
    accountId,
    "flex-cluster",
    `${project.groupId}/${name}`,
    name,
    {
      name,
      terminationProtectionEnabled: c.terminationProtectionEnabled ?? false,
      stateName: c.stateName,
      provider: c.providerSettings?.backingProviderName,
      region: c.providerSettings?.regionName,
      mongoDBVersion: c.mongoDBVersion,
      diskSizeGB: c.providerSettings?.diskSizeGB,
      backupEnabled: c.backupSettings?.enabled,
      standardSrv: c.connectionStrings?.standardSrv,
      createDate: c.createDate,
      clusterId: c.id,
      tags: tagString(c.tags),
      ...project,
    },
    {
      outputs: { standardSrv: c.connectionStrings?.standardSrv ?? "" },
      parentResourceId: projectParent(accountId, project.groupId),
    },
  );
}

export function mapServerless(
  accountId: string,
  s: AtlasServerless,
  project: ProjectRef,
): ResourceInstance {
  const name = s.name ?? "";
  return instance(
    accountId,
    "serverless-instance",
    `${project.groupId}/${name}`,
    name,
    {
      name,
      stateName: s.stateName,
      provider: s.providerSettings?.backingProviderName,
      region: s.providerSettings?.regionName,
      mongoDBVersion: s.mongoDBVersion,
      terminationProtectionEnabled: s.terminationProtectionEnabled ?? false,
      standardSrv: s.connectionStrings?.standardSrv,
      createDate: s.createDate,
      ...project,
    },
    {
      outputs: { standardSrv: s.connectionStrings?.standardSrv ?? "" },
      parentResourceId: projectParent(accountId, project.groupId),
    },
  );
}

/** `readWrite@app, read@reporting` (collection-scoped roles as `role@db.coll`). */
export function rolesToString(roles: AtlasDatabaseUser["roles"]): string {
  return (roles ?? [])
    .filter((r) => r.roleName)
    .map((r) => {
      const where = r.collectionName ? `${r.databaseName}.${r.collectionName}` : r.databaseName;
      return where ? `${r.roleName}@${where}` : String(r.roleName);
    })
    .join(", ");
}

/**
 * Parse the editable roles string back into API roles. Accepts `role@db`,
 * `role@db.collection`, and a bare role (which means `admin`, where every
 * `*AnyDatabase` role and atlasAdmin live).
 */
export function parseRoles(
  text: string,
): Array<{ roleName: string; databaseName: string; collectionName?: string }> {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("@");
      const roleName = (at >= 0 ? entry.slice(0, at) : entry).trim();
      const where = at >= 0 ? entry.slice(at + 1).trim() : "admin";
      const dot = where.indexOf(".");
      if (dot > 0) {
        return {
          roleName,
          databaseName: where.slice(0, dot),
          collectionName: where.slice(dot + 1),
        };
      }
      return { roleName, databaseName: where || "admin" };
    })
    .filter((r) => r.roleName);
}

function authType(u: AtlasDatabaseUser): string {
  if (u.awsIAMType && u.awsIAMType !== "NONE") return `AWS IAM (${u.awsIAMType.toLowerCase()})`;
  if (u.x509Type && u.x509Type !== "NONE") return `X.509 (${u.x509Type.toLowerCase()})`;
  if (u.ldapAuthType && u.ldapAuthType !== "NONE") return `LDAP (${u.ldapAuthType.toLowerCase()})`;
  if (u.oidcAuthType && u.oidcAuthType !== "NONE") return `OIDC (${u.oidcAuthType.toLowerCase()})`;
  return "Password (SCRAM)";
}

export function mapDatabaseUser(
  accountId: string,
  u: AtlasDatabaseUser,
  project: ProjectRef,
): ResourceInstance {
  const username = u.username ?? "";
  const db = u.databaseName ?? "admin";
  return instance(
    accountId,
    "database-user",
    `${project.groupId}/${db}/${username}`,
    username,
    {
      username,
      roles: rolesToString(u.roles),
      description: u.description,
      databaseName: db,
      authType: authType(u),
      scopes: (u.scopes ?? [])
        .map((s) => s.name ?? "")
        .filter(Boolean)
        .join(", "),
      deleteAfterDate: u.deleteAfterDate,
      hasAtlasAdmin: (u.roles ?? []).some((r) => r.roleName === "atlasAdmin"),
      ...project,
    },
    {
      outputs: { username },
      parentResourceId: projectParent(accountId, project.groupId),
    },
  );
}

export function accessEntryValue(e: AtlasAccessEntry): string {
  return e.cidrBlock ?? e.ipAddress ?? e.awsSecurityGroup ?? "";
}

export function mapAccessEntry(
  accountId: string,
  e: AtlasAccessEntry,
  project: ProjectRef,
): ResourceInstance {
  const entry = accessEntryValue(e);
  const kind = e.awsSecurityGroup
    ? "AWS security group"
    : e.cidrBlock && !e.cidrBlock.endsWith("/32")
      ? "CIDR block"
      : "IP address";
  return instance(
    accountId,
    "ip-access-entry",
    `${project.groupId}/${entry}`,
    e.comment ? `${entry} (${e.comment})` : entry,
    { entry, comment: e.comment, kind, deleteAfterDate: e.deleteAfterDate, ...project },
    { outputs: { entry }, parentResourceId: projectParent(accountId, project.groupId) },
  );
}

export function mapSnapshot(
  accountId: string,
  s: AtlasSnapshot,
  project: ProjectRef,
  clusterName: string,
): ResourceInstance {
  const id = s.id ?? "";
  const when = s.createdAt ? s.createdAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC") : id;
  return instance(
    accountId,
    "backup-snapshot",
    `${project.groupId}/${clusterName}/${id}`,
    s.description ? `${s.description} (${when})` : `${clusterName} ${when}`,
    {
      description: s.description,
      snapshotType: s.snapshotType,
      frequencyType: s.frequencyType,
      status: s.status,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      storageSizeBytes: s.storageSizeBytes,
      mongodVersion: s.mongodVersion,
      snapshotId: id,
      clusterName,
      ...project,
    },
    {
      outputs: { snapshotId: id },
      parentResourceId: clusterParent(accountId, project.groupId, clusterName),
    },
  );
}

const RETENTION_ORDER = ["hourly", "daily", "weekly", "monthly", "yearly", "ondemand"];

export function policySummary(schedule: AtlasBackupSchedule): string {
  const items = (schedule.policies ?? []).flatMap((p) => p.policyItems ?? []);
  return items
    .sort(
      (a, b) =>
        RETENTION_ORDER.indexOf(a.frequencyType ?? "") -
        RETENTION_ORDER.indexOf(b.frequencyType ?? ""),
    )
    .map((i) => {
      const every =
        i.frequencyType === "hourly"
          ? `every ${i.frequencyInterval ?? 1}h`
          : i.frequencyType === "weekly"
            ? `weekly (day ${i.frequencyInterval ?? ""})`
            : i.frequencyType === "monthly"
              ? `monthly (day ${i.frequencyInterval ?? ""})`
              : (i.frequencyType ?? "");
      return `${every} kept ${i.retentionValue ?? "?"} ${i.retentionUnit ?? ""}`.trim();
    })
    .join("; ");
}

export function mapBackupPolicy(
  accountId: string,
  schedule: AtlasBackupSchedule,
  project: ProjectRef,
  clusterName: string,
): ResourceInstance {
  return instance(
    accountId,
    "backup-policy",
    `${project.groupId}/${clusterName}`,
    `${clusterName} backup policy`,
    {
      referenceHourOfDay: schedule.referenceHourOfDay,
      referenceMinuteOfHour: schedule.referenceMinuteOfHour,
      restoreWindowDays: schedule.restoreWindowDays,
      policySummary: policySummary(schedule),
      nextSnapshot: schedule.nextSnapshot,
      autoExportEnabled: schedule.autoExportEnabled,
      copyRegions: (schedule.copySettings ?? [])
        .map((c) => [c.cloudProvider, c.regionName].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(", "),
      clusterName,
      ...project,
    },
    { parentResourceId: clusterParent(accountId, project.groupId, clusterName) },
  );
}

export function humanizeEvent(eventTypeName: string): string {
  if (!eventTypeName) return "";
  const words = eventTypeName.toLowerCase().split("_").filter(Boolean);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function mapAlert(accountId: string, a: AtlasAlert, project: ProjectRef): ResourceInstance {
  const id = a.id ?? "";
  const event = a.eventTypeName ?? "";
  const subject = a.clusterName ?? a.replicaSetName ?? a.hostnameAndPort ?? "";
  const metric = a.metricName ? `${humanizeEvent(a.metricName)}` : humanizeEvent(event);
  return instance(
    accountId,
    "alert",
    `${project.groupId}/${id}`,
    subject ? `${metric} on ${subject}` : metric || id,
    {
      eventTypeName: event,
      status: a.status,
      severity: a.severity,
      metricName: a.metricName,
      currentValue:
        a.currentValue?.number !== undefined
          ? `${a.currentValue.number}${a.currentValue.units ? ` ${a.currentValue.units.toLowerCase()}` : ""}`
          : undefined,
      hostnameAndPort: a.hostnameAndPort,
      replicaSetName: a.replicaSetName,
      clusterName: a.clusterName,
      created: a.created,
      resolved: a.resolved,
      acknowledgedUntil: a.acknowledgedUntil,
      acknowledgingUsername: a.acknowledgingUsername,
      alertConfigId: a.alertConfigId,
      ...project,
    },
    { parentResourceId: projectParent(accountId, project.groupId) },
  );
}

export function thresholdText(c: AtlasAlertConfig): string {
  const t = c.metricThreshold;
  if (t?.metricName) {
    const op = t.operator === "LESS_THAN" ? "<" : t.operator === "GREATER_THAN" ? ">" : "";
    return `${humanizeEvent(t.metricName)} ${op} ${t.threshold ?? ""}${t.units ? ` ${t.units.toLowerCase()}` : ""}`.trim();
  }
  const g = c.threshold;
  if (g && g.threshold !== undefined) {
    const op = g.operator === "LESS_THAN" ? "<" : g.operator === "GREATER_THAN" ? ">" : "";
    return `${op} ${g.threshold}${g.units ? ` ${g.units.toLowerCase()}` : ""}`.trim();
  }
  return "";
}

export function mapAlertConfig(
  accountId: string,
  c: AtlasAlertConfig,
  project: ProjectRef,
): ResourceInstance {
  const id = c.id ?? "";
  const threshold = thresholdText(c);
  const event = humanizeEvent(c.eventTypeName ?? "");
  return instance(
    accountId,
    "alert-configuration",
    `${project.groupId}/${id}`,
    threshold ? `${event}: ${threshold}` : event || id,
    {
      eventTypeName: c.eventTypeName,
      enabled: c.enabled ?? false,
      threshold,
      matchers: (c.matchers ?? [])
        .map((m) =>
          `${m.fieldName ?? ""} ${(m.operator ?? "").toLowerCase()} ${m.value ?? ""}`.trim(),
        )
        .join("; "),
      notifications: [...new Set((c.notifications ?? []).map((n) => n.typeName ?? ""))]
        .filter(Boolean)
        .map((t) => t.toLowerCase().replace(/_/g, " "))
        .join(", "),
      updated: c.updated,
      ...project,
    },
    { parentResourceId: projectParent(accountId, project.groupId) },
  );
}

export function mapSearchIndex(
  accountId: string,
  s: AtlasSearchIndex,
  project: ProjectRef,
  clusterName: string,
): ResourceInstance {
  const id = s.indexID ?? "";
  return instance(
    accountId,
    "search-index",
    `${project.groupId}/${clusterName}/${id}`,
    `${s.name ?? id} (${s.database ?? ""}.${s.collectionName ?? ""})`,
    {
      name: s.name,
      indexType: s.type === "vectorSearch" ? "Vector Search" : "Search",
      database: s.database,
      collectionName: s.collectionName,
      status: s.status,
      queryable: s.queryable,
      indexId: id,
      clusterName,
      ...project,
    },
    {
      outputs: { indexId: id },
      parentResourceId: clusterParent(accountId, project.groupId, clusterName),
    },
  );
}

export function mapOnlineArchive(
  accountId: string,
  a: AtlasOnlineArchive,
  project: ProjectRef,
  clusterName: string,
): ResourceInstance {
  const id = a._id ?? "";
  const namespace = `${a.dbName ?? ""}.${a.collName ?? ""}`;
  const criteria =
    a.criteria?.type === "DATE"
      ? `Documents older than ${a.criteria.expireAfterDays ?? "?"} days by ${a.criteria.dateField ?? "date"}`
      : a.criteria?.type === "CUSTOM"
        ? `Custom query ${a.criteria.query ?? ""}`.trim()
        : "";
  return instance(
    accountId,
    "online-archive",
    `${project.groupId}/${clusterName}/${id}`,
    namespace,
    {
      namespace,
      state: a.state,
      criteria,
      expireAfterDays: a.dataExpirationRule?.expireAfterDays,
      schedule: a.schedule?.type ? a.schedule.type.toLowerCase() : undefined,
      archiveId: id,
      clusterName,
      ...project,
    },
    { parentResourceId: clusterParent(accountId, project.groupId, clusterName) },
  );
}

export function mapEndpointService(
  accountId: string,
  e: AtlasEndpointService,
  project: ProjectRef,
): ResourceInstance {
  const id = e.id ?? "";
  const provider = e.cloudProvider ?? "";
  const endpoints = [
    ...(e.interfaceEndpoints ?? []),
    ...(e.privateEndpoints ?? []),
    ...(e.endpointGroupNames ?? []),
  ];
  const serviceName =
    e.endpointServiceName ?? e.privateLinkServiceName ?? e.serviceAttachmentNames?.[0] ?? "";
  return instance(
    accountId,
    "private-endpoint-service",
    `${project.groupId}/${provider}/${id}`,
    `${provider} ${e.regionName ?? ""}`.trim() || id,
    {
      cloudProvider: provider,
      regionName: e.regionName,
      status: e.status,
      serviceName,
      endpoints: endpoints.join(", "),
      endpointCount: endpoints.length,
      errorMessage: e.errorMessage,
      serviceId: id,
      ...project,
    },
    {
      outputs: { serviceName },
      parentResourceId: projectParent(accountId, project.groupId),
    },
  );
}
