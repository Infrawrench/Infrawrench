import type {
  PluginClient,
  ResourceCreateResult,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SectionNode,
  ActionNode,
  ChatMessage,
  ChatStreamEvent,
  ResourceTypeDefinition,
  DashboardStat,
  MetricSeries,
  CredentialExport,
  StatusDotNode,
  SizeOption,
  ImageOption,
  HostServices,
} from "@infrawrench/plugin-base";
import {
  dnsRecordBadgeColor,
  deleteS3Object,
  formatDnsTtl,
  getS3BucketPolicy,
  jsonRestFetch,
  labeledFieldItems,
  listS3Objects,
  makeS3Folder,
  putS3BucketPolicy,
  resourceTypeDisplayName,
  renderDnsRecordDetail as sharedRenderDnsRecordDetail,
  renderDnsRecordSidebar,
  signedS3Fetch,
  uploadS3Object,
  virtualHostedUrl,
} from "@infrawrench/plugin-base";
import type { S3StorageConfig, StorageObject } from "@infrawrench/plugin-base";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { SnapshotResourceType } from "./resources/snapshot.js";
import { ImageResourceType } from "./resources/image.js";
import { NfsShareResourceType } from "./resources/nfs-share.js";
import { SPACES_REGIONS } from "./constants.js";
import {
  type DoCreateContext,
  doGetCreateConfig,
  doCreateResource,
  estimateDoDatabaseMonthlyPrice,
} from "./create-handlers.js";
import {
  type ActionContext,
  invokeDropletAction,
  invokeVolumeAction,
  executeDropletCommand,
  executeVolumeCommand,
} from "./actions.js";

/**
 * Best-effort JSON-array parse for catalog data stuffed into resolvedOutputs
 * by enrichDetail. Returns [] on any error so the picker degrades gracefully.
 */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * DO's managed-database `connection.uri` doesn't always carry the credentials
 * inline — MongoDB clusters in particular hand back `mongodb+srv://host/...`
 * with the `user`/`password` exposed only as sibling fields, and feeding that
 * password-less URI to the mongo driver fails with `Password cannot be
 * empty`. Splice the userinfo back in when we have the parts but the URI
 * lacks them. URIs that already include credentials are returned untouched.
 *
 * Done with string manipulation rather than the `URL` class because
 * `mongodb+srv://` is a non-special scheme — the WHATWG URL parser doesn't
 * round-trip the username/password setters on non-special URLs, so a
 * `new URL(...); u.username = ...; u.toString()` no-ops here.
 */
function ensureUriCredentials(
  uri: string,
  user: string | undefined,
  password: string | undefined,
): string {
  if (!uri) return uri;
  if (!user && !password) return uri;
  const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(uri);
  if (!schemeMatch) return uri;
  const scheme = schemeMatch[1]!;
  const remainder = schemeMatch[2]!;
  // Split userinfo off the authority. Only the *last* `@` before the next
  // path/query/fragment terminator separates userinfo from host, because
  // `@` is allowed (percent-encoded) in passwords.
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? "" : remainder.slice(authorityEnd);
  const atIdx = authority.lastIndexOf("@");
  const userinfo = atIdx === -1 ? "" : authority.slice(0, atIdx);
  const host = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  // If the URI already has both halves of userinfo, leave it alone.
  if (userinfo.includes(":") && userinfo.split(":", 2)[1]) return uri;
  const encodedUser = user ? encodeURIComponent(user) : "";
  const encodedPassword = password ? encodeURIComponent(password) : "";
  const newUserinfo = `${encodedUser}:${encodedPassword}`;
  return `${scheme}${newUserinfo}@${host}${tail}`;
}

/**
 * Normalize DO's `kafkas://` (or `kafka://`) connection.uri to a form the
 * infrawrench kafka plugin's driver can consume: explicit
 * `sasl=scram-sha-256` and `ssl=true` query params. DO's Managed Kafka
 * uses SASL/SCRAM-SHA-256 over TLS — but the driver can't infer the
 * mechanism from the URI alone, so we tag it here.
 */
function normalizeKafkaUri(uri: string): string {
  if (!uri) return uri;
  let normalized = uri.startsWith("kafkas://") ? `kafka://${uri.slice("kafkas://".length)}` : uri;
  const queryIdx = normalized.indexOf("?");
  const base = queryIdx === -1 ? normalized : normalized.slice(0, queryIdx);
  const params = new URLSearchParams(queryIdx === -1 ? "" : normalized.slice(queryIdx + 1));
  if (!params.has("sasl")) params.set("sasl", "scram-sha-256");
  if (!params.has("ssl")) params.set("ssl", "true");
  normalized = `${base}?${params.toString()}`;
  return normalized;
}

/** True when `uri` has a non-empty password in its userinfo. */
function uriHasPassword(uri: string): boolean {
  if (!uri) return false;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(uri);
  if (!schemeMatch) return false;
  const remainder = schemeMatch[1]!;
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  const atIdx = authority.lastIndexOf("@");
  if (atIdx === -1) return false;
  const userinfo = authority.slice(0, atIdx);
  const colonIdx = userinfo.indexOf(":");
  return colonIdx !== -1 && userinfo.length > colonIdx + 1;
}

/** "May 21, 2026" — what people actually read off a backup card. */
function formatBackupDate(isoTimestamp: string): string {
  if (!isoTimestamp) return "unknown date";
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * DO names auto-generated backups like "web-01 2026-05-21 04:50:23". The
 * date is already in the name and we add a relative-friendly version in
 * the same row, so we strip the trailing timestamp to keep the option
 * label short. Falls back to the date when the name is empty.
 */
function formatBackupLabel(name: string, isoTimestamp: string): string {
  const trimmed = name.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "").trim();
  if (!trimmed) return formatBackupDate(isoTimestamp);
  return `${trimmed} • ${formatBackupDate(isoTimestamp)}`;
}

/**
 * Map a DigitalOcean Droplet's `status` value to a host status-dot. `active`
 * marks the droplet "healthy" — the host gates SSH/SFTP affordances on that.
 * See https://docs.digitalocean.com/reference/api/api-reference/#operation/droplets_list
 */
function dropletStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "active":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "new":
      return { kind: "status-dot", status: "provisioning", label: "Provisioning" };
    case "off":
      return { kind: "status-dot", status: "unknown", label: "Off" };
    case "archive":
      return { kind: "status-dot", status: "info", label: "Archived" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Map a DOKS cluster's `status.state` value to a host status-dot.
 * Source enum: running / provisioning / degraded / error / deleted /
 * deleting / upgrading
 * (per cluster_read.yml in digitalocean/openapi).
 */
function doksStatusDot(state: string): StatusDotNode {
  switch (state) {
    case "running":
      return { kind: "status-dot", status: "healthy", label: "Running" };
    case "provisioning":
      return { kind: "status-dot", status: "provisioning", label: "Provisioning" };
    case "upgrading":
      return { kind: "status-dot", status: "provisioning", label: "Upgrading" };
    case "degraded":
      return { kind: "status-dot", status: "degraded", label: "Degraded" };
    case "error":
      return { kind: "status-dot", status: "error", label: "Error" };
    case "deleting":
      return { kind: "status-dot", status: "provisioning", label: "Deleting" };
    case "deleted":
      return { kind: "status-dot", status: "info", label: "Deleted" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Volumes don't have a documented status field on the response (verified in
 * digitalocean/openapi/volumes/models/volume_base.yml). The closest signal
 * for "in use vs free" is the `droplet_ids` array — non-empty = attached.
 * Both attached and detached are operational ("healthy") for the purpose
 * of the host's status gating; the label just disambiguates.
 */
function volumeStatusDot(attached: boolean): StatusDotNode {
  return attached
    ? { kind: "status-dot", status: "healthy", label: "Attached" }
    : { kind: "status-dot", status: "healthy", label: "Available" };
}

/**
 * Map a DO managed-database `status` value to a host status-dot.
 * Source enum: creating / online / resizing / migrating / forking
 * (per database_cluster_read.yml in digitalocean/openapi).
 */
function managedDatabaseStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "online":
      return { kind: "status-dot", status: "healthy", label: "Online" };
    case "creating":
      return { kind: "status-dot", status: "provisioning", label: "Creating" };
    case "resizing":
      return { kind: "status-dot", status: "provisioning", label: "Resizing" };
    case "migrating":
      return { kind: "status-dot", status: "provisioning", label: "Migrating" };
    case "forking":
      return { kind: "status-dot", status: "provisioning", label: "Forking" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Map a DO custom-image `status` value to a host status-dot.
 * Source enum: NEW / available / pending / deleted / retired
 * (per images/models/image.yml in digitalocean/openapi).
 */
function imageStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "available":
      return { kind: "status-dot", status: "healthy", label: "Available" };
    case "NEW":
    case "pending":
      return { kind: "status-dot", status: "provisioning", label: "Pending" };
    case "deleted":
      return { kind: "status-dot", status: "info", label: "Deleted" };
    case "retired":
      return { kind: "status-dot", status: "info", label: "Retired" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Map a DO NFS share `status` value to a host status-dot.
 * Source enum: CREATING / ACTIVE / FAILED / DELETED
 * (per nfs/models/nfs_response.yml in digitalocean/openapi).
 */
function nfsShareStatusDot(status: string): StatusDotNode {
  switch (status) {
    case "ACTIVE":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "CREATING":
      return { kind: "status-dot", status: "provisioning", label: "Creating" };
    case "FAILED":
      return { kind: "status-dot", status: "error", label: "Failed" };
    case "DELETED":
      return { kind: "status-dot", status: "info", label: "Deleted" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * Dispatch a resource to its per-type status-dot mapper. Single place so
 * `renderDetail` and `renderSidebarItem` agree on what to show, and adding
 * a new resource type is a one-line case.
 */
function doStatusDot(resource: ResourceInstance): StatusDotNode {
  const fields = resource.fields;
  switch (resource.resourceTypeId) {
    case "droplet":
      return dropletStatusDot(String(fields["status"] ?? ""));
    case "doks-cluster":
      return doksStatusDot(String(fields["status"] ?? ""));
    case "managed-database":
      return managedDatabaseStatusDot(String(fields["status"] ?? ""));
    case "image":
      return imageStatusDot(String(fields["status"] ?? ""));
    case "nfs-share":
      return nfsShareStatusDot(String(fields["status"] ?? ""));
    case "volume":
      return volumeStatusDot(!!String(fields["dropletIds"] ?? ""));
    case "domain":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "gen-ai-agent": {
      const status = String(fields["status"] ?? "").toLowerCase();
      if (status.includes("running") || status === "active" || status === "deployed") {
        return { kind: "status-dot", status: "healthy", label: "Deployed" };
      }
      if (status.includes("provision") || status.includes("creat")) {
        return { kind: "status-dot", status: "provisioning", label: "Provisioning" };
      }
      if (status.includes("error") || status.includes("fail")) {
        return { kind: "status-dot", status: "error", label: status || "Error" };
      }
      return { kind: "status-dot", status: "info", label: status || "Unknown" };
    }
    case "gen-ai-knowledge-base": {
      const status = String(fields["lastIndexingStatus"] ?? "").toLowerCase();
      if (status === "indexing_status_completed" || status === "completed") {
        return { kind: "status-dot", status: "healthy", label: "Indexed" };
      }
      if (status.includes("indexing") || status.includes("pending")) {
        return { kind: "status-dot", status: "provisioning", label: "Indexing" };
      }
      if (status.includes("error") || status.includes("fail")) {
        return { kind: "status-dot", status: "error", label: "Indexing failed" };
      }
      return { kind: "status-dot", status: "info", label: "Ready" };
    }
    case "gen-ai-model-router":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    case "dedicated-inference": {
      const status = String(fields["status"] ?? "");
      switch (status) {
        case "active":
          return { kind: "status-dot", status: "healthy", label: "Active" };
        case "provisioning":
        case "new":
        case "updating":
          return { kind: "status-dot", status: "provisioning", label: status };
        case "deleting":
          return { kind: "status-dot", status: "provisioning", label: "Deleting" };
        case "error":
          return { kind: "status-dot", status: "error", label: "Error" };
        default:
          return { kind: "status-dot", status: "info", label: status || "Unknown" };
      }
    }
    case "inference-batch": {
      const status = String(fields["status"] ?? "");
      switch (status) {
        case "completed":
          return { kind: "status-dot", status: "healthy", label: "Completed" };
        case "in_progress":
        case "validating":
        case "finalizing":
          return { kind: "status-dot", status: "provisioning", label: status };
        case "cancelling":
          return { kind: "status-dot", status: "provisioning", label: "Cancelling" };
        case "cancelled":
          return { kind: "status-dot", status: "info", label: "Cancelled" };
        case "expired":
          return { kind: "status-dot", status: "degraded", label: "Expired" };
        case "failed":
          return { kind: "status-dot", status: "error", label: "Failed" };
        default:
          return { kind: "status-dot", status: "info", label: status || "Unknown" };
      }
    }
    case "model-api-key":
      return { kind: "status-dot", status: "healthy", label: "Active" };
    default:
      return { kind: "status-dot", status: "info" };
  }
}

/**
 * DigitalOcean plugin client.
 * Created per account (per API token) by the host.
 * All API calls are made server-side — the token never reaches the browser.
 */
export class DigitalOceanClient implements PluginClient {
  private readonly token: string;
  private readonly credentials: Record<string, string>;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly baseUrl = "https://api.digitalocean.com/v2";
  /**
   * Cache of bucket name → region populated by `listSpacesBuckets`. Storage
   * verbs only receive the bucket name, but Spaces endpoints are region-
   * specific; consulting the cache avoids a multi-region fan-out per call.
   */
  private readonly spacesBucketRegions = new Map<string, string>();
  /**
   * Short-lived cache of DO resource URN → projectId. The list-by-type host
   * flow calls listResources for every type back-to-back during one refresh
   * cycle; we don't want to rebuild the map for each call. The map's only
   * consumer is `parentResourceIdForUrn`, which always resolves against the
   * latest `/projects/{id}/resources` snapshot inside the TTL window.
   */
  private projectUrnMap: { map: Map<string, string>; expiresAt: number } | null = null;
  /**
   * Catalog caches keyed by the destination prompt-field consumer. Sizes
   * almost never change so a 30-minute TTL is generous; distribution images
   * are also stable. Both are JSON-serialisable into resolvedOutputs so the
   * downstream renderDetail can read them without going async.
   */
  private dropletCatalogCache: {
    sizes?: { value: SizeOption[]; expiresAt: number };
    distributionImages?: { value: ImageOption[]; expiresAt: number };
  } = {};

  private readonly services: HostServices | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("DigitalOcean plugin: missing apiToken credential");
    this.token = token;
    this.credentials = credentials;
    this.resourceTypes = resourceTypes;
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "DO",
        url: `${this.baseUrl}${path}`,
        errorPath: path,
        headers: { Authorization: `Bearer ${this.token}` },
        ...(options ? { init: options } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // DO's generic `{"id":"forbidden","message":"failed to create agent"}`
      // tells the user nothing actionable. Translate the common cause —
      // missing GenAI scopes on the personal access token — into a
      // pointer at the fix. Same root cause for the other gen-ai and
      // dedicated-inference endpoints, so cover both.
      if (
        message.includes("403") &&
        (path.startsWith("/gen-ai/") || path.startsWith("/dedicated-inferences"))
      ) {
        const product = path.startsWith("/dedicated-inferences")
          ? "Dedicated Inference"
          : "Gradient AI";
        throw new Error(
          `${message}\n\n` +
            `Hint: this is almost always the API token's scope. DigitalOcean ` +
            `${product} endpoints need the \`genai:create\` / \`genai:read\` / ` +
            `\`genai:update\` / \`genai:delete\` scopes (and ` +
            `\`dedicated_inference:*\` for Dedicated Inference), which older ` +
            `personal access tokens don't include. Mint a new token at ` +
            `https://cloud.digitalocean.com/account/api/tokens with the GenAI ` +
            `(or "Full Access") scope and update this account's credentials.`,
        );
      }
      throw err;
    }
  }

  /**
   * Build (or return the cached) map of DO resource URN → owning project id.
   * Needed because DO returns project membership via `/projects/{id}/resources`
   * (URNs only), not on the resource itself — and the host filters children by
   * `parentResourceId === project.id`, so without this lookup every droplet /
   * volume / db / etc. would be invisible inside its project's detail page.
   *
   * Cached for 5s so a single refresh cycle (which lists every type
   * back-to-back) pays the cost once. Errors per-project are swallowed so one
   * unreadable project doesn't blank the rest.
   */
  private async getProjectUrnMap(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.projectUrnMap && this.projectUrnMap.expiresAt > now) {
      return this.projectUrnMap.map;
    }
    const map = new Map<string, string>();
    try {
      const projects = await this.fetch<{ projects: Array<{ id: string }> }>("/projects");
      await Promise.all(
        (projects.projects ?? []).map(async (p) => {
          try {
            const data = await this.fetch<{ resources: Array<{ urn: string }> }>(
              `/projects/${p.id}/resources?per_page=200`,
            );
            for (const r of data.resources ?? []) {
              if (r.urn) map.set(r.urn, p.id);
            }
          } catch {
            /* skip projects whose resources we can't list */
          }
        }),
      );
    } catch {
      /* projects API failed entirely — leave the map empty */
    }
    this.projectUrnMap = { map, expiresAt: now + 5000 };
    return map;
  }

  /**
   * Resolve a DO resource URN to the host's full parentResourceId string, or
   * undefined when the resource isn't assigned to any visible project (DO
   * defaults these to the "default" project, but the projects API still maps
   * them; the undefined branch only fires when the cache is cold).
   */
  private parentResourceIdForUrn(
    accountId: string,
    urn: string,
    map: Map<string, string>,
  ): string | undefined {
    const projectId = map.get(urn);
    return projectId ? `${accountId}:project:${projectId}` : undefined;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "project":
        return this.listProjects(accountId);
      case "droplet":
        return this.listDroplets(accountId);
      case "doks-cluster":
        return this.listDOKSClusters(accountId);
      case "managed-database":
        return this.listManagedDatabases(accountId);
      case "spaces-bucket":
        return this.listSpacesBuckets(accountId);
      case "domain":
        return this.listDomains(accountId);
      case "dns-record":
        return this.listAllDnsRecords(accountId);
      case "volume":
        return this.listVolumes(accountId);
      case "snapshot":
        return this.listSnapshots(accountId);
      case "image":
        return this.listImages(accountId);
      case "nfs-share":
        return this.listNfsShares(accountId);
      case "db-user":
        return this.listDatabaseUsers(accountId);
      case "gen-ai-agent":
        return this.listGenAiAgents(accountId);
      case "gen-ai-knowledge-base":
        return this.listGenAiKnowledgeBases(accountId);
      case "gen-ai-model-router":
        return this.listGenAiModelRouters(accountId);
      case "dedicated-inference":
        return this.listDedicatedInferences(accountId);
      case "inference-batch":
        return this.listInferenceBatches(accountId);
      case "model-api-key":
        return this.listModelApiKeys(accountId);
      case "agent-api-key":
        return this.listAgentApiKeys(accountId);
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
  private async fetchOrEmpty<T>(path: string, fallback: T): Promise<T> {
    try {
      return await this.fetch<T>(path);
    } catch {
      return fallback;
    }
  }

  private async listGenAiAgents(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetchOrEmpty<{
      agents?: Array<Record<string, unknown>> | null;
    }>("/gen-ai/agents?per_page=200", { agents: [] });
    return (data.agents ?? []).map((a) => {
      const uuid = String(a["uuid"] ?? a["id"] ?? "");
      const model = a["model"] as Record<string, unknown> | undefined;
      const router = a["model_router"] as Record<string, unknown> | undefined;
      const deployment = a["deployment"] as Record<string, unknown> | undefined;
      const knowledgeBases = Array.isArray(a["knowledge_bases"])
        ? (a["knowledge_bases"] as unknown[])
        : [];
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

  private async listGenAiKnowledgeBases(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetchOrEmpty<{
      knowledge_bases?: Array<Record<string, unknown>> | null;
    }>("/gen-ai/knowledge_bases?per_page=200", { knowledge_bases: [] });
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

  private async listGenAiModelRouters(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetchOrEmpty<{
      model_routers?: Array<Record<string, unknown>> | null;
    }>("/gen-ai/models/routers?per_page=200", { model_routers: [] });
    return (data.model_routers ?? []).map((r) => {
      const uuid = String(r["uuid"] ?? r["id"] ?? "");
      const regions = Array.isArray(r["regions"]) ? (r["regions"] as string[]) : [];
      const config = r["config"] as Record<string, unknown> | undefined;
      const fallback = Array.isArray(config?.["fallback_models"])
        ? (config?.["fallback_models"] as string[])
        : [];
      const policies = Array.isArray(config?.["policies"])
        ? (config?.["policies"] as unknown[]).length
        : 0;
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
          fallbackModels: fallback.join(","),
          policyCount: policies,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: uuid,
        createdAt: String(r["created_at"] ?? new Date().toISOString()),
        updatedAt: String(r["updated_at"] ?? r["created_at"] ?? new Date().toISOString()),
      };
    });
  }

  private async listDedicatedInferences(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetchOrEmpty<{
      dedicated_inferences?: Array<Record<string, unknown>> | null;
    }>("/dedicated-inferences?per_page=200", { dedicated_inferences: [] });
    return (data.dedicated_inferences ?? []).map((d) => {
      const id = String(d["id"] ?? "");
      const spec = (d["spec"] ?? d["pending_deployment_spec"]) as
        | Record<string, unknown>
        | undefined;
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
  private async listInferenceBatches(accountId: string): Promise<ResourceInstance[]> {
    try {
      const res = await fetch("https://inference.do-ai.run/v1/batches?limit=100", {
        headers: { Authorization: `Bearer ${this.token}` },
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

  private async listModelApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetchOrEmpty<{
      api_key_infos?: Array<Record<string, unknown>> | null;
    }>("/gen-ai/models/api_keys?per_page=200", { api_key_infos: [] });
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
  private async listAgentApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const agentList = await this.fetchOrEmpty<{
      agents?: Array<Record<string, unknown>> | null;
    }>("/gen-ai/agents?per_page=200", { agents: [] });
    const agents = agentList.agents ?? [];
    const keyLists = await Promise.allSettled(
      agents.map(async (a) => {
        const agentUuid = String(a["uuid"] ?? a["id"] ?? "");
        if (!agentUuid) return [] as ResourceInstance[];
        const resp = await this.fetch<{
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    // Prefer the single-resource endpoint where DO exposes one — it avoids a
    // race against /v2/droplets right after a POST create returns (the list
    // endpoint can take a few seconds to reflect a brand-new droplet, which
    // surfaced as "resource not found" on the post-create navigation).
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "droplet" && externalId) {
      try {
        const [data, projectMap] = await Promise.all([
          this.fetch<{ droplet: Record<string, unknown> }>(`/droplets/${externalId}`),
          this.getProjectUrnMap(),
        ]);
        return this.mapDroplet(data.droplet, accountId, projectMap);
      } catch {
        // Fall through to the list-and-find path — covers the case where the
        // single endpoint 404s but the list-cached version still hangs around,
        // and keeps the existing behaviour for non-droplet types.
      }
    }
    // Spaces buckets aren't exposed via the REST API, and a freshly-created
    // bucket can be missing from `listSpacesBuckets` for tens of seconds
    // while regional S3 endpoints converge on the new key/bucket — which
    // surfaced as a post-create 404 on the bucket detail page. HEAD the
    // bucket directly via the S3 virtual-hosted endpoint instead; iterate
    // the known Spaces regions and accept the first 200. This is cheap (no
    // body), and `spacesBucketRegions` caches the resolved region so
    // subsequent calls don't fan out.
    if (typeId === "spaces-bucket" && externalId) {
      const accessKeyId = this.credentials["spacesAccessKeyId"];
      const secretAccessKey = this.credentials["spacesSecretAccessKey"];
      if (accessKeyId && secretAccessKey) {
        const cachedRegion = this.spacesBucketRegions.get(externalId);
        const regionsToProbe = cachedRegion
          ? [cachedRegion, ...SPACES_REGIONS.filter((r) => r !== cachedRegion)]
          : SPACES_REGIONS;
        for (const region of regionsToProbe) {
          const url = `https://${externalId}.${region}.digitaloceanspaces.com/`;
          const res = await signedS3Fetch({
            accessKey: accessKeyId,
            secretKey: secretAccessKey,
            region,
            method: "HEAD",
            url,
          }).catch(() => null);
          if (res && res.ok) {
            this.spacesBucketRegions.set(externalId, region);
            const projectMap = await this.getProjectUrnMap();
            const parentResourceId = this.parentResourceIdForUrn(
              accountId,
              `do:space:${externalId}`,
              projectMap,
            );
            return {
              id: `${accountId}:spaces-bucket:${externalId}`,
              pluginId: "digitalocean",
              resourceTypeId: "spaces-bucket",
              accountId,
              displayName: externalId,
              fields: { name: externalId, region, accessControl: "private" },
              resolvedOutputs: {
                endpoint: `https://${externalId}.${region}.digitaloceanspaces.com`,
              },
              secretStates: [],
              externalId,
              ...(parentResourceId ? { parentResourceId } : {}),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          }
        }
      }
      // Fall through — listResources may have a different cached state.
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`DigitalOcean plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    // resolveOutput receives the full `{accountId}:{typeId}:{externalId}`
    // resource id from the host. DO's REST endpoints take the bare external
    // id (the cluster/database UUID), so peel the prefix off before
    // interpolating — passing the full id produced
    // `/kubernetes/clusters/{accountId}:doks-cluster:{uuid}/kubeconfig`,
    // which 404s as "cluster not found".
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "doks-cluster" && outputKey === "kubeconfig") {
      // The kubeconfig endpoint returns raw `application/yaml` text, not a
      // JSON envelope (verified in digitalocean/openapi
      // resources/kubernetes/responses/kubeconfig.yml). Bypass
      // jsonRestFetch and read the body as text directly.
      const res = await fetch(`${this.baseUrl}/kubernetes/clusters/${externalId}/kubeconfig`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/yaml" },
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(
          `DO API error ${res.status} for /kubernetes/clusters/${externalId}/kubeconfig: ${body}`,
        );
      }
      return body;
    }

    if (typeId === "managed-database") {
      const data = await this.fetch<{
        database: {
          engine?: string;
          connection: Record<string, string>;
          private_connection?: Record<string, string>;
        };
      }>(`/databases/${externalId}`);
      const conn = data.database.connection;
      const engine = String(data.database.engine ?? "");
      switch (outputKey) {
        case "connectionString": {
          let uri = ensureUriCredentials(conn["uri"] ?? "", conn["user"], conn["password"]);
          // DO's `/databases/{id}` response can hand back `connection.uri`
          // as `mongodb+srv://doadmin:@host` with no password — the
          // credential lives on the per-user endpoint instead. Try that
          // before failing so the user doesn't have to paste a connection
          // string manually.
          let usersSnapshot: Array<{ name?: string; hasPassword: boolean }> = [];
          if (!uriHasPassword(uri) && conn["user"]) {
            try {
              const usersData = await this.fetch<{
                users?: Array<{ name?: string; password?: string }>;
              }>(`/databases/${externalId}/users`);
              const list = usersData.users ?? [];
              usersSnapshot = list.map((u) => ({
                ...(u.name != null ? { name: u.name } : {}),
                hasPassword: !!u.password,
              }));
              const match = list.find((u) => u.name === conn["user"]);
              if (match?.password) {
                uri = ensureUriCredentials(conn["uri"] ?? "", conn["user"], match.password);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(
                "DigitalOcean's `/databases/{id}/users` endpoint failed — this usually means " +
                  "the API token lacks the `database:view_credentials` scope. In the DO token UI, " +
                  "regenerate the token and explicitly tick that scope (it's *not* included by " +
                  `default in "Full Access"). Underlying error: ${msg}`,
              );
            }
          }
          // Last-ditch fallback: pull a password from a db-user resource
          // we minted ourselves and persisted via secretStates. Lets the
          // peer-pane work even when DO refuses to expose existing
          // passwords (no view_credentials scope, post-rotation, etc.).
          if (!uriHasPassword(uri)) {
            const minted = await this.findMintedDatabaseUser(externalId, accountId);
            if (minted) {
              uri = ensureUriCredentials(conn["uri"] ?? "", minted.name, minted.password);
            }
          }
          if (!uriHasPassword(uri)) {
            const usersDump =
              usersSnapshot.length > 0
                ? usersSnapshot
                    .map((u) => `${u.name ?? "?"} (password: ${u.hasPassword ? "yes" : "empty"})`)
                    .join(", ")
                : "(no users returned)";
            throw new Error(
              "DigitalOcean returned no password for this database's default user. " +
                "Open the cluster's detail page and add a user under the 'DB Users' section — " +
                "Infrawrench will capture the password DO mints and use it here. " +
                `Existing users on the cluster: ${usersDump}.`,
            );
          }
          if (engine === "kafka") {
            uri = normalizeKafkaUri(uri);
          }
          return uri;
        }
        case "host":
          return conn["host"] ?? "";
        case "port":
          return conn["port"] ?? "";
        case "username":
          return conn["user"] ?? "";
        case "password":
          return conn["password"] ?? "";
        case "database":
          return conn["database"] ?? "";
        case "caCertificate": {
          // DO returns the CA as base64-encoded PEM (the openapi spec
          // declares `format: byte` for this field — see
          // databases/models/ca.yml). Decode it so consumers (pg, mysql2)
          // receive raw PEM with the `-----BEGIN CERTIFICATE-----`
          // header they expect. Forwarding the base64 directly used to
          // produce "self signed certificate in certificate chain"
          // because the TLS layer couldn't parse the cert at all.
          const caData = await this.fetch<{ ca: { certificate: string } }>(
            `/databases/${externalId}/ca`,
          );
          const raw = caData.ca.certificate ?? "";
          // Already PEM? Pass through. Otherwise base64 → utf8.
          // `atob` is the cross-runtime decoder (Node ≥18 + browser);
          // we can't import `Buffer` here because this plugin is shared
          // with the renderer.
          if (raw.includes("-----BEGIN")) return raw;
          try {
            return atob(raw);
          } catch {
            return raw;
          }
        }
      }
    }

    if (typeId === "spaces-bucket") {
      // Spaces credentials are account-level (from the Spaces API keys), not bucket-specific
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        const region = String(resource.fields["region"] ?? "nyc3");
        return `https://${region}.digitaloceanspaces.com`;
      }
      if (outputKey === "accessKeyId") return this.credentials["spacesAccessKeyId"] ?? "";
      if (outputKey === "secretAccessKey") return this.credentials["spacesSecretAccessKey"] ?? "";
    }

    if (typeId === "domain" && outputKey === "nameservers") {
      return "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com";
    }

    if (typeId === "db-user" && outputKey === "password") {
      // We never look the password up from DO — it's only available the
      // instant the user was created. The plaintext lives in our local
      // secret store, keyed by the resource id.
      const value = await this.services?.secrets?.getPlaintext(resourceId, "password");
      if (!value) {
        throw new Error(
          "No stored password for this user. Passwords are only captured at create time; " +
            "DigitalOcean doesn't expose existing user passwords after the fact.",
        );
      }
      return value;
    }

    throw new Error(
      `DigitalOcean plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  /**
   * Look through every db-user we've persisted for the given cluster and
   * return the first one with a stored password. Used by managed-database's
   * `connectionString` resolver when DO refuses to hand back the original
   * doadmin credentials. The cluster's user list is fetched live (we don't
   * trust local cache for membership) but the password comes from the host's
   * secret store via `services.secrets.getPlaintext`.
   */
  private async findMintedDatabaseUser(
    clusterId: string,
    accountId: string,
  ): Promise<{ name: string; password: string } | null> {
    const secrets = this.services?.secrets;
    if (!secrets) return null;
    let users: Array<{ name?: string }> = [];
    try {
      const resp = await this.fetch<{ users?: Array<{ name?: string }> }>(
        `/databases/${clusterId}/users`,
      );
      users = resp.users ?? [];
    } catch {
      return null;
    }
    for (const u of users) {
      if (!u.name) continue;
      const id = `${accountId}:db-user:${clusterId}:${u.name}`;
      const password = await secrets.getPlaintext(id, "password");
      if (password) return { name: u.name, password };
    }
    return null;
  }

  private get createCtx(): DoCreateContext {
    return {
      fetch: this.fetch.bind(this),
      credentials: this.credentials,
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return doGetCreateConfig(this.createCtx, typeId, parentResourceId);
  }

  /**
   * Compute the form's estimated monthly cost. The size-picker only carries
   * the per-node price; the cost panel needs to multiply by node count for
   * resource types that scale horizontally (managed-database, doks-cluster).
   * Droplet has its own per-size price already shown in the picker; for it
   * we return the picked size's price directly so the panel matches.
   */
  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    if (typeId === "managed-database") {
      const slug = fields["size"] ?? "";
      const memMatch = /(\d+)gb/i.exec(slug);
      const memoryGb = memMatch ? Number(memMatch[1]) : 0;
      const perNode = estimateDoDatabaseMonthlyPrice(slug, memoryGb);
      const nodes = Math.max(1, Number(fields["nodeCount"] ?? 1));
      return perNode > 0 ? perNode * nodes : null;
    }
    if (typeId === "doks-cluster") {
      // Cluster control plane is free; cost is node count × droplet size price.
      // We don't have a size price lookup for DOKS sizes here — defer to the
      // sidebar's picker price which the host already shows.
      return null;
    }
    return null;
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "spaces-bucket") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const bucketName = String(resource.fields["name"] ?? resource.externalId ?? "");
      const region = String(resource.fields["region"] ?? "nyc3");
      if (!bucketName) throw new Error("Cannot determine Spaces bucket name");
      const permission =
        formatId === "bucket-scoped-ro"
          ? "read"
          : formatId === "bucket-scoped-rw"
            ? "readwrite"
            : "";
      if (!permission) {
        throw new Error(`DigitalOcean plugin: unknown spaces key format "${formatId}"`);
      }
      const name = `infrawrench-${bucketName}-${Date.now().toString(36)}`;
      const resp = await this.fetch<{
        key?: { name: string; access_key: string; secret_key?: string };
      }>("/spaces/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          grants: [{ bucket: bucketName, permission }],
        }),
      });
      const key = resp.key;
      const accessKeyId = key?.access_key ?? "";
      const secret = key?.secret_key ?? "";
      if (!accessKeyId || !secret) {
        throw new Error("DigitalOcean returned an empty Spaces key");
      }
      const endpoint = `https://${region}.digitaloceanspaces.com`;
      const ini =
        `[default]\n` +
        `aws_access_key_id=${accessKeyId}\n` +
        `aws_secret_access_key=${secret}\n` +
        `# endpoint=${endpoint}\n` +
        `# bucket=${bucketName}\n` +
        `# permission=${permission}\n`;
      return {
        content: ini,
        filename: `${bucketName}.credentials`,
        mimeType: "text/plain",
        fields: [
          { label: "Access Key ID", value: accessKeyId },
          { label: "Secret Access Key", value: secret, sensitive: true, hint: "Only shown once" },
          { label: "Endpoint", value: endpoint },
          { label: "Bucket", value: bucketName },
          { label: "Permission", value: permission },
        ],
        warning:
          "Save this now. The secret key cannot be re-fetched from the DigitalOcean API. This key is scoped to a single bucket — delete it from the DO console when no longer needed.",
      };
    }
    throw new Error(
      `DigitalOcean plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").pop();
    if (!externalId) throw new Error("Cannot parse resource ID");

    switch (typeId) {
      case "droplet":
        await this.fetch<unknown>(`/droplets/${externalId}`, { method: "DELETE" });
        break;
      case "doks-cluster":
        await this.fetch<unknown>(`/kubernetes/clusters/${externalId}`, { method: "DELETE" });
        break;
      case "managed-database":
        await this.fetch<unknown>(`/databases/${externalId}`, { method: "DELETE" });
        break;
      case "db-user": {
        // Composite id: `{accountId}:db-user:{clusterId}:{username}`. The
        // parent cluster id is the second-to-last segment, the username the
        // last. We can't reuse `externalId.split(":").pop()` alone because the
        // delete endpoint needs both.
        const parts = resourceId.split(":");
        const username = parts[parts.length - 1] ?? "";
        const clusterId = parts[parts.length - 2] ?? "";
        if (!username || !clusterId) {
          throw new Error("Cannot parse db-user resource ID");
        }
        await this.fetch<unknown>(`/databases/${clusterId}/users/${encodeURIComponent(username)}`, {
          method: "DELETE",
        });
        break;
      }
      case "spaces-bucket": {
        // Spaces are managed via the S3-compatible API, not the DO REST API.
        const accessKeyId = this.credentials["spacesAccessKeyId"];
        const secretAccessKey = this.credentials["spacesSecretAccessKey"];
        if (!accessKeyId || !secretAccessKey) {
          throw new Error(
            "DigitalOcean plugin: Spaces management requires S3-compatible credentials " +
              '("spacesAccessKeyId" and "spacesSecretAccessKey"). ' +
              "Generate these in the DigitalOcean console under API > Spaces Keys.",
          );
        }
        // We need the region to build the endpoint. Try to look it up from the resource,
        // but fall back to parsing the externalId (which is the bucket name).
        const bucketName = externalId;
        let bucketRegion = "nyc3";
        try {
          const resource = await this.getResource("spaces-bucket", resourceId, _accountId);
          bucketRegion = String(resource.fields["region"] ?? "nyc3");
        } catch {
          // Fall back to default region
        }
        const deleteHost = `${bucketName}.${bucketRegion}.digitaloceanspaces.com`;
        const delRes = await signedS3Fetch({
          accessKey: accessKeyId,
          secretKey: secretAccessKey,
          region: bucketRegion,
          method: "DELETE",
          url: `https://${deleteHost}/`,
        });
        if (!delRes.ok) {
          throw new Error(
            `Spaces S3 API error ${delRes.status} deleting bucket "${bucketName}": ${await delRes.text()}`,
          );
        }
        break;
      }
      case "domain":
        await this.fetch<unknown>(`/domains/${externalId}`, { method: "DELETE" });
        break;
      case "dns-record": {
        // externalId format: "{domainName}/{recordId}"
        const parts = externalId.split("/");
        const domainName = parts[0]!;
        const recordId = parts[1]!;
        await this.fetch<unknown>(`/domains/${domainName}/records/${recordId}`, {
          method: "DELETE",
        });
        break;
      }
      case "project":
        await this.fetch<unknown>(`/projects/${externalId}`, { method: "DELETE" });
        break;
      case "volume":
        await this.fetch<unknown>(`/volumes/${externalId}`, { method: "DELETE" });
        break;
      case "snapshot":
        // /v2/snapshots/{id} covers both droplet and volume snapshots — DO
        // uses the same endpoint family regardless of source type.
        await this.fetch<unknown>(`/snapshots/${externalId}`, { method: "DELETE" });
        break;
      case "image":
        // Only user-owned images (snapshots/backups/custom uploads) are
        // deletable — DO returns 403 for distribution images, surfaced as a
        // host-level error.
        await this.fetch<unknown>(`/images/${externalId}`, { method: "DELETE" });
        break;
      case "nfs-share": {
        // externalId format: "{region}/{shareId}" — the API endpoint takes
        // a `region` query param alongside the bare share id.
        const parts = externalId.split("/");
        const region = parts[0]!;
        const shareId = parts[1]!;
        await this.fetch<unknown>(`/nfs/${shareId}?region=${encodeURIComponent(region)}`, {
          method: "DELETE",
        });
        break;
      }
      case "gen-ai-agent":
        await this.fetch<unknown>(`/gen-ai/agents/${externalId}`, { method: "DELETE" });
        break;
      case "gen-ai-knowledge-base":
        await this.fetch<unknown>(`/gen-ai/knowledge_bases/${externalId}`, { method: "DELETE" });
        break;
      case "gen-ai-model-router":
        await this.fetch<unknown>(`/gen-ai/models/routers/${externalId}`, { method: "DELETE" });
        break;
      case "dedicated-inference":
        await this.fetch<unknown>(`/dedicated-inferences/${externalId}`, { method: "DELETE" });
        break;
      case "inference-batch": {
        // Batch jobs are cancelled rather than deleted. The endpoint lives
        // on the data-plane host, so bypass `this.fetch` (which targets
        // api.digitalocean.com) and call it directly with the same bearer.
        const res = await fetch(`https://inference.do-ai.run/v1/batches/${externalId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok && res.status !== 404) {
          throw new Error(`DO API error ${res.status} cancelling batch ${externalId}`);
        }
        break;
      }
      case "model-api-key":
        await this.fetch<unknown>(`/gen-ai/models/api_keys/${externalId}`, { method: "DELETE" });
        break;
      case "agent-api-key": {
        // Composite externalId `{agentUuid}/{keyUuid}` — both halves are
        // required because DO scopes the endpoint to the parent agent.
        const parts = externalId.split("/");
        const agentUuid = parts[0]!;
        const keyUuid = parts[1]!;
        await this.fetch<unknown>(`/gen-ai/agents/${agentUuid}/api_keys/${keyUuid}`, {
          method: "DELETE",
        });
        break;
      }
      default:
        throw new Error(`DigitalOcean plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").pop() ?? "";

    if (typeId === "gen-ai-agent") {
      // DO's PUT /v2/gen-ai/agents/{uuid} accepts only the fields supplied —
      // map the editable resource fields to the API's snake_case keys. A
      // `model_uuid`/`model_router_uuid` change is the swap-router flow: if
      // both are touched in the same edit, the explicit user intent is to
      // pick whichever side has a non-empty value (router wins ties, since
      // setting a router supersedes the model).
      const fieldMap: Record<string, string> = {
        name: "name",
        description: "description",
        instruction: "instruction",
        temperature: "temperature",
        maxTokens: "max_tokens",
        k: "k",
      };
      const body: Record<string, unknown> = {};
      for (const [src, dst] of Object.entries(fieldMap)) {
        if (fields[src] !== undefined) body[dst] = fields[src];
      }
      // temperature / max_tokens / k are typed `string` in the host diff but
      // the API wants numbers — coerce, dropping empty strings.
      for (const key of ["temperature", "max_tokens", "k"] as const) {
        if (body[key] !== undefined) {
          const n = Number(body[key]);
          if (Number.isFinite(n)) body[key] = n;
          else delete body[key];
        }
      }
      // Swap between a model and a router. `model_uuid` and
      // `model_router_uuid` are mutually exclusive in DO's API — picking a
      // router moves model_uuid to "" and vice versa. If only one side
      // changed, send only that side; if both, prefer router when set.
      const routerTouched = fields["modelRouterUuid"] !== undefined;
      const modelTouched = fields["modelUuid"] !== undefined;
      if (routerTouched && fields["modelRouterUuid"]) {
        body["model_router_uuid"] = fields["modelRouterUuid"];
      } else if (modelTouched && fields["modelUuid"]) {
        body["model_uuid"] = fields["modelUuid"];
      } else if (routerTouched && !fields["modelRouterUuid"] && fields["modelUuid"]) {
        // Router was cleared but a model UUID is still present — switch back
        // to the single-model path explicitly.
        body["model_uuid"] = fields["modelUuid"];
      }
      const data = await this.fetch<{ agent: Record<string, unknown> }>(
        `/gen-ai/agents/${externalId}`,
        {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      const a = data.agent ?? {};
      const uuid = String(a["uuid"] ?? externalId);
      const model = a["model"] as Record<string, unknown> | undefined;
      const router = a["model_router"] as Record<string, unknown> | undefined;
      const deployment = a["deployment"] as Record<string, unknown> | undefined;
      const deploymentUrl = String(deployment?.["url"] ?? "");
      const knowledgeBases = Array.isArray(a["knowledge_bases"])
        ? (a["knowledge_bases"] as unknown[])
        : [];
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
          deploymentUrl,
        },
        resolvedOutputs: deploymentUrl ? { deploymentUrl, agentEndpoint: deploymentUrl } : {},
        secretStates: [],
        externalId: uuid,
        createdAt: String(a["created_at"] ?? new Date().toISOString()),
        updatedAt: String(a["updated_at"] ?? new Date().toISOString()),
      };
    }

    if (typeId !== "project") {
      throw new Error(`DigitalOcean plugin: updateResource not supported for type "${typeId}"`);
    }
    // DO's PATCH /v2/projects/{id} accepts only the fields supplied — name,
    // description, purpose, environment. Send through whatever the caller
    // changed; the host has already diffed against the prior values.
    const body: Record<string, string> = {};
    for (const key of ["name", "description", "purpose", "environment"] as const) {
      if (fields[key] !== undefined) body[key] = fields[key];
    }
    const data = await this.fetch<{ project: Record<string, unknown> }>(`/projects/${externalId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const p = data.project;
    return {
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
    };
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "volume" && targetTypeId === "droplet") {
      const [volume, droplet] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeRegion = String(volume.fields["region"] ?? "");
      const dropletRegion = String(droplet.fields["region"] ?? "");
      if (volumeRegion && dropletRegion && volumeRegion !== dropletRegion) {
        throw new Error(
          `Volume region ${volumeRegion} does not match droplet region ${dropletRegion} — DigitalOcean volumes must be in the same region as the droplet.`,
        );
      }
      const volumeId = volume.externalId ?? sourceResourceId.split(":").pop();
      const dropletId = Number(droplet.externalId ?? targetResourceId.split(":").pop());
      if (!volumeId || !Number.isFinite(dropletId)) {
        throw new Error("Cannot determine volume or droplet id for attachment");
      }
      await this.fetch(`/volumes/${volumeId}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "attach", droplet_id: dropletId, region: volumeRegion }),
      });
      return;
    }
    if (sourceTypeId === "nfs-share" && targetTypeId === "droplet") {
      // DO scopes NFS access at VPC level (per nfs_actions.yml: `attach`
      // takes `vpc_id`). Resolve the droplet's vpc_uuid and register
      // it on the share's allowed VPCs. The share's externalId is
      // `{region}/{shareId}`; extract the trailing id.
      const [share, droplet] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const shareRegion = String(share.fields["region"] ?? "");
      const dropletRegion = String(droplet.fields["region"] ?? "");
      if (shareRegion && dropletRegion && shareRegion !== dropletRegion) {
        throw new Error(
          `NFS share region ${shareRegion} does not match droplet region ${dropletRegion} — droplets can only mount shares in their own region.`,
        );
      }
      const dropletVpc = String(droplet.fields["vpcUuid"] ?? "");
      if (!dropletVpc) {
        throw new Error(
          "Couldn't determine the droplet's VPC — refresh the droplet and try again.",
        );
      }
      // Idempotent: if this VPC is already on the share's allow list,
      // there's nothing to do. DO would return 422 otherwise.
      const allowedVpcs = String(share.fields["vpcIds"] ?? "")
        .split(",")
        .filter(Boolean);
      if (allowedVpcs.includes(dropletVpc)) return;
      const shareExternalId = share.externalId ?? sourceResourceId.split(":").slice(2).join(":");
      // externalId is `{region}/{id}` — peel off the region prefix to
      // get the bare share id for the actions URL.
      const shareId = shareExternalId.includes("/")
        ? shareExternalId.split("/")[1]!
        : shareExternalId;
      await this.fetch(`/nfs/${shareId}/actions`, {
        method: "POST",
        body: JSON.stringify({ type: "attach", vpc_id: dropletVpc, region: shareRegion }),
      });
      return;
    }
    if (sourceTypeId === "gen-ai-knowledge-base" && targetTypeId === "gen-ai-agent") {
      const kbUuid = sourceResourceId.split(":").slice(2).join(":");
      const agentUuid = targetResourceId.split(":").slice(2).join(":");
      if (!kbUuid || !agentUuid) {
        throw new Error("Cannot determine knowledge base or agent UUID for attachment.");
      }
      await this.fetch(`/gen-ai/agents/${agentUuid}/knowledge_bases/${kbUuid}`, {
        method: "POST",
      });
      return;
    }
    throw new Error(
      `DigitalOcean plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateResult> {
    return doCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
  }

  /**
   * Inline field actions. The agent create form's Inference Router picker
   * exposes a "+ New router" action that mints an Inference Router on the
   * side (without leaving the agent form) and returns the new router's
   * UUID + label so the host can splice it into the picker's options and
   * select it. Other actions can be added here as they're declared.
   */
  async executeFieldAction(
    typeId: string,
    _fieldKey: string,
    actionId: string,
    _accountId: string,
    _fields: Record<string, string>,
    actionFields?: Record<string, string>,
  ): Promise<{ value: string; option?: { id: string; label: string } }> {
    if (typeId === "gen-ai-agent" && actionId === "create-workspace") {
      const af = actionFields ?? {};
      const name = String(af["name"] ?? "").trim();
      if (!name) throw new Error("Workspace name is required.");
      const body: Record<string, unknown> = {
        name,
        ...(af["description"] ? { description: af["description"] } : {}),
      };
      const data = await this.fetch<{ workspace: Record<string, unknown> }>("/gen-ai/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      const w = data.workspace ?? {};
      const uuid = String(w["uuid"] ?? "");
      if (!uuid) throw new Error("DigitalOcean did not return a workspace UUID.");
      return {
        value: uuid,
        option: { id: uuid, label: String(w["name"] ?? name) },
      };
    }
    if (typeId === "gen-ai-agent" && actionId === "create-inference-router") {
      const af = actionFields ?? {};
      const name = String(af["name"] ?? "").trim();
      if (!name) throw new Error("Router name is required.");
      const fallback = String(af["fallbackModels"] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        name,
        ...(af["description"] ? { description: af["description"] } : {}),
        ...(fallback.length ? { fallback_models: fallback } : {}),
      };
      const data = await this.fetch<{ model_router: Record<string, unknown> }>(
        "/gen-ai/models/routers",
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );
      const r = data.model_router ?? {};
      const uuid = String(r["uuid"] ?? "");
      if (!uuid) throw new Error("DigitalOcean did not return a router UUID.");
      return {
        value: uuid,
        option: { id: uuid, label: String(r["name"] ?? name) },
      };
    }
    throw new Error(
      `DigitalOcean plugin: executeFieldAction not supported for "${typeId}" / "${actionId}".`,
    );
  }

  private get actionCtx(): ActionContext {
    return {
      fetch: this.fetch.bind(this),
      getResource: this.getResource.bind(this),
    };
  }

  /**
   * Parameterless droplet & volume actions. The host calls this in response to
   * an `ActionNode` whose action is `{ type: "plugin-action", actionId }`.
   * Destructive actions are pre-confirmed by the host via `confirmMessage`.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "droplet") {
      return invokeDropletAction(this.actionCtx, resourceId, accountId, actionId);
    }
    if (typeId === "volume") {
      return invokeVolumeAction(this.actionCtx, resourceId, accountId, actionId);
    }
    if (typeId === "gen-ai-agent") {
      const agentUuid = resourceId.split(":").slice(2).join(":");
      if (actionId === "make-public" || actionId === "make-private") {
        const visibility = actionId === "make-public" ? "VISIBILITY_PUBLIC" : "VISIBILITY_PRIVATE";
        await this.fetch<unknown>(`/gen-ai/agents/${agentUuid}/deployment_visibility`, {
          method: "PUT",
          body: JSON.stringify({ visibility }),
          headers: { "Content-Type": "application/json" },
        });
        return;
      }
      if (actionId === "regenerate-key") {
        // Not exposed as a header action on the agent itself, but on the
        // child key — kept here for symmetry once the row-action lands.
        return;
      }
    }
    if (typeId === "agent-api-key" && actionId === "regenerate") {
      // Composite resourceId — parse {agentUuid}/{keyUuid} from the
      // externalId, then PUT .../regenerate. DO returns a fresh secret_key
      // on this call (one-shot, same as create).
      const externalId = resourceId.split(":").slice(2).join(":");
      const parts = externalId.split("/");
      const agentUuid = parts[0]!;
      const keyUuid = parts[1]!;
      await this.fetch<unknown>(`/gen-ai/agents/${agentUuid}/api_keys/${keyUuid}/regenerate`, {
        method: "PUT",
      });
      return;
    }
    throw new Error(`DigitalOcean plugin: invokeAction not supported for type "${typeId}"`);
  }

  /**
   * Parameterised droplet & volume commands. Reuses the host's
   * `prompt-nosql-command` modal as a generic prompt mechanism (the modal name
   * is a historical artefact — it carries any plugin-defined form). The form
   * values arrive JSON-encoded in `args[0]`.
   */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId === "droplet") {
      return executeDropletCommand(this.actionCtx, resourceId, accountId, command, args);
    }
    if (typeId === "volume") {
      return executeVolumeCommand(this.actionCtx, resourceId, accountId, command, args);
    }
    if (typeId === "gen-ai-agent") {
      const agentUuid = resourceId.split(":").slice(2).join(":");
      const first = args[0];
      const values: Record<string, string> =
        typeof first === "string" && first
          ? (() => {
              try {
                const parsed = JSON.parse(first) as Record<string, string>;
                return parsed && typeof parsed === "object" ? parsed : {};
              } catch {
                return {};
              }
            })()
          : {};
      if (command === "attach-knowledge-base") {
        const kbUuid = String(values["knowledgeBaseUuid"] ?? "");
        if (!kbUuid) throw new Error("Pick a knowledge base.");
        await this.fetch(`/gen-ai/agents/${agentUuid}/knowledge_bases/${kbUuid}`, {
          method: "POST",
        });
        return;
      }
      if (command === "detach-knowledge-base") {
        const kbUuid = String(values["knowledgeBaseUuid"] ?? "");
        if (!kbUuid) throw new Error("Missing knowledge base UUID.");
        await this.fetch(`/gen-ai/agents/${agentUuid}/knowledge_bases/${kbUuid}`, {
          method: "DELETE",
        });
        return;
      }
      if (command === "attach-child-agent") {
        const childUuid = String(values["childAgentUuid"] ?? "");
        if (!childUuid) throw new Error("Pick an agent to route to.");
        const body: Record<string, string> = {};
        if (values["routeName"]) body["route_name"] = values["routeName"];
        if (values["ifCase"]) body["if_case"] = values["ifCase"];
        await this.fetch(`/gen-ai/agents/${agentUuid}/child_agents/${childUuid}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });
        return;
      }
      if (command === "detach-child-agent") {
        const childUuid = String(values["childAgentUuid"] ?? "");
        if (!childUuid) throw new Error("Missing child agent UUID.");
        await this.fetch(`/gen-ai/agents/${agentUuid}/child_agents/${childUuid}`, {
          method: "DELETE",
        });
        return;
      }
      if (command === "attach-function") {
        // The form's value keys map straight onto the DO request body.
        const name = String(values["functionName"] ?? "").trim();
        const faasName = String(values["faasName"] ?? "").trim();
        const faasNamespace = String(values["faasNamespace"] ?? "").trim();
        if (!name || !faasName || !faasNamespace) {
          throw new Error(
            "Function name, FaaS function name, and FaaS namespace are all required.",
          );
        }
        const body: Record<string, unknown> = {
          function_name: name,
          faas_name: faasName,
          faas_namespace: faasNamespace,
          ...(values["description"] ? { description: values["description"] } : {}),
          ...(values["inputSchema"] ? { input_schema: safeParseJson(values["inputSchema"]) } : {}),
          ...(values["outputSchema"]
            ? { output_schema: safeParseJson(values["outputSchema"]) }
            : {}),
        };
        await this.fetch(`/gen-ai/agents/${agentUuid}/functions`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });
        return;
      }
      if (command === "detach-function") {
        const fnUuid = String(values["functionUuid"] ?? "");
        if (!fnUuid) throw new Error("Missing function UUID.");
        await this.fetch(`/gen-ai/agents/${agentUuid}/functions/${fnUuid}`, {
          method: "DELETE",
        });
        return;
      }
    }
    throw new Error(`DigitalOcean plugin: executeNoSqlCommand not supported for type "${typeId}"`);
  }

  /**
   * In-memory fallback cache of `{ agentUuid → secret_key }` for hosts that
   * don't expose a secret write path. The durable store is the host's
   * encrypted secret-field state, keyed on the agent resource id under the
   * `PLAYGROUND_KEY_FIELD` field — that's org-scoped on the cloud host so
   * every team member's Playground reuses one minted key instead of each
   * session minting its own.
   */
  private readonly playgroundKeyCache = new Map<string, string>();

  private static readonly PLAYGROUND_KEY_FIELD = "__playgroundEndpointKey";

  /**
   * Resolve an endpoint access key for the Playground, in priority order:
   *   1. in-memory session cache (cheapest),
   *   2. the host's persisted secret store (shared across sessions; org-wide
   *      on the cloud host — the secret stays server-side and is never sent
   *      to other users' browsers),
   *   3. mint a fresh `infrawrench-playground` key, persist it, and cache it.
   *
   * The persisted-then-reused design is what stops us minting "a ton of
   * tokens" — one key per agent is created once and shared.
   */
  private async getOrMintPlaygroundKey(
    agentUuid: string,
    agentResourceId: string,
  ): Promise<string> {
    const field = DigitalOceanClient.PLAYGROUND_KEY_FIELD;

    const cached = this.playgroundKeyCache.get(agentUuid);
    if (cached) return cached;

    // Reuse a previously-persisted key when the host exposes secret storage.
    const stored = await this.services?.secrets?.getPlaintext(agentResourceId, field);
    if (stored) {
      this.playgroundKeyCache.set(agentUuid, stored);
      return stored;
    }

    const name = `infrawrench-playground`;
    // The agent-API-key create response nests the secret inside
    // `api_key_info.secret_key` (unlike model API keys, which return a
    // top-level `secret_key`). Read both spots to be safe.
    const data = await this.fetch<{
      api_key_info?: { secret_key?: string };
      secret_key?: string;
    }>(`/gen-ai/agents/${agentUuid}/api_keys`, {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json" },
    });
    const secret = String(data.api_key_info?.secret_key ?? data.secret_key ?? "");
    if (!secret) {
      throw new Error(
        "DigitalOcean didn't return an endpoint access key secret. Confirm the API token has the `genai:create` scope and try again.",
      );
    }
    this.playgroundKeyCache.set(agentUuid, secret);
    // Persist for reuse (best-effort — if the host has no write path or it
    // fails, we still chat this session via the in-memory cache).
    if (this.services?.secrets?.setPlaintext) {
      try {
        await this.services.secrets.setPlaintext(agentResourceId, field, secret);
      } catch {
        /* non-fatal — session cache covers this run */
      }
    }
    return secret;
  }

  /**
   * Stream tokens from a deployed agent's OpenAI-compatible chat completions
   * endpoint. DO's agents.do-ai.run gateway implements SSE (`stream: true`)
   * exactly like OpenAI — `data: {json}\n\n` lines, terminating with
   * `data: [DONE]`. We parse it incrementally and yield `delta` events as
   * each `choices[0].delta.content` chunk arrives, then a single `done` with
   * the assembled message.
   */
  // The body of the iterable is an async generator so plugins (and the
  // host's IPC bridge) can `for await (const event of stream) { … }`.
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "gen-ai-agent") {
      yield {
        kind: "error",
        message: `DigitalOcean plugin: streamChatMessage not supported for type "${typeId}".`,
      };
      return;
    }
    const agentUuid = resourceId.split(":").slice(2).join(":");
    if (!agentUuid) {
      yield { kind: "error", message: "Couldn't determine the agent UUID." };
      return;
    }

    // Resolve the deployment URL + endpoint access key. The deployment URL
    // already includes the `agents.do-ai.run` host; we tack `/api/v1/chat/
    // completions` on (matches DO's OpenAI-compatible path).
    let deploymentUrl: string;
    let secretKey: string;
    try {
      const agentRes = await this.fetch<{
        agent: { deployment?: { url?: string } };
      }>(`/gen-ai/agents/${agentUuid}`);
      deploymentUrl = String(agentRes.agent?.deployment?.url ?? "");
      if (!deploymentUrl) {
        yield {
          kind: "error",
          message:
            "Agent has no deployment URL yet. Wait for the agent to finish provisioning and reload.",
        };
        return;
      }
      secretKey = await this.getOrMintPlaygroundKey(agentUuid, resourceId);
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    const endpoint = `${deploymentUrl.replace(/\/+$/, "")}/api/v1/chat/completions`;
    const body = JSON.stringify({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      // Asking the gateway to return usage in the final chunk — DO mirrors
      // OpenAI's `stream_options.include_usage` opt-in here. Some gateways
      // ignore it, in which case we just skip the usage payload.
      stream_options: { include_usage: true },
    });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      yield {
        kind: "error",
        message: `Agent endpoint returned ${res.status}: ${errText || res.statusText}`,
      };
      return;
    }

    // Parse SSE chunks. The OpenAI-compatible stream format is
    // `data: {json}\n\n` lines until `data: [DONE]`. We accumulate the
    // `choices[0].delta.content` strings into `assembled` so we can hand
    // the host the full message in the terminal `done` event.
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let assembled = "";
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE messages are separated by blank lines. Split on `\n\n`,
        // keeping the trailing partial in `buffer` for the next read.
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assembled += delta;
              yield { kind: "delta", text: delta };
            }
            if (parsed.usage) {
              usage = {};
              if (parsed.usage.prompt_tokens !== undefined) {
                usage.inputTokens = parsed.usage.prompt_tokens;
              }
              if (parsed.usage.completion_tokens !== undefined) {
                usage.outputTokens = parsed.usage.completion_tokens;
              }
              if (parsed.usage.total_tokens !== undefined) {
                usage.totalTokens = parsed.usage.total_tokens;
              }
            }
          } catch {
            // Malformed SSE chunk — skip rather than abort the whole stream.
          }
        }
      }
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    yield {
      kind: "done",
      message: { role: "assistant", content: assembled },
      ...(usage ? { usage } : {}),
    };
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "droplet": {
        const stats: DashboardStat[] = [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: String(f["size"] ?? "") },
        ];
        if (resource.resolvedOutputs["ipv4"]) {
          stats.push({ label: "IPv4", value: resource.resolvedOutputs["ipv4"] });
        }
        const vcpus = Number(f["vcpus"] ?? 0);
        const memMb = Number(f["memoryMb"] ?? 0);
        if (vcpus > 0) stats.push({ label: "vCPU", value: String(vcpus) });
        if (memMb > 0) {
          stats.push({
            label: "Memory",
            value: `${(memMb / 1024).toFixed(memMb >= 1024 ? 0 : 1)} GB`,
          });
        }
        return stats;
      }
      case "snapshot":
        return [
          { label: "Source", value: String(f["resourceType"] ?? "") },
          ...(f["sizeGb"] ? [{ label: "Size", value: `${f["sizeGb"]} GB` }] : []),
        ];
      case "image":
        return [
          { label: "Type", value: String(f["type"] ?? "") },
          ...(f["distribution"]
            ? [{ label: "Distribution", value: String(f["distribution"]) }]
            : []),
          ...(f["sizeGb"] ? [{ label: "Size", value: `${f["sizeGb"]} GB` }] : []),
        ];
      case "nfs-share":
        return [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: `${String(f["sizeGib"] ?? 0)} GiB` },
          { label: "Tier", value: String(f["performanceTier"] ?? "") },
        ];
      case "volume":
        return [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: `${String(f["sizeGb"] ?? 0)} GB` },
          ...(f["dropletIds"] ? [{ label: "Attached", value: "Yes" }] : []),
        ];
      case "doks-cluster":
        return [
          { label: "Version", value: String(f["version"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Nodes", value: String(f["nodeCount"] ?? 0) },
        ];
      case "managed-database":
        return [
          { label: "Engine", value: String(f["engine"] ?? "") },
          { label: "Version", value: String(f["version"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Nodes", value: String(f["nodeCount"] ?? 1) },
        ];
      case "domain":
        return [{ label: "TTL", value: String(f["ttl"] ?? 1800) }];
      case "dns-record":
        return [
          { label: "Type", value: String(f["type"] ?? "") },
          { label: "Name", value: String(f["name"] ?? "") },
          { label: "Data", value: String(f["data"] ?? "") },
          ...(f["ttl"] != null ? [{ label: "TTL", value: String(f["ttl"]) }] : []),
        ];
      case "project": {
        const stats: DashboardStat[] = [{ label: "Name", value: String(f["name"] ?? "") }];
        if (f["environment"]) stats.push({ label: "Environment", value: String(f["environment"]) });
        if (f["purpose"]) stats.push({ label: "Purpose", value: String(f["purpose"]) });
        return stats;
      }
      case "spaces-bucket":
        return [
          { label: "Name", value: String(f["name"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          ...(f["accessControl"] ? [{ label: "Access", value: String(f["accessControl"]) }] : []),
        ];
      default:
        return [];
    }
  }

  /**
   * Logs tab for managed-databases. DO doesn't expose process logs over the
   * API — only the cluster event stream (creates, scale events, maintenance,
   * power cycles). We surface that as the closest available signal.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: { tailLines?: number },
  ): Promise<{ text: string; containers: string[]; activeContainer: string }> {
    if (typeId !== "managed-database") {
      return { text: "", containers: [], activeContainer: "" };
    }
    const externalId = resourceId.split(":").slice(2).join(":");
    const resp = await this.fetch<{
      events?: Array<{
        id?: string;
        event_type?: string;
        cluster_name?: string;
        create_time?: string;
      }>;
    }>(`/databases/${externalId}/events`);
    const events = resp.events ?? [];
    const tail = params.tailLines ?? 200;
    const lines = events
      .slice(-tail)
      .map(
        (e) =>
          `${e.create_time ?? "?"}  ${e.event_type ?? "unknown"}  ${e.cluster_name ?? ""}  (${e.id ?? ""})`,
      );
    const text =
      lines.length > 0
        ? lines.join("\n") + "\n"
        : "No cluster events yet. DO emits an event for create, scale, maintenance, and power-cycle actions — try again after one of those happens.\n";
    return { text, containers: ["events"], activeContainer: "events" };
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const now = Date.now();
    const startUnix = Math.floor((timeRange?.startMs ?? now - 3_600_000) / 1000);
    const endUnix = Math.floor((timeRange?.endMs ?? now) / 1000);

    interface MonitoringResult {
      values: [number, string][];
    }
    interface MonitoringResponse {
      data: { result: MonitoringResult[] };
    }

    const fetchPromMetric = async (
      path: string,
      label: string,
      unit: string,
    ): Promise<MetricSeries | null> => {
      try {
        const resp = await this.fetch<MonitoringResponse>(path);
        const values = resp.data?.result?.[0]?.values ?? [];
        if (values.length === 0) return null;
        return {
          label,
          unit,
          points: values.map(([ts, val]) => ({
            timestamp: ts * 1000,
            value: Number(val),
          })),
        };
      } catch {
        return null;
      }
    };

    if (resourceTypeId === "droplet") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const dropletId = resource.externalId ?? resourceId.split(":").pop();
      if (!dropletId) return [];
      // Every droplet metric DO exposes — see
      // https://docs.digitalocean.com/reference/api/digitalocean/#tag/Monitoring
      // Bandwidth and filesystem metrics need extra query parameters; the rest
      // share the host_id+start+end shape. Memory/disk/filesystem/load metrics
      // require the DO Metrics Agent to be installed on the droplet — DO will
      // 404 those endpoints for droplets without the agent, which
      // `fetchPromMetric` swallows.
      const droplet: Array<{ name: string; label: string; unit: string; extraQs?: string }> = [
        { name: "cpu", label: "CPU Utilization", unit: "%" },
        { name: "load_1", label: "Load (1m)", unit: "" },
        { name: "load_5", label: "Load (5m)", unit: "" },
        { name: "load_15", label: "Load (15m)", unit: "" },
        { name: "memory_total", label: "Memory Total", unit: "bytes" },
        { name: "memory_available", label: "Memory Available", unit: "bytes" },
        { name: "memory_free", label: "Memory Free", unit: "bytes" },
        { name: "memory_cached", label: "Memory Cached", unit: "bytes" },
        { name: "disk_read", label: "Disk Read", unit: "bytes/s" },
        { name: "disk_write", label: "Disk Write", unit: "bytes/s" },
        { name: "filesystem_size", label: "Filesystem Size", unit: "bytes" },
        { name: "filesystem_free", label: "Filesystem Free", unit: "bytes" },
        {
          name: "bandwidth",
          label: "Public In",
          unit: "bytes/s",
          extraQs: "&interface=public&direction=inbound",
        },
        {
          name: "bandwidth",
          label: "Public Out",
          unit: "bytes/s",
          extraQs: "&interface=public&direction=outbound",
        },
        {
          name: "bandwidth",
          label: "Private In",
          unit: "bytes/s",
          extraQs: "&interface=private&direction=inbound",
        },
        {
          name: "bandwidth",
          label: "Private Out",
          unit: "bytes/s",
          extraQs: "&interface=private&direction=outbound",
        },
      ];
      // Fan out in parallel — 16 metrics serially racks up real wall time.
      const series = await Promise.all(
        droplet.map((m) =>
          fetchPromMetric(
            `/monitoring/metrics/droplet/${m.name}?host_id=${dropletId}&start=${startUnix}&end=${endUnix}${m.extraQs ?? ""}`,
            m.label,
            m.unit,
          ),
        ),
      );
      return series.filter((s): s is MetricSeries => s != null);
    }

    if (resourceTypeId === "doks-cluster") {
      const clusterId = resourceId.split(":").pop();
      if (!clusterId) return [];
      let dropletIds: string[];
      try {
        const cluster = await this.fetch<{
          kubernetes_cluster: {
            node_pools: Array<{ nodes: Array<{ droplet_id?: string }> }>;
          };
        }>(`/kubernetes/clusters/${clusterId}`);
        dropletIds = (cluster.kubernetes_cluster?.node_pools ?? [])
          .flatMap((pool) => pool.nodes ?? [])
          .map((n) => String(n.droplet_id ?? ""))
          .filter((id) => id.length > 0);
      } catch {
        return [];
      }
      if (dropletIds.length === 0) return [];

      // For each metric, fetch per-droplet series and sum (or average) across nodes.
      // CPU is a percentage so average; memory_free is bytes so sum; bandwidth is bytes/sec so sum.
      const metricDefs: Array<{
        name: string;
        label: string;
        unit: string;
        combine: "avg" | "sum";
        extraQs?: string;
      }> = [
        { name: "cpu", label: "CPU Utilization (avg)", unit: "%", combine: "avg" },
        { name: "memory_free", label: "Free Memory (sum)", unit: "bytes", combine: "sum" },
        {
          name: "bandwidth",
          label: "Network In (sum)",
          unit: "bytes/s",
          combine: "sum",
          extraQs: "&interface=public&direction=inbound",
        },
      ];
      const results: MetricSeries[] = [];
      for (const def of metricDefs) {
        const perDroplet = await Promise.all(
          dropletIds.map((id) =>
            fetchPromMetric(
              `/monitoring/metrics/droplet/${def.name}?host_id=${id}&start=${startUnix}&end=${endUnix}${def.extraQs ?? ""}`,
              def.label,
              def.unit,
            ),
          ),
        );
        // Combine: bucket points by timestamp.
        const buckets = new Map<number, number[]>();
        for (const series of perDroplet) {
          if (!series) continue;
          for (const p of series.points) {
            const arr = buckets.get(p.timestamp) ?? [];
            arr.push(p.value);
            buckets.set(p.timestamp, arr);
          }
        }
        if (buckets.size === 0) continue;
        const merged = [...buckets.entries()]
          .sort(([a], [b]) => a - b)
          .map(([timestamp, values]) => ({
            timestamp,
            value:
              def.combine === "avg"
                ? values.reduce((s, v) => s + v, 0) / values.length
                : values.reduce((s, v) => s + v, 0),
          }));
        results.push({ label: def.label, unit: def.unit, points: merged });
      }
      return results;
    }

    if (resourceTypeId === "managed-database") {
      // DO managed-DB monitoring endpoints are engine-scoped:
      // `/v2/monitoring/metrics/database/{engine}/{metric}` with
      // `db_id` + `aggregate` + `start` + `end` query params.
      // Ref: https://docs.digitalocean.com/reference/pydo/reference/monitoring/get_database_mysql_cpu_usage/
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
      const dbId = resource.externalId ?? resourceId.split(":").pop();
      if (!dbId) return [];
      // Engine slug in URL is the full word: "pg" → "postgresql".
      const engineMap: Record<string, string> = {
        pg: "postgresql",
        mysql: "mysql",
        redis: "redis",
        mongodb: "mongodb",
        kafka: "kafka",
        opensearch: "opensearch",
      };
      const engineSlug = engineMap[String(resource.fields["engine"] ?? "")] ?? "";
      if (!engineSlug) return [];
      const qs = `db_id=${dbId}&aggregate=avg&start=${startUnix}&end=${endUnix}`;
      const base = `/monitoring/metrics/database/${engineSlug}`;
      // The four metrics below are the only ones DO documents across all
      // engines. Engine-specific metrics (e.g. mysql/op_rates, redis/cache_hit_rate)
      // exist but aren't surfaced here. fetchPromMetric swallows 404s for the
      // engines that don't publish a given metric, so adding new engines is
      // safe.
      const series = await Promise.all([
        fetchPromMetric(`${base}/cpu_usage?${qs}`, "CPU Utilization", "%"),
        fetchPromMetric(`${base}/memory_usage?${qs}`, "Memory Used", "%"),
        fetchPromMetric(`${base}/disk_usage?${qs}`, "Disk Used", "%"),
        fetchPromMetric(`${base}/load?${qs}`, "Load", ""),
      ]);
      return series.filter((s): s is MetricSeries => s != null);
    }

    if (resourceTypeId === "gen-ai-agent") {
      const agentUuid = resourceId.split(":").slice(2).join(":");
      if (!agentUuid) return [];
      const startIso = new Date(timeRange?.startMs ?? now - 3_600_000).toISOString();
      const stopIso = new Date(timeRange?.endMs ?? now).toISOString();
      try {
        const resp = await this.fetch<{
          usage?: {
            usage?: Array<{
              start?: string;
              end?: string;
              tokens?: number | string;
              input_tokens?: number | string;
              output_tokens?: number | string;
            }>;
            total_tokens?: number | string;
            total_input_tokens?: number | string;
            total_output_tokens?: number | string;
            throughput_tokens_per_second?: number | string;
            latency_seconds?: number | string;
            time_to_first_token_seconds?: number | string;
          };
        }>(
          `/gen-ai/agents/${agentUuid}/usage?start=${encodeURIComponent(startIso)}&stop=${encodeURIComponent(stopIso)}`,
        );
        const usage = resp.usage ?? {};
        const buckets = Array.isArray(usage.usage) ? usage.usage : [];

        // Convert a bucket array to a MetricSeries — DO returns one row per
        // sampling window with `start`/`end` ISO timestamps plus the token
        // counts. Use the window start as the chart x-coordinate.
        const bucketSeries = (
          label: string,
          unit: string,
          pick: (b: (typeof buckets)[number]) => unknown,
        ): MetricSeries | null => {
          const points = buckets
            .map((b) => {
              const ts = Date.parse(String(b.start ?? b.end ?? ""));
              if (!Number.isFinite(ts)) return null;
              const v = Number(pick(b));
              if (!Number.isFinite(v)) return null;
              return { timestamp: ts, value: v };
            })
            .filter((p): p is { timestamp: number; value: number } => p !== null);
          if (points.length === 0) return null;
          return { label, unit, points };
        };

        // For aggregate single-number stats DO returns alongside the bucket
        // series, emit a flat one-point line so the chart still renders.
        const flatSeries = (label: string, unit: string, raw: unknown): MetricSeries | null => {
          const v = Number(raw);
          if (!Number.isFinite(v)) return null;
          return { label, unit, points: [{ timestamp: now, value: v }] };
        };

        const series = [
          bucketSeries("Input tokens", "tokens", (b) => b.input_tokens),
          bucketSeries("Output tokens", "tokens", (b) => b.output_tokens),
          bucketSeries("Total tokens", "tokens", (b) => b.tokens),
          flatSeries("Throughput", "tokens/s", usage.throughput_tokens_per_second),
          flatSeries("Latency (avg)", "s", usage.latency_seconds),
          flatSeries("Time to first token (avg)", "s", usage.time_to_first_token_seconds),
        ].filter((s): s is MetricSeries => s != null);

        // If only the flat totals came back (no buckets), surface the
        // totals as one-point lines so the user sees something.
        if (buckets.length === 0) {
          const totals = [
            flatSeries("Total input tokens", "tokens", usage.total_input_tokens),
            flatSeries("Total output tokens", "tokens", usage.total_output_tokens),
            flatSeries("Total tokens", "tokens", usage.total_tokens),
          ].filter((s): s is MetricSeries => s != null);
          return [...totals, ...series];
        }
        return series;
      } catch {
        // /usage 404s for agents that have never received a request — that's
        // a legitimate empty state, not an error. The host renders an
        // empty-metrics message rather than failing the tab.
        return [];
      }
    }

    return [];
  }

  /**
   * Pre-fetch catalog data the detail page's action prompts need to render
   * pickers instead of raw text inputs (sizes for resize, distribution
   * images + private images for rebuild). Caches both for 30 minutes — the
   * size catalog rarely changes and distribution images only churn on new
   * OS releases. Embedded into resolvedOutputs as JSON so the sync
   * renderDetail can read them without going async.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId === "gen-ai-agent") {
      return this.enrichGenAiAgent(resource);
    }
    if (resource.resourceTypeId !== "droplet") return resource;

    const now = Date.now();
    const CATALOG_TTL_MS = 30 * 60 * 1000;
    const sizesCached = this.dropletCatalogCache.sizes;
    const distrosCached = this.dropletCatalogCache.distributionImages;
    const needSizes = !sizesCached || sizesCached.expiresAt <= now;
    const needDistros = !distrosCached || distrosCached.expiresAt <= now;

    const externalId = resource.externalId ?? resource.id.split(":").pop() ?? "";
    const backupIdsField = String(resource.fields["backupIds"] ?? "");
    const snapshotIdsField = String(resource.fields["snapshotIds"] ?? "");
    const hasBackups = backupIdsField.length > 0;
    const hasSnapshots = snapshotIdsField.length > 0;

    // The user's own snapshots/images are listable resources, but pulling
    // them in via the existing list endpoints would cost a second round
    // through the host's plugin loop on every detail page render. The
    // images endpoint (`/v2/images?private=true`) is the same call and
    // gives us the freshest view, so we fetch it inline alongside the
    // catalog refreshes (uncached — private inventory does change).
    //
    // Per-droplet backups/snapshots: fetched here so the Restore from
    // Backup picker can show "Daily backup • Mar 21 (5 GB)" instead of
    // raw numeric ids. Skipped entirely when the droplet has neither.
    const [sizesRes, distrosRes, privateImagesRes, backupsRes, snapshotsRes] = await Promise.all([
      needSizes
        ? this.fetch<{
            sizes: Array<{
              slug: string;
              memory: number;
              vcpus: number;
              disk: number;
              price_monthly: number;
              available: boolean;
              description: string;
            }>;
          }>("/sizes?per_page=200")
        : Promise.resolve(null),
      needDistros
        ? this.fetch<{
            images: Array<{
              id: number;
              slug: string | null;
              name: string;
              distribution: string;
              status: string;
            }>;
          }>("/images?type=distribution&per_page=200")
        : Promise.resolve(null),
      this.fetch<{
        images: Array<{ id: number; name: string; status: string; type: string }>;
      }>("/images?private=true&per_page=200").catch(() => ({ images: [] })),
      hasBackups && externalId
        ? this.fetch<{
            backups: Array<{
              id: number;
              name: string;
              created_at: string;
              size_gigabytes: number;
              distribution: string;
            }>;
          }>(`/droplets/${externalId}/backups`).catch(() => ({ backups: [] }))
        : Promise.resolve(null),
      hasSnapshots && externalId
        ? this.fetch<{
            snapshots: Array<{
              id: number;
              name: string;
              created_at: string;
              size_gigabytes: number;
              distribution: string;
            }>;
          }>(`/droplets/${externalId}/snapshots`).catch(() => ({ snapshots: [] }))
        : Promise.resolve(null),
    ]);

    if (sizesRes) {
      const sizes: SizeOption[] = sizesRes.sizes
        .filter((s) => s.available)
        .map((s) => ({
          id: s.slug,
          label: s.slug,
          vcpus: s.vcpus,
          memoryMb: s.memory,
          diskGb: s.disk,
          priceMonthly: s.price_monthly,
          category: s.description || "Standard",
        }));
      this.dropletCatalogCache.sizes = { value: sizes, expiresAt: now + CATALOG_TTL_MS };
    }
    if (distrosRes) {
      const distros: ImageOption[] = distrosRes.images
        .filter((i) => i.status === "available")
        .map((i) => ({
          id: i.slug ?? String(i.id),
          label: i.name,
          category: i.distribution,
        }));
      this.dropletCatalogCache.distributionImages = {
        value: distros,
        expiresAt: now + CATALOG_TTL_MS,
      };
    }

    const sizes = this.dropletCatalogCache.sizes?.value ?? [];
    const distros = this.dropletCatalogCache.distributionImages?.value ?? [];
    const privateImages: ImageOption[] = privateImagesRes.images
      .filter((i) => i.status === "available")
      .map((i) => ({
        id: String(i.id),
        label: i.name,
        category: i.type === "snapshot" ? "My Snapshots" : "My Images",
        isOwned: true,
      }));
    const images = [...distros, ...privateImages];

    // Build the restore-picker options list. Each entry carries `id` (the
    // numeric backup/snapshot id DO expects) and a label structured as
    // "{kind icon} {name/date} • {size}". The `select` field kind doesn't
    // support option groups, so the icon prefix is the only way to make
    // backups vs snapshots scannable in the dropdown. Falls back to raw-id
    // labels in the renderer when this fetch failed.
    type RestoreOption = { id: string; label: string; category: "Backups" | "Snapshots" };
    const restoreOptions: RestoreOption[] = [];
    // Newest first — DO returns oldest-first by default and "most recent"
    // is what people scan for when restoring.
    const sortedBackups = [...(backupsRes?.backups ?? [])].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
    const sortedSnapshots = [...(snapshotsRes?.snapshots ?? [])].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
    for (const b of sortedBackups) {
      restoreOptions.push({
        id: String(b.id),
        label: `[Backup] ${formatBackupLabel(b.name, b.created_at)} — ${b.size_gigabytes} GB`,
        category: "Backups",
      });
    }
    for (const s of sortedSnapshots) {
      restoreOptions.push({
        id: String(s.id),
        label: `[Snapshot] ${s.name || `Snapshot ${s.id}`} — ${formatBackupDate(s.created_at)} — ${s.size_gigabytes} GB`,
        category: "Snapshots",
      });
    }

    return {
      ...resource,
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        __sizes__: JSON.stringify(sizes),
        __images__: JSON.stringify(images),
        __restoreOptions__: JSON.stringify(restoreOptions),
      },
    };
  }

  /**
   * Fan out a `GET /v2/gen-ai/agents/{uuid}` to pull attached KBs, function
   * routes, child agents, and other agents (for the "attach child" picker)
   * for the detail view. Failures degrade gracefully — the detail still
   * renders without these sections rather than blanking the page.
   */
  private async enrichGenAiAgent(resource: ResourceInstance): Promise<ResourceInstance> {
    const agentUuid = resource.externalId ?? resource.id.split(":").pop() ?? "";
    if (!agentUuid) return resource;
    const [fullRes, allAgentsRes, allKbsRes, namespacesRes] = await Promise.all([
      this.fetch<{ agent: Record<string, unknown> }>(`/gen-ai/agents/${agentUuid}`).catch(
        () => null,
      ),
      this.fetch<{ agents?: Array<{ uuid?: string; name?: string }> }>(
        "/gen-ai/agents?per_page=200",
      ).catch(() => ({ agents: [] })),
      this.fetch<{ knowledge_bases?: Array<{ uuid?: string; name?: string }> }>(
        "/gen-ai/knowledge_bases?per_page=200",
      ).catch(() => ({ knowledge_bases: [] })),
      // Functions namespaces power the "Add function route" namespace picker.
      // Listing the individual functions within a namespace isn't exposed by
      // the /v2 API (that needs the per-namespace OpenWhisk key), so we only
      // pick the namespace; the function name stays a free-text field.
      this.fetch<{
        namespaces?: Array<{ namespace?: string; label?: string; region?: string }>;
      }>("/functions/namespaces").catch(() => ({ namespaces: [] })),
    ]);
    const a = fullRes?.agent ?? {};
    const kbs = Array.isArray(a["knowledge_bases"])
      ? (a["knowledge_bases"] as Array<Record<string, unknown>>)
      : [];
    const functions = Array.isArray(a["functions"])
      ? (a["functions"] as Array<Record<string, unknown>>)
      : [];
    const childAgents = Array.isArray(a["child_agents"])
      ? (a["child_agents"] as Array<Record<string, unknown>>)
      : [];
    const allAgents = (allAgentsRes.agents ?? []).filter(
      (other) => String(other.uuid ?? "") !== agentUuid,
    );
    const allKbs = allKbsRes.knowledge_bases ?? [];
    // The chatbot identifier + config power the public embed snippet. The
    // identifier lives in `chatbot_identifiers[].agent_chatbot_identifier`.
    const chatbotIdentifiers = Array.isArray(a["chatbot_identifiers"])
      ? (a["chatbot_identifiers"] as Array<Record<string, unknown>>)
      : [];
    const chatbotId = String(chatbotIdentifiers[0]?.["agent_chatbot_identifier"] ?? "");
    const chatbot = (a["chatbot"] ?? {}) as Record<string, unknown>;
    return {
      ...resource,
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        __attachedKbs__: JSON.stringify(kbs.map((k) => ({ uuid: k["uuid"], name: k["name"] }))),
        __functions__: JSON.stringify(
          functions.map((f) => ({
            uuid: f["uuid"],
            function_name: f["function_name"],
            description: f["description"],
            faas_name: f["faas_name"],
            faas_namespace: f["faas_namespace"],
          })),
        ),
        __childAgents__: JSON.stringify(
          childAgents.map((c) => ({
            uuid: c["uuid"],
            name: c["name"],
            route_name: c["route_name"],
            if_case: c["if_case"],
          })),
        ),
        __allAgents__: JSON.stringify(allAgents),
        __allKbs__: JSON.stringify(allKbs),
        __functionNamespaces__: JSON.stringify(
          (namespacesRes.namespaces ?? []).map((n) => ({
            namespace: n.namespace,
            label: n.label,
            region: n.region,
          })),
        ),
        ...(chatbotId ? { __chatbotId__: chatbotId } : {}),
        __chatbot__: JSON.stringify({
          name: String(chatbot["name"] ?? a["name"] ?? ""),
          primary_color: String(chatbot["primary_color"] ?? "#031B4E"),
          secondary_color: String(chatbot["secondary_color"] ?? "#E5E8ED"),
          button_background_color: String(chatbot["button_background_color"] ?? "#0061EB"),
          starting_message: String(chatbot["starting_message"] ?? ""),
          logo: String(chatbot["logo"] ?? ""),
        }),
      },
    };
  }

  /**
   * Build DigitalOcean's embeddable chatbot `<script>` snippet for a public
   * agent. Mirrors what the DO control panel offers under "Embed". Only valid
   * for public agents with a chatbot identifier — the widget script is served
   * from the agent's own deployment host.
   */
  private buildAgentEmbedScript(
    deploymentUrl: string,
    chatbotId: string,
    chatbot: {
      name?: string;
      primary_color?: string;
      secondary_color?: string;
      button_background_color?: string;
      starting_message?: string;
      logo?: string;
    },
    agentUuid: string,
  ): string {
    let origin = deploymentUrl;
    try {
      origin = new URL(deploymentUrl).origin;
    } catch {
      /* fall back to the raw url */
    }
    const attr = (k: string, v: string): string => `  data-${k}="${v.replace(/"/g, "&quot;")}"`;
    const lines = [
      "<script",
      `  src="${origin}/static/chatbot/widget.js"`,
      attr("agent-id", agentUuid),
      attr("chatbot-id", chatbotId),
      attr("name", `${chatbot.name ?? "Agent"} Chatbot`),
      attr("primary-color", chatbot.primary_color ?? "#031B4E"),
      attr("secondary-color", chatbot.secondary_color ?? "#E5E8ED"),
      attr("button-background-color", chatbot.button_background_color ?? "#0061EB"),
      ...(chatbot.starting_message ? [attr("starting-message", chatbot.starting_message)] : []),
      attr("logo", chatbot.logo || "/static/chatbot/icons/default-agent.svg"),
      "  async>",
      "</script>",
    ];
    return lines.join("\n");
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    if (resource.resourceTypeId === "domain") {
      return this.renderDomainDetail(resource);
    }
    if (resource.resourceTypeId === "dns-record") {
      return this.renderDnsRecordDetail(resource);
    }
    const fields = resource.fields;
    const detail: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `${resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId)} \u00B7 ${String(fields["region"] ?? "")}`,
      status: doStatusDot(resource),
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: labeledFieldItems(fields, this.resourceTypes, resource.resourceTypeId),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };

    if (resource.resourceTypeId === "droplet") {
      this.applyDropletDetail(detail, resource);
    } else if (resource.resourceTypeId === "volume") {
      this.applyVolumeDetail(detail, resource);
    } else if (resource.resourceTypeId === "snapshot") {
      this.applySnapshotDetail(detail, resource);
    } else if (resource.resourceTypeId === "image") {
      this.applyImageDetail(detail, resource);
    } else if (resource.resourceTypeId === "nfs-share") {
      this.applyNfsShareDetail(detail, resource);
    }

    if (resource.resourceTypeId === "spaces-bucket") {
      const bucketName = resource.externalId ?? String(fields["name"] ?? resource.displayName);
      detail.storageBrowser = { bucketName };
      detail.bucketPolicyEditor = {
        bucketArn: `arn:aws:s3:::${bucketName}`,
        bucketName,
        vendor: "do-spaces",
      };
    }

    if (resource.resourceTypeId === "managed-database") {
      this.applyManagedDatabaseDetail(detail, resource);
    } else if (resource.resourceTypeId === "db-user") {
      this.applyDatabaseUserDetail(detail, resource);
    } else if (resource.resourceTypeId === "gen-ai-agent") {
      this.applyGenAiAgentDetail(detail, resource);
    }

    return detail;
  }

  /**
   * Adds the events log + a banner that nudges the user to mint a connection
   * user when DO's inline connection.uri lacks a password (the common case
   * for tokens without `database:view_credentials`). The "DB Users" section
   * is rendered automatically by the host as a child-resource group thanks
   * to `db-user.parentTypeId === "managed-database"`.
   */
  private applyManagedDatabaseDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
    const status = String(resource.fields["status"] ?? "");
    const online = status === "online";

    // Events log — DO doesn't expose process-level logs, but the cluster's
    // event stream covers backups, maintenance, scale events, etc. That's
    // useful as a "what's been happening to my cluster" feed.
    detail.logs = { defaultTailLines: 200 };

    // Pre-online clusters can't accept POST /users yet. Inform the user via
    // a non-blocking banner rather than throwing on click.
    if (!online) {
      detail.sections.push({
        kind: "section",
        title: "Connection setup",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              `Cluster status: ${status || "unknown"}. Once it flips to "online" you can mint a ` +
              "connection user under the DB Users section below — Infrawrench captures DO's " +
              "one-shot password and uses it for the peer-pane connection string. Until then, " +
              "the MongoDB / Postgres / MySQL peer-pane tabs will report no credentials.",
          },
        ],
      });
    } else {
      detail.sections.push({
        kind: "section",
        title: "Connection setup",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              "Mint a user under the DB Users section so peer-pane tabs have a credentialed " +
              "connection string. DO only exposes a user's password once — Infrawrench captures " +
              "it at create time and persists it locally.",
          },
        ],
      });
    }
  }

  /** A db-user's detail view is mostly its connection-credential summary. */
  private applyDatabaseUserDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
    detail.subtitle = `Database user · ${String(resource.fields["role"] ?? "user")}`;
    detail.sections.push({
      kind: "section",
      title: "Credential",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "The password DO returned at create time is stored locally and used to fill in the " +
            "cluster's connection string. DO doesn't expose passwords for users it didn't create " +
            "via this flow, so pre-existing users (including `doadmin`) show no stored password.",
        },
      ],
    });
  }

  /**
   * Agent detail page: visibility toggle in the header, attached-resource
   * sections (knowledge bases, function routes, child agents) populated by
   * `enrichGenAiAgent`, and "+ Attach"/"+ Add"/"+ Route" header actions.
   */
  private applyGenAiAgentDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
    const fields = resource.fields;
    const outputs = resource.resolvedOutputs ?? {};

    // Wire the Playground chat tab. Disabled while the deployment is still
    // provisioning — the agents.do-ai.run hostname only resolves once status
    // flips to running.
    const status = String(fields["status"] ?? "").toUpperCase();
    const deploymentReady = status === "STATUS_RUNNING" || status === "RUNNING";
    const modelLabel = String(fields["modelName"] ?? fields["modelRouterName"] ?? "");
    detail.chatPanel = {
      tabLabel: "Playground",
      subtitle: modelLabel ? `Chat with this agent · ${modelLabel}` : "Chat with this agent",
      greeting:
        "Hi! This is the deployed agent — try out a prompt to see how it responds. The full conversation history is sent on each turn.",
      inputPlaceholder: "Send a message…",
      ...(deploymentReady
        ? {}
        : {
            disabledReason:
              "The agent is still deploying. Wait for the status to flip to Running and reload this tab.",
          }),
    };
    const visibility = String(fields["deploymentVisibility"] ?? "");
    const isPublic = visibility === "VISIBILITY_PUBLIC";

    interface AttachedKb {
      uuid?: string;
      name?: string;
    }
    interface AttachedFn {
      uuid?: string;
      function_name?: string;
      description?: string;
      faas_name?: string;
      faas_namespace?: string;
    }
    interface AttachedChild {
      uuid?: string;
      name?: string;
      route_name?: string;
      if_case?: string;
    }
    interface PickerAgent {
      uuid?: string;
      name?: string;
    }
    interface PickerKb {
      uuid?: string;
      name?: string;
    }
    interface FunctionNamespace {
      namespace?: string;
      label?: string;
      region?: string;
    }
    const attachedKbs = parseJsonArray<AttachedKb>(outputs["__attachedKbs__"]);
    const functions = parseJsonArray<AttachedFn>(outputs["__functions__"]);
    const childAgents = parseJsonArray<AttachedChild>(outputs["__childAgents__"]);
    const allAgents = parseJsonArray<PickerAgent>(outputs["__allAgents__"]);
    const allKbs = parseJsonArray<PickerKb>(outputs["__allKbs__"]);
    const functionNamespaces = parseJsonArray<FunctionNamespace>(outputs["__functionNamespaces__"]);
    const namespaceOptions = functionNamespaces
      .filter((n) => n.namespace)
      .map((n) => ({
        id: String(n.namespace),
        label: n.label ? `${n.label} (${n.region ?? "?"})` : String(n.namespace),
      }));

    // Knowledge bases not already attached — used as the picker options
    // for the "Attach knowledge base" prompt.
    const attachedKbUuids = new Set(attachedKbs.map((k) => String(k.uuid ?? "")));
    const unattachedKbs = allKbs.filter((k) => !attachedKbUuids.has(String(k.uuid ?? "")));
    const attachedChildUuids = new Set(childAgents.map((c) => String(c.uuid ?? "")));
    const unattachedAgents = allAgents.filter((a) => !attachedChildUuids.has(String(a.uuid ?? "")));

    // Header — Refresh, visibility toggle, attach buttons. Visibility flips
    // between Public and Private; the label tracks the *current* state so
    // the button always shows the action that will happen.
    detail.headerActions = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: isPublic ? "Make Private" : "Make Public",
        variant: "ghost",
        action: {
          type: "plugin-action",
          actionId: isPublic ? "make-private" : "make-public",
          confirmMessage: isPublic
            ? "Make this agent's endpoint private? Existing public chatbot links will stop working."
            : "Make this agent's endpoint public? Anyone with the URL will be able to chat with it.",
          successMessage: `Endpoint is now ${isPublic ? "Private" : "Public"}.`,
        },
      },
      {
        kind: "action",
        label: "+ Attach knowledge base",
        variant: "ghost",
        action: {
          type: "prompt-nosql-command",
          command: "attach-knowledge-base",
          title: "Attach knowledge base",
          description:
            unattachedKbs.length === 0
              ? "No knowledge bases available to attach. Create one in the Knowledge Bases section first, or drag an existing one onto this agent."
              : "Pick a knowledge base to attach to this agent.",
          ...(unattachedKbs.length === 0
            ? { descriptionVariant: "error" as const, blocked: true }
            : {}),
          fields: [
            {
              key: "knowledgeBaseUuid",
              label: "Knowledge Base",
              kind: "select",
              required: true,
              options: unattachedKbs.map((k) => ({
                id: String(k.uuid ?? ""),
                label: String(k.name ?? k.uuid ?? ""),
              })),
            },
          ],
        },
      },
      {
        kind: "action",
        label: "+ Add function route",
        variant: "ghost",
        action: {
          type: "prompt-nosql-command",
          command: "attach-function",
          title: "Add function route",
          fields: [
            { key: "functionName", label: "Function name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "faasName",
              label: "FaaS function name",
              kind: "text",
              required: true,
              description: "DigitalOcean Functions name (e.g. `weather/lookup`).",
            },
            namespaceOptions.length > 0
              ? {
                  key: "faasNamespace",
                  label: "FaaS namespace",
                  kind: "select" as const,
                  required: true,
                  options: namespaceOptions,
                  ...(namespaceOptions[0] ? { defaultValue: namespaceOptions[0].id } : {}),
                  description: "Pick one of this account's DigitalOcean Functions namespaces.",
                }
              : {
                  key: "faasNamespace",
                  label: "FaaS namespace",
                  kind: "text" as const,
                  required: true,
                  description:
                    "Functions namespace id (fn-…). No namespaces found on this account — create one in DigitalOcean Functions first.",
                },
            {
              key: "inputSchema",
              label: "Input JSON Schema",
              kind: "json-schema",
              required: false,
              description: "Describe the function's arguments as named properties.",
            },
            {
              key: "outputSchema",
              label: "Output JSON Schema",
              kind: "json-schema",
              required: false,
              description: "Describe the function's return value as named properties.",
            },
          ],
        },
      },
      {
        kind: "action",
        label: "+ Route to child agent",
        variant: "ghost",
        action: {
          type: "prompt-nosql-command",
          command: "attach-child-agent",
          title: "Attach child agent",
          description:
            unattachedAgents.length === 0
              ? "No other agents to route to. Create another agent first."
              : "Route this agent's requests to a child agent under specific conditions.",
          ...(unattachedAgents.length === 0
            ? { descriptionVariant: "error" as const, blocked: true }
            : {}),
          fields: [
            {
              key: "childAgentUuid",
              label: "Child agent",
              kind: "select",
              required: true,
              options: unattachedAgents.map((a) => ({
                id: String(a.uuid ?? ""),
                label: String(a.name ?? a.uuid ?? ""),
              })),
            },
            {
              key: "routeName",
              label: "Route name",
              kind: "text",
              required: false,
              description: "Display label for this route — visible to the agent during routing.",
            },
            {
              key: "ifCase",
              label: "If case",
              kind: "text",
              required: false,
              description:
                "Optional condition string the parent agent uses when deciding to route here.",
            },
          ],
        },
      },
    ];

    // Endpoint section — copyable deployment URL + the OpenAI-compatible
    // base URL. Both are `copyable` so the host renders a copy button.
    const deploymentUrl = String(outputs["deploymentUrl"] ?? fields["deploymentUrl"] ?? "");
    if (deploymentUrl) {
      let baseUrl = deploymentUrl;
      try {
        baseUrl = `${new URL(deploymentUrl).origin}/api/v1`;
      } catch {
        baseUrl = `${deploymentUrl.replace(/\/+$/, "")}/api/v1`;
      }
      detail.sections.push({
        kind: "section",
        title: "Endpoint",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Deployment URL", value: deploymentUrl, copyable: true },
              { key: "OpenAI base URL", value: baseUrl, copyable: true },
            ],
          },
        ],
      });
    }

    // Embed section — DigitalOcean's public chatbot <script> snippet. Only
    // valid once the agent's endpoint is public (private agents need an
    // access key the public widget can't supply) and a chatbot identifier
    // exists. Rendered as a copyable mono block.
    const chatbotId = String(outputs["__chatbotId__"] ?? "");
    if (isPublic && chatbotId && deploymentUrl) {
      const chatbot = (() => {
        try {
          return JSON.parse(String(outputs["__chatbot__"] ?? "{}")) as Record<string, string>;
        } catch {
          return {};
        }
      })();
      const agentUuid = resource.externalId ?? resource.id.split(":").pop() ?? "";
      const script = this.buildAgentEmbedScript(deploymentUrl, chatbotId, chatbot, agentUuid);
      detail.sections.push({
        kind: "section",
        title: "Embed (public chatbot)",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              "Drop this snippet into your site's HTML to embed the chatbot widget. Works because the endpoint is public.",
          },
          { kind: "text", variant: "mono", content: script, copyable: true },
        ],
      });
    } else if (chatbotId && deploymentUrl) {
      // Has a chatbot but the endpoint is private — tell the user how to
      // enable the embed rather than silently hiding it.
      detail.sections.push({
        kind: "section",
        title: "Embed (public chatbot)",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              "The embeddable chatbot widget is only available for public endpoints. Use the Make Public header action, then reload to copy the snippet.",
          },
        ],
      });
    }

    // Knowledge bases section — one row per attached KB with an inline
    // Detach button. The detach button reuses prompt-nosql-command so we
    // can confirm before the DELETE.
    if (attachedKbs.length > 0) {
      detail.sections.push({
        kind: "section",
        title: "Knowledge Bases",
        children: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Name" },
              { key: "uuid", label: "UUID", mono: true },
              { key: "action", label: "", width: "narrow" },
            ],
            rows: attachedKbs.map((k) => ({
              cells: {
                name: String(k.name ?? k.uuid ?? ""),
                uuid: String(k.uuid ?? ""),
                action: {
                  kind: "action",
                  label: "Detach",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "detach-knowledge-base",
                    title: "Detach knowledge base",
                    description: `Detach "${k.name ?? k.uuid}" from this agent? The knowledge base itself isn't deleted.`,
                    submitLabel: "Detach",
                    danger: true,
                    fields: [
                      {
                        key: "knowledgeBaseUuid",
                        label: "Knowledge Base UUID",
                        kind: "text",
                        required: true,
                        hidden: true,
                        defaultValue: String(k.uuid ?? ""),
                      },
                    ],
                  },
                } as ActionNode,
              },
            })),
          },
        ],
      });
    } else {
      detail.sections.push({
        kind: "section",
        title: "Knowledge Bases",
        children: [
          {
            kind: "text",
            variant: "muted",
            content:
              "No knowledge bases attached. Drag a knowledge base from the sidebar onto this agent, or use the '+ Attach knowledge base' header action.",
          },
        ],
      });
    }

    // Function routes section.
    if (functions.length > 0) {
      detail.sections.push({
        kind: "section",
        title: "Function Routes",
        children: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Function" },
              { key: "target", label: "FaaS target" },
              { key: "description", label: "Description" },
              { key: "action", label: "", width: "narrow" },
            ],
            rows: functions.map((f) => ({
              cells: {
                name: String(f.function_name ?? f.uuid ?? ""),
                target: `${String(f.faas_namespace ?? "")}/${String(f.faas_name ?? "")}`,
                description: String(f.description ?? ""),
                action: {
                  kind: "action",
                  label: "Detach",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "detach-function",
                    title: "Detach function route",
                    description: `Remove function route "${f.function_name ?? f.uuid}" from this agent?`,
                    submitLabel: "Remove",
                    danger: true,
                    fields: [
                      {
                        key: "functionUuid",
                        label: "Function UUID",
                        kind: "text",
                        required: true,
                        hidden: true,
                        defaultValue: String(f.uuid ?? ""),
                      },
                    ],
                  },
                } as ActionNode,
              },
            })),
          },
        ],
      });
    }

    // Child agents (agent routes) section.
    if (childAgents.length > 0) {
      detail.sections.push({
        kind: "section",
        title: "Agent Routes",
        children: [
          {
            kind: "table",
            columns: [
              { key: "route", label: "Route" },
              { key: "agent", label: "Child agent" },
              { key: "if", label: "If case" },
              { key: "action", label: "", width: "narrow" },
            ],
            rows: childAgents.map((c) => ({
              cells: {
                route: String(c.route_name ?? c.name ?? c.uuid ?? ""),
                agent: String(c.name ?? c.uuid ?? ""),
                if: String(c.if_case ?? ""),
                action: {
                  kind: "action",
                  label: "Detach",
                  variant: "ghost",
                  action: {
                    type: "prompt-nosql-command",
                    command: "detach-child-agent",
                    title: "Detach child agent",
                    description: `Remove route to "${c.name ?? c.uuid}"?`,
                    submitLabel: "Detach",
                    danger: true,
                    fields: [
                      {
                        key: "childAgentUuid",
                        label: "Child Agent UUID",
                        kind: "text",
                        required: true,
                        hidden: true,
                        defaultValue: String(c.uuid ?? ""),
                      },
                    ],
                  },
                } as ActionNode,
              },
            })),
          },
        ],
      });
    }
  }

  /**
   * Add power/lifecycle action buttons + custom tabs (Actions, Backups,
   * Snapshots, Attached Volumes) to a droplet's detail view. State-aware:
   * surfaces "Power On" when the droplet is off and "Power Off" / "Shutdown"
   * when it's running so users don't see no-op buttons.
   */
  private applyDropletDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const isRunning = status === "active";
    const isOff = status === "off";
    const features = String(fields["features"] ?? "").split(",");
    // Backups: prefer `nextBackupStart` / `backupPolicyPlan` over the
    // `features` array — DO sets the policy and the next-window timestamps
    // synchronously with the enable_backups action, but flips the
    // `features` entry on a separate (sometimes-delayed) tick. Using only
    // `features` meant the Enable Backups button stuck around after a
    // successful enable until the lag resolved.
    const backupsEnabled =
      features.includes("backups") ||
      !!String(fields["nextBackupStart"] ?? "") ||
      !!String(fields["backupPolicyPlan"] ?? "");
    // IPv6 is a one-way flip on DO — once enabled, the only signal is the
    // feature flag (and a public-v6 entry in `networks.v6`, which we surface
    // as the `ipv6` resolved output). We hide the Enable IPv6 button once
    // either is set so it doesn't look like the previous click was ignored.
    const ipv6Enabled =
      features.includes("ipv6") || !!String(resource.resolvedOutputs["ipv6"] ?? "");

    // Catalog data populated by enrichDetail. Falls back to empty arrays so
    // the modal still renders if enrichment failed (the picker will show no
    // options rather than the whole detail page crashing).
    const enrichedSizes = parseJsonArray<SizeOption>(resource.resolvedOutputs["__sizes__"]);
    const enrichedImages = parseJsonArray<ImageOption>(resource.resolvedOutputs["__images__"]);
    const currentSizeSlug = String(fields["size"] ?? "");
    const sizeOptions = enrichedSizes.filter((s) => s.id !== currentSizeSlug);

    // Backup/snapshot picker options: prefer the rich, human-readable list
    // populated by enrichDetail (one /v2/droplets/{id}/backups +
    // /v2/droplets/{id}/snapshots round-trip each). Falls back to the raw
    // id strings already in fields when enrichment failed or hasn't run
    // yet, so the picker still works on a slow/offline first paint.
    type RestoreOption = { id: string; label: string; category?: string };
    const enrichedRestore = parseJsonArray<RestoreOption>(
      resource.resolvedOutputs["__restoreOptions__"],
    );
    const backupIds = String(fields["backupIds"] ?? "")
      .split(",")
      .filter(Boolean);
    const snapshotIds = String(fields["snapshotIds"] ?? "")
      .split(",")
      .filter(Boolean);
    const restoreOptions: RestoreOption[] =
      enrichedRestore.length > 0
        ? enrichedRestore
        : [
            ...backupIds.map((id) => ({ id, label: `Backup ${id}`, category: "Backups" })),
            ...snapshotIds.map((id) => ({ id, label: `Snapshot ${id}`, category: "Snapshots" })),
          ];

    // Header lifecycle controls \u2014 keep this list short so the bar doesn't wrap.
    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
    if (isOff) {
      headerActions.push({
        kind: "action",
        label: "Power On",
        action: { type: "plugin-action", actionId: "power_on", successMessage: "Power-on queued." },
      });
    }
    if (isRunning) {
      headerActions.push(
        {
          kind: "action",
          label: "Reboot",
          variant: "ghost",
          action: {
            type: "plugin-action",
            actionId: "reboot",
            confirmMessage: "Reboot this droplet? The OS will be sent a soft reboot signal.",
            successMessage: "Reboot queued.",
          },
        },
        {
          kind: "action",
          label: "Shutdown",
          variant: "ghost",
          action: {
            type: "plugin-action",
            actionId: "shutdown",
            confirmMessage: "Cleanly shut down this droplet?",
            successMessage: "Shutdown queued.",
          },
        },
      );
    }
    headerActions.push({
      kind: "action",
      label: "Take Snapshot",
      variant: "ghost",
      action: {
        type: "plugin-action",
        actionId: "snapshot",
        confirmMessage:
          "Take a snapshot of this droplet now? Snapshots are auto-named with a timestamp and billed at the snapshot storage rate.",
        successMessage: "Snapshot queued.",
      },
    });
    detail.headerActions = headerActions;

    const lifecycleSections: SectionNode[] = [
      {
        kind: "section",
        title: "Power",
        children: [
          {
            kind: "grid",
            columns: 2,
            items: [
              {
                kind: "action",
                label: "Power Cycle (hard restart)",
                variant: "danger",
                action: {
                  type: "plugin-action",
                  actionId: "power_cycle",
                  confirmMessage:
                    "Power-cycle this droplet? Equivalent to pulling the plug \u2014 running processes will not flush state.",
                  successMessage: "Power-cycle queued.",
                },
              },
              {
                kind: "action",
                label: "Power Off (hard)",
                variant: "danger",
                action: {
                  type: "plugin-action",
                  actionId: "power_off",
                  confirmMessage: "Force this droplet off without a clean OS shutdown?",
                  successMessage: "Power-off queued.",
                },
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Snapshot & Image",
        children: [
          {
            kind: "grid",
            columns: 2,
            items: [
              {
                kind: "action",
                label: "Take Named Snapshot\u2026",
                action: {
                  type: "prompt-nosql-command",
                  command: "snapshot-named",
                  title: "Take a snapshot",
                  description:
                    "Snapshots are billed at the snapshot storage rate while they exist. DigitalOcean recommends powering the droplet off first for a consistent snapshot.",
                  fields: [
                    {
                      key: "name",
                      label: "Snapshot Name",
                      kind: "text",
                      required: true,
                      defaultValue: `${String(fields["name"] ?? "droplet")}-${new Date().toISOString().slice(0, 10)}`,
                    },
                  ],
                  submitLabel: "Take Snapshot",
                },
              },
              {
                kind: "action",
                label: "Rebuild from Image\u2026",
                variant: "danger",
                action: {
                  type: "prompt-nosql-command",
                  command: "rebuild",
                  title: "Rebuild droplet",
                  description:
                    "DESTRUCTIVE \u2014 rebuilds the droplet from an image. All data on the boot disk will be erased. The IP address is preserved.",
                  fields: [
                    {
                      key: "image",
                      label: "Image",
                      kind: "image-picker",
                      required: true,
                      images: enrichedImages,
                    },
                  ],
                  submitLabel: "Rebuild",
                  danger: true,
                },
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Configuration",
        children: [
          {
            kind: "grid",
            columns: 2,
            items: [
              {
                kind: "action",
                label: "Rename\u2026",
                action: {
                  type: "prompt-nosql-command",
                  command: "rename",
                  title: "Rename droplet",
                  fields: [
                    {
                      key: "name",
                      label: "New Name",
                      kind: "text",
                      required: true,
                      defaultValue: String(fields["name"] ?? ""),
                    },
                  ],
                  submitLabel: "Rename",
                },
              },
              {
                kind: "action",
                label: "Resize\u2026",
                variant: "danger",
                action: {
                  type: "prompt-nosql-command",
                  command: "resize",
                  title: "Resize droplet",
                  description: `Current size: ${currentSizeSlug || "unknown"}. DigitalOcean powers the droplet down before resizing. Disk resizes are permanent (cannot scale down) \u2014 CPU/RAM-only resizes are reversible.`,
                  fields: [
                    {
                      key: "size",
                      label: "New Size",
                      kind: "size-picker",
                      required: true,
                      sizes: sizeOptions,
                    },
                    {
                      key: "disk",
                      label: "Resize Disk Too?",
                      kind: "select",
                      required: true,
                      defaultValue: "false",
                      options: [
                        { id: "false", label: "No (CPU/RAM only \u2014 reversible)" },
                        { id: "true", label: "Yes (permanent \u2014 cannot scale down later)" },
                      ],
                    },
                  ],
                  submitLabel: "Resize",
                  danger: true,
                },
              },
              ...(ipv6Enabled
                ? []
                : [
                    {
                      kind: "action" as const,
                      label: "Enable IPv6",
                      action: {
                        type: "plugin-action" as const,
                        actionId: "enable_ipv6",
                        confirmMessage: "Enable IPv6 networking on this droplet?",
                        successMessage: "IPv6 enabled.",
                      },
                    },
                  ]),
              {
                kind: "action",
                label: "Reset Root Password",
                variant: "danger",
                action: {
                  type: "plugin-action",
                  actionId: "password_reset",
                  confirmMessage:
                    "Reset the root password? DigitalOcean will email the new password to the account owner.",
                  successMessage: "Password reset queued \u2014 check your DO account email.",
                },
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Backups",
        children: [
          {
            kind: "grid",
            columns: 2,
            items: [
              backupsEnabled
                ? {
                    kind: "action",
                    label: "Disable Backups",
                    variant: "danger",
                    action: {
                      type: "plugin-action",
                      actionId: "disable_backups",
                      confirmMessage:
                        "Disable automatic backups? Existing backup images will be retained for the standard retention period.",
                      successMessage: "Backups disabled.",
                    },
                  }
                : {
                    kind: "action",
                    label: "Enable Backups",
                    action: {
                      type: "plugin-action",
                      actionId: "enable_backups",
                      confirmMessage:
                        "Enable automatic backups? Adds ~20% to the droplet's hourly cost. Default schedule is weekly.",
                      successMessage: "Backups enabled.",
                    },
                  },
              {
                kind: "action",
                label: "Change Backup Policy\u2026",
                action: {
                  type: "prompt-nosql-command",
                  command: "change-backup-policy",
                  title: "Change backup policy",
                  description:
                    "Daily backups have a 4-hour window; weekly backups also pick a weekday.",
                  fields: [
                    {
                      key: "plan",
                      label: "Plan",
                      kind: "select",
                      required: true,
                      defaultValue: "weekly",
                      options: [
                        { id: "daily", label: "Daily" },
                        { id: "weekly", label: "Weekly" },
                      ],
                    },
                    {
                      key: "hour",
                      label: "Hour (UTC)",
                      kind: "select",
                      required: true,
                      defaultValue: "4",
                      options: [
                        { id: "0", label: "00:00" },
                        { id: "4", label: "04:00" },
                        { id: "8", label: "08:00" },
                        { id: "12", label: "12:00" },
                        { id: "16", label: "16:00" },
                        { id: "20", label: "20:00" },
                      ],
                    },
                    {
                      key: "weekday",
                      label: "Weekday",
                      kind: "select",
                      required: false,
                      defaultValue: "SUN",
                      options: [
                        { id: "SUN", label: "Sunday" },
                        { id: "MON", label: "Monday" },
                        { id: "TUE", label: "Tuesday" },
                        { id: "WED", label: "Wednesday" },
                        { id: "THU", label: "Thursday" },
                        { id: "FRI", label: "Friday" },
                        { id: "SAT", label: "Saturday" },
                      ],
                      showWhen: { fieldKey: "plan", fieldValue: "weekly" },
                    },
                  ],
                  submitLabel: "Save Policy",
                },
              },
              ...(restoreOptions.length > 0
                ? [
                    {
                      kind: "action" as const,
                      label: "Restore from Backup\u2026",
                      variant: "danger" as const,
                      action: {
                        type: "prompt-nosql-command" as const,
                        command: "restore",
                        title: "Restore from backup or snapshot",
                        description:
                          "DESTRUCTIVE \u2014 replaces the boot disk with the chosen image. The droplet is powered down during the restore.",
                        fields: [
                          {
                            key: "image",
                            label: "Backup or Snapshot",
                            kind: "select" as const,
                            required: true,
                            options: restoreOptions.map((r) => ({ id: r.id, label: r.label })),
                            description: `${
                              restoreOptions.filter((r) => r.category === "Backups").length
                            } backup(s) and ${
                              restoreOptions.filter((r) => r.category === "Snapshots").length
                            } snapshot(s) available. Newest first.`,
                          },
                        ],
                        submitLabel: "Restore",
                        danger: true,
                      },
                    },
                  ]
                : [
                    // No restore points exist yet \u2014 surface the why and the
                    // next step inline rather than a dead-end modal.
                    {
                      kind: "text" as const,
                      variant: "muted" as const,
                      content: backupsEnabled
                        ? "No restore points yet \u2014 backups are enabled but the first one runs within ~24 hours of enabling. Use Take Named Snapshot above for an immediate restore point."
                        : "No restore points yet \u2014 enable backups below, or use Take Named Snapshot above to create one now.",
                    },
                  ]),
            ],
          },
        ],
      },
    ];

    // Backups/Snapshots/Volumes render as key-value rows with restore/detach
    // actions inline. backupIds/snapshotIds were collected above for the
    // restore picker.
    const volumeIds = String(fields["volumeIds"] ?? "")
      .split(",")
      .filter(Boolean);

    const customTabs: DetailViewSchema["customTabs"] = [
      { id: "actions", label: "Actions", sections: lifecycleSections },
    ];

    // The restore-picker option labels are already formatted as
    // "[Backup] {name} \u2014 {date} \u2014 {size GB}" / "[Snapshot] {name} \u2014 \u2026".
    // Strip the leading "[Kind] " prefix for the pill label since the kind
    // is implied by the containing tab.
    const stripKindPrefix = (label: string): string => label.replace(/^\[[^\]]+\]\s*/, "");
    const backupPillOptions = restoreOptions.filter((r) => r.category === "Backups");
    const snapshotPillOptions = restoreOptions.filter((r) => r.category === "Snapshots");

    if (backupIds.length > 0) {
      const accountId = resource.accountId;
      // Backups aren't first-class resources (no detail page), so the pill
      // can't navigate. Pre-fill the Restore prompt with this backup id so
      // a click is one decision step instead of "open Restore \u2192 find this
      // id in the dropdown".
      const pills =
        backupPillOptions.length > 0
          ? backupPillOptions.map((b) => ({
              kind: "action" as const,
              label: stripKindPrefix(b.label),
              action: {
                type: "prompt-nosql-command" as const,
                command: "restore",
                title: "Restore from this backup",
                description:
                  "DESTRUCTIVE \u2014 replaces the boot disk with this backup image. The droplet is powered down during the restore.",
                fields: [
                  {
                    key: "image",
                    label: "Backup",
                    kind: "select" as const,
                    required: true,
                    options: [{ id: b.id, label: b.label }],
                    defaultValue: b.id,
                  },
                ],
                submitLabel: "Restore",
                danger: true,
              },
            }))
          : // Enrichment hasn't loaded \u2014 fall back to raw-id pills with no
            // metadata so the user at least sees the count match.
            backupIds.map((id) => ({
              kind: "action" as const,
              label: `Backup ${id}`,
              action: {
                type: "prompt-nosql-command" as const,
                command: "restore",
                title: "Restore from this backup",
                description: "DESTRUCTIVE \u2014 replaces the boot disk with this backup image.",
                fields: [
                  {
                    key: "image",
                    label: "Backup ID",
                    kind: "select" as const,
                    required: true,
                    options: [{ id, label: `Backup ${id}` }],
                    defaultValue: id,
                  },
                ],
                submitLabel: "Restore",
                danger: true,
              },
            }));
      void accountId;
      customTabs.push({
        id: "backups",
        label: `Backups (${backupIds.length})`,
        sections: [
          {
            kind: "section",
            title: "Backup images",
            children: [
              { kind: "grid", columns: 2, items: pills },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Backups are kept for the retention window configured on the droplet. Click a backup above to restore from it.",
              },
            ],
          },
        ],
      });
    }

    if (snapshotIds.length > 0) {
      const accountId = resource.accountId;
      // Snapshots ARE resources \u2014 pills navigate to each snapshot's detail
      // page where rename / delete / create-droplet-from live.
      const pills =
        snapshotPillOptions.length > 0
          ? snapshotPillOptions.map((s) => ({
              kind: "action" as const,
              label: stripKindPrefix(s.label),
              action: {
                type: "navigate-to-resource" as const,
                pluginId: "digitalocean",
                resourceTypeId: "snapshot",
                resourceId: `${accountId}:snapshot:${s.id}`,
              },
            }))
          : snapshotIds.map((id) => ({
              kind: "action" as const,
              label: `Snapshot ${id}`,
              action: {
                type: "navigate-to-resource" as const,
                pluginId: "digitalocean",
                resourceTypeId: "snapshot",
                resourceId: `${accountId}:snapshot:${id}`,
              },
            }));
      customTabs.push({
        id: "snapshots",
        label: `Snapshots (${snapshotIds.length})`,
        sections: [
          {
            kind: "section",
            title: "Snapshots taken from this droplet",
            children: [
              { kind: "grid", columns: 2, items: pills },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Click a snapshot to open it \u2014 rename, delete, or create a new droplet from there.",
              },
            ],
          },
        ],
      });
    }

    if (volumeIds.length > 0) {
      const accountId = resource.accountId;
      customTabs.push({
        id: "volumes",
        label: `Volumes (${volumeIds.length})`,
        sections: [
          {
            kind: "section",
            title: "Attached block storage",
            children: [
              {
                kind: "table",
                columns: [
                  { key: "id", label: "Volume ID", mono: true },
                  { key: "open", label: "" },
                ],
                rows: volumeIds.map((id) => ({
                  cells: {
                    id,
                    open: {
                      kind: "action",
                      label: "Open",
                      action: {
                        type: "navigate-to-resource",
                        pluginId: "digitalocean",
                        resourceTypeId: "volume",
                        resourceId: `${accountId}:volume:${id}`,
                      },
                    },
                  },
                })),
              },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Detach from the volume's detail page. Volumes can only be attached to one droplet at a time and must be in the same region.",
              },
            ],
          },
        ],
      });
    }

    detail.customTabs = customTabs;
    detail.metricsCapability = { defaultTimeRangeMs: 60 * 60 * 1000 };
  }

  private applyVolumeDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
    const fields = resource.fields;
    const dropletIds = String(fields["dropletIds"] ?? "")
      .split(",")
      .filter(Boolean);
    const isAttached = dropletIds.length > 0;
    const headerActions: DetailViewSchema["headerActions"] = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: "Take Snapshot\u2026",
        action: {
          type: "prompt-nosql-command",
          command: "volume-snapshot",
          title: "Snapshot volume",
          description:
            "Captures a point-in-time copy of this volume. Snapshots inherit the volume's region but can be used to create volumes in any DO region.",
          fields: [
            {
              key: "name",
              label: "Snapshot Name",
              kind: "text",
              required: true,
              defaultValue: `${String(fields["name"] ?? "vol")}-${new Date().toISOString().slice(0, 10)}`,
            },
          ],
          submitLabel: "Snapshot",
        },
      },
      {
        kind: "action",
        label: "Resize\u2026",
        action: {
          type: "prompt-nosql-command",
          command: "volume-resize",
          title: "Resize volume",
          description:
            "Block storage volumes can only grow \u2014 DigitalOcean does not support shrinking. The filesystem may need a manual `resize2fs` / `xfs_growfs` call after.",
          fields: [
            {
              key: "sizeGb",
              label: "New Size (GiB)",
              kind: "number",
              required: true,
              defaultValue: String(fields["sizeGb"] ?? "100"),
              description: "Must be greater than the current size.",
            },
          ],
          submitLabel: "Resize",
        },
      },
    ];
    if (isAttached) {
      headerActions.push({
        kind: "action",
        label: "Detach",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "detach",
          confirmMessage: `Detach this volume from droplet ${dropletIds[0]}? Make sure the filesystem is unmounted first.`,
          successMessage: "Detach queued.",
        },
      });
    }
    detail.headerActions = headerActions;
  }

  private applySnapshotDetail(detail: DetailViewSchema, _resource: ResourceInstance): void {
    detail.headerActions = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
  }

  private applyImageDetail(detail: DetailViewSchema, _resource: ResourceInstance): void {
    detail.headerActions = [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ];
  }

  private applyNfsShareDetail(detail: DetailViewSchema, resource: ResourceInstance): void {
    const fields = resource.fields;
    const mountTarget = String(
      resource.resolvedOutputs["mountTarget"] ?? fields["mountTarget"] ?? "",
    );
    const mountCmd = String(resource.resolvedOutputs["mountCommand"] ?? "");
    if (mountTarget || mountCmd) {
      detail.sections.push({
        kind: "section",
        title: "Mount",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "NFS Server", value: mountTarget, copyable: true },
              ...(mountCmd ? [{ key: "Mount Command", value: mountCmd, copyable: true }] : []),
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "The mount target is only reachable from droplets and DOKS nodes in a VPC listed on this share. NFSv4.1 only.",
          },
        ],
      });
    }
  }

  private renderDomainDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Domain Info",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Domain", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Default TTL", value: formatDnsTtl(Number(fields["ttl"] ?? 0)) },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Nameservers",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "NS 1", value: "ns1.digitalocean.com", copyable: true },
              { key: "NS 2", value: "ns2.digitalocean.com", copyable: true },
              { key: "NS 3", value: "ns3.digitalocean.com", copyable: true },
            ],
          },
          {
            kind: "text",
            content: "Point your domain registrar to these nameservers to use DigitalOcean DNS.",
            variant: "muted",
          },
        ],
      },
    ];
    return {
      title: resource.displayName,
      subtitle: "DNS Domain",
      status: { kind: "status-dot", status: "healthy", label: "Active" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDnsRecordDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const extraInfoItems: Array<{ key: string; value: string; copyable?: boolean }> = [];
    if (fields["port"] !== undefined) {
      extraInfoItems.push({ key: "Port", value: String(fields["port"]) });
    }
    if (fields["weight"] !== undefined) {
      extraInfoItems.push({ key: "Weight", value: String(fields["weight"]) });
    }
    if (fields["tag"]) {
      extraInfoItems.push({ key: "Tag", value: String(fields["tag"]) });
    }
    const opts = extraInfoItems.length > 0 ? { extraInfoItems } : {};
    return sharedRenderDnsRecordDetail(resource, opts);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "dns-record") {
      return renderDnsRecordSidebar(resource);
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: doStatusDot(resource),
    };
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ projects?: Array<Record<string, unknown>> | null }>(
      "/projects",
    );
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

  private async listDroplets(accountId: string): Promise<ResourceInstance[]> {
    // DO's /droplets default page size is 20 — without per_page, a freshly-
    // created droplet on page 2 looks like it doesn't exist.
    const [data, projectMap] = await Promise.all([
      this.fetch<{ droplets?: Array<Record<string, unknown>> | null }>("/droplets?per_page=200"),
      this.getProjectUrnMap(),
    ]);
    return (data.droplets ?? []).map((d) => this.mapDroplet(d, accountId, projectMap));
  }

  /**
   * Shape a single DO /droplets element into a `ResourceInstance`. Shared
   * between the list path and the single-resource `getResource` path so the
   * post-create detail page (which uses GET /v2/droplets/{id} to avoid a
   * race with the list endpoint) produces identical fields/outputs.
   */
  private mapDroplet(
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
    const parentResourceId = this.parentResourceIdForUrn(
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

  private async listSnapshots(accountId: string): Promise<ResourceInstance[]> {
    // /v2/snapshots aggregates both droplet and volume snapshots. resource_type
    // disambiguates; resource_id points to the originating droplet (number) or
    // volume (uuid).
    const data = await this.fetch<{
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

  private async listImages(accountId: string): Promise<ResourceInstance[]> {
    // Surface user-owned images by default (snapshots, backups, custom uploads).
    // Distribution + application marketplace images are noisy in a sidebar and
    // already exposed in the droplet create form via getCreateConfig.
    const data = await this.fetch<{
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

  private async listNfsShares(accountId: string): Promise<ResourceInstance[]> {
    // The NFS API is region-scoped but listing without a region returns shares
    // from every region the account has any in. DO encodes the region in each
    // share's response so we don't have to fan-out by region for listing.
    let shares: Array<Record<string, unknown>> = [];
    try {
      const data = await this.fetch<{ nfs?: Array<Record<string, unknown>> }>("/nfs?per_page=200");
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

  private async listDOKSClusters(accountId: string): Promise<ResourceInstance[]> {
    const [data, projectMap] = await Promise.all([
      this.fetch<{ kubernetes_clusters?: Array<Record<string, unknown>> | null }>(
        "/kubernetes/clusters",
      ),
      this.getProjectUrnMap(),
    ]);
    return (data.kubernetes_clusters ?? []).map((c) => {
      const nodePool = (c["node_pools"] as Array<Record<string, unknown>> | undefined)?.[0];
      const parentResourceId = this.parentResourceIdForUrn(
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

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    // DO returns `{ "databases": null }` for accounts that have never had
    // one (instead of an empty array), which made `.map` throw and the
    // account section render "Cannot read properties of null".
    const [data, projectMap] = await Promise.all([
      this.fetch<{ databases?: Array<Record<string, unknown>> | null }>("/databases"),
      this.getProjectUrnMap(),
    ]);
    return (data.databases ?? []).map((db) => {
      const parentResourceId = this.parentResourceIdForUrn(
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
  private async listDatabaseUsers(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ databases?: Array<Record<string, unknown>> | null }>(
      "/databases",
    );
    const clusters = data.databases ?? [];
    const userLists = await Promise.allSettled(
      clusters.map(async (db) => {
        const clusterId = String(db["id"] ?? "");
        if (!clusterId) return [] as ResourceInstance[];
        const resp = await this.fetch<{
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

  private async listSpacesBuckets(accountId: string): Promise<ResourceInstance[]> {
    const accessKeyId = this.credentials["spacesAccessKeyId"];
    const secretAccessKey = this.credentials["spacesSecretAccessKey"];
    if (!accessKeyId || !secretAccessKey) return [];

    const projectMap = await this.getProjectUrnMap();

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
      this.spacesBucketRegions.set(name, region);
      const parentResourceId = this.parentResourceIdForUrn(
        accountId,
        `do:space:${name}`,
        projectMap,
      );
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

  private async listDomains(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ domains: Array<Record<string, unknown>> }>("/domains");
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

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    const domains = await this.listDomains(accountId);
    const results: ResourceInstance[] = [];
    for (const domain of domains) {
      const domainName = String(domain.fields["name"]);
      try {
        const data = await this.fetch<{
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

  private async listVolumes(accountId: string): Promise<ResourceInstance[]> {
    const [data, projectMap] = await Promise.all([
      this.fetch<{ volumes: Array<Record<string, unknown>> }>("/volumes?per_page=200"),
      this.getProjectUrnMap(),
    ]);
    return (data.volumes ?? []).map((v) => {
      const parentResourceId = this.parentResourceIdForUrn(
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
          dropletIds: Array.isArray(v["droplet_ids"])
            ? (v["droplet_ids"] as number[]).join(",")
            : "",
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

  // ── Spaces (S3-compatible) storage browser ──────────────────────────────

  private async getSpacesConfig(bucket: string): Promise<S3StorageConfig> {
    const accessKey = this.credentials["spacesAccessKeyId"];
    const secretKey = this.credentials["spacesSecretAccessKey"];
    if (!accessKey || !secretKey) {
      throw new Error(
        "DigitalOcean plugin: Spaces storage requires S3-compatible credentials " +
          '("spacesAccessKeyId" and "spacesSecretAccessKey"). ' +
          "Generate these in the DigitalOcean console under API > Spaces Keys.",
      );
    }
    let region = this.spacesBucketRegions.get(bucket);
    if (!region) {
      // Cold cache: a list against any region returns 301 with the home region
      // in the `x-amz-bucket-region` header. The signing region doesn't have to
      // match the bucket region for this probe — S3 surfaces the redirect for
      // any signed GET on the bucket root.
      const probeRegion = SPACES_REGIONS[0] ?? "nyc3";
      const probeHost = `${bucket}.${probeRegion}.digitaloceanspaces.com`;
      const res = await signedS3Fetch({
        accessKey,
        secretKey,
        region: probeRegion,
        method: "HEAD",
        url: `https://${probeHost}/`,
      });
      const reported = res.headers.get("x-amz-bucket-region");
      region = reported || probeRegion;
      this.spacesBucketRegions.set(bucket, region);
    }
    return {
      accessKey,
      secretKey,
      region,
      buildUrl: virtualHostedUrl((r) => `${r}.digitaloceanspaces.com`)(region),
    };
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const cfg = await this.getSpacesConfig(bucket);
    return listS3Objects(cfg, bucket, prefix);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const cfg = await this.getSpacesConfig(bucket);
    return uploadS3Object(cfg, bucket, key, file);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const cfg = await this.getSpacesConfig(bucket);
    return makeS3Folder(cfg, bucket, key);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const cfg = await this.getSpacesConfig(bucket);
    return deleteS3Object(cfg, bucket, key);
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "spaces-bucket") {
      throw new Error(`DigitalOcean plugin: getManifest not supported for type "${typeId}"`);
    }
    const bucket = parts.slice(2).join(":");
    const cfg = await this.getSpacesConfig(bucket);
    const raw = await getS3BucketPolicy(cfg, bucket);
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";
    if (typeId !== "spaces-bucket") {
      throw new Error(`DigitalOcean plugin: applyManifest not supported for type "${typeId}"`);
    }
    const bucket = parts.slice(2).join(":");
    const cfg = await this.getSpacesConfig(bucket);
    return putS3BucketPolicy(cfg, bucket, manifest);
  }

  // Satisfy the required fields from DOKSClusterResourceType and ManagedDatabaseResourceType
  // so TypeScript knows they are used
  static readonly _resourceTypes = [
    DOKSClusterResourceType,
    ManagedDatabaseResourceType,
    SnapshotResourceType,
    ImageResourceType,
    NfsShareResourceType,
  ];
}
