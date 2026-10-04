import type { ResourceInstance } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";
import type {
  RcAccount,
  RcAclRole,
  RcAclRule,
  RcAclUser,
  RcCloudAccount,
  RcDatabase,
  RcEssentialsSubscription,
  RcPricing,
  RcProSubscription,
  RcPscEndpoint,
  RcPscService,
  RcTransitGateway,
  RcVpcPeering,
} from "./types.js";

type Fields = Record<string, string | number | boolean>;

export type PlanKind = "pro" | "essentials";

/** Hours in an average month, the convention every cloud price sheet uses. */
export const HOURS_PER_MONTH = 730;

/** Below this much used memory a paid database is treated as empty. */
export const EMPTY_DATABASE_MB = 5;

/** Drop undefined/null/empty-string values so absent data renders as absent. */
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
  parentExternalId?: string,
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "redis-cloud",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parentExternalId
      ? { parentResourceId: `${accountId}:${T.subscription}:${parentExternalId}` }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** `pro-123` / `ess-456`: the subscription external id carries its plan family. */
export function subscriptionExternalId(kind: PlanKind, id: number | string): string {
  return `${kind === "pro" ? "pro" : "ess"}-${id}`;
}

export function parseSubscriptionExternalId(
  externalId: string,
): { kind: PlanKind; id: string } | null {
  const m = /^(pro|ess)-(\d+)$/.exec(externalId);
  if (!m) return null;
  return { kind: m[1] === "pro" ? "pro" : "essentials", id: m[2]! };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Monthly list price of a Pro subscription from its pricing lines. */
export function proMonthlyPrice(pricing: RcPricing[] | undefined): {
  amount: number | undefined;
  currency: string | undefined;
} {
  let total = 0;
  let priced = false;
  let currency: string | undefined;
  for (const line of pricing ?? []) {
    const unit = Number(line.pricePerUnit);
    const qty = Number(line.quantity ?? 1);
    if (!Number.isFinite(unit) || !Number.isFinite(qty)) continue;
    const period = String(line.pricePeriod ?? "").toLowerCase();
    const perMonth = period.startsWith("hour") ? unit * qty * HOURS_PER_MONTH : unit * qty;
    total += perMonth;
    priced = true;
    currency ??= line.priceCurrency;
  }
  return { amount: priced ? round2(total) : undefined, currency };
}

function shardLines(pricing: RcPricing[] | undefined): RcPricing[] {
  return (pricing ?? []).filter(
    (p) =>
      /shard/i.test(String(p.type ?? "")) || /shard/i.test(String(p.quantityMeasurement ?? "")),
  );
}

export function mapProSubscription(accountId: string, s: RcProSubscription): ResourceInstance {
  const cloud = s.cloudDetails?.[0];
  const regions = (s.cloudDetails ?? []).flatMap((c) => c.regions ?? []);
  const shards = shardLines(s.subscriptionPricing);
  const price = proMonthlyPrice(s.subscriptionPricing);
  const fields = compact({
    name: s.name,
    plan: "Pro",
    status: s.status,
    provider: [...new Set((s.cloudDetails ?? []).map((c) => c.provider).filter(Boolean))].join(
      ", ",
    ),
    region: regions
      .map((r) => r.region)
      .filter(Boolean)
      .join(", "),
    deploymentType: s.deploymentType,
    memoryStorage: s.memoryStorage,
    numberOfDatabases: s.numberOfDatabases,
    shards: shards.length ? shards.reduce((n, p) => n + Number(p.quantity ?? 0), 0) : undefined,
    shardType: shards
      .map((p) => p.typeDetails)
      .filter(Boolean)
      .join(", "),
    monthlyPrice: price.amount,
    priceCurrency: price.currency,
    paymentMethodType: s.paymentMethodType,
    publicEndpointAccess: s.publicEndpointAccess,
    cloudAccountId: cloud?.cloudAccountId !== undefined ? String(cloud.cloudAccountId) : undefined,
    multiAz: regions.some((r) => r.multipleAvailabilityZones === true),
    deploymentCidr: regions
      .flatMap((r) => r.networking ?? [])
      .map((n) => n.deploymentCIDR)
      .filter(Boolean)
      .join(", "),
  });
  const inst = instance(
    accountId,
    T.subscription,
    subscriptionExternalId("pro", s.id ?? ""),
    s.name ?? `Subscription ${s.id}`,
    fields,
  );
  if (s.prometheusEndpoint) inst.resolvedOutputs["prometheusEndpoint"] = s.prometheusEndpoint;
  return inst;
}

export function mapEssentialsSubscription(
  accountId: string,
  s: RcEssentialsSubscription,
): ResourceInstance {
  const unit = String(s.sizeMeasurementUnit ?? "GB").toUpperCase();
  const sizeGb =
    s.size === undefined ? undefined : unit === "MB" ? round2(s.size / 1024) : Number(s.size);
  const monthly =
    s.price === undefined
      ? undefined
      : String(s.pricePeriod ?? "month")
            .toLowerCase()
            .startsWith("hour")
        ? round2(s.price * HOURS_PER_MONTH)
        : s.price;
  return instance(
    accountId,
    T.subscription,
    subscriptionExternalId("essentials", s.id ?? ""),
    s.name ?? `Subscription ${s.id}`,
    compact({
      name: s.name,
      plan: "Essentials",
      status: s.status,
      provider: s.provider,
      region: s.region,
      deploymentType: s.availability,
      planName: s.planName,
      planSizeGb: sizeGb,
      monthlyPrice: monthly,
      priceCurrency: s.priceCurrency,
      paymentMethodType: s.paymentMethodType,
      createdAt: s.creationDate,
      // Undeclared: the plan picker's current value and the Terraform mapping.
      planId: s.planId !== undefined ? String(s.planId) : undefined,
      paymentMethodId: s.paymentMethodId !== undefined ? String(s.paymentMethodId) : undefined,
      free: s.price === 0,
    }),
  );
}

/** `host:port` → parts; a bare host keeps Redis Cloud's port-less form. */
export function splitEndpoint(endpoint: string | undefined): { host: string; port: string } {
  if (!endpoint) return { host: "", port: "" };
  const idx = endpoint.lastIndexOf(":");
  if (idx <= 0) return { host: endpoint, port: "" };
  return { host: endpoint.slice(0, idx), port: endpoint.slice(idx + 1) };
}

/** Memory limit in GB for either plan family, or undefined when unreported. */
export function databaseMemoryLimitGb(db: RcDatabase): number | undefined {
  if (typeof db.memoryLimitInGb === "number") return db.memoryLimitInGb;
  if (typeof db.planMemoryLimit === "number") {
    const unit = String(db.memoryLimitMeasurementUnit ?? "GB").toUpperCase();
    return unit === "MB" ? round2(db.planMemoryLimit / 1024) : db.planMemoryLimit;
  }
  if (typeof db.datasetSizeInGb === "number") {
    return db.replication ? db.datasetSizeInGb * 2 : db.datasetSizeInGb;
  }
  return undefined;
}

/**
 * Size the dataset is allowed to reach, the number Redis Cloud bills and
 * resizes against. Pro databases report it; Essentials report the plan's
 * memory limit, which is the same figure.
 */
export function databaseDatasetGb(db: RcDatabase): number | undefined {
  if (typeof db.datasetSizeInGb === "number") return db.datasetSizeInGb;
  if (typeof db.planDatasetSize === "number") {
    const unit = String(db.memoryLimitMeasurementUnit ?? "GB").toUpperCase();
    return unit === "MB" ? round2(db.planDatasetSize / 1024) : db.planDatasetSize;
  }
  const limit = databaseMemoryLimitGb(db);
  if (limit === undefined) return undefined;
  return db.replication ? limit / 2 : limit;
}

export interface DatabaseContext {
  kind: PlanKind;
  subscriptionId: string;
  subscriptionName?: string;
  /** Essentials plans priced at zero are free tier: never a savings candidate. */
  free?: boolean;
}

export function mapDatabase(
  accountId: string,
  db: RcDatabase,
  ctx: DatabaseContext,
): ResourceInstance {
  const datasetGb = databaseDatasetGb(db);
  const usedMb = typeof db.memoryUsedInMb === "number" ? db.memoryUsedInMb : undefined;
  const usedPct =
    usedMb !== undefined && datasetGb ? round2((usedMb / (datasetGb * 1024)) * 100) : undefined;
  const throughput = db.throughputMeasurement;
  const empty =
    !ctx.free &&
    String(db.status ?? "").toLowerCase() === "active" &&
    usedMb !== undefined &&
    usedMb < EMPTY_DATABASE_MB;
  const security = db.security ?? {};
  const defaultUser = security.enableDefaultUser ?? security.defaultUserEnabled;
  const fields = compact({
    name: db.name,
    plan: ctx.kind === "pro" ? "Pro" : "Essentials",
    subscriptionId: ctx.subscriptionId,
    subscriptionName: ctx.subscriptionName,
    status: db.status,
    provider: db.provider,
    region: db.region,
    protocol: db.protocol,
    redisVersion: db.redisVersion ?? db.redisVersionCompliance,
    respVersion: db.respVersion,
    memoryLimitGb: databaseMemoryLimitGb(db),
    datasetSizeGb: datasetGb,
    memoryUsedMb: usedMb,
    memoryUsedPct: usedPct,
    throughput:
      throughput?.value !== undefined
        ? `${throughput.value} ${throughput.by === "number-of-shards" ? "shards" : "ops/sec"}`
        : undefined,
    throughputOpsPerSec: throughput?.by === "operations-per-second" ? throughput.value : undefined,
    shards: db.clustering?.numberOfShards,
    modules: (db.modules ?? [])
      .map((m) => m.capabilityName ?? m.name)
      .filter(Boolean)
      .join(", "),
    replication: db.replication,
    dataPersistence: db.dataPersistence,
    dataEvictionPolicy: db.dataEvictionPolicy,
    enableTls: security.enableTls ?? false,
    defaultUserEnabled: defaultUser,
    sourceIps: (security.sourceIps ?? []).join(", "),
    publicEndpoint: db.publicEndpoint,
    privateEndpoint: db.privateEndpoint,
    alerts: (db.alerts ?? [])
      .filter((a) => a.name)
      .map((a) => `${a.name}=${a.value ?? ""}`)
      .join(", "),
    backupEnabled: db.backup?.remoteBackupEnabled,
    backupInterval: db.backup?.interval,
    activatedOn: db.activatedOn,
    lastModified: db.lastModified,
    savingsFlag: empty ? "empty" : undefined,
  });
  return instance(
    accountId,
    T.database,
    String(db.databaseId ?? ""),
    db.name ?? `Database ${db.databaseId}`,
    fields,
    subscriptionExternalId(ctx.kind, ctx.subscriptionId),
  );
}

/**
 * Parse the `alerts` field (`name=value, …`) back into a map. The detail view
 * and the alerts prompt both work from the stored field, so nothing has to
 * re-fetch the database to show the current thresholds.
 */
export function parseAlerts(raw: string | number | boolean | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of String(raw ?? "").split(",")) {
    const [name, value] = part.split("=").map((s) => s.trim());
    if (!name) continue;
    const n = Number(value);
    if (Number.isFinite(n)) out[name] = n;
  }
  return out;
}

