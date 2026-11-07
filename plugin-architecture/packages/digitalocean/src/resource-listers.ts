/**
 * Every DigitalOcean resource lister.
 *
 * `listDoResources` is the type dispatcher the client's `listResources`
 * delegates to; the per-type listers below it map one DO API payload into the
 * host's `ResourceInstance` shape. They take a `DoListerContext` rather than
 * living on the client so the whole listing layer is testable with a fake
 * `fetch`, and so `client.ts` stays a dispatcher.
 */
import type { ApiListItem, ResourceInstance } from "@infrawrench/plugin-base";
import { requireListPage, signedS3Fetch } from "@infrawrench/plugin-base";
import { failedWith, idSegment, rowsOf } from "./api.js";
import type { DoApi, DoResponse } from "./api.js";
import type { operations } from "./api-types.gen.js";
import { SPACES_REGIONS } from "./constants.js";
import { listDoServiceResources } from "./service-listers.js";

/** The slice of `DigitalOceanClient` the listers need. */
export interface DoListerContext {
  /** Raw PAT: the inference endpoints live off `api.digitalocean.com/v2`. */
  token: string;
  credentials: Record<string, string>;
  api: DoApi;
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

type DoDroplet = ApiListItem<operations["droplets_list"], "droplets"> & {
  /** Not in the document, which keeps it at `/droplets/{id}/backups/policy` (#415). */
  backup_policy?: { plan?: string; hour?: number; weekday?: string } | null;
};

/** The document's list rows have no `id`, `status` or `knowledge_bases` (#414). */
export type DoAgentRow = ApiListItem<operations["genai_list_agents"], "agents"> & {
  id?: string;
  status?: string;
  knowledge_bases?: Array<{ uuid?: string }> | null;
};

export type DoKnowledgeBaseRow = ApiListItem<
  operations["genai_list_knowledge_bases"],
  "knowledge_bases"
> & {
  id?: string;
  /** Not in the document (#414). */
  data_sources?: readonly object[] | null;
};

type DoModelRouterRow = ApiListItem<operations["genai_list_model_routers"], "model_routers"> & {
  id?: string;
};

type DoModelApiKeyRow = ApiListItem<operations["genai_list_model_api_keys"], "api_key_infos"> & {
  id?: string;
  /** Not in the document (#414). */
  last_used_at?: string;
};

type DoAgentApiKeyRow = ApiListItem<operations["genai_list_agent_api_keys"], "api_key_infos"> & {
  id?: string;
};

/** What the plugin reads of a share: the document's fields, and one it does not list (#411). */
type DoNfsRow = Partial<NonNullable<DoResponse<"nfs_list">["shares"]>[number]> & {
  mount_targets?: Array<{ address?: string; mount_path?: string; export_path?: string }> | null;
};

/** A router's model reference: the document says an id, and an object has been seen. */
function modelRef(m: string | { uuid?: string; name?: string }): { id: string; name: string } {
  return typeof m === "string"
    ? { id: m, name: "" }
    : {
        id: String(m.uuid ?? ""),
        name: String(m.name ?? ""),
      };
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
    default: {
      const services = await listDoServiceResources(ctx, typeId, accountId);
      if (services) return services;
      throw new Error(`DigitalOcean plugin: unknown resource type "${typeId}"`);
    }
  }
}

/**
 * Waits for a request, but tolerates the "feature not enabled for this account"
 * shape DO returns for early-access products (GenAI / Dedicated Inference): 403/404
 * collapses to an empty list so the sidebar group doesn't become an error spinner
 * for everyone who hasn't opted in. A 401 is a token that no longer works, and
 * anything else is a failure: read as empty, either would prune what the account has.
 */
async function orEmpty<T>(request: Promise<T[]>): Promise<T[]> {
  try {
    return await request;
  } catch (err) {
    if (failedWith(err, 403, 404)) return [];
    throw err;
  }
}

