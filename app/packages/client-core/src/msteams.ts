import type { CloudFetch } from "./fetch";

/**
 * Microsoft Teams connection + per-channel alert routing. Server contract:
 * org-scoped `/api/org/:orgId/msteams/*` routes (see web `api/routes/msteams.ts`).
 *
 * A channel opts into each alert trigger independently — the same set Slack
 * channels have — so a channel can take budget crossings without also taking
 * every sync failure.
 *
 * Unlike Slack there is no install/OAuth step: Teams offers no app-only flow
 * for posting channel messages, so a channel is identified by the webhook URL
 * of a Teams "Workflows" automation. That URL is a bearer credential; the
 * server never returns it, so a webhook carries only a `urlHint` for display.
 */

export interface MsTeamsWebhook {
  id: string;
  /** User-supplied display name, e.g. `#alerts (Platform)`. */
  label: string;
  /** Non-secret hint at the stored URL, e.g. `contoso.webhook.office.com · …a7f2`. */
  urlHint: string;
  syncIncidents: boolean;
  budgetAlerts: boolean;
  /** Statistical spend-spike (cost anomaly) alerts. */
  anomalyAlerts: boolean;
  /** Metric threshold rule firings and recoveries. */
  metricAlerts: boolean;
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
  /** Critical/high security posture findings from the posture alert pass. */
  postureAlerts: boolean;
  /** Synthetic probe down/recovered transitions. */
  probeAlerts: boolean;
  /** The Monday-morning weekly summary (only sends when the org enables it). */
  weeklyDigest: boolean;
}

export interface MsTeamsStatus {
  webhooks: MsTeamsWebhook[];
}

export interface MsTeamsTestResult {
  ok: boolean;
  webhookCount: number;
  attempted: number;
  succeeded: number;
}

const EMPTY_STATUS: MsTeamsStatus = { webhooks: [] };

export async function getMsTeamsStatus(api: CloudFetch, orgId: string): Promise<MsTeamsStatus> {
  return (await api.org<MsTeamsStatus>(orgId, "/msteams/status")) ?? EMPTY_STATUS;
}

export interface AddMsTeamsWebhookArgs {
  label: string;
  /** The full webhook URL copied out of the Teams Workflows automation. */
  url: string;
  syncIncidents?: boolean;
  budgetAlerts?: boolean;
  anomalyAlerts?: boolean;
  metricAlerts?: boolean;
  resourceDrift?: boolean;
  workflowPages?: boolean;
  providerIncidents?: boolean;
  expiryAlerts?: boolean;
  logMatchAlerts?: boolean;
  postureAlerts?: boolean;
  probeAlerts?: boolean;
  weeklyDigest?: boolean;
}

export async function addMsTeamsWebhook(
  api: CloudFetch,
  orgId: string,
  args: AddMsTeamsWebhookArgs,
): Promise<MsTeamsWebhook | null> {
  return api.org<MsTeamsWebhook>(orgId, "/msteams/webhooks", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export type MsTeamsWebhookTriggers = Pick<
  MsTeamsWebhook,
  | "syncIncidents"
  | "budgetAlerts"
  | "anomalyAlerts"
  | "metricAlerts"
  | "resourceDrift"
  | "workflowPages"
  | "providerIncidents"
  | "expiryAlerts"
  | "logMatchAlerts"
  | "postureAlerts"
  | "probeAlerts"
  | "weeklyDigest"
>;

export async function updateMsTeamsWebhook(
  api: CloudFetch,
  orgId: string,
  webhookId: string,
  patch: Partial<MsTeamsWebhookTriggers & { label: string }>,
): Promise<MsTeamsWebhook | null> {
  return api.org<MsTeamsWebhook>(orgId, `/msteams/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function removeMsTeamsWebhook(
  api: CloudFetch,
  orgId: string,
  webhookId: string,
): Promise<void> {
  await api.org(orgId, `/msteams/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
  });
}

export async function sendMsTeamsTestMessage(
  api: CloudFetch,
  orgId: string,
): Promise<MsTeamsTestResult | null> {
  return api.org<MsTeamsTestResult>(orgId, "/msteams/test", { method: "POST" });
}
