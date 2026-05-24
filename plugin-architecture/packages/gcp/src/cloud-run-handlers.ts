import yaml from "js-yaml";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { gcpFetch, parseFormArg } from "./utils.js";

export interface CloudRunContext {
  project: string;
  token: () => Promise<string>;
}

/** One row in the Revisions tab. */
export interface CloudRunRevisionSummary {
  name: string;
  fullName: string;
  trafficPercent: number;
  ready: boolean;
  image: string;
  imageDigest: string;
  createTime: string;
  cpuLimit: string;
  memoryLimit: string;
  envCount: number;
  volumeCount: number;
  healthCheckCount: number;
  serviceAccount: string;
}

export interface CloudRunIamBinding {
  role: string;
  members: string[];
}

export interface CloudRunIamInfo {
  bindings: CloudRunIamBinding[];
  etag: string;
  error: string;
}

export interface CloudRunTriggerSummary {
  name: string;
  fullName: string;
  eventType: string;
  transport: string;
  createTime: string;
  serviceAccount: string;
}

export interface CloudRunFullServiceResult {
  service: Record<string, unknown> | null;
  error: string;
}

export interface CloudRunDomainDnsRecord {
  /** Subdomain or apex name the user must add as a DNS record. */
  name: string;
  /** Record type (A, AAAA, CNAME). */
  type: string;
  /** RDATA — IP address or canonical name to point at. */
  rrdata: string;
}

export interface CloudRunDomainMapping {
  domain: string;
  ready: boolean;
  status: string;
  url: string;
  routeName: string;
  resourceRecords: CloudRunDomainDnsRecord[];
  message: string;
  createTime: string;
}

export interface CloudRunDomainMappingsResult {
  mappings: CloudRunDomainMapping[];
  /** When non-empty, a fetch error is shown to the user verbatim. */
  error: string;
}

function parseServiceFullName(fullName: string): {
  project: string;
  region: string;
  service: string;
} | null {
  // Cloud Run v2 service names: projects/<p>/locations/<region>/services/<name>
  const m = /^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/.exec(fullName);
  if (!m) return null;
  return { project: m[1]!, region: m[2]!, service: m[3]! };
}

export async function fetchCloudRunServiceFull(
  ctx: CloudRunContext,
  resource: ResourceInstance,
): Promise<CloudRunFullServiceResult> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) return { service: null, error: "Cannot parse service name" };
  const res = await gcpFetch(
    ctx,
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}`,
  );
  if (!res.ok) {
    return { service: null, error: `Cloud Run API ${res.status}: ${await res.text()}` };
  }
  const service = (await res.json()) as Record<string, unknown>;
  return { service, error: "" };
}

export async function listCloudRunRevisions(
  ctx: CloudRunContext,
  resource: ResourceInstance,
): Promise<CloudRunRevisionSummary[]> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) return [];
  const url = `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}/revisions`;
  const items: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(url);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await gcpFetch(ctx, u.toString());
    if (!res.ok) throw new Error(`Cloud Run revisions ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      revisions?: Record<string, unknown>[];
      nextPageToken?: string;
    };
    if (data.revisions) items.push(...data.revisions);
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Traffic split lives on the parent service. Read it from the cached full
  // service if present, else from the resource fields traffic JSON populated
  // by the lister.
  let traffic: Array<Record<string, unknown>> = [];
  const fullJson = String(resource.resolvedOutputs["cloudRunFullService"] ?? "");
  if (fullJson) {
    try {
      const parsed = JSON.parse(fullJson) as { service?: Record<string, unknown> };
      const list = parsed.service?.["trafficStatuses"] ?? parsed.service?.["traffic"];
      if (Array.isArray(list)) traffic = list as Array<Record<string, unknown>>;
    } catch {
      /* ignore */
    }
  }
  if (traffic.length === 0) {
    const tj = String(resource.resolvedOutputs["traffic"] ?? "");
    if (tj) {
      try {
        traffic = JSON.parse(tj) as Array<Record<string, unknown>>;
      } catch {
        /* ignore */
      }
    }
  }
  const trafficByRev = new Map<string, number>();
  for (const t of traffic) {
    const rev = String(t["revision"] ?? "");
    const pct = Number(t["percent"] ?? 0);
    if (rev) trafficByRev.set(rev, pct);
  }

  return items.map((rev) => {
    const revFull = String(rev["name"] ?? "");
    const revName = revFull.split("/").pop() ?? "";
    const tpl = (rev["template"] as Record<string, unknown> | undefined) ?? {};
    const containers = (rev["containers"] ?? tpl["containers"] ?? []) as Array<
      Record<string, unknown>
    >;
    const c0 = containers[0] ?? {};
    const image = String(c0["image"] ?? "");
    const env = (c0["env"] as unknown[] | undefined) ?? [];
    const startupProbe = c0["startupProbe"];
    const livenessProbe = c0["livenessProbe"];
    const healthCount = (startupProbe ? 1 : 0) + (livenessProbe ? 1 : 0);
    const resources = (c0["resources"] as Record<string, unknown> | undefined) ?? {};
    const limits = (resources["limits"] as Record<string, unknown> | undefined) ?? {};
    const volumes = (rev["volumes"] as unknown[] | undefined) ?? [];
    const conditions = (rev["conditions"] as Array<Record<string, unknown>> | undefined) ?? [];
    const ready = conditions.some(
      (c) => c["type"] === "Ready" && c["state"] === "CONDITION_SUCCEEDED",
    );
    const digest = String(
      rev["containerStatuses"]
        ? ((rev["containerStatuses"] as Array<Record<string, unknown>>)[0]?.["imageDigest"] ?? "")
        : "",
    );
    return {
      name: revName,
      fullName: revFull,
      trafficPercent: trafficByRev.get(revName) ?? 0,
      ready,
      image,
      imageDigest: digest,
      createTime: String(rev["createTime"] ?? ""),
      cpuLimit: String(limits["cpu"] ?? ""),
      memoryLimit: String(limits["memory"] ?? ""),
      envCount: Array.isArray(env) ? env.length : 0,
      volumeCount: Array.isArray(volumes) ? volumes.length : 0,
      healthCheckCount: healthCount,
      serviceAccount: String(rev["serviceAccount"] ?? ""),
    };
  });
}