async function listGenAiAgents(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const agents = await orEmpty(ctx.api.getAll("/gen-ai/agents", "agents"));
  return agents.map((a: DoAgentRow) => {
    const uuid = String(a.uuid ?? a.id ?? "");
    const model = a.model;
    const router = a.model_router;
    const deployment = a.deployment;
    const knowledgeBases = Array.isArray(a.knowledge_bases) ? a.knowledge_bases : [];
    // Each attached KB carries its own uuid (schema `apiKnowledgeBase`): the
    // same uuid a `gen-ai-knowledge-base` resource uses as its externalId.
    const knowledgeBaseUuids = knowledgeBases.map((kb) => String(kb?.uuid ?? "")).filter(Boolean);
    const deploymentUrl = String(deployment?.url ?? "");
    return {
      id: `${accountId}:gen-ai-agent:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
      accountId,
      displayName: String(a.name ?? uuid),
      fields: {
        name: String(a.name ?? ""),
        region: String(a.region ?? ""),
        description: String(a.description ?? ""),
        instruction: String(a.instruction ?? ""),
        modelUuid: String(model?.uuid ?? ""),
        modelName: String(model?.name ?? ""),
        modelRouterUuid: String(router?.uuid ?? ""),
        modelRouterName: String(router?.name ?? ""),
        projectId: String(a.project_id ?? ""),
        temperature: Number(a.temperature ?? 0),
        maxTokens: Number(a.max_tokens ?? 0),
        k: Number(a.k ?? 0),
        status: String(deployment?.status ?? a.status ?? ""),
        deploymentVisibility: String(deployment?.visibility ?? ""),
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
      createdAt: String(a.created_at ?? new Date().toISOString()),
      updatedAt: String(a.updated_at ?? a.created_at ?? new Date().toISOString()),
    };
  });
}

async function listGenAiKnowledgeBases(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const knowledgeBases = await orEmpty(
    ctx.api.getAll("/gen-ai/knowledge_bases", "knowledge_bases"),
  );
  return knowledgeBases.map((kb: DoKnowledgeBaseRow) => {
    const uuid = String(kb.uuid ?? kb.id ?? "");
    const lastJob = kb.last_indexing_job;
    const tags = Array.isArray(kb.tags) ? kb.tags : [];
    const dataSources = Array.isArray(kb.data_sources) ? kb.data_sources.length : 0;
    return {
      id: `${accountId}:gen-ai-knowledge-base:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-knowledge-base",
      accountId,
      displayName: String(kb.name ?? uuid),
      fields: {
        name: String(kb.name ?? ""),
        region: String(kb.region ?? ""),
        embeddingModelUuid: String(kb.embedding_model_uuid ?? ""),
        databaseId: String(kb.database_id ?? ""),
        projectId: String(kb.project_id ?? ""),
        isPublic: kb.is_public ? "yes" : "no",
        lastIndexingStatus: String(lastJob?.status ?? ""),
        dataSourceCount: dataSources,
        tags: tags.join(","),
      },
      resolvedOutputs: uuid
        ? { retrievalEndpoint: `https://kbaas.do-ai.run/v1/${uuid}/retrieve` }
        : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(kb.created_at ?? new Date().toISOString()),
      updatedAt: String(kb.updated_at ?? kb.created_at ?? new Date().toISOString()),
    };
  });
}

async function listGenAiModelRouters(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const routers = await orEmpty(ctx.api.getAll("/gen-ai/models/routers", "model_routers"));
  return routers.map((r: DoModelRouterRow) => {
    const uuid = String(r.uuid ?? r.id ?? "");
    const regions = Array.isArray(r.regions) ? r.regions : [];
    const config = r.config;
    const fallbackRaw = Array.isArray(config?.fallback_models) ? config.fallback_models : [];
    const policiesRaw = Array.isArray(config?.policies) ? config.policies : [];
    // Normalize each policy for the detail-page viewer. `models` entries can
    // be plain id strings or objects ({uuid,name}); flatten to {id,name}.
    const policies = policiesRaw.map((p) => {
      const models = Array.isArray(p.models) ? p.models : [];
      // `slug` is not in the document.
      const custom: { name?: string; slug?: string } | undefined = p.custom_task;
      const selection = p.selection_policy;
      return {
        task: String(p.task_slug ?? custom?.name ?? custom?.slug ?? ""),
        prefer: String(selection?.prefer ?? ""),
        models: models.map(modelRef),
      };
    });
    const fallback = fallbackRaw.map(modelRef);
    return {
      id: `${accountId}:gen-ai-model-router:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-model-router",
      accountId,
      displayName: String(r.name ?? uuid),
      fields: {
        name: String(r.name ?? ""),
        description: String(r.description ?? ""),
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
      createdAt: String(r.created_at ?? new Date().toISOString()),
      updatedAt: String(r.updated_at ?? r.created_at ?? new Date().toISOString()),
    };
  });
}

async function listDedicatedInferences(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const inferences = await orEmpty(ctx.api.getAll("/dedicated-inferences", "dedicated_inferences"));
  return inferences.map((d) => {
    const id = String(d.id ?? "");
    const spec = d.spec ?? d.pending_deployment_spec;
    // `model_uuid` and `model_name` are not in the document.
    const deployments: Array<{ model_id?: string; model_uuid?: string; model_name?: string }> =
      Array.isArray(spec?.model_deployments) ? spec.model_deployments : [];
    const endpoints = d.endpoints;
    const publicEndpoint = String(endpoints?.public_endpoint_fqdn ?? "");
    const privateEndpoint = String(endpoints?.private_endpoint_fqdn ?? "");
    const modelSummary = deployments
      .map((m) => String(m.model_id ?? m.model_uuid ?? m.model_name ?? ""))
      .filter(Boolean)
      .join(", ");
    return {
      id: `${accountId}:dedicated-inference:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "dedicated-inference",
      accountId,
      displayName: String(spec?.name ?? id),
      fields: {
        name: String(spec?.name ?? ""),
        region: String(d.region ?? ""),
        vpcUuid: String(d.vpc_uuid ?? ""),
        enablePublicEndpoint: spec?.enable_public_endpoint ? "yes" : "no",
        modelCount: deployments.length,
        modelSummary,
        publicEndpoint,
        privateEndpoint,
        status: String(d.status ?? ""),
      },
      resolvedOutputs: {
        ...(publicEndpoint ? { publicEndpointUrl: publicEndpoint } : {}),
        ...(privateEndpoint ? { privateEndpointUrl: privateEndpoint } : {}),
      },
      secretStates: [],
      externalId: id,
      createdAt: String(d.created_at ?? new Date().toISOString()),
      updatedAt: String(d.updated_at ?? d.created_at ?? new Date().toISOString()),
    };
  });
}

