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
  HostServices,
} from "@infrawrench/plugin-base";
import {
  dnsRecordBadgeColor,
  formatDnsTtl,
  jsonRestFetch,
  labeledFieldItems,
  resourceTypeDisplayName,
  renderDnsRecordDetail as sharedRenderDnsRecordDetail,
  renderDnsRecordSidebar,
  signedS3Fetch,
} from "@infrawrench/plugin-base";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { SPACES_REGIONS } from "./constants.js";
import { type DoCreateContext, doGetCreateConfig, doCreateResource } from "./create-handlers.js";

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
  private readonly caCert: string;
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
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "DO",
      url: `${this.baseUrl}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.token}` },
      ...(options ? { init: options } : {}),
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
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
      default:
        throw new Error(`DigitalOcean plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
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
      default:
        throw new Error(`DigitalOcean plugin: deleteResource not supported for type "${typeId}"`);
    }
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

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "droplet":
        return [
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Size", value: String(f["size"] ?? "") },
          ...(resource.resolvedOutputs["ipv4"]
            ? [{ label: "IPv4", value: resource.resolvedOutputs["ipv4"] }]
            : []),
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
      const metricDefs: Array<{ name: string; label: string; unit: string }> = [
        { name: "cpu", label: "CPU Utilization", unit: "%" },
        { name: "memory_free", label: "Free Memory", unit: "bytes" },
        { name: "bandwidth", label: "Public Inbound Bandwidth", unit: "bytes/sec" },
      ];
      const results: MetricSeries[] = [];
      for (const metric of metricDefs) {
        const basePath = `/monitoring/metrics/droplet/${metric.name}?host_id=${dropletId}&start=${startUnix}&end=${endUnix}`;
        const path =
          metric.name === "bandwidth" ? `${basePath}&interface=public&direction=inbound` : basePath;
        const series = await fetchPromMetric(path, metric.label, metric.unit);
        if (series) results.push(series);
      }
      return results;
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
      status: { kind: "status-dot", status: "info" },
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
    const data = await this.fetch<{ droplets: Array<Record<string, unknown>> }>("/droplets");
    return data.droplets.map((d) => ({
      id: `${accountId}:droplet:${String(d["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        region: String((d["region"] as Record<string, unknown>)?.["slug"] ?? ""),
        size: String((d["size"] as Record<string, unknown>)?.["slug"] ?? ""),
        image: String((d["image"] as Record<string, unknown>)?.["slug"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(d["id"]),
      createdAt: String(d["created_at"] ?? new Date().toISOString()),
      updatedAt: String(d["created_at"] ?? new Date().toISOString()),
    }));
  }

  private async listDOKSClusters(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{
      kubernetes_clusters: Array<Record<string, unknown>>;
    }>("/kubernetes/clusters");
    return data.kubernetes_clusters.map((c) => {
      const nodePool = (c["node_pools"] as Array<Record<string, unknown>> | undefined)?.[0];
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
        createdAt: String(c["created_at"] ?? new Date().toISOString()),
        updatedAt: String(c["updated_at"] ?? new Date().toISOString()),
      };
    });
  }

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{
      databases: Array<Record<string, unknown>>;
    }>("/databases");
    return data.databases.map((db) => ({
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
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: String(db["created_at"] ?? new Date().toISOString()),
    }));
  }

  private async listSpacesBuckets(accountId: string): Promise<ResourceInstance[]> {
    const accessKeyId = this.credentials["spacesAccessKeyId"];
    const secretAccessKey = this.credentials["spacesSecretAccessKey"];
    if (!accessKeyId || !secretAccessKey) return [];

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
    const data = await this.fetch<{ volumes: Array<Record<string, unknown>> }>(
      "/volumes?per_page=200",
    );
    return (data.volumes ?? []).map((v) => ({
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
      createdAt: String(v["created_at"] ?? new Date().toISOString()),
      updatedAt: String(v["created_at"] ?? new Date().toISOString()),
    }));
  }

  // Satisfy the required fields from DOKSClusterResourceType and ManagedDatabaseResourceType
  // so TypeScript knows they are used
  static readonly _resourceTypes = [DOKSClusterResourceType, ManagedDatabaseResourceType];
}
