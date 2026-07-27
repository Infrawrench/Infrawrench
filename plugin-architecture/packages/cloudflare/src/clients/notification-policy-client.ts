import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type {
  MechanismParam,
  PolicyCreateParams,
  PolicyUpdateParams,
} from "cloudflare/resources/alerting/policies";

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

function emailMechanisms(emailCsv: string): MechanismParam {
  const emails = emailCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id }));
  return { email: emails };
}

/**
 * Every `alert_type` the alerting API accepts (`PolicyCreateParams.alert_type`).
 * The create form only offers a curated subset, but a policy can be created
 * from a manifest or the HTTP API, so the whole set is listed here rather than
 * just the form's options — otherwise a legitimate alert type would be silently
 * rewritten to the fallback below.
 */
const ALERT_TYPES = [
  "abuse_report_alert",
  "access_custom_certificate_expiration_type",
  "advanced_ddos_attack_l4_alert",
  "advanced_ddos_attack_l7_alert",
  "advanced_http_alert_error",
  "bgp_hijack_notification",
  "billing_usage_alert",
  "block_notification_block_removed",
  "block_notification_new_block",
  "block_notification_review_rejected",
  "bot_traffic_basic_alert",
  "brand_protection_alert",
  "brand_protection_digest",
  "clickhouse_alert_fw_anomaly",
  "clickhouse_alert_fw_ent_anomaly",
  "cloudforce_one_request_notification",
  "cni_maintenance_notification",
  "custom_analytics",
  "custom_bot_detection_alert",
  "custom_ssl_certificate_event_type",
  "dedicated_ssl_certificate_event_type",
  "device_connectivity_anomaly_alert",
  "dos_attack_l4",
  "dos_attack_l7",
  "expiring_service_token_alert",
  "failing_logpush_job_disabled_alert",
  "fbm_auto_advertisement",
  "fbm_dosd_attack",
  "fbm_volumetric_attack",
  "health_check_status_notification",
  "hostname_aop_custom_certificate_expiration_type",
  "http_alert_edge_error",
  "http_alert_origin_error",
  "image_notification",
  "image_resizing_notification",
  "incident_alert",
  "load_balancing_health_alert",
  "load_balancing_pool_enablement_alert",
  "logo_match_alert",
  "magic_tunnel_health_check_event",
  "magic_wan_tunnel_health",
  "maintenance_event_notification",
  "mtls_certificate_store_certificate_expiration_type",
  "pages_event_alert",
  "radar_notification",
  "real_origin_monitoring",
  "scriptmonitor_alert_new_code_change_detections",
  "scriptmonitor_alert_new_hosts",
  "scriptmonitor_alert_new_malicious_hosts",
  "scriptmonitor_alert_new_malicious_scripts",
  "scriptmonitor_alert_new_malicious_url",
  "scriptmonitor_alert_new_max_length_resource_url",
  "scriptmonitor_alert_new_resources",
  "secondary_dns_all_primaries_failing",
  "secondary_dns_primaries_failing",
  "secondary_dns_warning",
  "secondary_dns_zone_successfully_updated",
  "secondary_dns_zone_validation_warning",
  "security_insights_alert",
  "sentinel_alert",
  "stream_live_notifications",
  "synthetic_test_latency_alert",
  "synthetic_test_low_availability_alert",
  "traffic_anomalies_alert",
  "tunnel_health_event",
  "tunnel_update_event",
  "universal_ssl_event_type",
  "web_analytics_metrics_update",
  "zone_aop_custom_certificate_expiration_type",
] as const satisfies readonly PolicyCreateParams["alert_type"][];
type AlertType = (typeof ALERT_TYPES)[number];

/** The create form's default, also used when an unknown alert type arrives. */
const DEFAULT_ALERT_TYPE: AlertType = "universal_ssl_event_type";

function isAlertType(value: string): value is AlertType {
  return (ALERT_TYPES as readonly string[]).includes(value);
}

export async function createNotificationPolicy(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const alertType = fields["alertType"] ?? "";
  const params: PolicyCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    alert_type: isAlertType(alertType) ? alertType : DEFAULT_ALERT_TYPE,
    enabled: fields["enabled"] !== "false",
    mechanisms: emailMechanisms(fields["email"] ?? ""),
    ...(fields["description"] ? { description: fields["description"] } : {}),
  };
  const p = await api.cf.alerting.policies.create(params);
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
  const email = fields["email"];
  const params: PolicyUpdateParams = {
    account_id,
    ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
    ...(fields["enabled"] !== undefined ? { enabled: fields["enabled"] === "true" } : {}),
    ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
    ...(email ? { mechanisms: emailMechanisms(email) } : {}),
  };
  const p = await api.cf.alerting.policies.update(externalId, params);
  return mapPolicy(asRecord(p), accountId);
}

export async function deleteNotificationPolicy(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.alerting.policies.delete(externalId, { account_id });
}
