/**
 * Every DigitalOcean resource lister, extracted from `client.ts`.
 *
 * `listDoResources` is the type dispatcher the client's `listResources`
 * delegates to; the per-type listers below it map one DO API payload into the
 * host's `ResourceInstance` shape. They take a `DoListerContext` rather than
 * living on the client so the whole listing layer is testable with a fake
 * `fetch`, and so `client.ts` stays a dispatcher.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { signedS3Fetch } from "@infrawrench/plugin-base";
import { SPACES_REGIONS } from "./constants.js";

/** The slice of `DigitalOceanClient` the listers need. */
export interface DoListerContext {
  /** Raw PAT — the inference endpoints live off `api.digitalocean.com/v2`. */
  token: string;
  credentials: Record<string, string>;
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  /** Cached DO resource URN → owning project id. */
  getProjectUrnMap(): Promise<Map<string, string>>;
  parentResourceIdForUrn(
    accountId: string,
    urn: string,
    map: Map<string, string>,
  ): string | undefined;
  /** Bucket name → region cache, written by `listSpacesBuckets`. */
  spacesBucketRegions: Map<string, string>;
}

export async function listDoResources(
  ctx: DoListerContext,
  typeId: string,
  accountId: string,
): Promise<ResourceInstance[]> {
  switch (typeId) {
    case "project":
      return listProjects(ctx, accountId);
    case "droplet":
      return listDroplets(ctx, accountId);
    case "doks-cluster":
      return listDOKSClusters(ctx, accountId);
    case "managed-database":
      return listManagedDatabases(ctx, accountId);
    case "spaces-bucket":
      return listSpacesBuckets(ctx, accountId);
    case "container-registry":
      return listContainerRegistry(ctx, accountId);
    case "domain":
      return listDomains(ctx, accountId);
    case "dns-record":
      return listAllDnsRecords(ctx, accountId);
    case "volume":
      return listVolumes(ctx, accountId);
    case "vpc":
      return listVpcs(ctx, accountId);
    case "reserved-ip":
      return listReservedIps(ctx, accountId);
    case "snapshot":
      return listSnapshots(ctx, accountId);
    case "image":
      return listImages(ctx, accountId);
    case "nfs-share":
      return listNfsShares(ctx, accountId);
    case "db-user":
      return listDatabaseUsers(ctx, accountId);
    case "gen-ai-agent":
      return listGenAiAgents(ctx, accountId);
    case "gen-ai-knowledge-base":
      return listGenAiKnowledgeBases(ctx, accountId);
    case "gen-ai-model-router":
      return listGenAiModelRouters(ctx, accountId);
    case "dedicated-inference":
      return listDedicatedInferences(ctx, accountId);
    case "inference-batch":
      return listInferenceBatches(ctx, accountId);
    case "model-api-key":
      return listModelApiKeys(ctx, accountId);
    case "agent-api-key":
      return listAgentApiKeys(ctx, accountId);
    default:
      throw new Error(`DigitalOcean plugin: unknown resource type "${typeId}"`);
  }
}

/**
 * Like `fetch`, but tolerates the "feature not enabled for this account"
 * shape DO returns for early-access products (GenAI / Dedicated Inference)
 * — 401/403/404 collapses to an empty list so the sidebar group doesn't
 * become an error spinner for everyone who hasn't opted into the product.
 */
async function fetchOrEmpty<T>(ctx: DoListerContext, path: string, fallback: T): Promise<T> {
  try {
    return await ctx.fetch<T>(path);
  } catch {
    return fallback;
  }
}