export async function listEventarcTriggersForService(
  ctx: CloudRunContext,
  resource: ResourceInstance,
): Promise<CloudRunTriggerSummary[]> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) return [];
  const url = `https://eventarc.googleapis.com/v1/projects/${parts.project}/locations/${parts.region}/triggers`;
  const items: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(url);
    u.searchParams.set("pageSize", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await gcpFetch(ctx, u.toString());
    if (!res.ok) throw new Error(`Eventarc API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      triggers?: Record<string, unknown>[];
      nextPageToken?: string;
    };
    if (data.triggers) items.push(...data.triggers);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items
    .filter((t) => {
      const dest = t["destination"] as Record<string, unknown> | undefined;
      const cr = dest?.["cloudRun"] as Record<string, unknown> | undefined;
      return String(cr?.["service"] ?? "") === parts.service;
    })
    .map((t) => {
      const fullName = String(t["name"] ?? "");
      const name = fullName.split("/").pop() ?? "";
      const filters = (t["eventFilters"] as Array<Record<string, unknown>> | undefined) ?? [];
      const eventType = filters.find((f) => f["attribute"] === "type")?.["value"]?.toString() ?? "";
      const transport = t["transport"] ? "Pub/Sub" : "HTTP";
      return {
        name,
        fullName,
        eventType,
        transport,
        createTime: String(t["createTime"] ?? ""),
        serviceAccount: String(t["serviceAccount"] ?? ""),
      };
    });
}

export async function fetchCloudRunIamBindings(
  ctx: CloudRunContext,
  resource: ResourceInstance,
): Promise<CloudRunIamInfo> {
  const empty: CloudRunIamInfo = { bindings: [], etag: "", error: "" };
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) return { ...empty, error: "Cannot parse service name" };
  // Cloud Run v2 getIamPolicy is GET with a query parameter, not POST with
  // a body. (Cloud Resource Manager's getIamPolicy is POST — easy to
  // confuse.)
  const res = await gcpFetch(
    ctx,
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}:getIamPolicy?options.requestedPolicyVersion=3`,
  );
  if (!res.ok) {
    return { ...empty, error: `Cloud Run getIamPolicy ${res.status}: ${await res.text()}` };
  }
  const policy = (await res.json()) as {
    bindings?: Array<{ role: string; members?: string[] }>;
    etag?: string;
  };
  return {
    bindings: (policy.bindings ?? []).map((b) => ({
      role: b.role,
      members: (b.members ?? []).slice().sort(),
    })),
    etag: policy.etag ?? "",
    error: "",
  };
}