export function mapVpcPeering(
  accountId: string,
  subscriptionId: string,
  provider: string,
  p: RcVpcPeering,
): ResourceInstance {
  const cidrs = (p.vpcCidrs ?? []).map((c) => c.vpcCidr).filter(Boolean) as string[];
  if (cidrs.length === 0 && p.vpcCidr) cidrs.push(p.vpcCidr);
  const label = p.vpcUid ?? p.networkName ?? `Peering ${p.vpcPeeringId}`;
  return instance(
    accountId,
    T.vpcPeering,
    `${subscriptionId}/${p.vpcPeeringId}`,
    label,
    compact({
      status: p.status,
      subscriptionId,
      provider,
      region: p.regionName,
      awsAccountId: p.awsAccountId,
      vpcId: p.vpcUid,
      vpcCidrs: cidrs.join(", "),
      gcpProject: p.projectUid,
      gcpNetwork: p.networkName,
      redisProject: p.redisProjectUid,
      redisNetwork: p.redisNetworkName,
      cloudPeeringId: p.cloudPeeringId ?? p.awsPeeringUid,
    }),
    subscriptionExternalId("pro", subscriptionId),
  );
}

export function mapTransitGateway(
  accountId: string,
  subscriptionId: string,
  t: RcTransitGateway,
): ResourceInstance {
  return instance(
    accountId,
    T.transitGateway,
    `${subscriptionId}/${t.id}`,
    t.awsTgwUid ?? `Transit gateway ${t.id}`,
    compact({
      status: t.status,
      subscriptionId,
      awsTgwId: t.awsTgwUid,
      awsAccountId: t.awsAccountId,
      attachmentId: t.attachmentUid,
      attachmentStatus: t.attachmentStatus,
      cidrs: (t.cidrs ?? [])
        .map((c) => c.cidrAddress)
        .filter(Boolean)
        .join(", "),
    }),
    subscriptionExternalId("pro", subscriptionId),
  );
}