async function listGenAiAgents(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await fetchOrEmpty<{
    agents?: Array<Record<string, unknown>> | null;
  }>(ctx, "/gen-ai/agents?per_page=200", { agents: [] });
  return (data.agents ?? []).map((a) => {
    const uuid = String(a["uuid"] ?? a["id"] ?? "");
    const model = a["model"] as Record<string, unknown> | undefined;
    const router = a["model_router"] as Record<string, unknown> | undefined;
    const deployment = a["deployment"] as Record<string, unknown> | undefined;
    const knowledgeBases = Array.isArray(a["knowledge_bases"])
      ? (a["knowledge_bases"] as Array<Record<string, unknown>>)
      : [];
    // Each attached KB carries its own uuid (schema `apiKnowledgeBase`) — the
    // same uuid a `gen-ai-knowledge-base` resource uses as its externalId.
    const knowledgeBaseUuids = knowledgeBases
      .map((kb) => String(kb?.["uuid"] ?? ""))
      .filter(Boolean);
    const deploymentUrl = String(deployment?.["url"] ?? "");
    return {
      id: `${accountId}:gen-ai-agent:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
      accountId,
      displayName: String(a["name"] ?? uuid),
      fields: {
        name: String(a["name"] ?? ""),
        region: String(a["region"] ?? ""),
        description: String(a["description"] ?? ""),
        instruction: String(a["instruction"] ?? ""),
        modelUuid: String(model?.["uuid"] ?? ""),
        modelName: String(model?.["name"] ?? ""),
        modelRouterUuid: String(router?.["uuid"] ?? ""),
        modelRouterName: String(router?.["name"] ?? ""),
        projectId: String(a["project_id"] ?? ""),
        temperature: Number(a["temperature"] ?? 0),
        maxTokens: Number(a["max_tokens"] ?? 0),
        k: Number(a["k"] ?? 0),
        status: String(deployment?.["status"] ?? a["status"] ?? ""),
        deploymentVisibility: String(deployment?.["visibility"] ?? ""),
        knowledgeBaseCount: knowledgeBases.length,
        knowledgeBaseUuids: knowledgeBaseUuids.join(", "),
        deploymentUrl,
      },
      resolvedOutputs: {
        ...(deploymentUrl ? { deploymentUrl } : {}),
        ...(deploymentUrl ? { agentEndpoint: deploymentUrl } : {}),
      },
      secretStates: [],
      externalId: uuid,
      createdAt: String(a["created_at"] ?? new Date().toISOString()),
      updatedAt: String(a["updated_at"] ?? a["created_at"] ?? new Date().toISOString()),
    };
  });
}

async function listGenAiKnowledgeBases(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await fetchOrEmpty<{
    knowledge_bases?: Array<Record<string, unknown>> | null;
  }>(ctx, "/gen-ai/knowledge_bases?per_page=200", { knowledge_bases: [] });
  return (data.knowledge_bases ?? []).map((kb) => {
    const uuid = String(kb["uuid"] ?? kb["id"] ?? "");
    const lastJob = kb["last_indexing_job"] as Record<string, unknown> | undefined;
    const tags = Array.isArray(kb["tags"]) ? (kb["tags"] as string[]) : [];
    const dataSources = Array.isArray(kb["data_sources"])
      ? (kb["data_sources"] as unknown[]).length
      : 0;
    return {
      id: `${accountId}:gen-ai-knowledge-base:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-knowledge-base",
      accountId,
      displayName: String(kb["name"] ?? uuid),
      fields: {
        name: String(kb["name"] ?? ""),
        region: String(kb["region"] ?? ""),
        embeddingModelUuid: String(kb["embedding_model_uuid"] ?? ""),
        databaseId: String(kb["database_id"] ?? ""),
        projectId: String(kb["project_id"] ?? ""),
        isPublic: kb["is_public"] ? "yes" : "no",
        lastIndexingStatus: String(lastJob?.["status"] ?? ""),
        dataSourceCount: dataSources,
        tags: tags.join(","),
      },
      resolvedOutputs: uuid
        ? { retrievalEndpoint: `https://kbaas.do-ai.run/v1/${uuid}/retrieve` }
        : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(kb["created_at"] ?? new Date().toISOString()),
      updatedAt: String(kb["updated_at"] ?? kb["created_at"] ?? new Date().toISOString()),
    };
  });
}

async function listGenAiModelRouters(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await fetchOrEmpty<{
    model_routers?: Array<Record<string, unknown>> | null;
  }>(ctx, "/gen-ai/models/routers?per_page=200", { model_routers: [] });
  return (data.model_routers ?? []).map((r) => {
    const uuid = String(r["uuid"] ?? r["id"] ?? "");
    const regions = Array.isArray(r["regions"]) ? (r["regions"] as string[]) : [];
    const config = r["config"] as Record<string, unknown> | undefined;
    const fallbackRaw = Array.isArray(config?.["fallback_models"])
      ? (config?.["fallback_models"] as unknown[])
      : [];
    const policiesRaw = Array.isArray(config?.["policies"])
      ? (config?.["policies"] as Array<Record<string, unknown>>)
      : [];
    // Normalize each policy for the detail-page viewer. `models` entries can
    // be plain id strings or objects ({uuid,name}); flatten to {id,name}.
    const policies = policiesRaw.map((p) => {
      const models = Array.isArray(p["models"]) ? (p["models"] as unknown[]) : [];
      const custom = p["custom_task"] as Record<string, unknown> | undefined;
      const selection = p["selection_policy"] as Record<string, unknown> | undefined;
      return {
        task: String(p["task_slug"] ?? custom?.["name"] ?? custom?.["slug"] ?? ""),
        prefer: String(selection?.["prefer"] ?? ""),
        models: models.map((m) =>
          typeof m === "string"
            ? { id: m, name: "" }
            : {
                id: String((m as Record<string, unknown>)["uuid"] ?? ""),
                name: String((m as Record<string, unknown>)["name"] ?? ""),
              },
        ),
      };
    });
    const fallback = fallbackRaw.map((m) =>
      typeof m === "string"
        ? { id: m, name: "" }
        : {
            id: String((m as Record<string, unknown>)["uuid"] ?? ""),
            name: String((m as Record<string, unknown>)["name"] ?? ""),
          },
    );
    return {
      id: `${accountId}:gen-ai-model-router:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-model-router",
      accountId,
      displayName: String(r["name"] ?? uuid),
      fields: {
        name: String(r["name"] ?? ""),
        description: String(r["description"] ?? ""),
        regions: regions.join(","),
        fallbackModels: fallback.map((m) => m.name || m.id).join(", "),
        policyCount: policies.length,
      },
      resolvedOutputs: {
        __policies__: JSON.stringify(policies),
        __fallbackModels__: JSON.stringify(fallback),
      },
      secretStates: [],
      externalId: uuid,
      createdAt: String(r["created_at"] ?? new Date().toISOString()),
      updatedAt: String(r["updated_at"] ?? r["created_at"] ?? new Date().toISOString()),
    };
  });
}

async function listDedicatedInferences(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await fetchOrEmpty<{
    dedicated_inferences?: Array<Record<string, unknown>> | null;
  }>(ctx, "/dedicated-inferences?per_page=200", { dedicated_inferences: [] });
  return (data.dedicated_inferences ?? []).map((d) => {
    const id = String(d["id"] ?? "");
    const spec = (d["spec"] ?? d["pending_deployment_spec"]) as Record<string, unknown> | undefined;
    const deployments = Array.isArray(spec?.["model_deployments"])
      ? (spec?.["model_deployments"] as Array<Record<string, unknown>>)
      : [];
    const endpoints = d["endpoints"] as Record<string, unknown> | undefined;
    const publicEndpoint = String(endpoints?.["public_endpoint_fqdn"] ?? "");
    const privateEndpoint = String(endpoints?.["private_endpoint_fqdn"] ?? "");
    const modelSummary = deployments
      .map((m) => String(m["model_id"] ?? m["model_uuid"] ?? m["model_name"] ?? ""))
      .filter(Boolean)
      .join(", ");
    return {
      id: `${accountId}:dedicated-inference:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "dedicated-inference",
      accountId,
      displayName: String(spec?.["name"] ?? id),
      fields: {
        name: String(spec?.["name"] ?? ""),
        region: String(d["region"] ?? ""),
        vpcUuid: String(d["vpc_uuid"] ?? ""),
        enablePublicEndpoint: spec?.["enable_public_endpoint"] ? "yes" : "no",
        modelCount: deployments.length,
        modelSummary,
        publicEndpoint,
        privateEndpoint,
        status: String(d["status"] ?? ""),
      },
      resolvedOutputs: {
        ...(publicEndpoint ? { publicEndpointUrl: publicEndpoint } : {}),
        ...(privateEndpoint ? { privateEndpointUrl: privateEndpoint } : {}),
      },
      secretStates: [],
      externalId: id,
      createdAt: String(d["created_at"] ?? new Date().toISOString()),
      updatedAt: String(d["updated_at"] ?? d["created_at"] ?? new Date().toISOString()),
    };
  });
}

