import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type { PolicyCreateParams } from "cloudflare/resources/alerting/policies";

/**
 * Cloudflare Notification policies (`/accounts/{id}/alerting/v3/policies`) — the
 * account-level alerting rules that fan an `alert_type` out to delivery
 * mechanisms (email / webhook / PagerDuty). We model the common email-delivery
 * case in the create form; richer mechanisms are preserved on edit.
 */
function summarizeMechanisms(mechanisms: unknown): string {
  if (!mechanisms || typeof mechanisms !== "object") return "";
  const m = mechanisms as Record<string, Array<Record<string, unknown>>>;
  const parts: string[] = [];
  if (Array.isArray(m["email"]) && m["email"].length > 0) {
    parts.push(m["email"].map((e) => String(e["id"] ?? "")).join(", "));
  }
  if (Array.isArray(m["webhooks"]) && m["webhooks"].length > 0) {
    parts.push(`${m["webhooks"].length} webhook(s)`);
  }
  if (Array.isArray(m["pagerduty"]) && m["pagerduty"].length > 0) {
    parts.push(`${m["pagerduty"].length} PagerDuty`);
  }
  return parts.join("; ");
}

function mapPolicy(p: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(p["id"] ?? "");
  const name = String(p["name"] ?? "");
  return {
    id: `${accountId}:notification-policy:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "notification-policy",
    accountId,
    displayName: name || id,
    fields: {
      name,
      alertType: String(p["alert_type"] ?? ""),
      enabled: Boolean(p["enabled"]),
      description: String(p["description"] ?? ""),
      mechanisms: summarizeMechanisms(p["mechanisms"]),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: id,
    createdAt: String(p["created"] ?? new Date().toISOString()),
    updatedAt: String(p["modified"] ?? new Date().toISOString()),
  };
}

export async function listNotificationPolicies(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const p of api.cf.alerting.policies.list({ account_id })) {
        results.push(mapPolicy(asRecord(p), accountId));
      }
      return results;
    },
    "notification policies",
    "Account · Notifications:Read",
  );
}

function emailMechanisms(emailCsv: string): Record<string, unknown> {
  const emails = emailCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id }));
  return { email: emails };
}

export async function createNotificationPolicy(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const body: Record<string, unknown> = {
    account_id,
    name: fields["name"] ?? "",
    alert_type: fields["alertType"] ?? "universal_ssl_event_type",
    enabled: fields["enabled"] !== "false",
    mechanisms: emailMechanisms(fields["email"] ?? ""),
    ...(fields["description"] ? { description: fields["description"] } : {}),
  };
  const p = await api.cf.alerting.policies.create(body as unknown as PolicyCreateParams);
  return mapPolicy(asRecord(p), accountId);
}

export async function editNotificationPolicy(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  // Update is a PATCH; only send the editable scalars (name / enabled /
  // description / recipient emails when re-specified).
  const body: Record<string, unknown> = { account_id };
  if (fields["name"] !== undefined) body["name"] = fields["name"];
  if (fields["enabled"] !== undefined) body["enabled"] = fields["enabled"] === "true";
  if (fields["description"] !== undefined) body["description"] = fields["description"];
  if (fields["email"]) body["mechanisms"] = emailMechanisms(fields["email"]);
  const p = await api.cf.alerting.policies.update(
    externalId,
    body as unknown as Parameters<typeof api.cf.alerting.policies.update>[1],
  );
  return mapPolicy(asRecord(p), accountId);
}

export async function deleteNotificationPolicy(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.alerting.policies.delete(externalId, { account_id });
}
