import type { CloudFetch } from "./fetch";

/**
 * Slack connection + per-channel alert routing. Server contract: org-scoped
 * `/api/org/:orgId/slack/*` routes (see web `api/routes/slack.ts`).
 *
 * A channel opts into each alert trigger independently — the five mobile push
 * has, plus the channel-only weekly digest — so a channel can take budget
 * crossings without also taking every sync failure.
 */

export interface SlackInstallation {
  id: string;
  /** Slack workspace id (`T…`). */
  teamId: string;
  teamName: string | null;
}

export interface SlackChannel {
  id: string;
  installationId: string;
  /** Slack channel id (`C…`/`G…`). */
  channelId: string;
  /** Channel name without the leading `#`. */
  channelName: string;
  isPrivate: boolean;
  syncIncidents: boolean;
  budgetAlerts: boolean;
  /** Statistical spend-spike (cost anomaly) alerts. */
  anomalyAlerts: boolean;
  /** Batched resource-drift digests from the change timeline. Defaults off. */
  resourceDrift: boolean;
  /** Pages and approval requests raised by a workflow or by `POST /pages`. */
  workflowPages: boolean;
  /** A provider status-page incident overlaps resources the org holds. */
  providerIncidents: boolean;
  /** Daily digests of approaching resource deadlines (certs, domains, keys). */
  expiryAlerts: boolean;
  /** Saved log-query matches from the log workspace alert pass. */
  logMatchAlerts: boolean;
  /** The Monday-morning weekly summary (only sends when the org enables it). */
  weeklyDigest: boolean;
}

export interface SlackStatus {
  /** False when the deployment has no Slack app registered at all. */
  configured: boolean;
  installations: SlackInstallation[];
  channels: SlackChannel[];
}

/** A channel the connected workspace can see, for the picker. */
export interface SlackAvailableChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface SlackTestResult {
  ok: boolean;
  channelCount: number;
  attempted: number;
  succeeded: number;
}

const EMPTY_STATUS: SlackStatus = { configured: false, installations: [], channels: [] };

export async function getSlackStatus(api: CloudFetch, orgId: string): Promise<SlackStatus> {
  return (await api.org<SlackStatus>(orgId, "/slack/status")) ?? EMPTY_STATUS;
}

/**
 * The "Add to Slack" URL. Open it in a browser: Slack redirects back to the
 * server's OAuth callback, which records the install against this org.
 */
export async function getSlackInstallUrl(api: CloudFetch, orgId: string): Promise<string | null> {
  const res = await api.org<{ url: string }>(orgId, "/slack/install-url");
  return res?.url ?? null;
}

export async function listAvailableSlackChannels(
  api: CloudFetch,
  orgId: string,
  installationId: string,
): Promise<SlackAvailableChannel[]> {
  const res = await api.org<{ channels: SlackAvailableChannel[] }>(
    orgId,
    `/slack/installations/${encodeURIComponent(installationId)}/available-channels`,
  );
  return res?.channels ?? [];
}

export interface AddSlackChannelArgs {
  installationId: string;
  channelId: string;
  channelName: string;
  isPrivate?: boolean;
  syncIncidents?: boolean;
  budgetAlerts?: boolean;
  anomalyAlerts?: boolean;
  resourceDrift?: boolean;
  workflowPages?: boolean;
  providerIncidents?: boolean;
  expiryAlerts?: boolean;
  logMatchAlerts?: boolean;
  weeklyDigest?: boolean;
}

export async function addSlackChannel(
  api: CloudFetch,
  orgId: string,
  args: AddSlackChannelArgs,
): Promise<SlackChannel | null> {
  return api.org<SlackChannel>(orgId, "/slack/channels", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export type SlackChannelTriggers = Pick<
  SlackChannel,
  | "syncIncidents"
  | "budgetAlerts"
  | "anomalyAlerts"
  | "resourceDrift"
  | "workflowPages"
  | "providerIncidents"
  | "expiryAlerts"
  | "logMatchAlerts"
  | "weeklyDigest"
>;

export async function updateSlackChannel(
  api: CloudFetch,
  orgId: string,
  channelId: string,
  patch: Partial<SlackChannelTriggers>,
): Promise<SlackChannel | null> {
  return api.org<SlackChannel>(orgId, `/slack/channels/${encodeURIComponent(channelId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function removeSlackChannel(
  api: CloudFetch,
  orgId: string,
  channelId: string,
): Promise<void> {
  await api.org(orgId, `/slack/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
}

export async function disconnectSlackWorkspace(
  api: CloudFetch,
  orgId: string,
  installationId: string,
): Promise<void> {
  await api.org(orgId, `/slack/installations/${encodeURIComponent(installationId)}`, {
    method: "DELETE",
  });
}

export async function sendSlackTestMessage(
  api: CloudFetch,
  orgId: string,
): Promise<SlackTestResult | null> {
  return api.org<SlackTestResult>(orgId, "/slack/test", { method: "POST" });
}
