import type { ResourceInstance } from "@infrawrench/plugin-base";
import { makeInstance } from "./kit.js";
import type {
  KyApp,
  KyDefinition,
  KyDeployment,
  KyDomain,
  KyInstance,
  KyOrganization,
  KyProject,
  KySecret,
  KyService,
  KySnapshot,
  KyVolume,
} from "./types.js";

/** Pure mapping from Koyeb payloads to host resource instances. */

export function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function appHost(app: Pick<KyApp, "domains"> | undefined): string {
  const domains = app?.domains ?? [];
  return (
    (domains.find((d) => d.type === "CUSTOM" && d.status === "ACTIVE") ?? domains[0])?.name ?? ""
  );
}

export function mapOrganization(
  o: KyOrganization,
  extra: { budgetCents?: number; apps?: number; services?: number; instances?: number },
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "organization",
    externalId: o.id,
    displayName: o.name,
    fields: {
      name: o.name,
      plan: o.plan ?? "",
      status: o.status ?? "",
      statusMessage: o.status_message ?? "",
      ...(o.has_payment_method !== undefined ? { hasPaymentMethod: o.has_payment_method } : {}),
      trialEndsAt: o.trialing ? (o.trial_ends_at ?? "") : "",
      ...(extra.budgetCents !== undefined ? { spendingAlert: extra.budgetCents / 100 } : {}),
      ...(extra.apps !== undefined ? { apps: extra.apps } : {}),
      ...(extra.services !== undefined ? { services: extra.services } : {}),
      ...(extra.instances !== undefined ? { instances: extra.instances } : {}),
    },
    outputs: { organizationId: o.id },
  });
}

export function mapProject(p: KyProject, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "project",
    externalId: p.id,
    displayName: p.name,
    fields: {
      name: p.name,
      description: p.description ?? "",
      ...(num(p.service_count) !== undefined ? { serviceCount: num(p.service_count)! } : {}),
      createdAt: p.created_at ?? "",
    },
    outputs: { projectId: p.id },
    ...(p.created_at ? { createdAt: p.created_at } : {}),
  });
}

export function mapApp(a: KyApp, accountId: string): ResourceInstance {
  const host = appHost(a);
  return makeInstance({
    accountId,
    typeId: "app",
    externalId: a.id,
    displayName: a.name,
    fields: {
      name: a.name,
      status: a.status ?? "",
      domains: (a.domains ?? []).map((d) => d.name).join(", "),
      messages: (a.messages ?? []).join("; "),
      pausedAt: a.status === "PAUSED" ? (a.paused_at ?? "") : "",
      createdAt: a.created_at ?? "",
    },
    outputs: { appId: a.id, hostname: host, url: host ? `https://${host}` : "" },
    ...(a.created_at ? { createdAt: a.created_at } : {}),
    ...(a.updated_at ? { updatedAt: a.updated_at } : {}),
  });
}

function scaling(def: KyDefinition | undefined): { min?: number; max?: number } {
  const s = def?.scalings?.find((x) => !x.scopes?.length) ?? def?.scalings?.[0];
  return {
    ...(s?.min !== undefined ? { min: Number(s.min) } : {}),
    ...(s?.max !== undefined ? { max: Number(s.max) } : {}),
  };
}