/**
 * The Batch Inference API lives on a separate host (inference.do-ai.run)
 * and uses the same bearer token as the management plane. The endpoint
 * paginates with `after` cursors instead of page/per_page — we only fetch
 * the first page (newest 100) for the sidebar; the detail page can drill
 * in for older jobs.
 */
async function listInferenceBatches(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  try {
    const res = await fetch("https://inference.do-ai.run/v1/batches?limit=100", {
      headers: { Authorization: `Bearer ${ctx.token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<Record<string, unknown>> | null;
    };
    return (data.data ?? []).map((b) => {
      const batchId = String(b["batch_id"] ?? b["id"] ?? "");
      const counts = b["request_counts"] as Record<string, unknown> | undefined;
      return {
        id: `${accountId}:inference-batch:${batchId}`,
        pluginId: "digitalocean",
        resourceTypeId: "inference-batch",
        accountId,
        displayName: batchId,
        fields: {
          provider: String(b["provider"] ?? ""),
          endpoint: String(b["endpoint"] ?? ""),
          completionWindow: String(b["completion_window"] ?? "24h"),
          inputFileId: String(b["input_file_id"] ?? ""),
          outputFileId: String(b["output_file_id"] ?? ""),
          errorFileId: String(b["error_file_id"] ?? ""),
          status: String(b["status"] ?? ""),
          totalRequests: Number(counts?.["total"] ?? 0),
          completedRequests: Number(counts?.["completed"] ?? 0),
          failedRequests: Number(counts?.["failed"] ?? 0),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: batchId,
        createdAt: String(b["created_at"] ?? new Date().toISOString()),
        updatedAt: String(b["updated_at"] ?? b["created_at"] ?? new Date().toISOString()),
      };
    });
  } catch {
    return [];
  }
}

async function listModelApiKeys(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await fetchOrEmpty<{
    api_key_infos?: Array<Record<string, unknown>> | null;
  }>(ctx, "/gen-ai/models/api_keys?per_page=200", { api_key_infos: [] });
  return (data.api_key_infos ?? []).map((k) => {
    const uuid = String(k["uuid"] ?? k["id"] ?? "");
    return {
      id: `${accountId}:model-api-key:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "model-api-key",
      accountId,
      displayName: String(k["name"] ?? uuid),
      fields: {
        name: String(k["name"] ?? ""),
        createdBy: String(k["created_by"] ?? ""),
        lastUsedAt: String(k["last_used_at"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(k["created_at"] ?? new Date().toISOString()),
      updatedAt: String(k["created_at"] ?? new Date().toISOString()),
    };
  });
}

/**
 * Agent-scoped API keys (the per-agent bearer tokens used by client SDKs
 * to call an agent's deployment endpoint). DO exposes them only per agent,
 * not as a flat list — so we fan out across every agent and concat. One
 * failed lookup doesn't blank the rest. Composite externalId
 * `{agentUuid}/{keyUuid}` mirrors `nfs-share`'s `{region}/{shareId}` shape.
 */
async function listAgentApiKeys(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const agentList = await fetchOrEmpty<{
    agents?: Array<Record<string, unknown>> | null;
  }>(ctx, "/gen-ai/agents?per_page=200", { agents: [] });
  const agents = agentList.agents ?? [];
  const keyLists = await Promise.allSettled(
    agents.map(async (a) => {
      const agentUuid = String(a["uuid"] ?? a["id"] ?? "");
      if (!agentUuid) return [] as ResourceInstance[];
      const resp = await ctx.fetch<{
        api_key_infos?: Array<Record<string, unknown>> | null;
      }>(`/gen-ai/agents/${agentUuid}/api_keys?per_page=200`);
      const now = new Date().toISOString();
      return (resp.api_key_infos ?? []).map<ResourceInstance>((k) => {
        const keyUuid = String(k["uuid"] ?? k["id"] ?? "");
        return {
          id: `${accountId}:agent-api-key:${agentUuid}/${keyUuid}`,
          pluginId: "digitalocean",
          resourceTypeId: "agent-api-key",
          accountId,
          displayName: String(k["name"] ?? keyUuid),
          fields: {
            name: String(k["name"] ?? ""),
            createdBy: String(k["created_by"] ?? ""),
            // The owning agent, already known from the fan-out above. Also
            // encoded in `parentResourceId`, but the graph reads fields.
            agentUuid,
          },
          resolvedOutputs: {},
          // Secret isn't returned by the list endpoint — only on create
          // and regenerate. Existing keys have no recoverable secret.
          secretStates: [],
          externalId: `${agentUuid}/${keyUuid}`,
          parentResourceId: `${accountId}:gen-ai-agent:${agentUuid}`,
          createdAt: String(k["created_at"] ?? now),
          updatedAt: String(k["created_at"] ?? now),
        };
      });
    }),
  );
  return keyLists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

async function listProjects(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.fetch<{ projects?: Array<Record<string, unknown>> | null }>("/projects");
  return (data.projects ?? []).map((p) => ({
    id: `${accountId}:project:${String(p["id"])}`,
    pluginId: "digitalocean",
    resourceTypeId: "project",
    accountId,
    displayName: String(p["name"]),
    fields: {
      name: String(p["name"]),
      purpose: String(p["purpose"] ?? ""),
      description: String(p["description"] ?? ""),
      environment: String(p["environment"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(p["id"]),
    createdAt: String(p["created_at"] ?? new Date().toISOString()),
    updatedAt: String(p["updated_at"] ?? new Date().toISOString()),
  }));
}

async function listDroplets(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // DO's /droplets default page size is 20 — without per_page, a freshly-
  // created droplet on page 2 looks like it doesn't exist.
  const [data, projectMap] = await Promise.all([
    ctx.fetch<{ droplets?: Array<Record<string, unknown>> | null }>("/droplets?per_page=200"),
    ctx.getProjectUrnMap(),
  ]);
  return (data.droplets ?? []).map((d) => mapDroplet(ctx, d, accountId, projectMap));
}

/**
 * Shape a single DO /droplets element into a `ResourceInstance`. Shared
 * between the list path and the single-resource `getResource` path so the
 * post-create detail page (which uses GET /v2/droplets/{id} to avoid a
 * race with the list endpoint) produces identical fields/outputs.
 */
export function mapDroplet(
  ctx: DoListerContext,
  d: Record<string, unknown>,
  accountId: string,
  projectMap: Map<string, string>,
): ResourceInstance {
  const v4 = ((d["networks"] as Record<string, unknown> | undefined)?.["v4"] ?? []) as Array<{
    ip_address?: string;
    type?: string;
  }>;
  const v6 = ((d["networks"] as Record<string, unknown> | undefined)?.["v6"] ?? []) as Array<{
    ip_address?: string;
    type?: string;
  }>;
  const ipv4 = v4.find((n) => n.type === "public")?.ip_address ?? "";
  const ipv4Private = v4.find((n) => n.type === "private")?.ip_address ?? "";
  const ipv6 = v6.find((n) => n.type === "public")?.ip_address ?? "";
  const backupIds = Array.isArray(d["backup_ids"]) ? (d["backup_ids"] as number[]) : [];
  const snapshotIds = Array.isArray(d["snapshot_ids"]) ? (d["snapshot_ids"] as number[]) : [];
  const volumeIds = Array.isArray(d["volume_ids"]) ? (d["volume_ids"] as string[]) : [];
  const tags = Array.isArray(d["tags"]) ? (d["tags"] as string[]) : [];
  const sizeObj = d["size"] as Record<string, unknown> | undefined;
  // `next_backup_window` is the authoritative "backups are scheduled" signal.
  // DO's `features` array can lag after the enable_backups action completes,
  // which made the Enable Backups button stick around after a successful
  // enable. We surface the next-window start so the button conditional can
  // fall back on it regardless of when DO eventually flips `features`.
  const nextBackupWindow = d["next_backup_window"] as
    | { start?: string; end?: string }
    | null
    | undefined;
  const nextBackupStart = nextBackupWindow?.start ?? "";
  const backupPolicy = d["backup_policy"] as
    | { plan?: string; hour?: number; weekday?: string }
    | null
    | undefined;
  const parentResourceId = ctx.parentResourceIdForUrn(
    accountId,
    `do:droplet:${String(d["id"])}`,
    projectMap,
  );
  return {
    id: `${accountId}:droplet:${String(d["id"])}`,
    pluginId: "digitalocean",
    resourceTypeId: "droplet",
    accountId,
    displayName: String(d["name"]),
    fields: {
      name: String(d["name"]),
      region: String((d["region"] as Record<string, unknown>)?.["slug"] ?? ""),
      size: String(sizeObj?.["slug"] ?? ""),
      image: String((d["image"] as Record<string, unknown>)?.["slug"] ?? ""),
      status: String(d["status"] ?? ""),
      memoryMb: Number(d["memory"] ?? 0),
      vcpus: Number(d["vcpus"] ?? 0),
      diskGb: Number(d["disk"] ?? 0),
      priceMonthly: Number(sizeObj?.["price_monthly"] ?? 0),
      tags: tags.join(","),
      backupIds: backupIds.join(","),
      snapshotIds: snapshotIds.join(","),
      volumeIds: volumeIds.join(","),
      features: Array.isArray(d["features"]) ? (d["features"] as string[]).join(",") : "",
      nextBackupStart,
      backupPolicyPlan: backupPolicy?.plan ?? "",
      backupPolicyHour: backupPolicy?.hour != null ? String(backupPolicy.hour) : "",
      backupPolicyWeekday: backupPolicy?.weekday ?? "",
      // VPC the droplet lives in — used by the NFS-share→droplet drop
      // target to derive the share-level `attach` action's `vpc_id`.
      vpcUuid: String(d["vpc_uuid"] ?? ""),
    },
    resolvedOutputs: {
      ...(ipv4 ? { ipv4 } : {}),
      ...(ipv4Private ? { ipv4Private } : {}),
      ...(ipv6 ? { ipv6 } : {}),
    },
    secretStates: [],
    externalId: String(d["id"]),
    ...(parentResourceId ? { parentResourceId } : {}),
    createdAt: String(d["created_at"] ?? new Date().toISOString()),
    updatedAt: String(d["created_at"] ?? new Date().toISOString()),
  };
}

async function listSnapshots(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // /v2/snapshots aggregates both droplet and volume snapshots. resource_type
  // disambiguates; resource_id points to the originating droplet (number) or
  // volume (uuid).
  const data = await ctx.fetch<{
    snapshots: Array<Record<string, unknown>>;
  }>("/snapshots?per_page=200");
  return (data.snapshots ?? []).map((s) => ({
    id: `${accountId}:snapshot:${String(s["id"])}`,
    pluginId: "digitalocean",
    resourceTypeId: "snapshot",
    accountId,
    displayName: String(s["name"] ?? s["id"]),
    fields: {
      name: String(s["name"] ?? ""),
      resourceType: String(s["resource_type"] ?? ""),
      resourceId: String(s["resource_id"] ?? ""),
      regions: Array.isArray(s["regions"]) ? (s["regions"] as string[]).join(",") : "",
      sizeGb: Number(s["size_gigabytes"] ?? 0),
      minDiskSize: Number(s["min_disk_size"] ?? 0),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(s["id"]),
    createdAt: String(s["created_at"] ?? new Date().toISOString()),
    updatedAt: String(s["created_at"] ?? new Date().toISOString()),
  }));
}

async function listImages(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // Surface user-owned images by default (snapshots, backups, custom uploads).
  // Distribution + application marketplace images are noisy in a sidebar and
  // already exposed in the droplet create form via getCreateConfig.
  const data = await ctx.fetch<{
    images: Array<Record<string, unknown>>;
  }>("/images?private=true&per_page=200");
  return (data.images ?? []).map((img) => ({
    id: `${accountId}:image:${String(img["id"])}`,
    pluginId: "digitalocean",
    resourceTypeId: "image",
    accountId,
    displayName: String(img["name"] ?? img["id"]),
    fields: {
      name: String(img["name"] ?? ""),
      type: String(img["type"] ?? ""),
      distribution: String(img["distribution"] ?? ""),
      slug: String(img["slug"] ?? ""),
      regions: Array.isArray(img["regions"]) ? (img["regions"] as string[]).join(",") : "",
      sizeGb: Number(img["size_gigabytes"] ?? 0),
      minDiskSize: Number(img["min_disk_size"] ?? 0),
      status: String(img["status"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(img["id"]),
    createdAt: String(img["created_at"] ?? new Date().toISOString()),
    updatedAt: String(img["created_at"] ?? new Date().toISOString()),
  }));
}

async function listNfsShares(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // The NFS API is region-scoped but listing without a region returns shares
  // from every region the account has any in. DO encodes the region in each
  // share's response so we don't have to fan-out by region for listing.
  let shares: Array<Record<string, unknown>> = [];
  try {
    const data = await ctx.fetch<{ nfs?: Array<Record<string, unknown>> }>("/nfs?per_page=200");
    shares = data.nfs ?? [];
  } catch {
    // NFS is region-gated; an account in a non-NFS region returns 4xx.
    return [];
  }
  return shares.map((s) => {
    const region = String(s["region"] ?? "");
    const externalId = `${region}/${String(s["id"])}`;
    const mountTargets = Array.isArray(s["mount_targets"])
      ? (s["mount_targets"] as Array<Record<string, unknown>>)
      : [];
    const mountTarget = String(
      mountTargets[0]?.["address"] ?? mountTargets[0]?.["mount_path"] ?? "",
    );
    const exportPath = String(mountTargets[0]?.["export_path"] ?? `/${String(s["id"])}`);
    const mountCommand = mountTarget
      ? `sudo mount -t nfs -o nfsvers=4.1 ${mountTarget}:${exportPath} /mnt/${s["name"] ?? s["id"]}`
      : "";
    const vpcIds = Array.isArray(s["vpc_ids"]) ? (s["vpc_ids"] as string[]) : [];
    return {
      id: `${accountId}:nfs-share:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "nfs-share",
      accountId,
      displayName: String(s["name"] ?? s["id"]),
      fields: {
        name: String(s["name"] ?? ""),
        region,
        sizeGib: Number(s["size_gib"] ?? 0),
        performanceTier: String(s["performance_tier"] ?? "standard"),
        vpcIds: vpcIds.join(","),
        mountTarget,
        status: String(s["status"] ?? ""),
      },
      resolvedOutputs: {
        ...(mountTarget ? { mountTarget } : {}),
        ...(mountCommand ? { mountCommand } : {}),
      },
      secretStates: [],
      externalId,
      createdAt: String(s["created_at"] ?? new Date().toISOString()),
      updatedAt: String(s["created_at"] ?? new Date().toISOString()),
    };
  });
}

async function listDOKSClusters(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const [data, projectMap] = await Promise.all([
    ctx.fetch<{ kubernetes_clusters?: Array<Record<string, unknown>> | null }>(
      "/kubernetes/clusters",
    ),
    ctx.getProjectUrnMap(),
  ]);
  return (data.kubernetes_clusters ?? []).map((c) => {
    const nodePool = (c["node_pools"] as Array<Record<string, unknown>> | undefined)?.[0];
    const parentResourceId = ctx.parentResourceIdForUrn(
      accountId,
      `do:kubernetes:${String(c["id"])}`,
      projectMap,
    );
    const statusObj = c["status"] as { state?: string; message?: string } | undefined;
    return {
      id: `${accountId}:doks-cluster:${String(c["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "doks-cluster",
      accountId,
      displayName: String(c["name"]),
      fields: {
        name: String(c["name"]),
        region: String(c["region"] ?? ""),
        version: String(c["version"] ?? ""),
        nodePoolSize: String(nodePool?.["size"] ?? ""),
        nodeCount: Number(nodePool?.["count"] ?? 0),
        status: String(statusObj?.state ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(c["id"]),
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt: String(c["created_at"] ?? new Date().toISOString()),
      updatedAt: String(c["updated_at"] ?? new Date().toISOString()),
    };
  });
}

async function listManagedDatabases(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // DO returns `{ "databases": null }` for accounts that have never had
  // one (instead of an empty array), which made `.map` throw and the
  // account section render "Cannot read properties of null".
  const [data, projectMap] = await Promise.all([
    ctx.fetch<{ databases?: Array<Record<string, unknown>> | null }>("/databases"),
    ctx.getProjectUrnMap(),
  ]);
  return (data.databases ?? []).map((db) => {
    const parentResourceId = ctx.parentResourceIdForUrn(
      accountId,
      `do:dbaas:${String(db["id"])}`,
      projectMap,
    );
    return {
      id: `${accountId}:managed-database:${String(db["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "managed-database",
      accountId,
      displayName: String(db["name"]),
      fields: {
        name: String(db["name"]),
        engine: String(db["engine"] ?? ""),
        version: String(db["version"] ?? ""),
        region: String(db["region"] ?? ""),
        size: String(db["size"] ?? ""),
        nodeCount: Number(db["num_nodes"] ?? 1),
        status: String(db["status"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(db["id"]),
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: String(db["created_at"] ?? new Date().toISOString()),
    };
  });
}

/**
 * Fan out across every cluster to enumerate its users. DO has no "list users
 * across all my clusters" endpoint — only per-cluster — so we re-use the
 * already-fetched cluster list and parallelise the per-cluster calls. Failed
 * lookups are skipped silently so one mid-provision cluster (which 409s on
 * /users until it's online) doesn't blow up the whole sidebar.
 */
async function listDatabaseUsers(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.fetch<{ databases?: Array<Record<string, unknown>> | null }>("/databases");
  const clusters = data.databases ?? [];
  const userLists = await Promise.allSettled(
    clusters.map(async (db) => {
      const clusterId = String(db["id"] ?? "");
      if (!clusterId) return [] as ResourceInstance[];
      const resp = await ctx.fetch<{
        users?: Array<{ name?: string; role?: string }>;
      }>(`/databases/${clusterId}/users`);
      const now = String(db["created_at"] ?? new Date().toISOString());
      return (resp.users ?? []).map<ResourceInstance>((u) => ({
        id: `${accountId}:db-user:${clusterId}:${u.name ?? ""}`,
        pluginId: "digitalocean",
        resourceTypeId: "db-user",
        accountId,
        displayName: u.name ?? "(unnamed)",
        fields: {
          name: u.name ?? "",
          role: u.role ?? "",
          // The owning cluster, already known from the fan-out above. Also
          // encoded in `parentResourceId`, but the graph reads fields.
          databaseId: clusterId,
        },
        resolvedOutputs: {},
        // The list endpoint never returns the password — only the per-user
        // `POST /users` response does. We can't reconstruct it after the
        // fact, so existing users (incl. doadmin) are persisted without one.
        secretStates: [],
        externalId: u.name ?? "",
        parentResourceId: `${accountId}:managed-database:${clusterId}`,
        createdAt: now,
        updatedAt: now,
      }));
    }),
  );
  return userLists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export async function listSpacesBuckets(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const accessKeyId = ctx.credentials["spacesAccessKeyId"];
  const secretAccessKey = ctx.credentials["spacesSecretAccessKey"];
  if (!accessKeyId || !secretAccessKey) return [];

  const projectMap = await ctx.getProjectUrnMap();

  // Per-region fan-out is tolerant of individual region failures —
  // freshly-minted Spaces keys can take longer to propagate to some
  // regions than others, and we'd previously blow up the whole list
  // call (and the post-create detail page) on a single 403. We log
  // the failures but never throw from the per-region results.
  const settled = await Promise.allSettled(
    SPACES_REGIONS.map(async (region) => {
      const host = `${region}.digitaloceanspaces.com`;
      const res = await signedS3Fetch({
        accessKey: accessKeyId,
        secretKey: secretAccessKey,
        region,
        method: "GET",
        url: `https://${host}/`,
      });
      if (!res.ok) {
        // Bury the body so it doesn't appear in the host's toast as
        // "Spaces S3 API error 403 listing buckets in nyc1: …" while
        // the user is looking at the bucket they just created in fra1.
        throw new Error(`Spaces ${region} returned ${res.status}`);
      }
      const xml = await res.text();
      // Parse each `<Bucket>…</Bucket>` block independently then extract
      // `<Name>` / `<CreationDate>` from inside. DO's S3 ListAllMyBuckets
      // response can include additional child elements (e.g.
      // `<BucketRegion>`) which a tighter regex would have rejected,
      // making the bucket invisible after creation.
      const items: Array<{ name: string; createdAt: string; region: string }> = [];
      for (const block of xml.matchAll(/<Bucket\b[^>]*>([\s\S]*?)<\/Bucket>/g)) {
        const inner = block[1] ?? "";
        const name = /<Name>\s*([^<]+?)\s*<\/Name>/.exec(inner)?.[1];
        const createdAt = /<CreationDate>\s*([^<]+?)\s*<\/CreationDate>/.exec(inner)?.[1];
        if (name && createdAt) items.push({ name, createdAt, region });
      }
      return items;
    }),
  );
  const perRegion: Array<Array<{ name: string; createdAt: string; region: string }>> = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      perRegion.push(r.value);
    } else {
      console.warn(
        `[do.listSpacesBuckets] region ${SPACES_REGIONS[i]} unavailable, skipping: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
      perRegion.push([]);
    }
  }

  // Dedupe by bucket name: if DO's endpoint returns the same bucket from multiple
  // regions, keep the first occurrence (regions iterated in SPACES_REGIONS order).
  const seen = new Set<string>();
  const buckets: ResourceInstance[] = [];
  for (const entry of perRegion.flat()) {
    const { name, createdAt, region } = entry;
    if (!name || !createdAt || seen.has(name)) continue;
    seen.add(name);
    ctx.spacesBucketRegions.set(name, region);
    const parentResourceId = ctx.parentResourceIdForUrn(accountId, `do:space:${name}`, projectMap);
    buckets.push({
      id: `${accountId}:spaces-bucket:${name}`,
      pluginId: "digitalocean",
      resourceTypeId: "spaces-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        accessControl: "private",
      },
      resolvedOutputs: {
        endpoint: `https://${name}.${region}.digitaloceanspaces.com`,
        // `name|region` — consumed by the KB "Add Spaces source" resource
        // picker so the handler gets both halves without a region lookup.
        bucketRef: `${name}|${region}`,
      },
      secretStates: [],
      externalId: name,
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt,
      updatedAt: createdAt,
    });
  }
  return buckets;
}

/**
 * DO allows at most one container registry per account, and GET /v2/registry
 * returns it or 404s when none exists — so a 404 maps to an empty list while
 * every other error propagates (unlike `fetchOrEmpty`, which would also hide
 * scope/rate-limit failures). The subscription tier isn't on the registry
 * payload; it lives on GET /v2/registry/subscription, fetched best-effort so
 * a token without the extra scope just leaves the field blank.
 */
async function listContainerRegistry(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  let data: { registry?: Record<string, unknown> | null };
  try {
    data = await ctx.fetch<{ registry?: Record<string, unknown> | null }>("/registry");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\bAPI error 404\b/.test(message)) return [];
    throw err;
  }
  const r = data.registry;
  if (!r) return [];
  const name = String(r["name"] ?? "");
  const subscription = await ctx
    .fetch<{ subscription?: { tier?: { slug?: string } } }>("/registry/subscription")
    .catch(() => null);
  const now = new Date().toISOString();
  return [
    {
      id: `${accountId}:container-registry:${name}`,
      pluginId: "digitalocean",
      resourceTypeId: "container-registry",
      accountId,
      displayName: name,
      fields: {
        name,
        subscriptionTier: String(subscription?.subscription?.tier?.slug ?? ""),
        region: String(r["region"] ?? ""),
        storageUsageBytes: Number(r["storage_usage_bytes"] ?? 0),
        createdAt: String(r["created_at"] ?? ""),
      },
      resolvedOutputs: {
        endpoint: `registry.digitalocean.com/${name}`,
        serverUrl: "registry.digitalocean.com",
      },
      secretStates: [],
      externalId: name,
      createdAt: String(r["created_at"] ?? now),
      updatedAt: now,
    },
  ];
}

async function listDomains(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.fetch<{ domains: Array<Record<string, unknown>> }>("/domains");
  return (data.domains ?? []).map((d) => ({
    id: `${accountId}:domain:${String(d["name"])}`,
    pluginId: "digitalocean",
    resourceTypeId: "domain",
    accountId,
    displayName: String(d["name"]),
    fields: {
      name: String(d["name"]),
      ttl: Number(d["ttl"] ?? 1800),
      zoneFile: String(d["zone_file"] ?? ""),
    },
    resolvedOutputs: {
      nameservers: "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com",
    },
    secretStates: [],
    externalId: String(d["name"]),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

async function listAllDnsRecords(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const domains = await listDomains(ctx, accountId);
  const results: ResourceInstance[] = [];
  for (const domain of domains) {
    const domainName = String(domain.fields["name"]);
    try {
      const data = await ctx.fetch<{
        domain_records: Array<Record<string, unknown>>;
      }>(`/domains/${domainName}/records?per_page=200`);
      for (const r of data.domain_records ?? []) {
        const type = String(r["type"] ?? "");
        const name = String(r["name"] ?? "@");
        const displayName = name === "@" ? domainName : `${name}.${domainName}`;
        results.push({
          id: `${accountId}:dns-record:${domainName}/${String(r["id"])}`,
          pluginId: "digitalocean",
          resourceTypeId: "dns-record",
          accountId,
          displayName: `${type} ${displayName}`,
          fields: {
            type,
            name: displayName,
            data: String(r["data"] ?? ""),
            ttl: Number(r["ttl"] ?? 1800),
            ...(r["priority"] !== undefined && r["priority"] !== null
              ? { priority: Number(r["priority"]) }
              : {}),
            ...(r["port"] !== undefined && r["port"] !== null ? { port: Number(r["port"]) } : {}),
            ...(r["weight"] !== undefined && r["weight"] !== null
              ? { weight: Number(r["weight"]) }
              : {}),
            ...(r["flags"] !== undefined && r["flags"] !== null
              ? { flags: Number(r["flags"]) }
              : {}),
            ...(r["tag"] ? { tag: String(r["tag"]) } : {}),
            domainName,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${domainName}/${String(r["id"])}`,
          parentResourceId: `${accountId}:domain:${domainName}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      // Skip domains we can't read records for
    }
  }
  return results;
}

async function listVolumes(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const [data, projectMap] = await Promise.all([
    ctx.fetch<{ volumes: Array<Record<string, unknown>> }>("/volumes?per_page=200"),
    ctx.getProjectUrnMap(),
  ]);
  return (data.volumes ?? []).map((v) => {
    const parentResourceId = ctx.parentResourceIdForUrn(
      accountId,
      `do:volume:${String(v["id"])}`,
      projectMap,
    );
    return {
      id: `${accountId}:volume:${String(v["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "volume",
      accountId,
      displayName: String(v["name"] ?? v["id"]),
      fields: {
        name: String(v["name"] ?? ""),
        region: String((v["region"] as Record<string, unknown>)?.["slug"] ?? ""),
        sizeGb: Number(v["size_gigabytes"] ?? 0),
        filesystemType: String(v["filesystem_type"] ?? ""),
        dropletIds: Array.isArray(v["droplet_ids"]) ? (v["droplet_ids"] as number[]).join(",") : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(v["id"] ?? ""),
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt: String(v["created_at"] ?? new Date().toISOString()),
      updatedAt: String(v["created_at"] ?? new Date().toISOString()),
    };
  });
}

/**
 * Reserved IPs. `GET /v2/reserved_ips` returns `{ reserved_ips: [...] }` with
 * the standard page/per_page pagination; each element carries `ip`, the full
 * `region` object, the full `droplet` object (or `null`), `locked` and
 * `project_id` (verified against digitalocean/openapi, schema `reserved_ip`).
 *
 * The address doubles as the identifier — every other reserved-IP endpoint is
 * `/v2/reserved_ips/{ip}` — so `externalId` is the dotted-quad.
 *
 * Unlike volumes/droplets this doesn't need the project-URN map: the payload
 * carries `project_id` directly (it needs the token's `project:read` scope;
 * without it the field is absent and the address simply lists un-parented).
 *
 * `dropletId` is always written — `""` when unassigned — because the orphan
 * rule compares it with `equals: ""`.
 */
async function listReservedIps(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.fetch<{ reserved_ips?: Array<Record<string, unknown>> | null }>(
    "/reserved_ips?per_page=200",
  );
  return (data.reserved_ips ?? []).map((r) => {
    const ip = String(r["ip"] ?? "");
    const droplet = (r["droplet"] ?? null) as Record<string, unknown> | null;
    const dropletId = droplet?.["id"] != null ? String(droplet["id"]) : "";
    const projectId = String(r["project_id"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:reserved-ip:${ip}`,
      pluginId: "digitalocean",
      resourceTypeId: "reserved-ip",
      accountId,
      displayName: ip,
      fields: {
        ip,
        region: String((r["region"] as Record<string, unknown>)?.["slug"] ?? ""),
        dropletId,
        dropletName: droplet ? String(droplet["name"] ?? "") : "",
        locked: r["locked"] === true,
        projectId,
      },
      resolvedOutputs: { ...(ip ? { ip } : {}) },
      secretStates: [],
      externalId: ip,
      ...(projectId ? { parentResourceId: `${accountId}:project:${projectId}` } : {}),
      // DO doesn't timestamp reserved IPs on the list payload.
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * VPC networks. `GET /v2/vpcs` returns `{ vpcs: [...] }` with the standard
 * page/per_page pagination; each element carries `id`, `urn`, `name`,
 * `description`, `region`, `ip_range`, `default` and `created_at` (verified
 * against DigitalOcean's published OpenAPI spec, schema `vpc`).
 *
 * `externalId` is the bare uuid, which is exactly what a Droplet's `vpc_uuid`,
 * an NFS share's `vpc_ids` and a Dedicated Inference endpoint's `vpc_uuid`
 * hold — so those fields resolve to this resource without a translation step.
 *
 * Member counts are deliberately absent: DO exposes them only via a separate
 * `/v2/vpcs/{id}/members` request per VPC, which listing must not spend.
 */
async function listVpcs(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.fetch<{ vpcs?: Array<Record<string, unknown>> | null }>(
    "/vpcs?per_page=200",
  );
  return (data.vpcs ?? []).map((v) => {
    const id = String(v["id"] ?? "");
    const createdAt = String(v["created_at"] ?? new Date().toISOString());
    return {
      id: `${accountId}:vpc:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "vpc",
      accountId,
      displayName: String(v["name"] ?? id),
      fields: {
        name: String(v["name"] ?? ""),
        region: String(v["region"] ?? ""),
        ipRange: String(v["ip_range"] ?? ""),
        description: String(v["description"] ?? ""),
        isDefault: v["default"] === true,
        createdAt,
      },
      resolvedOutputs: { ...(id ? { vpcId: id } : {}) },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  });
}

// ── Spaces (S3-compatible) storage browser ──────────────────────────────
