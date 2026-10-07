import type { ResourceInstance } from "@infrawrench/plugin-base";
import { EDGE_DEPLOYMENTS } from "./api.js";
import type {
  AxAnnotation,
  AxCapabilities,
  AxDashboard,
  AxDataset,
  AxField,
  AxMonitor,
  AxNotifier,
  AxNotifierProperties,
  AxOrg,
  AxStarredQuery,
  AxToken,
  AxUser,
  AxView,
  AxVirtualField,
} from "./types.js";

export const PLUGIN_ID = "axiom";
export const APP_URL = "https://app.axiom.co";

export function resourceIdFor(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

type Value = string | number | boolean | null | undefined;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, Value>,
  extra: { parentResourceId?: string; resolvedOutputs?: Record<string, string> } = {},
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  const now = new Date().toISOString();
  return {
    id: resourceIdFor(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: extra.resolvedOutputs ?? {},
    secretStates: [],
    externalId,
    ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function edgeLabel(id: string | undefined): string {
  if (!id) return "";
  return EDGE_DEPLOYMENTS[id]?.label ?? id;
}

/** The ingest/query base URL of a dataset's edge deployment. */
export function datasetEdgeUrl(d: AxDataset, defaultEdge?: string): string {
  if (d.edgeDeploymentUrl) return d.edgeDeploymentUrl;
  const host = EDGE_DEPLOYMENTS[d.edgeDeployment ?? defaultEdge ?? ""]?.host;
  return host ? `https://${host}` : "";
}

export function mapOrganization(accountId: string, org: AxOrg): ResourceInstance {
  const l = org.license ?? {};
  return instance(
    accountId,
    "organization",
    org.id ?? "org",
    org.name ?? org.id ?? "Axiom",
    {
      name: org.name,
      plan: org.plan,
      paymentStatus: org.paymentStatus,
      defaultEdgeDeployment: edgeLabel(org.defaultEdgeDeployment),
      edgeDeployments: (l.edgeDeployments ?? []).map(edgeLabel).join(", "),
      billingPeriodStart: l.billingPeriodStart,
      billingPeriodEnd: l.billingPeriodEnd,
      monthlyIngestGb: l.monthlyIngestGb,
      monthlyQueryGbHours: l.monthlyQueryGbHours,
      maxDatasets: l.maxDatasets,
      maxMonitors: l.maxMonitors,
      maxUsers: l.maxUsers,
      maxFields: l.maxFields,
      primaryEmail: org.primaryEmail,
      orgId: org.id,
    },
    { resolvedOutputs: org.id ? { orgId: org.id } : {} },
  );
}

export function mapDataset(
  accountId: string,
  d: AxDataset,
  defaultEdge?: string,
): ResourceInstance {
  const id = d.id ?? d.name ?? "";
  const edgeUrl = datasetEdgeUrl(d, defaultEdge);
  return instance(
    accountId,
    "dataset",
    id,
    d.name ?? id,
    {
      name: d.name ?? id,
      description: d.description ?? "",
      useRetentionPeriod: d.useRetentionPeriod ?? false,
      retentionDays: d.retentionDays,
      kind: d.kind,
      edgeDeployment: edgeLabel(d.edgeDeployment ?? defaultEdge),
      mapFields: (d.mapFields ?? []).join(", "),
      createdBy: d.who,
      createdAt: d.created,
      updatedAt: d.updatedAt,
      sharedByOrg: d.sharedByOrg,
    },
    { resolvedOutputs: { name: d.name ?? id, ...(edgeUrl ? { edgeUrl } : {}) } },
  );
}

export function mapField(accountId: string, dataset: string, f: AxField): ResourceInstance {
  const name = f.name ?? "";
  return instance(
    accountId,
    "field",
    `${dataset}/${name}`,
    name,
    {
      name,
      type: f.type,
      unit: f.unit ?? "",
      description: f.description ?? "",
      hidden: f.hidden ?? false,
      dataset,
    },
    { parentResourceId: resourceIdFor(accountId, "dataset", dataset) },
  );
}

export function mapVirtualField(accountId: string, v: AxVirtualField): ResourceInstance {
  return instance(
    accountId,
    "virtual-field",
    v.id ?? v.name ?? "",
    v.name ?? v.id ?? "",
    {
      name: v.name,
      expression: v.expression,
      type: v.type ?? "",
      unit: v.unit ?? "",
      description: v.description ?? "",
      dataset: v.dataset,
    },
    v.dataset ? { parentResourceId: resourceIdFor(accountId, "dataset", v.dataset) } : {},
  );
}

export function mapMonitor(
  accountId: string,
  m: AxMonitor,
  notifierNames: Map<string, string>,
  state?: string,
): ResourceInstance {
  const ids = m.notifierIds ?? [];
  return instance(
    accountId,
    "monitor",
    m.id ?? "",
    m.name ?? m.id ?? "",
    {
      name: m.name,
      description: m.description ?? "",
      aplQuery: m.aplQuery ?? m.mplQuery ?? "",
      operator: m.operator ?? "",
      threshold: m.threshold,
      intervalMinutes: m.intervalMinutes,
      rangeMinutes: m.rangeMinutes,
      alertOnNoData: m.alertOnNoData ?? false,
      notifyByGroup: m.notifyByGroup ?? false,
      notifyEveryRun: m.notifyEveryRun ?? false,
      type: m.type,
      disabled: m.disabled ?? false,
      disabledUntil: m.disabledUntil,
      state,
      notifiers: ids.map((id) => notifierNames.get(id) ?? id).join(", "),
      notifierIds: ids.join(", "),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    },
    { resolvedOutputs: m.id ? { monitorId: m.id } : {} },
  );
}

/** Which channel a notifier uses, and its human-facing target. */
export function notifierChannel(p: AxNotifierProperties | undefined): {
  channel: string;
  target: string;
} {
  const props = p ?? {};
  if (props.email) return { channel: "email", target: (props.email.emails ?? []).join(", ") };
  if (props.slack) return { channel: "slack", target: props.slack.slackUrl ?? "" };
  if (props.pagerduty) return { channel: "pagerduty", target: "" };
  if (props.opsgenie) return { channel: "opsgenie", target: props.opsgenie.isEU ? "EU" : "" };
  if (props.microsoftTeams) {
    return { channel: "microsoftTeams", target: props.microsoftTeams.microsoftTeamsUrl ?? "" };
  }
  if (props.discordWebhook) {
    return { channel: "discordWebhook", target: props.discordWebhook.discordWebhookUrl ?? "" };
  }
  if (props.discord) return { channel: "discord", target: props.discord.discordChannel ?? "" };
  if (props.customWebhook)
    return { channel: "customWebhook", target: props.customWebhook.url ?? "" };
  if (props.webhook) return { channel: "webhook", target: props.webhook.url ?? "" };
  return { channel: "", target: "" };
}

/** Hide everything but the host of a URL (webhook URLs embed secrets). */
export function redactUrl(target: string): string {
  if (!/^https?:\/\//.test(target)) return target;
  try {
    return `${new URL(target).origin}/…`;
  } catch {
    return target;
  }
}

export function mapNotifier(accountId: string, n: AxNotifier): ResourceInstance {
  const { channel, target } = notifierChannel(n.properties);
  return instance(
    accountId,
    "notifier",
    n.id ?? "",
    n.name ?? n.id ?? "",
    {
      name: n.name,
      target: channel === "email" ? target : redactUrl(target),
      channel,
      disabledUntil: n.disabledUntil,
      createdBy: n.createdBy,
      createdAt: n.createdAt,
    },
    { resolvedOutputs: n.id ? { notifierId: n.id } : {} },
  );
}

export function mapDashboard(accountId: string, d: AxDashboard): ResourceInstance {
  const uid = d.uid ?? d.dashboard?.uid ?? d.id ?? "";
  const url = uid ? `${APP_URL}/dashboards/${encodeURIComponent(uid)}` : "";
  return instance(
    accountId,
    "dashboard",
    uid,
    d.dashboard?.name ?? uid,
    {
      name: d.dashboard?.name,
      description: d.dashboard?.description ?? "",
      charts: d.dashboard?.charts?.length ?? 0,
      owner: d.dashboard?.owner === "X-AXIOM-EVERYONE" ? "Everyone" : d.dashboard?.owner,
      uid,
      version: d.version,
      updatedAt: d.updatedAt,
      url,
    },
    { resolvedOutputs: { uid, ...(url ? { url } : {}) } },
  );
}

export function mapView(accountId: string, v: AxView): ResourceInstance {
  const id = v.id ?? v.name ?? "";
  return instance(accountId, "view", id, v.name ?? id, {
    name: v.name,
    aplQuery: v.aplQuery,
    description: v.description ?? "",
    datasets: (v.datasets ?? []).join(", "),
  });
}

export function mapStarredQuery(accountId: string, q: AxStarredQuery): ResourceInstance {
  return instance(accountId, "starred-query", q.id ?? "", q.name ?? q.id ?? "", {
    name: q.name,
    apl: q.query?.apl ?? "",
    dataset: q.dataset,
    who: q.who,
  });
}

export function mapAnnotation(accountId: string, a: AxAnnotation): ResourceInstance {
  const when = a.time ? a.time.slice(0, 16).replace("T", " ") : "";
  return instance(
    accountId,
    "annotation",
    a.id ?? "",
    `${a.title || a.type || "Annotation"}${when ? ` (${when})` : ""}`,
    {
      title: a.title ?? "",
      description: a.description ?? "",
      url: a.url ?? "",
      type: a.type,
      time: a.time,
      endTime: a.endTime,
      datasets: (a.datasets ?? []).join(", "),
    },
  );
}

export function capabilitiesText(c: AxCapabilities | undefined): string {
  return Object.entries(c ?? {})
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}: ${(v ?? []).join("/")}`)
    .join(", ");
}

export function mapToken(accountId: string, t: AxToken): ResourceInstance {
  const datasets = Object.entries(t.datasetCapabilities ?? {})
    .map(([ds, caps]) => `${ds} (${capabilitiesText(caps)})`)
    .join("; ");
  return instance(
    accountId,
    "api-token",
    t.id ?? "",
    t.name ?? t.id ?? "",
    {
      name: t.name,
      description: t.description ?? "",
      expiresAt: t.expiresAt,
      orgCapabilities: capabilitiesText(t.orgCapabilities),
      datasetCapabilities: datasets,
    },
    { resolvedOutputs: t.id ? { tokenId: t.id } : {} },
  );
}

export function mapUser(accountId: string, u: AxUser): ResourceInstance {
  return instance(
    accountId,
    "user",
    u.id ?? "",
    u.name || u.email || u.id || "",
    { name: u.name, email: u.email, role: u.role?.name ?? u.role?.id },
    { resolvedOutputs: u.email ? { email: u.email } : {} },
  );
}