/** The data-plane Batch Inference list, which is outside the API's OpenAPI document. */
interface InferenceBatchList {
  data?: Array<{
    batch_id?: string;
    id?: string;
    provider?: string;
    endpoint?: string;
    completion_window?: string;
    input_file_id?: string;
    output_file_id?: string;
    error_file_id?: string;
    status?: string;
    request_counts?: { total?: number; completed?: number; failed?: number };
    created_at?: string;
    updated_at?: string;
  }> | null;
}

/**
 * The Batch Inference API lives on a separate host (inference.do-ai.run) and uses
 * the same bearer token as the management plane. 403/404 means the product is not
 * enabled for this account.
 */
async function listInferenceBatches(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // Rolling window: the newest 100, which the document says is what the first page
  // holds. Older rows falling off is what this type means.
  const path = "/v1/batches";
  const res = await ctx.api.fetch(`https://inference.do-ai.run${path}?limit=100`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
  });
  if (res.status === 403 || res.status === 404) return [];
  if (!res.ok) throw new Error(`DO API error ${res.status} for ${path}: ${await res.text()}`);
  const data: InferenceBatchList = await res.json();
  return requireListPage(data.data, { vendor: "DO", path, key: "data" }).map((b) => {
    const batchId = String(b.batch_id ?? b.id ?? "");
    const counts = b.request_counts;
    return {
      id: `${accountId}:inference-batch:${batchId}`,
      pluginId: "digitalocean",
      resourceTypeId: "inference-batch",
      accountId,
      displayName: batchId,
      fields: {
        provider: String(b.provider ?? ""),
        endpoint: String(b.endpoint ?? ""),
        completionWindow: String(b.completion_window ?? "24h"),
        inputFileId: String(b.input_file_id ?? ""),
        outputFileId: String(b.output_file_id ?? ""),
        errorFileId: String(b.error_file_id ?? ""),
        status: String(b.status ?? ""),
        totalRequests: Number(counts?.total ?? 0),
        completedRequests: Number(counts?.completed ?? 0),
        failedRequests: Number(counts?.failed ?? 0),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: batchId,
      createdAt: String(b.created_at ?? new Date().toISOString()),
      updatedAt: String(b.updated_at ?? b.created_at ?? new Date().toISOString()),
    };
  });
}

