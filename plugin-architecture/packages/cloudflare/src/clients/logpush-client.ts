import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone, resolveZoneName } from "./shared.js";
import type { JobCreateParams, JobUpdateParams } from "cloudflare/resources/logpush/jobs";

/**
 * Cloudflare identifies a Logpush job by an integer (`LogpushJob.id?: number`,
 * cloudflare/resources/logpush/jobs.d.ts:111), and the SDK types
 * `jobs.update`/`jobs.delete` as taking a `number`. Our externalId carries
 * that id as a string (`<zoneId>/<jobId>`), so convert it back rather than
 * pretending a string is a number.
 */
function logpushJobId(jobId: string): number {
  const parsed = Number(jobId);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Cloudflare plugin: "${jobId}" is not a valid Logpush job id — Cloudflare job ids are integers.`,
    );
  }
  return parsed;
}

/**
 * Datasets the Logpush API accepts, mirroring `JobCreateParams["dataset"]`
 * (cloudflare/resources/logpush/jobs.d.ts:371). The `satisfies` clause makes
 * the compiler reject any entry the SDK stops supporting.
 *
 * The create form offers a handful of these; a value that isn't in the list at
 * all is dropped from the request so Cloudflare answers with its own
 * validation error instead of us silently substituting a different dataset.
 */
const LOGPUSH_DATASETS = [
  "access_requests",
  "audit_logs",
  "audit_logs_v2",
  "biso_user_actions",
  "casb_findings",
  "device_posture_results",
  "dex_application_tests",
  "dex_device_state_events",
  "dlp_forensic_copies",
  "dns_firewall_logs",
  "dns_logs",
  "email_security_alerts",
  "email_security_post_delivery_events",
  "firewall_events",
  "gateway_dns",
  "gateway_http",
  "gateway_network",
  "http_requests",
  "ipsec_logs",
  "magic_ids_detections",
  "mcp_portal_logs",
  "nel_reports",
  "network_analytics_logs",
  "page_shield_events",
  "sinkhole_http_logs",
  "spectrum_events",
  "ssh_logs",
  "warp_config_changes",
  "warp_toggle_changes",
  "workers_trace_events",
  "zaraz_events",
  "zero_trust_network_sessions",
] as const satisfies ReadonlyArray<NonNullable<JobCreateParams["dataset"]>>;
type LogpushDataset = (typeof LOGPUSH_DATASETS)[number];
const logpushDataset = (value: string | undefined): LogpushDataset | null => {
  const isLogpushDataset = (v: string): v is LogpushDataset =>
    (LOGPUSH_DATASETS as readonly string[]).includes(v);
  return value !== undefined && isLogpushDataset(value) ? value : null;
};

/**
 * The deprecated `frequency` knob only accepts `high` or `low`
 * (cloudflare/resources/logpush/jobs.d.ts:474). An unrecognized value is
 * dropped so the PATCH leaves the job's current frequency alone.
 */
const LOGPUSH_FREQUENCIES = ["high", "low"] as const;
type LogpushFrequency = (typeof LOGPUSH_FREQUENCIES)[number];
const logpushFrequency = (value: string | undefined): LogpushFrequency | null => {
  const isLogpushFrequency = (v: string): v is LogpushFrequency =>
    (LOGPUSH_FREQUENCIES as readonly string[]).includes(v);
  return value !== undefined && isLogpushFrequency(value) ? value : null;
};

function mapLogpushJob(
  job: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  zoneName: string,
): ResourceInstance {
  const id = String(job["id"] ?? "");
  const name = String(job["name"] ?? "");
  const dataset = String(job["dataset"] ?? "");
  const destinationConf = String(job["destination_conf"] ?? "");
  // Extract destination type from the destination_conf URL scheme
  const destType = destinationConf.split("://")[0] ?? "";
  return {
    id: `${accountId}:logpush-job:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "logpush-job",
    accountId,
    displayName: name || `${dataset} → ${destType}`,
    fields: {
      name,
      enabled: Boolean(job["enabled"]),
      dataset,
      destinationType: destType,
      frequency: String(job["frequency"] ?? ""),
      logpullOptions: String(job["logpull_options"] ?? ""),
      lastComplete: String(job["last_complete"] ?? ""),
      lastError: String(job["last_error"] ?? ""),
      zoneName,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllLogpushJobs(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      for await (const job of api.cf.logpush.jobs.list({ zone_id: zoneId })) {
        if (!job) continue;
        part.push(mapLogpushJob(asRecord(job), accountId, zoneId, zoneName));
      }
      return part;
    },
    "logpush jobs",
    "Zone · Logs:Read",
  );
}

export async function createLogpushJob(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a logpush job");
  const dataset = logpushDataset(fields["dataset"]);
  const body: JobCreateParams = {
    zone_id: zoneId,
    destination_conf: fields["destinationConf"] ?? "",
    ...(dataset ? { dataset } : {}),
    enabled: true,
    ...(fields["name"] ? { name: fields["name"] } : {}),
  };
  const job = await api.cf.logpush.jobs.create(body);
  if (!job) throw new Error("Cloudflare plugin: failed to create logpush job (null response)");
  return mapLogpushJob(asRecord(job), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function editLogpushJob(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, jobId] = externalId.split("/");
  if (!zoneId || !jobId) throw new Error("Invalid logpush job ID");
  // Logpush update is a PATCH — only send the editable settings.
  const frequency = logpushFrequency(fields["frequency"]);
  const body: JobUpdateParams = {
    zone_id: zoneId,
    ...(fields["enabled"] !== undefined ? { enabled: fields["enabled"] === "true" } : {}),
    ...(frequency ? { frequency } : {}),
    ...(fields["logpullOptions"] !== undefined
      ? { logpull_options: fields["logpullOptions"] }
      : {}),
    ...(fields["destinationConf"] ? { destination_conf: fields["destinationConf"] } : {}),
  };
  const job = await api.cf.logpush.jobs.update(logpushJobId(jobId), body);
  if (!job) throw new Error("Cloudflare plugin: failed to update logpush job (null response)");
  return mapLogpushJob(asRecord(job), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function deleteLogpushJob(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, jobId] = externalId.split("/");
  if (!zoneId || !jobId) throw new Error("Invalid logpush job ID");
  await api.cf.logpush.jobs.delete(logpushJobId(jobId), { zone_id: zoneId });
}
