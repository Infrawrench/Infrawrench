import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  CvCustomDomain,
  CvDeployKey,
  CvDeployment,
  CvLogStream,
  CvProject,
  CvUsage,
  CvUsageLimit,
} from "./api.js";

type Fields = ResourceInstance["fields"];

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  opts: { parentTypeId?: string; parentExternalId?: string; createdAt?: string } = {},
): ResourceInstance {
  const clean: Fields = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "convex",
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(opts.parentTypeId && opts.parentExternalId
      ? { parentResourceId: `${accountId}:${opts.parentTypeId}:${opts.parentExternalId}` }
      : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
  };
}

export function iso(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
}

/** `https://x.convex.cloud` → `https://x.convex.site` (HTTP actions live on .site). */
export function siteUrlOf(deploymentUrl: string): string {
  return deploymentUrl.replace(/\.convex\.cloud(\/|$)/, ".convex.site$1");
}

export function toProject(p: CvProject, accountId: string): ResourceInstance {
  const createdAt = iso(p.createTime);
  return instance(
    accountId,
    "convex-project",
    String(p.id),
    p.name,
    {
      name: p.name,
      slug: p.slug,
      projectId: p.id,
      teamSlug: p.teamSlug,
      prodDeploymentName: p.prodDeploymentName ?? "",
      createdAt,
    },
    { createdAt },
  );
}

export function toDeployment(
  d: CvDeployment,
  accountId: string,
  projectSlug?: string,
): ResourceInstance {
  const createdAt = iso(d.createTime);
  const url = d.deploymentUrl ?? `https://${d.name}.convex.cloud`;
  const label = d.reference && d.reference !== d.name ? `${d.name} (${d.reference})` : d.name;
  return instance(
    accountId,
    "convex-deployment",
    d.name,
    label,
    {
      name: d.name,
      projectId: d.projectId,
      projectSlug: projectSlug ?? "",
      deploymentType: d.deploymentType,
      region: d.region ?? "",
      class: d.class ?? "",
      reference: d.reference ?? "",
      isDefault: d.isDefault ?? false,
      dashboardEditConfirmation: d.dashboardEditConfirmation ?? undefined,
      sendLogsToClient: d.sendLogsToClient ?? undefined,
      expiresAt: iso(d.expiresAt),
      deploymentUrl: url,
      siteUrl: siteUrlOf(url),
      previewIdentifier: d.previewIdentifier ?? "",
      lastDeployAt: iso(d.lastDeployTime),
      createdAt,
    },
    { parentTypeId: "convex-project", parentExternalId: String(d.projectId), createdAt },
  );
}

function managed(k: CvDeployKey): boolean {
  return k.managedBy !== null && k.managedBy !== undefined;
}

export function toDeployKey(
  k: CvDeployKey,
  deployment: string,
  accountId: string,
): ResourceInstance {
  const createdAt = iso(k.creationTime);
  return instance(
    accountId,
    "convex-deploy-key",
    `${deployment}/${k.id}`,
    k.name,
    {
      name: k.name,
      deploymentName: deployment,
      allowedActions: k.allowedActions.map((a) => a.replace(/^deployment:/, "")).join(", "),
      managed: managed(k),
      createdAt,
      lastUsedAt: iso(k.lastUsedTime),
      expiresAt: iso(k.expiresAt),
    },
    { parentTypeId: "convex-deployment", parentExternalId: deployment, createdAt },
  );
}

export function toPreviewKey(
  k: CvDeployKey,
  projectId: number,
  accountId: string,
): ResourceInstance {
  const createdAt = iso(k.creationTime);
  return instance(
    accountId,
    "convex-preview-deploy-key",
    `${projectId}/${k.id}`,
    k.name,
    {
      name: k.name,
      projectId,
      managed: managed(k),
      createdAt,
      lastUsedAt: iso(k.lastUsedTime),
      expiresAt: iso(k.expiresAt),
    },
    { parentTypeId: "convex-project", parentExternalId: String(projectId), createdAt },
  );
}

export function toCustomDomain(cd: CvCustomDomain, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "convex-custom-domain",
    `${cd.deploymentName}/${cd.requestDestination}/${cd.domain}`,
    cd.domain,
    {
      domain: cd.domain,
      deploymentName: cd.deploymentName,
      requestDestination: cd.requestDestination,
      verified: typeof cd.verificationTime === "number",
      verifiedAt: iso(cd.verificationTime),
      createdAt: iso(cd.creationTime),
    },
    { parentTypeId: "convex-deployment", parentExternalId: cd.deploymentName },
  );
}

const STREAM_NAMES: Record<string, string> = {
  datadog: "Datadog",
  webhook: "Webhook",
  axiom: "Axiom",
  sentry: "Sentry",
  postHogLogs: "PostHog Logs",
  postHogErrorTracking: "PostHog Error Tracking",
  s3Export: "S3 export",
};

export function streamName(type: string): string {
  return STREAM_NAMES[type] ?? type;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function toLogStream(
  s: CvLogStream,
  deployment: string,
  accountId: string,
): ResourceInstance {
  const target =
    str(s["url"]) ||
    str(s["datasetName"]) ||
    (s["siteLocation"] ? `Datadog ${str(s["siteLocation"])}` : "") ||
    (s["bucket"] ? `s3://${str(s["bucket"])}/${str(s["prefix"])}` : "") ||
    str(s["host"]);
  const topics = Array.isArray(s["topics"])
    ? (s["topics"] as unknown[]).map(String).join(", ")
    : "";
  return instance(
    accountId,
    "convex-log-stream",
    `${deployment}/${s.id}`,
    `${streamName(s.logStreamType)}${target ? ` → ${target}` : ""}`,
    {
      streamType: s.logStreamType,
      deploymentName: deployment,
      status: s.status.type,
      failureReason: s.status.type === "failed" ? s.status.reason : "",
      target,
      url: str(s["url"]),
      format: str(s["format"]),
      service: str(s["service"]),
      datasetName: str(s["datasetName"]),
      topics,
    },
    { parentTypeId: "convex-deployment", parentExternalId: deployment },
  );
}

export function toUsageLimit(
  l: CvUsageLimit,
  deployment: string,
  accountId: string,
  usage?: CvUsage,
): ResourceInstance {
  const m = usage?.metrics?.[l.metric];
  return instance(
    accountId,
    "convex-usage-limit",
    `${deployment}/${l.id}`,
    `${l.metric} ≤ ${l.limit} per ${l.window}`,
    {
      metric: l.metric,
      deploymentName: deployment,
      window: l.window,
      limitType: l.limitType,
      limit: l.limit,
      enabled: l.enabled,
      currentUsage: m
        ? l.window === "day"
          ? m.usage.current_day
          : m.usage.current_month
        : undefined,
    },
    { parentTypeId: "convex-deployment", parentExternalId: deployment },
  );
}