async function listModelApiKeys(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const keys = await orEmpty(ctx.api.getAll("/gen-ai/models/api_keys", "api_key_infos"));
  return keys.map((k: DoModelApiKeyRow) => {
    const uuid = String(k.uuid ?? k.id ?? "");
    return {
      id: `${accountId}:model-api-key:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "model-api-key",
      accountId,
      displayName: String(k.name ?? uuid),
      fields: {
        name: String(k.name ?? ""),
        createdBy: String(k.created_by ?? ""),
        lastUsedAt: String(k.last_used_at ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(k.created_at ?? new Date().toISOString()),
      updatedAt: String(k.created_at ?? new Date().toISOString()),
    };
  });
}

/**
 * Agent-scoped API keys (the per-agent bearer tokens used by client SDKs
 * to call an agent's deployment endpoint). DO exposes them only per agent,
 * not as a flat list, so we fan out across every agent and concat. An agent that went
 * away mid-walk has no keys; any other failure fails the list rather than prune the
 * keys of the agents it could not read. Composite externalId
 * `{agentUuid}/{keyUuid}` mirrors `nfs-share`'s `{region}/{shareId}` shape.
 */
async function listAgentApiKeys(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const agents = await orEmpty(ctx.api.getAll("/gen-ai/agents", "agents"));
  const keyLists = await Promise.all(
    agents.map(async (a: DoAgentRow): Promise<ResourceInstance[]> => {
      const agentUuid = String(a.uuid ?? a.id ?? "");
      if (!agentUuid) return [];
      const keys = await orEmpty(
        ctx.api.getAll(`/gen-ai/agents/${idSegment(agentUuid)}/api_keys`, "api_key_infos"),
      );
      const now = new Date().toISOString();
      return keys.map<ResourceInstance>((k: DoAgentApiKeyRow) => {
        const keyUuid = String(k.uuid ?? k.id ?? "");
        return {
          id: `${accountId}:agent-api-key:${agentUuid}/${keyUuid}`,
          pluginId: "digitalocean",
          resourceTypeId: "agent-api-key",
          accountId,
          displayName: String(k.name ?? keyUuid),
          fields: {
            name: String(k.name ?? ""),
            createdBy: String(k.created_by ?? ""),
            // The owning agent, already known from the fan-out above. Also
            // encoded in `parentResourceId`, but the graph reads fields.
            agentUuid,
          },
          resolvedOutputs: {},
          // Secret isn't returned by the list endpoint, only on create
          // and regenerate. Existing keys have no recoverable secret.
          secretStates: [],
          externalId: `${agentUuid}/${keyUuid}`,
          parentResourceId: `${accountId}:gen-ai-agent:${agentUuid}`,
          createdAt: String(k.created_at ?? now),
          updatedAt: String(k.created_at ?? now),
        };
      });
    }),
  );
  return keyLists.flat();
}

async function listProjects(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const projects = await ctx.api.getAll("/projects", "projects");
  return projects.map((p) => ({
    id: `${accountId}:project:${String(p.id)}`,
    pluginId: "digitalocean",
    resourceTypeId: "project",
    accountId,
    displayName: String(p.name),
    fields: {
      name: String(p.name),
      purpose: String(p.purpose ?? ""),
      description: String(p.description ?? ""),
      environment: String(p.environment ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(p.id),
    createdAt: String(p.created_at ?? new Date().toISOString()),
    updatedAt: String(p.updated_at ?? new Date().toISOString()),
  }));
}

async function listDroplets(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const [droplets, projectMap] = await Promise.all([
    ctx.api.getAll("/droplets", "droplets"),
    ctx.getProjectUrnMap(),
  ]);
  return droplets.map((d) => mapDroplet(ctx, d, accountId, projectMap));
}

/**
 * Shape a single DO /droplets element into a `ResourceInstance`. Shared
 * between the list path and the single-resource `getResource` path so the
 * post-create detail page (which uses GET /v2/droplets/{id} to avoid a
 * race with the list endpoint) produces identical fields/outputs.
 */
export function mapDroplet(
  ctx: DoListerContext,
  d: DoDroplet,
  accountId: string,
  projectMap: Map<string, string>,
): ResourceInstance {
  const v4 = d.networks?.v4 ?? [];
  const v6 = d.networks?.v6 ?? [];
  const ipv4 = v4.find((n) => n.type === "public")?.ip_address ?? "";
  const ipv4Private = v4.find((n) => n.type === "private")?.ip_address ?? "";
  const ipv6 = v6.find((n) => n.type === "public")?.ip_address ?? "";
  const backupIds = Array.isArray(d.backup_ids) ? d.backup_ids : [];
  const snapshotIds = Array.isArray(d.snapshot_ids) ? d.snapshot_ids : [];
  const volumeIds = Array.isArray(d.volume_ids) ? d.volume_ids : [];
  const tags = Array.isArray(d.tags) ? d.tags : [];
  const sizeObj = d.size;
  // `next_backup_window` is the authoritative "backups are scheduled" signal.
  // DO's `features` array can lag after the enable_backups action completes,
  // which made the Enable Backups button stick around after a successful
  // enable. We surface the next-window start so the button conditional can
  // fall back on it regardless of when DO eventually flips `features`.
  const nextBackupWindow = d.next_backup_window;
  const nextBackupStart = nextBackupWindow?.start ?? "";
  const backupPolicy = d.backup_policy;
  const parentResourceId = ctx.parentResourceIdForUrn(
    accountId,
    `do:droplet:${String(d.id)}`,
    projectMap,
  );
  return {
    id: `${accountId}:droplet:${String(d.id)}`,
    pluginId: "digitalocean",
    resourceTypeId: "droplet",
    accountId,
    displayName: String(d.name),
    fields: {
      name: String(d.name),
      region: String(d.region?.slug ?? ""),
      size: String(sizeObj?.slug ?? ""),
      image: String(d.image?.slug ?? ""),
      status: String(d.status ?? ""),
      memoryMb: Number(d.memory ?? 0),
      vcpus: Number(d.vcpus ?? 0),
      diskGb: Number(d.disk ?? 0),
      priceMonthly: Number(sizeObj?.price_monthly ?? 0),
      tags: tags.join(","),
      backupIds: backupIds.join(","),
      snapshotIds: snapshotIds.join(","),
      volumeIds: volumeIds.join(","),
      features: Array.isArray(d.features) ? d.features.join(",") : "",
      nextBackupStart,
      backupPolicyPlan: backupPolicy?.plan ?? "",
      backupPolicyHour: backupPolicy?.hour != null ? String(backupPolicy.hour) : "",
      backupPolicyWeekday: backupPolicy?.weekday ?? "",
      // VPC the droplet lives in: used by the NFS-share→droplet drop
      // target to derive the share-level `attach` action's `vpc_id`.
      vpcUuid: String(d.vpc_uuid ?? ""),
    },
    resolvedOutputs: {
      ...(ipv4 ? { ipv4 } : {}),
      ...(ipv4Private ? { ipv4Private } : {}),
      ...(ipv6 ? { ipv6 } : {}),
    },
    secretStates: [],
    externalId: String(d.id),
    ...(parentResourceId ? { parentResourceId } : {}),
    createdAt: String(d.created_at ?? new Date().toISOString()),
    updatedAt: String(d.created_at ?? new Date().toISOString()),
  };
}

async function listSnapshots(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // /v2/snapshots aggregates both droplet and volume snapshots. resource_type
  // disambiguates; resource_id points to the originating droplet (number) or
  // volume (uuid).
  const snapshots = await ctx.api.getAll("/snapshots", "snapshots");
  return snapshots.map((s) => ({
    id: `${accountId}:snapshot:${String(s.id)}`,
    pluginId: "digitalocean",
    resourceTypeId: "snapshot",
    accountId,
    displayName: String(s.name ?? s.id),
    fields: {
      name: String(s.name ?? ""),
      resourceType: String(s.resource_type ?? ""),
      resourceId: String(s.resource_id ?? ""),
      regions: Array.isArray(s.regions) ? s.regions.join(",") : "",
      sizeGb: Number(s.size_gigabytes ?? 0),
      minDiskSize: Number(s.min_disk_size ?? 0),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(s.id),
    createdAt: String(s.created_at ?? new Date().toISOString()),
    updatedAt: String(s.created_at ?? new Date().toISOString()),
  }));
}

async function listImages(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // Surface user-owned images by default (snapshots, backups, custom uploads).
  // Distribution + application marketplace images are noisy in a sidebar and
  // already exposed in the droplet create form via getCreateConfig.
  const images = await ctx.api.getAll("/images", "images", { query: { private: true } });
  return images.map((img) => ({
    id: `${accountId}:image:${String(img.id)}`,
    pluginId: "digitalocean",
    resourceTypeId: "image",
    accountId,
    displayName: String(img.name ?? img.id),
    fields: {
      name: String(img.name ?? ""),
      type: String(img.type ?? ""),
      distribution: String(img.distribution ?? ""),
      slug: String(img.slug ?? ""),
      regions: Array.isArray(img.regions) ? img.regions.join(",") : "",
      sizeGb: Number(img.size_gigabytes ?? 0),
      minDiskSize: Number(img.min_disk_size ?? 0),
      status: String(img.status ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(img.id),
    createdAt: String(img.created_at ?? new Date().toISOString()),
    updatedAt: String(img.created_at ?? new Date().toISOString()),
  }));
}

async function listNfsShares(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  // The NFS API is region-scoped but listing without a region returns shares
  // from every region the account has any in. DO encodes the region in each
  // share's response so we don't have to fan-out by region for listing.
  let shares: DoNfsRow[] = [];
  try {
    // The document takes no `per_page` here and answers `shares` (#411).
    const data: DoResponse<"nfs_list"> & { nfs?: DoNfsRow[] | null } =
      await ctx.api.written<"nfs_list">("/nfs?per_page=200");
    shares = data.nfs ?? [];
  } catch {
    // NFS is region-gated; an account in a non-NFS region returns 4xx.
    return [];
  }
  return shares.map((s) => {
    const region = String(s.region ?? "");
    const externalId = `${region}/${String(s.id)}`;
    const mountTargets = Array.isArray(s.mount_targets) ? s.mount_targets : [];
    const mountTarget = String(mountTargets[0]?.address ?? mountTargets[0]?.mount_path ?? "");
    const exportPath = String(mountTargets[0]?.export_path ?? `/${String(s.id)}`);
    const mountCommand = mountTarget
      ? `sudo mount -t nfs -o nfsvers=4.1 ${mountTarget}:${exportPath} /mnt/${s.name ?? s.id}`
      : "";
    const vpcIds = Array.isArray(s.vpc_ids) ? s.vpc_ids : [];
    return {
      id: `${accountId}:nfs-share:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "nfs-share",
      accountId,
      displayName: String(s.name ?? s.id),
      fields: {
        name: String(s.name ?? ""),
        region,
        sizeGib: Number(s.size_gib ?? 0),
        performanceTier: String(s.performance_tier ?? "standard"),
        vpcIds: vpcIds.join(","),
        mountTarget,
        status: String(s.status ?? ""),
      },
      resolvedOutputs: {
        ...(mountTarget ? { mountTarget } : {}),
        ...(mountCommand ? { mountCommand } : {}),
      },
      secretStates: [],
      externalId,
      createdAt: String(s.created_at ?? new Date().toISOString()),
      updatedAt: String(s.created_at ?? new Date().toISOString()),
    };
  });
}

