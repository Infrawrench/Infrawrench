/** API response → `ResourceInstance` mapping for every Grafana Cloud type. */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  GcAccessPolicy,
  GcMember,
  GcOrg,
  GcStack,
  GcStackPlugin,
  GcToken,
  GfAlertRule,
  GfContactPoint,
  GfDashboardHit,
  GfDatasource,
  SmCheck,
} from "./types.js";

export const PLUGIN_ID = "grafana-cloud";

type FieldValue = string | number | boolean | undefined | null;

export function resourceIdFor(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parentResourceId?: string,
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: resourceIdFor(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    ...(parentResourceId ? { parentResourceId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export function formatLabels(labels: Record<string, string> | null | undefined): string {
  return Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** `team=platform, env=prod` → `{ team: "platform", env: "prod" }`. */
export function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) throw new Error(`Label "${trimmed}" must be written key=value.`);
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const idText = (v: number | undefined): string | undefined =>
  v === undefined || v === null || v === 0 ? undefined : String(v);

export function mapOrganization(
  accountId: string,
  org: GcOrg,
  extra: { monthToDate?: number; stackCount?: number } = {},
): ResourceInstance {
  const slug = org.slug ?? str(org.id);
  const current = org.subscriptions?.current;
  return instance(
    accountId,
    "organization",
    slug,
    org.name ?? slug,
    {
      name: org.name ?? slug,
      slug,
      plan: current?.publicName ?? current?.product ?? current?.plan ?? undefined,
      trial: current?.isTrial === true ? true : undefined,
      trialEndsAt: current?.isTrial ? (current.endDate ?? org.trialEndDate) : undefined,
      contractType: org.contractType,
      monthToDate: extra.monthToDate,
      stackCount: extra.stackCount,
      createdAt: org.createdAt,
      orgId: idText(org.id),
    },
    { slug, orgId: idText(org.id) },
  );
}

export function mapStack(
  accountId: string,
  s: GcStack,
  opts: { connected?: boolean } = {},
): ResourceInstance {
  const slug = s.slug ?? str(s.id);
  return instance(
    accountId,
    "stack",
    slug,
    s.name ?? slug,
    {
      name: s.name ?? slug,
      description: s.description,
      labels: formatLabels(s.labels),
      deleteProtection: s.deleteProtection === true,
      slug,
      url: s.url,
      region: s.regionSlug,
      regionName: s.regionPublicName,
      provider: s.provider,
      status: s.status,
      plan: s.planName ?? s.plan,
      version: s.runningVersion ?? s.version,
      dashboards: s.dashboardCnt,
      alerts: s.alertCnt,
      activeUsers: s.currentActiveUsers,
      activeSeries: s.hmInstancePromCurrentActiveSeries,
      logsUsage: s.hlInstanceCurrentUsage,
      tracesUsage: s.htInstanceCurrentUsage,
      profilesUsage: s.hpInstanceCurrentUsage,
      connected: opts.connected === true,
      stackId: idText(s.id),
      createdAt: s.createdAt,
      // Kept for the metric queries and the Synthetic Monitoring client.
      promInstanceId: idText(s.hmInstancePromId),
      logsInstanceId: idText(s.hlInstanceId),
      tracesInstanceId: idText(s.htInstanceId),
      smApiUrl: s.regionSyntheticMonitoringApiUrl,
      orgId: idText(s.orgId),
    },
    {
      url: s.url,
      prometheusUrl: s.hmInstancePromUrl,
      prometheusUser: idText(s.hmInstancePromId),
      lokiUrl: s.hlInstanceUrl,
      lokiUser: idText(s.hlInstanceId),
      tempoUrl: s.htInstanceUrl,
      tempoUser: idText(s.htInstanceId),
      pyroscopeUrl: s.hpInstanceUrl,
      alertmanagerUrl: s.amInstanceUrl,
      stackId: idText(s.id),
    },
  );
}

export function mapStackPlugin(
  accountId: string,
  stackSlug: string,
  p: GcStackPlugin,
): ResourceInstance {
  const pluginSlug = p.pluginSlug ?? str(p.pluginId);
  const version = p.version ?? "";
  const latest = p.latestVersion ?? "";
  return instance(
    accountId,
    "stack-plugin",
    `${stackSlug}/${pluginSlug}`,
    p.pluginName ?? pluginSlug,
    {
      pluginName: p.pluginName ?? pluginSlug,
      pluginSlug,
      version,
      latestVersion: latest,
      updateAvailable: Boolean(version && latest && version !== latest),
      stack: stackSlug,
      installedAt: p.createdAt,
    },
    {},
    resourceIdFor(accountId, "stack", stackSlug),
  );
}

function describeRealms(p: GcAccessPolicy, stackNames: Map<string, string>): string {
  return (p.realms ?? [])
    .map((r) => {
      if (r.type === "org") return "Whole organization";
      const id = str(r.identifier);
      return `Stack ${stackNames.get(id) ?? id}`;
    })
    .join(", ");
}

export function mapAccessPolicy(
  accountId: string,
  region: string,
  p: GcAccessPolicy,
  stackNames: Map<string, string>,
): ResourceInstance {
  const id = p.id ?? "";
  return instance(
    accountId,
    "access-policy",
    `${region}/${id}`,
    p.displayName || p.name || id,
    {
      displayName: p.displayName || p.name,
      status: p.status,
      name: p.name,
      scopes: (p.scopes ?? []).join(", "),
      realms: describeRealms(p, stackNames),
      allowedSubnets: (p.conditions?.allowedSubnets ?? []).join(", "),
      region,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      policyId: id,
    },
    { policyId: id },
  );
}

export function mapToken(
  accountId: string,
  region: string,
  t: GcToken,
  policyNames: Map<string, string>,
): ResourceInstance {
  const id = t.id ?? "";
  const policyId = t.accessPolicyId ?? "";
  return instance(
    accountId,
    "access-policy-token",
    `${region}/${id}`,
    t.displayName || t.name || id,
    {
      displayName: t.displayName || t.name,
      name: t.name,
      policyName: policyNames.get(policyId),
      // The dependency rule matches the policy's external id, which is region-qualified.
      policyId: policyId ? `${region}/${policyId}` : undefined,
      expiresAt: t.expiresAt,
      firstUsedAt: t.firstUsedAt,
      lastUsedAt: t.lastUsedAt,
      region,
      createdAt: t.createdAt,
    },
  );
}

export function mapMember(accountId: string, m: GcMember): ResourceInstance {
  const username = m.userUsername ?? str(m.userId);
  return instance(accountId, "member", username, m.userName || m.userEmail || username, {
    role: m.role,
    name: m.userName,
    email: m.userEmail,
    username,
    mfaEnabled: m.mfaEnabled,
    joinedAt: m.createdAt,
  });
}

function absolute(baseUrl: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function mapDashboard(
  accountId: string,
  stack: { slug: string; url: string },
  d: GfDashboardHit,
): ResourceInstance {
  const uid = d.uid ?? str(d.id);
  const url = absolute(stack.url, d.url);
  return instance(
    accountId,
    "dashboard",
    `${stack.slug}/${uid}`,
    d.title ?? uid,
    {
      title: d.title ?? uid,
      folder: d.folderTitle,
      tags: (d.tags ?? []).join(", "),
      starred: d.isStarred === true,
      url,
      uid,
      stack: stack.slug,
    },
    { url },
    resourceIdFor(accountId, "stack", stack.slug),
  );
}

export function mapAlertRule(
  accountId: string,
  stack: { slug: string; url: string },
  r: GfAlertRule,
  folders: Map<string, string>,
): ResourceInstance {
  const uid = r.uid ?? str(r.id);
  return instance(
    accountId,
    "alert-rule",
    `${stack.slug}/${uid}`,
    r.title ?? uid,
    {
      title: r.title ?? uid,
      folder: r.folderUID ? (folders.get(r.folderUID) ?? r.folderUID) : undefined,
      ruleGroup: r.ruleGroup,
      paused: r.isPaused === true,
      pendingPeriod: r.for,
      noDataState: r.noDataState,
      execErrState: r.execErrState,
      labels: formatLabels(r.labels),
      summary: r.annotations?.["summary"],
      provenance: r.provenance,
      updatedAt: r.updated,
      url: absolute(stack.url, `/alerting/grafana/${encodeURIComponent(uid)}/view`),
      uid,
      stack: stack.slug,
      folderUid: r.folderUID,
    },
    {},
    resourceIdFor(accountId, "stack", stack.slug),
  );
}

export function mapContactPoint(
  accountId: string,
  stack: { slug: string; url: string },
  c: GfContactPoint,
): ResourceInstance {
  const uid = c.uid ?? "";
  return instance(
    accountId,
    "contact-point",
    `${stack.slug}/${uid}`,
    c.name ? `${c.name}${c.type ? ` (${c.type})` : ""}` : uid,
    {
      name: c.name,
      type: c.type,
      disableResolveMessage: c.disableResolveMessage === true,
      provenance: c.provenance,
      uid,
      stack: stack.slug,
    },
    {},
    resourceIdFor(accountId, "stack", stack.slug),
  );
}

export function mapDatasource(
  accountId: string,
  stack: { slug: string; url: string },
  d: GfDatasource,
): ResourceInstance {
  const uid = d.uid ?? str(d.id);
  return instance(
    accountId,
    "datasource",
    `${stack.slug}/${uid}`,
    d.name ?? uid,
    {
      name: d.name ?? uid,
      type: d.typeName ?? d.type,
      url: d.url,
      access: d.access,
      isDefault: d.isDefault === true,
      readOnly: d.readOnly === true,
      grafanaUrl: absolute(stack.url, `/connections/datasources/edit/${encodeURIComponent(uid)}`),
      uid,
      stack: stack.slug,
    },
    {},
    resourceIdFor(accountId, "stack", stack.slug),
  );
}

/** The check type is the single key of `settings` (`http`, `ping`, `dns`, ...). */
export function checkType(c: SmCheck): string {
  return Object.keys(c.settings ?? {})[0] ?? "";
}

export function mapSyntheticCheck(
  accountId: string,
  stack: { slug: string; url: string },
  c: SmCheck,
  probeNames: Map<number, string>,
): ResourceInstance {
  const id = str(c.id);
  return instance(
    accountId,
    "synthetic-check",
    `${stack.slug}/${id}`,
    c.job ? `${c.job}` : id,
    {
      job: c.job,
      target: c.target,
      type: checkType(c),
      enabled: c.enabled === true,
      frequencySeconds: typeof c.frequency === "number" ? c.frequency / 1000 : undefined,
      timeoutSeconds: typeof c.timeout === "number" ? c.timeout / 1000 : undefined,
      probes: (c.probes ?? []).map((p) => probeNames.get(p) ?? String(p)).join(", "),
      labels: (c.labels ?? []).map((l) => `${str(l.name)}=${str(l.value)}`).join(", "),
      checkId: id,
      stack: stack.slug,
    },
    {},
    resourceIdFor(accountId, "stack", stack.slug),
  );
}