export function mapPscEndpoint(
  accountId: string,
  subscriptionId: string,
  service: RcPscService,
  e: RcPscEndpoint,
): ResourceInstance {
  return instance(
    accountId,
    T.pscEndpoint,
    `${subscriptionId}/${service.id}/${e.id}`,
    e.endpointConnectionName ?? `Endpoint ${e.id}`,
    compact({
      status: e.status,
      subscriptionId,
      pscServiceId: service.id !== undefined ? String(service.id) : undefined,
      serviceStatus: service.status,
      connectionHostName: service.connectionHostName,
      gcpProjectId: e.gcpProjectId,
      gcpVpcName: e.gcpVpcName,
      gcpVpcSubnetName: e.gcpVpcSubnetName,
      endpointConnectionName: e.endpointConnectionName,
    }),
    subscriptionExternalId("pro", subscriptionId),
  );
}

export function mapAclRule(accountId: string, r: RcAclRule): ResourceInstance {
  return instance(
    accountId,
    T.aclRule,
    String(r.id ?? ""),
    r.name ?? `Rule ${r.id}`,
    compact({ name: r.name, rule: r.acl, isDefault: r.isDefault ?? false, status: r.status }),
  );
}

export function mapAclRole(accountId: string, r: RcAclRole): ResourceInstance {
  const dbNames = new Set<string>();
  for (const rule of r.redisRules ?? []) {
    for (const db of rule.databases ?? []) {
      dbNames.add(db.databaseName ?? String(db.databaseId ?? ""));
    }
  }
  const ruleSpec = (r.redisRules ?? [])
    .filter((x) => x.ruleName)
    .map((x) => ({
      ruleName: x.ruleName!,
      databases: (x.databases ?? [])
        .filter((d) => d.subscriptionId !== undefined && d.databaseId !== undefined)
        .map((d) => `${d.subscriptionId}/${d.databaseId}`),
    }));
  return instance(
    accountId,
    T.aclRole,
    String(r.id ?? ""),
    r.name ?? `Role ${r.id}`,
    compact({
      name: r.name,
      rules: (r.redisRules ?? [])
        .map((x) => x.ruleName)
        .filter(Boolean)
        .join(", "),
      databases: [...dbNames].filter(Boolean).join(", "),
      users: (r.users ?? [])
        .map((u) => u.name)
        .filter(Boolean)
        .join(", "),
      status: r.status,
      // Undeclared machine-readable copy: the edit prompt's defaults and the
      // Terraform mapping read it; the detail view renders the readable fields.
      ruleSpec: ruleSpec.length ? JSON.stringify(ruleSpec) : undefined,
    }),
  );
}

