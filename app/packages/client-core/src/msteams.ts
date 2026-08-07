import type { CloudFetch } from "./fetch";

/**
 * Microsoft Teams connection management. Server contract: org-scoped
 * `/api/org/:orgId/msteams/*` routes (see web `api/routes/msteams.ts`).
 *
 * A webhook is a *destination*, not a policy. Which alerts reach it is decided
 * by the org's routing rules (`alert-routing.ts`), which reference this row by
 * id — so the twelve trigger booleans a webhook used to carry are gone.
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

/**
 * A webhook is only renameable now. Which alerts reach it is an `alert_rules`
 * question — see `alert-routing.ts` — so the twelve trigger booleans this patch
 * used to carry are gone rather than moved.
 */
export async function updateMsTeamsWebhook(
  api: CloudFetch,
  orgId: string,
  webhookId: string,
  patch: { label?: string },
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