export function mapService(
  s: KyService,
  app: Pick<KyApp, "name" | "domains"> | undefined,
  latest: KyDeployment | undefined,
  accountId: string,
): ResourceInstance {
  const def = latest?.definition;
  const sc = scaling(def);
  const db = def?.database?.neon_postgres;
  const dbInfo = latest?.database_info?.neon_postgres;
  const host = appHost(app);
  const path = def?.routes?.[0]?.path ?? "/";
  const url = s.type === "WEB" && host ? `https://${host}${path === "/" ? "" : path}` : "";
  const regions = def?.regions ?? (db?.region ? [db.region] : []);
  const sizeMb = num(dbInfo?.default_branch_logical_size);
  return makeInstance({
    accountId,
    typeId: "service",
    externalId: s.id,
    displayName: s.name,
    fields: {
      name: s.name,
      type: s.type ?? "",
      status: s.status ?? "",
      region: regions[0] ?? "",
      regions: regions.join(", "),
      instanceType: def?.instance_types?.[0]?.type ?? db?.instance_type ?? "",
      ...(sc.min !== undefined ? { minScale: sc.min } : {}),
      ...(sc.max !== undefined ? { maxScale: sc.max } : {}),
      image: def?.docker?.image ?? "",
      repository: def?.git?.repository ?? "",
      branch: def?.git?.branch ?? "",
      buildCommand: def?.git?.buildpack?.build_command ?? def?.git?.build_command ?? "",
      runCommand:
        def?.git?.buildpack?.run_command ?? def?.git?.run_command ?? def?.docker?.command ?? "",
      ports: (def?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? "http"}`).join(", "),
      routes: (def?.routes ?? []).map((r) => `${r.path ?? "/"} → ${r.port}`).join(", "),
      ...(def?.env ? { envCount: def.env.length } : {}),
      ...(db?.pg_version ? { pgVersion: db.pg_version } : {}),
      dbHost: dbInfo?.server_host ?? "",
      dbState: dbInfo?.endpoint_state ?? "",
      ...(sizeMb !== undefined ? { dbSizeMb: Math.round(sizeMb / 1_048_576) } : {}),
      activeDeploymentId: s.active_deployment_id ?? "",
      latestDeploymentId: s.latest_deployment_id ?? "",
      appId: s.app_id,
      appName: app?.name ?? "",
      messages: (s.messages ?? []).join("; "),
      createdAt: s.created_at ?? "",
    },
    outputs: {
      serviceId: s.id,
      url,
      privateHost: app?.name ? `${s.name}.${app.name}.internal` : "",
    },
    parentTypeId: "app",
    parentExternalId: s.app_id,
    ...(s.created_at ? { createdAt: s.created_at } : {}),
    ...(s.updated_at ? { updatedAt: s.updated_at } : {}),
  });
}

export function mapDeployment(
  d: KyDeployment,
  activeId: string,
  accountId: string,
): ResourceInstance {
  const sha =
    d.provisioning_info?.sha || d.metadata?.trigger?.git?.sha || d.definition?.git?.sha || "";
  const message = (d.metadata?.trigger?.git?.message ?? "").split("\n")[0] ?? "";
  const image = d.provisioning_info?.image || d.definition?.docker?.image || "";
  return makeInstance({
    accountId,
    typeId: "deployment",
    externalId: d.id,
    displayName:
      [sha.slice(0, 7), message].filter(Boolean).join(" ") ||
      image ||
      `v${d.version ?? ""}` ||
      d.id,
    fields: {
      status: d.status ?? "",
      trigger: (d.metadata?.trigger?.type ?? "").toLowerCase(),
      sha,
      commitMessage: message,
      image,
      active: d.id === activeId,
      messages: (d.messages ?? []).join("; "),
      serviceId: d.service_id ?? "",
      appId: d.app_id ?? "",
      createdAt: d.created_at ?? "",
      succeededAt: d.succeeded_at ?? "",
    },
    outputs: { deploymentId: d.id },
    parentTypeId: "service",
    parentExternalId: d.service_id ?? "",
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapInstance(i: KyInstance, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "instance",
    externalId: i.id,
    displayName: `${i.type ?? "instance"} ${i.region ?? ""} #${i.replica_index ?? 0}`.trim(),
    fields: {
      status: i.status ?? "",
      type: i.type ?? "",
      region: i.region ?? "",
      datacenter: i.datacenter ?? "",
      ...(i.replica_index !== undefined ? { replicaIndex: Number(i.replica_index) } : {}),
      messages: (i.messages ?? []).join("; "),
      serviceId: i.service_id ?? "",
      createdAt: i.created_at ?? "",
    },
    parentTypeId: "service",
    parentExternalId: i.service_id ?? "",
    ...(i.created_at ? { createdAt: i.created_at } : {}),
  });
}

function registryOf(s: KySecret): string {
  if (s.docker_hub_registry) return "Docker Hub";
  if (s.github_registry) return "GitHub";
  if (s.gitlab_registry) return "GitLab";
  if (s.digital_ocean_registry) return "DigitalOcean";
  if (s.gcp_container_registry) return "Google Artifact Registry";
  if (s.azure_container_registry) return "Azure Container Registry";
  if (s.private_registry) return s.private_registry.url ?? "Private registry";
  return "";
}

export function mapSecret(s: KySecret, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "secret",
    externalId: s.id,
    displayName: s.name,
    fields: {
      name: s.name,
      type: s.type ?? "",
      registry: registryOf(s),
      createdAt: s.created_at ?? "",
      updatedAt: s.updated_at ?? "",
    },
    outputs: { secretName: s.name },
    ...(s.created_at ? { createdAt: s.created_at } : {}),
  });
}

export function mapDomain(
  d: KyDomain,
  appNames: Map<string, string>,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "domain",
    externalId: d.id,
    displayName: d.name,
    fields: {
      name: d.name,
      type: d.type ?? "",
      status: d.status ?? "",
      intendedCname: d.intended_cname ?? "",
      appId: d.app_id ?? "",
      appName: d.app_id ? (appNames.get(d.app_id) ?? "") : "",
      verifiedAt: d.verified_at ?? "",
      messages: (d.messages ?? []).join("; "),
      createdAt: d.created_at ?? "",
    },
    outputs: { hostname: d.name, url: `https://${d.name}`, cnameTarget: d.intended_cname ?? "" },
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapVolume(v: KyVolume, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "volume",
    externalId: v.id,
    displayName: v.name,
    fields: {
      name: v.name,
      region: v.region ?? "",
      ...(num(v.max_size) !== undefined ? { sizeGb: num(v.max_size)! } : {}),
      ...(num(v.cur_size) !== undefined ? { usedGb: num(v.cur_size)! } : {}),
      status: (v.status ?? "").replace("PERSISTENT_VOLUME_STATUS_", "").toLowerCase(),
      ...(v.read_only !== undefined ? { readOnly: v.read_only } : {}),
      serviceId: v.service_id ?? "",
      snapshotId: v.snapshot_id ?? "",
      createdAt: v.created_at ?? "",
    },
    outputs: { volumeId: v.id },
    ...(v.created_at ? { createdAt: v.created_at } : {}),
  });
}

export function mapSnapshot(s: KySnapshot, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "snapshot",
    externalId: s.id,
    displayName: s.name || s.id,
    fields: {
      name: s.name,
      status: (s.status ?? "").replace("SNAPSHOT_STATUS_", "").toLowerCase(),
      type: (s.type ?? "").replace("SNAPSHOT_TYPE_", "").toLowerCase(),
      ...(num(s.size) !== undefined ? { size: num(s.size)! } : {}),
      region: s.region ?? "",
      parentVolumeId: s.parent_volume_id ?? "",
      createdAt: s.created_at ?? "",
    },
    ...(s.created_at ? { createdAt: s.created_at } : {}),
  });
}