/** Parse the stored `ruleSpec` field of a role. */
export function parseRuleSpec(
  raw: string | number | boolean | undefined,
): Array<{ ruleName: string; databases: string[] }> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is { ruleName: string; databases: string[] } =>
        !!x &&
        typeof (x as { ruleName?: unknown }).ruleName === "string" &&
        Array.isArray((x as { databases?: unknown }).databases),
    );
  } catch {
    return [];
  }
}

export function mapAclUser(accountId: string, u: RcAclUser): ResourceInstance {
  return instance(
    accountId,
    T.aclUser,
    String(u.id ?? ""),
    u.name ?? `User ${u.id}`,
    compact({ name: u.name, role: u.role, status: u.status }),
  );
}

export function mapCloudAccount(accountId: string, c: RcCloudAccount): ResourceInstance {
  return instance(
    accountId,
    T.cloudAccount,
    String(c.id ?? ""),
    c.name ?? `Cloud account ${c.id}`,
    compact({
      name: c.name,
      provider: c.provider,
      status: c.status,
      accessKeyId: c.accessKeyId,
      signInLoginUrl: c.signInLoginUrl,
      awsConsoleRoleArn: c.awsConsoleRoleArn,
      awsUserArn: c.awsUserArn,
    }),
  );
}

export function mapAccount(
  accountId: string,
  a: RcAccount,
  paymentMethodCount: number | undefined,
): ResourceInstance {
  return instance(
    accountId,
    T.account,
    "account",
    a.name ?? "Redis Cloud account",
    compact({
      name: a.name,
      accountId: a.id !== undefined ? String(a.id) : undefined,
      marketplaceStatus: a.marketplaceStatus,
      keyName: a.key?.name,
      keyOwner: a.key?.owner?.email ?? a.key?.owner?.name,
      paymentMethods: paymentMethodCount,
    }),
  );
}
