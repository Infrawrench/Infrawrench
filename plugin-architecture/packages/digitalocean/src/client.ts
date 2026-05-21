import type {
  PluginClient,
  ResourceCreateResult,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SectionNode,
  ResourceTypeDefinition,
  DashboardStat,
  MetricSeries,
  CredentialExport,
  StatusDotNode,
  SizeOption,
  ImageOption,
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
import { type DoCreateContext, doGetCreateConfig, doCreateResource } from "./create-handlers.js";
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
function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
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

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("DigitalOcean plugin: missing apiToken credential");
    this.token = token;
    this.credentials = credentials;
    this.resourceTypes = resourceTypes;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "DO",
      url: `${this.baseUrl}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.token}` },
      ...(options ? { init: options } : {}),
    });
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
      default:
        throw new Error(`DigitalOcean plugin: unknown resource type "${typeId}"`);
    }
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
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`DigitalOcean plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    if (typeId === "doks-cluster" && outputKey === "kubeconfig") {
      const data = await this.fetch<{ kubeconfig: string }>(
        `/kubernetes/clusters/${resourceId}/kubeconfig`,
      );
      return data.kubeconfig;
    }

    if (typeId === "managed-database") {
      const data = await this.fetch<{
        database: {
          connection: Record<string, string>;
          private_connection?: Record<string, string>;
        };
      }>(`/databases/${resourceId}`);
      const conn = data.database.connection;
      switch (outputKey) {
        case "connectionString":
          return conn["uri"] ?? "";
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
          const caData = await this.fetch<{ ca: { certificate: string } }>(
            `/databases/${resourceId}/ca`,
          );
          return caData.ca.certificate;
        }
      }
    }

    if (typeId === "spaces-bucket") {
      // Spaces credentials are account-level (from the Spaces API keys), not bucket-specific
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, _accountId);
        const region = String(resource.fields["region"] ?? "nyc3");
        return `https://${region}.digitaloceanspaces.com`;
      }
      if (outputKey === "accessKeyId") return this.credentials["spacesAccessKeyId"] ?? "";
      if (outputKey === "secretAccessKey") return this.credentials["spacesSecretAccessKey"] ?? "";
    }

    if (typeId === "domain" && outputKey === "nameservers") {
      return "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com";
    }

    throw new Error(
      `DigitalOcean plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
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
      }>("/v2/spaces/keys", {
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
    throw new Error(`DigitalOcean plugin: executeNoSqlCommand not supported for type "${typeId}"`);
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
      // The DO managed-DB monitoring endpoints are engine-scoped and use the
      // pattern `/v2/monitoring/metrics/database/{engine}/{metric}` with
      // `db_id` + `aggregate` + `start` + `end` as query params. The earlier
      // implementation used `/database/{metric}?cluster_uuid=...` which
      // doesn't exist — the API responded 404 and we silently returned
      // nothing.
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
      status:
        resource.resourceTypeId === "droplet"
          ? dropletStatusDot(String(fields["status"] ?? ""))
          : { kind: "status-dot", status: "info" },
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

    // MongoDB-engined managed databases get the inline MongoDB peer browser \u2014
    // user links one of their MongoDB accounts and browses documents in place.
    if (
      resource.resourceTypeId === "managed-database" &&
      String(fields["engine"] ?? "") === "mongodb"
    ) {
      detail.noSqlBrowser = {
        driver: "mongodb-peer",
        databaseLabel: String(fields["name"] ?? resource.externalId ?? ""),
        helpText:
          "Link a MongoDB account in your sidebar to browse this database inline. The account must be reachable from your network \u2014 for trusted-sources-only clusters, connect from inside the VPC.",
      };
    }

    return detail;
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

    // === Actions tab \u2014 every droplet lifecycle action that isn't on the bar.
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

    // === Backups, Snapshots, Volumes \u2014 referenced from the fields we pulled
    // out of the listDroplets response. Each id renders as a key-value row with
    // its own restore/detach action so users can act without navigating away.
    // (backupIds/snapshotIds were already collected above for the restore picker.)
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
    if (resource.resourceTypeId === "domain") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: "healthy", label: "Active" },
      };
    }
    if (resource.resourceTypeId === "droplet") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: dropletStatusDot(String(resource.fields["status"] ?? "")),
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ projects: Array<Record<string, unknown>> }>("/projects");
    return data.projects.map((p) => ({
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
      this.fetch<{ droplets: Array<Record<string, unknown>> }>("/droplets?per_page=200"),
      this.getProjectUrnMap(),
    ]);
    return data.droplets.map((d) => this.mapDroplet(d, accountId, projectMap));
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
      this.fetch<{ kubernetes_clusters: Array<Record<string, unknown>> }>("/kubernetes/clusters"),
      this.getProjectUrnMap(),
    ]);
    return data.kubernetes_clusters.map((c) => {
      const nodePool = (c["node_pools"] as Array<Record<string, unknown>> | undefined)?.[0];
      const parentResourceId = this.parentResourceIdForUrn(
        accountId,
        `do:kubernetes:${String(c["id"])}`,
        projectMap,
      );
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
    const [data, projectMap] = await Promise.all([
      this.fetch<{ databases: Array<Record<string, unknown>> }>("/databases"),
      this.getProjectUrnMap(),
    ]);
    return data.databases.map((db) => {
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

  private async listSpacesBuckets(accountId: string): Promise<ResourceInstance[]> {
    const accessKeyId = this.credentials["spacesAccessKeyId"];
    const secretAccessKey = this.credentials["spacesSecretAccessKey"];
    if (!accessKeyId || !secretAccessKey) return [];

    const projectMap = await this.getProjectUrnMap();

    const perRegion = await Promise.all(
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
          throw new Error(
            `Spaces S3 API error ${res.status} listing buckets in ${region}: ${await res.text()}`,
          );
        }
        const xml = await res.text();
        const entries = [
          ...xml.matchAll(
            /<Bucket>\s*<Name>([^<]+)<\/Name>\s*<CreationDate>([^<]+)<\/CreationDate>\s*<\/Bucket>/g,
          ),
        ];
        return entries.map(([, name, createdAt]) => ({ name, createdAt, region }));
      }),
    );

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