/**
 * List Cloud Run custom domain mappings whose `spec.routeName` matches this
 * service. Domain mappings live in the v1 (Knative-style) API and are queried
 * against a region-prefixed host — the global `run.googleapis.com` host
 * returns empty for managed Cloud Run.
 */
export async function listCloudRunDomainMappings(
  ctx: CloudRunContext,
  resource: ResourceInstance,
): Promise<CloudRunDomainMappingsResult> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) return { mappings: [], error: "Cannot parse service name" };
  const url = `https://${parts.region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${parts.project}/domainmappings`;
  const res = await gcpFetch(ctx, url);
  if (!res.ok) {
    return {
      mappings: [],
      error: `Cloud Run domain mappings ${res.status}: ${await res.text()}`,
    };
  }
  const data = (await res.json()) as { items?: Record<string, unknown>[] };
  const items = data.items ?? [];
  const mappings: CloudRunDomainMapping[] = [];
  for (const item of items) {
    const spec = (item["spec"] as Record<string, unknown> | undefined) ?? {};
    const routeName = String(spec["routeName"] ?? "");
    if (routeName !== parts.service) continue;
    const meta = (item["metadata"] as Record<string, unknown> | undefined) ?? {};
    const status = (item["status"] as Record<string, unknown> | undefined) ?? {};
    const conditions = (status["conditions"] as Array<Record<string, unknown>> | undefined) ?? [];
    const ready = conditions.some(
      (c) => c["type"] === "Ready" && (c["status"] === "True" || c["status"] === true),
    );
    const certCondition = conditions.find((c) => c["type"] === "CertificateProvisioned");
    const readyCondition = conditions.find((c) => c["type"] === "Ready");
    const statusLabel = ready
      ? "Ready"
      : String(certCondition?.["reason"] ?? readyCondition?.["reason"] ?? "Pending") || "Pending";
    const records = (status["resourceRecords"] as Array<Record<string, unknown>> | undefined) ?? [];
    mappings.push({
      domain: String(meta["name"] ?? ""),
      ready,
      status: statusLabel,
      url: String(status["url"] ?? ""),
      routeName,
      resourceRecords: records.map((r) => ({
        name: String(r["name"] ?? ""),
        type: String(r["type"] ?? ""),
        rrdata: String(r["rrdata"] ?? ""),
      })),
      message: String(readyCondition?.["message"] ?? ""),
      createTime: String(meta["creationTimestamp"] ?? ""),
    });
  }
  return { mappings, error: "" };
}