async function listDOKSClusters(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const [clusters, projectMap] = await Promise.all([
    ctx.api.getAll("/kubernetes/clusters", "kubernetes_clusters"),
    ctx.getProjectUrnMap(),
  ]);
  return clusters.map((c) => {
    const nodePool = c.node_pools?.[0];
    const parentResourceId = ctx.parentResourceIdForUrn(
      accountId,
      `do:kubernetes:${String(c.id)}`,
      projectMap,
    );
    const statusObj = c.status;
    return {
      id: `${accountId}:doks-cluster:${String(c.id)}`,
      pluginId: "digitalocean",
      resourceTypeId: "doks-cluster",
      accountId,
      displayName: String(c.name),
      fields: {
        name: String(c.name),
        region: String(c.region ?? ""),
        version: String(c.version ?? ""),
        nodePoolSize: String(nodePool?.size ?? ""),
        nodeCount: Number(nodePool?.count ?? 0),
        status: String(statusObj?.state ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(c.id),
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt: String(c.created_at ?? new Date().toISOString()),
      updatedAt: String(c.updated_at ?? new Date().toISOString()),
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
  const [data, projectMap] = await Promise.all([ctx.api.get("/databases"), ctx.getProjectUrnMap()]);
  return rowsOf(data, "databases", "/databases").map((db) => {
    const parentResourceId = ctx.parentResourceIdForUrn(
      accountId,
      `do:dbaas:${String(db.id)}`,
      projectMap,
    );
    return {
      id: `${accountId}:managed-database:${String(db.id)}`,
      pluginId: "digitalocean",
      resourceTypeId: "managed-database",
      accountId,
      displayName: String(db.name),
      fields: {
        name: String(db.name),
        engine: String(db.engine ?? ""),
        version: String(db.version ?? ""),
        region: String(db.region ?? ""),
        size: String(db.size ?? ""),
        nodeCount: Number(db.num_nodes ?? 1),
        status: String(db.status ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(db.id),
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt: String(db.created_at ?? new Date().toISOString()),
      updatedAt: String(db.created_at ?? new Date().toISOString()),
    };
  });
}

/**
 * Fan out across every cluster to enumerate its users. DO has no "list users
 * across all my clusters" endpoint (only per-cluster) so we re-use the
 * already-fetched cluster list and parallelise the per-cluster calls. A cluster
 * still provisioning answers 409 until it's online, one that went away 404, and a
 * token without `database:view_credentials` 403: those have no users to show. Any
 * other failure fails the list rather than prune one cluster's users.
 */
async function listDatabaseUsers(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.api.get("/databases");
  const clusters = rowsOf(data, "databases", "/databases");
  const userLists = await Promise.all(
    clusters.map(async (db): Promise<ResourceInstance[]> => {
      const clusterId = String(db.id ?? "");
      if (!clusterId) return [];
      const path = `/databases/${idSegment(clusterId)}/users` as const;
      const resp = await ctx.api.get(path).catch((err: unknown) => {
        if (failedWith(err, 403, 404, 409)) return { users: [] };
        throw err;
      });
      const now = String(db.created_at ?? new Date().toISOString());
      return rowsOf(resp, "users", path).map<ResourceInstance>((u) => ({
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
        // The list endpoint never returns the password, only the per-user
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
  return userLists.flat();
}

export async function listSpacesBuckets(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const accessKeyId = ctx.credentials["spacesAccessKeyId"];
  const secretAccessKey = ctx.credentials["spacesSecretAccessKey"];
  if (!accessKeyId || !secretAccessKey) return [];

  const projectMap = await ctx.getProjectUrnMap();

  // Per-region fan-out is tolerant of a region refusing the key: freshly-minted Spaces
  // keys can take longer to propagate to some regions than others, and a single 403
  // must not fail the whole list call (and with it the post-create detail page). A 5xx
  // or 429 is different: read as nothing, it would prune that region's buckets.
  const serverFailures: Error[] = [];
  const settled = await Promise.allSettled(
    SPACES_REGIONS.map(async (region) => {
      const host = `${region}.digitaloceanspaces.com`;
      const res = await signedS3Fetch({
        fetch: ctx.api.fetch,
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
        const failure = new Error(`Spaces ${region} returned ${res.status}`);
        if (res.status >= 500 || res.status === 429) serverFailures.push(failure);
        throw failure;
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
  if (serverFailures[0]) throw serverFailures[0];
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
        // `name|region`: consumed by the KB "Add Spaces source" resource
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
 * returns it or 404s when none exists, so a 404 maps to an empty list while
 * every other error propagates (unlike `fetchOrEmpty`, which would also hide
 * scope/rate-limit failures). The subscription tier isn't on the registry
 * payload; it lives on GET /v2/registry/subscription, fetched best-effort so
 * a token without the extra scope just leaves the field blank.
 */
async function listContainerRegistry(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  let data: DoResponse<"registry_get">;
  try {
    data = await ctx.api.get("/registry");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\bAPI error 404\b/.test(message)) return [];
    throw err;
  }
  const r = data.registry;
  if (!r) return [];
  const name = String(r.name ?? "");
  const subscription = await ctx.api.get("/registry/subscription").catch(() => null);
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
        region: String(r.region ?? ""),
        storageUsageBytes: Number(r.storage_usage_bytes ?? 0),
        createdAt: String(r.created_at ?? ""),
      },
      resolvedOutputs: {
        endpoint: `registry.digitalocean.com/${name}`,
        serverUrl: "registry.digitalocean.com",
      },
      secretStates: [],
      externalId: name,
      createdAt: String(r.created_at ?? now),
      updatedAt: now,
    },
  ];
}

async function listDomains(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const domains = await ctx.api.getAll("/domains", "domains");
  return domains.map((d) => ({
    id: `${accountId}:domain:${String(d.name)}`,
    pluginId: "digitalocean",
    resourceTypeId: "domain",
    accountId,
    displayName: String(d.name),
    fields: {
      name: String(d.name),
      ttl: Number(d.ttl ?? 1800),
      zoneFile: String(d.zone_file ?? ""),
    },
    resolvedOutputs: {
      nameservers: "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com",
    },
    secretStates: [],
    externalId: String(d.name),
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
      const records = await ctx.api.getAll(
        `/domains/${idSegment(domainName)}/records`,
        "domain_records",
      );
      for (const r of records) {
        const type = String(r.type ?? "");
        const name = String(r.name ?? "@");
        const displayName = name === "@" ? domainName : `${name}.${domainName}`;
        results.push({
          id: `${accountId}:dns-record:${domainName}/${String(r.id)}`,
          pluginId: "digitalocean",
          resourceTypeId: "dns-record",
          accountId,
          displayName: `${type} ${displayName}`,
          fields: {
            type,
            name: displayName,
            data: String(r.data ?? ""),
            ttl: Number(r.ttl ?? 1800),
            ...(r.priority !== undefined && r.priority !== null
              ? { priority: Number(r.priority) }
              : {}),
            ...(r.port !== undefined && r.port !== null ? { port: Number(r.port) } : {}),
            ...(r.weight !== undefined && r.weight !== null ? { weight: Number(r.weight) } : {}),
            ...(r.flags !== undefined && r.flags !== null ? { flags: Number(r.flags) } : {}),
            ...(r.tag ? { tag: String(r.tag) } : {}),
            domainName,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${domainName}/${String(r.id)}`,
          parentResourceId: `${accountId}:domain:${domainName}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      // A domain that went away mid-walk, or one this token cannot read.
      if (!failedWith(err, 403, 404)) throw err;
    }
  }
  return results;
}

async function listVolumes(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const [volumes, projectMap] = await Promise.all([
    ctx.api.getAll("/volumes", "volumes"),
    ctx.getProjectUrnMap(),
  ]);
  return volumes.map((v) => {
    const parentResourceId = ctx.parentResourceIdForUrn(
      accountId,
      `do:volume:${String(v.id)}`,
      projectMap,
    );
    return {
      id: `${accountId}:volume:${String(v.id)}`,
      pluginId: "digitalocean",
      resourceTypeId: "volume",
      accountId,
      displayName: String(v.name ?? v.id),
      fields: {
        name: String(v.name ?? ""),
        region: String(v.region?.slug ?? ""),
        sizeGb: Number(v.size_gigabytes ?? 0),
        filesystemType: String(v.filesystem_type ?? ""),
        dropletIds: Array.isArray(v.droplet_ids) ? v.droplet_ids.join(",") : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(v.id ?? ""),
      ...(parentResourceId ? { parentResourceId } : {}),
      createdAt: String(v.created_at ?? new Date().toISOString()),
      updatedAt: String(v.created_at ?? new Date().toISOString()),
    };
  });
}

/**
 * Reserved IPs. `GET /v2/reserved_ips` returns `{ reserved_ips: [...] }` with
 * the standard page/per_page pagination; each element carries `ip`, the full
 * `region` object, the full `droplet` object (or `null`), `locked` and
 * `project_id` (verified against digitalocean/openapi, schema `reserved_ip`).
 *
 * The address doubles as the identifier (every other reserved-IP endpoint is
 * `/v2/reserved_ips/{ip}`) so `externalId` is the dotted-quad.
 *
 * Unlike volumes/droplets this doesn't need the project-URN map: the payload
 * carries `project_id` directly (it needs the token's `project:read` scope;
 * without it the field is absent and the address simply lists un-parented).
 *
 * `dropletId` is always written (`""` when unassigned) because the orphan
 * rule compares it with `equals: ""`.
 */
async function listReservedIps(
  ctx: DoListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const reservedIps = await ctx.api.getAll("/reserved_ips", "reserved_ips");
  return reservedIps.map((r) => {
    const ip = String(r.ip ?? "");
    const droplet = r.droplet ?? null;
    const dropletId = droplet?.id != null ? String(droplet.id) : "";
    const projectId = String(r.project_id ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:reserved-ip:${ip}`,
      pluginId: "digitalocean",
      resourceTypeId: "reserved-ip",
      accountId,
      displayName: ip,
      fields: {
        ip,
        region: String(r.region?.slug ?? ""),
        dropletId,
        dropletName: droplet ? String(droplet.name ?? "") : "",
        locked: r.locked === true,
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
 * hold, so those fields resolve to this resource without a translation step.
 *
 * Member counts are deliberately absent: DO exposes them only via a separate
 * `/v2/vpcs/{id}/members` request per VPC, which listing must not spend.
 */
async function listVpcs(ctx: DoListerContext, accountId: string): Promise<ResourceInstance[]> {
  const vpcs = await ctx.api.getAll("/vpcs", "vpcs");
  return vpcs.map((v) => {
    const id = String(v.id ?? "");
    const createdAt = String(v.created_at ?? new Date().toISOString());
    return {
      id: `${accountId}:vpc:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "vpc",
      accountId,
      displayName: String(v.name ?? id),
      fields: {
        name: String(v.name ?? ""),
        region: String(v.region ?? ""),
        ipRange: String(v.ip_range ?? ""),
        description: String(v.description ?? ""),
        isDefault: v.default === true,
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