async function createCloudRunDomainMapping(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  domain: string,
): Promise<void> {
  const trimmed = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) {
    throw new Error(
      `"${domain}" is not a valid domain name. Use a fully-qualified hostname like example.com or app.example.com.`,
    );
  }
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");
  const url = `https://${parts.region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${parts.project}/domainmappings`;
  const res = await gcpFetch(ctx, url, {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "domains.cloudrun.com/v1",
      kind: "DomainMapping",
      metadata: { name: trimmed, namespace: parts.project },
      spec: { routeName: parts.service },
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloud Run domain mapping create failed: ${res.status} ${await res.text()}`);
  }
}

async function deleteCloudRunDomainMapping(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  domain: string,
): Promise<void> {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) throw new Error("domain is required");
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");
  const url = `https://${parts.region}-run.googleapis.com/apis/domains.cloudrun.com/v1/namespaces/${parts.project}/domainmappings/${encodeURIComponent(trimmed)}`;
  const res = await gcpFetch(ctx, url, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Cloud Run domain mapping delete failed: ${res.status} ${await res.text()}`);
  }
}

interface CreateEventarcTriggerOpts {
  name: string;
  eventSource: string; // "pubsub" | "storage-finalized" | "storage-deleted" | "audit-log" | "custom"
  pubsubTopic?: string;
  storageBucket?: string;
  auditService?: string;
  auditMethod?: string;
  customType?: string;
  customFilters?: string; // JSON: [{ "attribute": "x", "value": "y" }]
  serviceAccount?: string;
}

async function createEventarcTrigger(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  opts: CreateEventarcTriggerOpts,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");
  const triggerId = opts.name.trim();
  if (!triggerId) throw new Error("Trigger name is required");
  if (!/^[a-z0-9-]{1,63}$/.test(triggerId)) {
    throw new Error("Trigger name must be lowercase alphanumeric + dashes (max 63 chars)");
  }

  const eventFilters: Array<Record<string, unknown>> = [];
  let transport: Record<string, unknown> | undefined;
  switch (opts.eventSource) {
    case "pubsub":
      eventFilters.push({
        attribute: "type",
        value: "google.cloud.pubsub.topic.v1.messagePublished",
      });
      if (opts.pubsubTopic && opts.pubsubTopic.trim()) {
        const topic = opts.pubsubTopic.trim();
        // Accept either a full resource name or a bare topic id.
        const fullTopic = topic.startsWith("projects/")
          ? topic
          : `projects/${parts.project}/topics/${topic}`;
        transport = { pubsub: { topic: fullTopic } };
      }
      break;
    case "storage-finalized":
      if (!opts.storageBucket) throw new Error("GCS bucket is required for storage triggers");
      eventFilters.push(
        { attribute: "type", value: "google.cloud.storage.object.v1.finalized" },
        { attribute: "bucket", value: opts.storageBucket.trim() },
      );
      break;
    case "storage-deleted":
      if (!opts.storageBucket) throw new Error("GCS bucket is required for storage triggers");
      eventFilters.push(
        { attribute: "type", value: "google.cloud.storage.object.v1.deleted" },
        { attribute: "bucket", value: opts.storageBucket.trim() },
      );
      break;
    case "audit-log":
      if (!opts.auditService || !opts.auditMethod) {
        throw new Error("Service name and method are required for audit-log triggers");
      }
      eventFilters.push(
        { attribute: "type", value: "google.cloud.audit.log.v1.written" },
        { attribute: "serviceName", value: opts.auditService.trim() },
        { attribute: "methodName", value: opts.auditMethod.trim() },
      );
      break;
    case "custom":
      if (!opts.customType) throw new Error("Custom event type is required");
      eventFilters.push({ attribute: "type", value: opts.customType.trim() });
      if (opts.customFilters && opts.customFilters.trim()) {
        try {
          const extra = JSON.parse(opts.customFilters) as Array<Record<string, unknown>>;
          if (Array.isArray(extra)) eventFilters.push(...extra);
        } catch (e) {
          throw new Error(
            'Custom filters must be a JSON array, e.g. [{"attribute":"x","value":"y"}]',
            { cause: e },
          );
        }
      }
      break;
    default:
      throw new Error(`Unknown event source: ${opts.eventSource}`);
  }

  const body: Record<string, unknown> = {
    name: `projects/${parts.project}/locations/${parts.region}/triggers/${triggerId}`,
    eventFilters,
    destination: {
      cloudRun: {
        service: parts.service,
        region: parts.region,
      },
    },
  };
  if (opts.serviceAccount && opts.serviceAccount.trim()) {
    const sa = opts.serviceAccount.trim();
    body["serviceAccount"] = sa.includes("@")
      ? sa
      : `${sa}@${parts.project}.iam.gserviceaccount.com`;
  }
  if (transport) body["transport"] = transport;

  const url =
    `https://eventarc.googleapis.com/v1/projects/${parts.project}/locations/${parts.region}/triggers` +
    `?triggerId=${encodeURIComponent(triggerId)}`;
  const res = await gcpFetch(ctx, url, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Eventarc trigger create failed: ${res.status} ${await res.text()}`);
  }
}

async function deleteEventarcTrigger(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  triggerName: string,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");
  const trimmed = triggerName.trim();
  if (!trimmed) throw new Error("Trigger name is required");
  const url = `https://eventarc.googleapis.com/v1/projects/${parts.project}/locations/${parts.region}/triggers/${encodeURIComponent(trimmed)}`;
  const res = await gcpFetch(ctx, url, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Eventarc trigger delete failed: ${res.status} ${await res.text()}`);
  }
}

/** Read the live IAM policy and apply a mutation, then setIamPolicy. */
async function mutateCloudRunIamPolicy(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  mutate: (bindings: Array<{ role: string; members: string[] }>) => void,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");
  const getUrl =
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}:getIamPolicy` +
    `?options.requestedPolicyVersion=3`;
  const getRes = await gcpFetch(ctx, getUrl);
  if (!getRes.ok) {
    throw new Error(`Cloud Run getIamPolicy failed: ${getRes.status} ${await getRes.text()}`);
  }
  const policy = (await getRes.json()) as {
    bindings?: Array<{ role: string; members?: string[] }>;
    etag?: string;
    version?: number;
  };
  const bindings = (policy.bindings ?? []).map((b) => ({
    role: b.role,
    members: (b.members ?? []).slice(),
  }));
  mutate(bindings);
  // Drop any bindings that ended up with no members.
  const cleaned = bindings.filter((b) => b.members.length > 0);
  const setUrl = `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}:setIamPolicy`;
  const setRes = await gcpFetch(ctx, setUrl, {
    method: "POST",
    body: JSON.stringify({
      policy: {
        bindings: cleaned,
        etag: policy.etag ?? "",
        version: 3,
      },
    }),
  });
  if (!setRes.ok) {
    throw new Error(`Cloud Run setIamPolicy failed: ${setRes.status} ${await setRes.text()}`);
  }
}

async function setCloudRunAuthMode(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  mode: string, // "public" | "authenticated"
): Promise<void> {
  await mutateCloudRunIamPolicy(ctx, resource, (bindings) => {
    let invoker = bindings.find((b) => b.role === "roles/run.invoker");
    if (!invoker) {
      invoker = { role: "roles/run.invoker", members: [] };
      bindings.push(invoker);
    }
    invoker.members = invoker.members.filter((m) => m !== "allUsers");
    if (mode === "public") {
      invoker.members.push("allUsers");
    }
  });
}

async function addCloudRunIamBinding(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  role: string,
  member: string,
): Promise<void> {
  if (!role.trim() || !member.trim()) throw new Error("role and member are required");
  const r = role.trim();
  const m = member.trim();
  await mutateCloudRunIamPolicy(ctx, resource, (bindings) => {
    let b = bindings.find((x) => x.role === r);
    if (!b) {
      b = { role: r, members: [] };
      bindings.push(b);
    }
    if (!b.members.includes(m)) b.members.push(m);
  });
}

async function removeCloudRunIamBinding(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  role: string,
  member: string,
): Promise<void> {
  await mutateCloudRunIamPolicy(ctx, resource, (bindings) => {
    const b = bindings.find((x) => x.role === role);
    if (!b) return;
    b.members = b.members.filter((x) => x !== member);
  });
}

async function setCloudRunBinaryAuthorization(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  enabled: boolean,
  policy?: string,
): Promise<void> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");
  const liveRes = await gcpFetch(
    ctx,
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}`,
  );
  if (!liveRes.ok) {
    throw new Error(`Failed to read service: ${liveRes.status} ${await liveRes.text()}`);
  }
  const live = (await liveRes.json()) as Record<string, unknown>;
  const liveTemplate = (live["template"] as Record<string, unknown> | undefined) ?? {};
  const newRevisionName = `${parts.service}-${Date.now().toString(36).slice(-5)}-${Math.random()
    .toString(36)
    .slice(2, 5)}`;
  const newTemplate: Record<string, unknown> = { ...liveTemplate, revision: newRevisionName };
  const body: Record<string, unknown> = { template: newTemplate };
  if (enabled) {
    if (policy && policy.trim()) {
      body["binaryAuthorization"] = { policy: policy.trim() };
    } else {
      body["binaryAuthorization"] = { useDefault: true };
    }
  } else {
    body["binaryAuthorization"] = {};
  }
  const url =
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}` +
    `?updateMask=binaryAuthorization,template`;
  const res = await gcpFetch(ctx, url, { method: "PATCH", body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Binary authorization patch failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * PATCH the service's networking knobs: ingress mode, default URL toggle, VPC
 * connector + egress, and the mesh annotation. Annotations are merged with
 * what's on the service so we don't clobber unrelated keys.
 */
async function editCloudRunNetworking(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  vals: {
    ingress?: string;
    defaultUri?: string; // "enabled" | "disabled"
    vpcConnector?: string;
    vpcEgress?: string;
    mesh?: string;
  },
): Promise<void> {
  const fullName = resource.externalId ?? "";
  const parts = parseServiceFullName(fullName);
  if (!parts) throw new Error("Cannot parse service name");

  // Pull the live service for current annotations + a sensible base.
  const liveRes = await gcpFetch(
    ctx,
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}`,
  );
  if (!liveRes.ok) {
    throw new Error(`Failed to read service: ${liveRes.status} ${await liveRes.text()}`);
  }
  const live = (await liveRes.json()) as Record<string, unknown>;
  const liveAnnotations = (live["annotations"] as Record<string, string> | undefined) ?? {};
  const liveTemplate = (live["template"] as Record<string, unknown> | undefined) ?? {};

  const updateMaskParts: string[] = [];
  const body: Record<string, unknown> = {};

  if (vals.ingress) {
    body["ingress"] = vals.ingress;
    updateMaskParts.push("ingress");
  }
  if (vals.defaultUri) {
    body["defaultUriDisabled"] = vals.defaultUri === "disabled";
    updateMaskParts.push("defaultUriDisabled");
  }

  // VPC config goes on the template.
  let vpcChanged = false;
  let newVpcAccess: Record<string, unknown> | null = null;
  if (vals.vpcConnector !== undefined || vals.vpcEgress !== undefined) {
    vpcChanged = true;
    const vpcAccess: Record<string, unknown> = {};
    if (vals.vpcConnector && vals.vpcConnector.trim()) {
      vpcAccess["connector"] = vals.vpcConnector.trim();
    }
    if (vals.vpcEgress && vals.vpcEgress.trim()) {
      vpcAccess["egress"] = vals.vpcEgress.trim();
    }
    newVpcAccess = Object.keys(vpcAccess).length > 0 ? vpcAccess : null;
  }

  // Cloud Run v2 has a quirk: ANY services.patch — even on a top-level
  // field like ingress — runs revision validation against the live state.
  // When the latest revision was created by a different deployer (e.g. gen2
  // functions, console, gcloud), that validation hits ALREADY_EXISTS on
  // the inherited revision name. Workaround mirroring what gcloud does:
  // always include `template` with a fresh revision name + the live
  // template content in the body, regardless of which fields are being
  // changed. This forces Cloud Run to mint a new revision.
  if (updateMaskParts.length > 0 || vpcChanged) {
    const newRevisionName = `${parts.service}-${Date.now().toString(36).slice(-5)}-${Math.random()
      .toString(36)
      .slice(2, 5)}`;
    const newTemplate: Record<string, unknown> = { ...liveTemplate };
    newTemplate["revision"] = newRevisionName;
    if (vpcChanged) {
      if (newVpcAccess) {
        newTemplate["vpcAccess"] = newVpcAccess;
      } else {
        delete newTemplate["vpcAccess"];
      }
    }
    body["template"] = newTemplate;
    if (!updateMaskParts.includes("template")) updateMaskParts.push("template");
  }

  // Mesh annotation merge.
  if (vals.mesh !== undefined) {
    const mergedAnnotations: Record<string, string> = { ...liveAnnotations };
    const mesh = vals.mesh.trim();
    if (mesh) {
      mergedAnnotations["run.googleapis.com/mesh"] = mesh;
    } else {
      delete mergedAnnotations["run.googleapis.com/mesh"];
    }
    body["annotations"] = mergedAnnotations;
    updateMaskParts.push("annotations");
  }

  if (updateMaskParts.length === 0) return;

  const url =
    `https://run.googleapis.com/v2/projects/${parts.project}/locations/${parts.region}/services/${parts.service}` +
    `?updateMask=${updateMaskParts.join(",")}`;
  const bodyJson = JSON.stringify(body);
  const res = await gcpFetch(ctx, url, { method: "PATCH", body: bodyJson });
  if (!res.ok) {
    const errText = await res.text();
    // Surface the revision name we sent so we can tell whether the server
    // is rejecting our value or silently inheriting the existing one.
    const sentRevision =
      ((body["template"] as Record<string, unknown> | undefined)?.["revision"] as string) ??
      "(none)";
    throw new Error(
      `Cloud Run networking patch failed: ${res.status} ${errText}\n` +
        `(sent updateMask=${updateMaskParts.join(",")}, template.revision=${sentRevision})`,
    );
  }
}

/** Dispatcher for Cloud Run service commands invoked from `prompt-nosql-command` actions. */
export async function executeCloudRunCommand(
  ctx: CloudRunContext,
  resource: ResourceInstance,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  switch (command) {
    case "createDomainMapping": {
      const vals = parseFormArg(args[0]);
      await createCloudRunDomainMapping(ctx, resource, String(vals["domain"] ?? ""));
      return null;
    }
    case "deleteDomainMapping": {
      const vals = parseFormArg(args[0]);
      await deleteCloudRunDomainMapping(ctx, resource, String(vals["domain"] ?? ""));
      return null;
    }
    case "editNetworking": {
      const vals = parseFormArg(args[0]);
      const opts: {
        ingress?: string;
        defaultUri?: string;
        vpcConnector?: string;
        vpcEgress?: string;
        mesh?: string;
      } = {};
      if (vals["ingress"] !== undefined) opts.ingress = vals["ingress"];
      if (vals["defaultUri"] !== undefined) opts.defaultUri = vals["defaultUri"];
      if (vals["vpcConnector"] !== undefined) opts.vpcConnector = vals["vpcConnector"];
      if (vals["vpcEgress"] !== undefined) opts.vpcEgress = vals["vpcEgress"];
      if (vals["mesh"] !== undefined) opts.mesh = vals["mesh"];
      await editCloudRunNetworking(ctx, resource, opts);
      return null;
    }
    case "editAuthMode": {
      const vals = parseFormArg(args[0]);
      await setCloudRunAuthMode(ctx, resource, String(vals["mode"] ?? "authenticated"));
      return null;
    }
    case "addIamBinding": {
      const vals = parseFormArg(args[0]);
      await addCloudRunIamBinding(
        ctx,
        resource,
        String(vals["role"] ?? ""),
        String(vals["member"] ?? ""),
      );
      return null;
    }
    case "removeIamBinding": {
      const vals = parseFormArg(args[0]);
      await removeCloudRunIamBinding(
        ctx,
        resource,
        String(vals["role"] ?? ""),
        String(vals["member"] ?? ""),
      );
      return null;
    }
    case "editBinaryAuthorization": {
      const vals = parseFormArg(args[0]);
      const enabled = vals["mode"] === "enabled" || vals["mode"] === "default";
      const policy = vals["mode"] === "custom" ? vals["policy"] : undefined;
      await setCloudRunBinaryAuthorization(ctx, resource, enabled, policy);
      return null;
    }
    case "createTrigger": {
      const vals = parseFormArg(args[0]);
      const opts: CreateEventarcTriggerOpts = {
        name: String(vals["name"] ?? ""),
        eventSource: String(vals["eventSource"] ?? ""),
      };
      if (vals["pubsubTopic"]) opts.pubsubTopic = vals["pubsubTopic"];
      if (vals["storageBucket"]) opts.storageBucket = vals["storageBucket"];
      if (vals["auditService"]) opts.auditService = vals["auditService"];
      if (vals["auditMethod"]) opts.auditMethod = vals["auditMethod"];
      if (vals["customType"]) opts.customType = vals["customType"];
      if (vals["customFilters"]) opts.customFilters = vals["customFilters"];
      if (vals["serviceAccount"]) opts.serviceAccount = vals["serviceAccount"];
      await createEventarcTrigger(ctx, resource, opts);
      return null;
    }
    case "deleteTrigger": {
      const vals = parseFormArg(args[0]);
      await deleteEventarcTrigger(ctx, resource, String(vals["triggerName"] ?? ""));
      return null;
    }
    default:
      throw new Error(`Unknown Cloud Run command: ${command}`);
  }
}

/**
 * Strip server-managed fields and serialise a Cloud Run Service as YAML.
 * Mirrors the kubectl-style cleanup the kubernetes plugin does for K8s objects.
 */
export function serviceToYaml(service: Record<string, unknown> | null): string {
  if (!service) return "";
  const clone = JSON.parse(JSON.stringify(service)) as Record<string, unknown>;
  // Drop computed/server-side noise
  delete clone["etag"];
  delete clone["uid"];
  delete clone["generation"];
  delete clone["latestCreatedRevision"];
  delete clone["observedGeneration"];
  delete clone["reconciling"];
  delete clone["terminalCondition"];
  delete clone["conditions"];
  return yaml.dump(clone, { lineWidth: 120, noRefs: true, sortKeys: false });
}
