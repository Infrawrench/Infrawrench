import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  ResourceStatus,
  ResourceTypeDefinition,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { jsonRestFetch, labeledFieldItems } from "@infrawrench/plugin-base";

/**
 * Scaleway plugin client.
 * Created per account (per secret key) by the host.
 */
export class ScalewayClient implements PluginClient {
  private readonly secretKey: string;
  private readonly accessKey: string;
  private readonly defaultProjectId: string;
  private readonly credentials: Record<string, string>;
  private readonly resourceTypes: ResourceTypeDefinition[];

  private static readonly ZONE_INFO: Record<
    string,
    { region: string; location: string; flag: string }
  > = {
    "fr-par-1": { region: "fr-par", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "fr-par-2": { region: "fr-par", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "fr-par-3": { region: "fr-par", location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "nl-ams-1": {
      region: "nl-ams",
      location: "Amsterdam, Netherlands",
      flag: "\u{1F1F3}\u{1F1F1}",
    },
    "nl-ams-2": {
      region: "nl-ams",
      location: "Amsterdam, Netherlands",
      flag: "\u{1F1F3}\u{1F1F1}",
    },
    "nl-ams-3": {
      region: "nl-ams",
      location: "Amsterdam, Netherlands",
      flag: "\u{1F1F3}\u{1F1F1}",
    },
    "pl-waw-1": { region: "pl-waw", location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
    "pl-waw-2": { region: "pl-waw", location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
    "pl-waw-3": { region: "pl-waw", location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  };

  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    "fr-par": { location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
    "nl-ams": { location: "Amsterdam, Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
    "pl-waw": { location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  };

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    const secretKey = credentials["secretKey"];
    if (!secretKey) throw new Error("Scaleway plugin: missing secretKey credential");
    this.secretKey = secretKey;
    this.accessKey = credentials["accessKey"] ?? "";
    this.defaultProjectId = credentials["defaultProjectId"] ?? "";
    this.credentials = credentials;
    this.resourceTypes = resourceTypes;
  }

  private assertS3Credentials(): void {
    if (!this.accessKey) {
      throw new Error(
        "Scaleway plugin: Object Storage operations require an Access Key. " +
          "Please add your Scaleway Access Key (SCW...) in the account credentials.",
      );
    }
  }

  /**
   * Perform an S3-compatible request signed with AWS Signature V4.
   * Only SHA-256 via WebCrypto is used so it works in Node 18+ and browsers.
   */
  private async s3Fetch<T>(
    method: string,
    host: string,
    path: string,
    region: string,
    parseXml?: (text: string) => T,
  ): Promise<T> {
    this.assertS3Credentials();

    const url = `https://${host}${path}`;
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z"); // 20260415T120000Z
    const dateStamp = amzDate.slice(0, 8); // 20260415

    const service = "s3";
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

    const payloadHash = await this.sha256Hex("");
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    // Canonical request
    const signedHeaderKeys = Object.keys(headers).sort();
    const signedHeaders = signedHeaderKeys.join(";");
    const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
    const canonicalRequest = [
      method,
      path || "/",
      "", // query string (none)
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await this.sha256Hex(canonicalRequest),
    ].join("\n");

    // Signing key
    const kDate = await this.hmacSha256(
      new TextEncoder().encode("AWS4" + this.secretKey),
      dateStamp,
    );
    const kRegion = await this.hmacSha256(kDate, region);
    const kService = await this.hmacSha256(kRegion, service);
    const signingKey = await this.hmacSha256(kService, "aws4_request");

    const signature = await this.hmacSha256Hex(signingKey, stringToSign);

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        Authorization: authorization,
      },
    });

    if (!res.ok) {
      throw new Error(`Scaleway S3 error ${res.status} for ${method} ${url}: ${await res.text()}`);
    }
    if (res.status === 204 || !parseXml) return undefined as unknown as T;
    const text = await res.text();
    return parseXml(text);
  }

  private async sha256Hex(data: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    return this.bufToHex(hash);
  }

  private async hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  }

  private async hmacSha256Hex(key: BufferSource, data: string): Promise<string> {
    return this.bufToHex(await this.hmacSha256(key, data));
  }

  private bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Scaleway",
      url,
      headers: { "X-Auth-Token": this.secretKey },
      ...(options ? { init: options } : {}),
    });
  }

  private instanceUrl(zone: string, path: string): string {
    return `https://api.scaleway.com/instance/v1/zones/${zone}${path}`;
  }

  private k8sUrl(region: string, path: string): string {
    return `https://api.scaleway.com/k8s/v1/regions/${region}${path}`;
  }

  private rdbUrl(region: string, path: string): string {
    return `https://api.scaleway.com/rdb/v1/regions/${region}${path}`;
  }

  private blockUrl(zone: string, path: string): string {
    return `https://api.scaleway.com/block/v1/zones/${zone}${path}`;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "instance":
        return this.listInstances(accountId);
      case "kapsule-cluster":
        return this.listKapsuleClusters(accountId);
      case "rdb-instance":
        return this.listManagedDatabases(accountId);
      case "object-storage-bucket":
        return this.listObjectStorageBuckets(accountId);
      case "block-volume":
        return this.listBlockVolumes(accountId);
      default:
        throw new Error(`Scaleway plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Scaleway plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "kapsule-cluster" && outputKey === "kubeconfig") {
      const externalId = resourceId.split(":").pop()!;
      // externalId format: {region}/{clusterId}
      const parts = externalId.split("/");
      const region = parts[0]!;
      const clusterId = parts[1]!;
      const data = await this.apiFetch<{ content: string }>(
        this.k8sUrl(region, `/clusters/${clusterId}/kubeconfig`),
      );
      // Scaleway returns base64-encoded kubeconfig content
      return typeof data.content === "string" ? atob(data.content) : "";
    }

    if (typeId === "rdb-instance") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]!;
      const instanceId = parts[1]!;
      const data = await this.apiFetch<{
        endpoints: Array<{ ip: string; port: number; name?: string }>;
        engine: string;
      }>(this.rdbUrl(region, `/instances/${instanceId}`));
      const endpoint = data.endpoints?.[0];
      switch (outputKey) {
        case "host":
          return endpoint?.ip ?? "";
        case "port":
          return String(endpoint?.port ?? "");
        case "username":
          return ""; // User needs to look up users from the RDB API
        case "password":
          return ""; // Password is only shown at creation time
        case "dbName":
          return "rdb"; // Default database name
      }
    }

    if (typeId === "object-storage-bucket") {
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        const region = String(resource.fields["region"] ?? "fr-par");
        return `https://s3.${region}.scw.cloud`;
      }
      if (outputKey === "accessKeyId") return this.accessKey;
      if (outputKey === "secretAccessKey") return this.secretKey;
    }

    throw new Error(`Scaleway plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "instance") {
      return this.getInstanceCreateConfig();
    }

    if (typeId === "kapsule-cluster") {
      return this.getKapsuleCreateConfig();
    }

    if (typeId === "rdb-instance") {
      return {
        fields: [
          { key: "name", label: "Instance Name", kind: "text", required: true },
          {
            key: "engine",
            label: "Engine",
            kind: "select",
            required: true,
            options: [
              { id: "PostgreSQL-16", label: "PostgreSQL 16" },
              { id: "PostgreSQL-15", label: "PostgreSQL 15" },
              { id: "MySQL-8", label: "MySQL 8" },
            ],
            defaultValue: "PostgreSQL-16",
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
              id,
              label: id,
              location: info.location,
              flag: info.flag,
            })),
            defaultValue: "fr-par",
          },
          {
            key: "nodeType",
            label: "Node Type",
            kind: "text",
            required: true,
            defaultValue: "DB-DEV-S",
            description: "e.g. DB-DEV-S, DB-GP-XS",
          },
          {
            key: "isHaCluster",
            label: "High Availability",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "Standalone" },
              { id: "true", label: "HA Cluster" },
            ],
            defaultValue: "false",
          },
          {
            key: "disableBackup",
            label: "Backups",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "Enabled" },
              { id: "true", label: "Disabled" },
            ],
            defaultValue: "false",
          },
          {
            key: "userName",
            label: "Admin Username",
            kind: "text",
            required: true,
            defaultValue: "admin",
          },
          { key: "password", label: "Admin Password", kind: "text", required: true },
        ],
      };
    }

    if (typeId === "object-storage-bucket") {
      return {
        fields: [
          { key: "name", label: "Bucket Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
              id,
              label: id,
              location: info.location,
              flag: info.flag,
            })),
            defaultValue: "fr-par",
          },
        ],
      };
    }

    if (typeId === "block-volume") {
      return {
        fields: [
          { key: "name", label: "Volume Name", kind: "text", required: true },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: Object.entries(ScalewayClient.ZONE_INFO).map(([id, info]) => ({
              id,
              label: id,
              location: info.location,
              flag: info.flag,
            })),
            defaultValue: "fr-par-1",
          },
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 1,
            maxGb: 10000,
            defaultGb: 100,
            stepGb: 1,
          },
          {
            key: "perfIops",
            label: "Performance (IOPS)",
            kind: "select",
            required: true,
            defaultValue: "5000",
            options: [
              { id: "5000", label: "5,000 IOPS" },
              { id: "15000", label: "15,000 IOPS" },
            ],
          },
        ],
      };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "instance") {
      const externalId = resourceId.split(":").pop()!;
      // externalId format: {zone}/{serverId}
      const parts = externalId.split("/");
      const zone = parts[0]!;
      const serverId = parts[1]!;
      // Terminate to also release the IP
      await this.apiFetch<unknown>(this.instanceUrl(zone, `/servers/${serverId}/action`), {
        method: "POST",
        body: JSON.stringify({ action: "terminate" }),
      });
      return;
    }

    if (typeId === "kapsule-cluster") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]!;
      const clusterId = parts[1]!;
      await this.apiFetch<unknown>(this.k8sUrl(region, `/clusters/${clusterId}`), {
        method: "DELETE",
        body: JSON.stringify({ with_additional_resources: true }),
      });
      return;
    }

    if (typeId === "rdb-instance") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]!;
      const instanceId = parts[1]!;
      await this.apiFetch<unknown>(this.rdbUrl(region, `/instances/${instanceId}`), {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "object-storage-bucket") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const region = parts[0]!;
      const bucketName = parts[1]!;
      // S3-compatible DeleteBucket: DELETE https://<bucket>.s3.<region>.scw.cloud/
      await this.s3Fetch("DELETE", `${bucketName}.s3.${region}.scw.cloud`, "/", region);
      return;
    }

    if (typeId === "block-volume") {
      const externalId = resourceId.split(":").pop()!;
      const parts = externalId.split("/");
      const zone = parts[0]!;
      const volumeId = parts[1]!;
      await this.apiFetch<unknown>(this.blockUrl(zone, `/volumes/${volumeId}`), {
        method: "DELETE",
      });
      return;
    }

    throw new Error(`Scaleway plugin: deleteResource not supported for type "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "block-volume" && targetTypeId === "instance") {
      const [volume, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeZone = String(volume.fields["zone"] ?? "");
      const instanceZone = String(instance.fields["zone"] ?? "");
      if (volumeZone && instanceZone && volumeZone !== instanceZone) {
        throw new Error(
          `Volume zone ${volumeZone} does not match instance zone ${instanceZone} — Scaleway block volumes must be in the same AZ as the instance.`,
        );
      }
      const instanceExternalId = instance.externalId ?? "";
      const serverId = instanceExternalId.split("/").pop() ?? "";
      const volumeExternalId = volume.externalId ?? "";
      const volumeId = volumeExternalId.split("/").pop() ?? "";
      if (!serverId || !volumeId || !instanceZone) {
        throw new Error("Cannot determine zone/instance/volume id for attachment");
      }
      // Attach is done via Instance API PATCH with the *full* volumes map.
      // Read the server's existing volumes, append the new one, then PATCH.
      const serverData = await this.apiFetch<{
        server: { volumes?: Record<string, Record<string, unknown>> };
      }>(this.instanceUrl(instanceZone, `/servers/${serverId}`));
      const existing = serverData.server.volumes ?? {};
      const usedKeys = new Set(Object.keys(existing).map((k) => Number(k)));
      let nextKey = 0;
      while (usedKeys.has(nextKey)) nextKey++;
      const updated = {
        ...existing,
        [String(nextKey)]: { id: volumeId, volume_type: "sbs_volume", boot: false },
      };
      await this.apiFetch(this.instanceUrl(instanceZone, `/servers/${serverId}`), {
        method: "PATCH",
        body: JSON.stringify({ volumes: updated }),
      });
      return;
    }
    throw new Error(
      `Scaleway plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "instance") {
      return this.createInstance(accountId, fields);
    }

    if (typeId === "kapsule-cluster") {
      return this.createKapsuleCluster(accountId, fields);
    }

    if (typeId === "rdb-instance") {
      const region = fields["region"] ?? "fr-par";
      const data = await this.apiFetch<{
        id: string;
        name: string;
        status: string;
        engine: string;
        node_type: string;
        created_at: string;
      }>(this.rdbUrl(region, "/instances"), {
        method: "POST",
        body: JSON.stringify({
          name: fields["name"] ?? "",
          engine: fields["engine"] ?? "PostgreSQL-16",
          node_type: fields["nodeType"] ?? "DB-DEV-S",
          is_ha_cluster: fields["isHaCluster"] === "true",
          disable_backup: fields["disableBackup"] === "true",
          user_name: fields["userName"] ?? "admin",
          password: fields["password"] ?? "",
        }),
      });
      const engine = fields["engine"] ?? "PostgreSQL-16";
      const [engineName, engineVersion] = engine.split("-");
      return {
        id: `${accountId}:rdb-instance:${region}/${data.id}`,
        pluginId: "scaleway",
        resourceTypeId: "rdb-instance",
        accountId,
        displayName: data.name,
        fields: {
          name: data.name,
          engine: engineName ?? engine,
          engineVersion: engineVersion ?? "",
          region,
          nodeType: fields["nodeType"] ?? "DB-DEV-S",
          status: data.status ?? "provisioning",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${region}/${data.id}`,
        createdAt: data.created_at ?? new Date().toISOString(),
        updatedAt: data.created_at ?? new Date().toISOString(),
      };
    }

    if (typeId === "object-storage-bucket") {
      const region = fields["region"] ?? "fr-par";
      const bucketName = fields["name"] ?? "";
      // S3-compatible CreateBucket: PUT https://<bucket>.s3.<region>.scw.cloud/
      await this.s3Fetch("PUT", `${bucketName}.s3.${region}.scw.cloud`, "/", region);
      const now = new Date().toISOString();
      return {
        id: `${accountId}:object-storage-bucket:${region}/${bucketName}`,
        pluginId: "scaleway",
        resourceTypeId: "object-storage-bucket",
        accountId,
        displayName: bucketName,
        fields: { name: bucketName, region },
        resolvedOutputs: {
          endpoint: `https://s3.${region}.scw.cloud`,
        },
        secretStates: [],
        externalId: `${region}/${bucketName}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "block-volume") {
      const zone = fields["zone"] ?? "fr-par-1";
      const sizeGb = Number(fields["sizeGb"] ?? 100);
      const perfIops = Number(fields["perfIops"] ?? 5000);
      const data = await this.apiFetch<{
        id: string;
        name: string;
        size: number;
        status: string;
        created_at?: string;
      }>(this.blockUrl(zone, "/volumes"), {
        method: "POST",
        body: JSON.stringify({
          project_id: this.defaultProjectId,
          name: fields["name"] ?? "",
          perf_iops: perfIops,
          from_empty: { size: sizeGb * 1_000_000_000 },
        }),
      });
      const now = new Date().toISOString();
      return {
        id: `${accountId}:block-volume:${zone}/${data.id}`,
        pluginId: "scaleway",
        resourceTypeId: "block-volume",
        accountId,
        displayName: data.name ?? fields["name"] ?? data.id,
        fields: {
          name: data.name ?? fields["name"] ?? "",
          zone,
          sizeGb: Math.round(data.size / 1_000_000_000),
          perfIops: String(perfIops),
          status: data.status ?? "creating",
          attachedInstanceId: "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${zone}/${data.id}`,
        createdAt: data.created_at ?? now,
        updatedAt: now,
      };
    }

    throw new Error(`Scaleway plugin: createResource not supported for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const ro = resource.resolvedOutputs ?? {};

    switch (resourceTypeId) {
      case "instance": {
        const state = String(f.state ?? "unknown");
        const stats: DashboardStat[] = [
          {
            label: "State",
            value: state,
            variant:
              state === "running"
                ? "status-healthy"
                : state === "stopped" || state === "off"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Type", value: String(f.commercialType ?? "") },
          { label: "Zone", value: String(f.zone ?? "") },
        ];
        if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
        return stats;
      }
      case "kapsule-cluster": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "ready" || status === "running" ? "status-healthy" : "status-degraded",
          },
          { label: "Version", value: String(f.version ?? "") },
          { label: "Region", value: String(f.region ?? "") },
          { label: "Nodes", value: String(f.nodeCount ?? 0) },
        ];
      }
      case "rdb-instance": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "ready" || status === "running" ? "status-healthy" : "status-degraded",
          },
          { label: "Engine", value: String(f.engine ?? "") },
          { label: "Node Type", value: String(f.nodeType ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      case "object-storage-bucket": {
        return [
          { label: "Name", value: String(f.name ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? fields["status"] ?? "");

    let statusKind: ResourceStatus = "info";
    if (state === "running" || state === "ready") statusKind = "healthy";
    else if (
      state === "starting" ||
      state === "stopping" ||
      state === "provisioning" ||
      state === "creating"
    )
      statusKind = "provisioning";
    else if (state === "stopped" || state === "error" || state === "locked" || state === "deleting")
      statusKind = "error";

    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} \u00B7 ${String(fields["zone"] ?? fields["region"] ?? "")}`,
      status: { kind: "status-dot", status: statusKind },
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
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
    let status: ResourceStatus = "info";
    if (state === "running" || state === "ready") status = "healthy";
    else if (state === "starting" || state === "stopping" || state === "provisioning")
      status = "provisioning";
    else if (state === "stopped" || state === "error" || state === "locked") status = "error";

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  private async listBlockVolumes(accountId: string): Promise<ResourceInstance[]> {
    const zones = Object.keys(ScalewayClient.ZONE_INFO);
    const results: ResourceInstance[] = [];
    const fetches = zones.map(async (zone) => {
      try {
        const data = await this.apiFetch<{
          volumes?: Array<{
            id: string;
            name?: string;
            size: number;
            status?: string;
            references?: Array<{ type?: string; product_resource_id?: string }>;
            specs?: { perf_iops?: number };
            created_at?: string;
            updated_at?: string;
          }>;
        }>(this.blockUrl(zone, `/volumes?project_id=${this.defaultProjectId}`));
        return (data.volumes ?? []).map((v) => {
          const attached =
            (v.references ?? []).find((r) => r.type === "instance_server")?.product_resource_id ??
            "";
          return {
            id: `${accountId}:block-volume:${zone}/${v.id}`,
            pluginId: "scaleway",
            resourceTypeId: "block-volume",
            accountId,
            displayName: v.name ?? v.id,
            fields: {
              name: v.name ?? "",
              zone,
              sizeGb: Math.round(v.size / 1_000_000_000),
              perfIops: String(v.specs?.perf_iops ?? ""),
              status: v.status ?? "",
              attachedInstanceId: attached,
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: `${zone}/${v.id}`,
            createdAt: v.created_at ?? new Date().toISOString(),
            updatedAt: v.updated_at ?? v.created_at ?? new Date().toISOString(),
          };
        });
      } catch {
        return [];
      }
    });
    const allResults = await Promise.all(fetches);
    for (const batch of allResults) {
      results.push(...batch);
    }
    return results;
  }

  private async listInstances(accountId: string): Promise<ResourceInstance[]> {
    const zones = [
      "fr-par-1",
      "fr-par-2",
      "fr-par-3",
      "nl-ams-1",
      "nl-ams-2",
      "nl-ams-3",
      "pl-waw-1",
      "pl-waw-2",
      "pl-waw-3",
    ];
    const results: ResourceInstance[] = [];

    const fetches = zones.map(async (zone) => {
      try {
        const data = await this.apiFetch<{
          servers: Array<Record<string, unknown>>;
        }>(this.instanceUrl(zone, `/servers?project=${this.defaultProjectId}`));
        return data.servers.map((s) => this.mapInstance(s, zone, accountId));
      } catch {
        // Zone may not be available — skip silently
        return [];
      }
    });

    const allResults = await Promise.all(fetches);
    for (const batch of allResults) {
      results.push(...batch);
    }
    return results;
  }

  private mapInstance(
    s: Record<string, unknown>,
    zone: string,
    accountId: string,
  ): ResourceInstance {
    const publicIpObj = s["public_ip"] as Record<string, unknown> | null;
    const publicIp = publicIpObj ? String(publicIpObj["address"] ?? "") : "";
    const privateIp = String((s["private_ip"] as string) ?? "");
    const serverId = String(s["id"]);
    const externalId = `${zone}/${serverId}`;

    return {
      id: `${accountId}:instance:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "instance",
      accountId,
      displayName: String(s["name"]),
      fields: {
        name: String(s["name"]),
        zone,
        commercialType: String(s["commercial_type"] ?? ""),
        image: String((s["image"] as Record<string, unknown>)?.["name"] ?? ""),
        state: String(s["state"] ?? ""),
      },
      resolvedOutputs: { publicIp, privateIp },
      secretStates: [],
      externalId,
      createdAt: String(s["creation_date"] ?? new Date().toISOString()),
      updatedAt: String(s["modification_date"] ?? s["creation_date"] ?? new Date().toISOString()),
    };
  }

  private async getInstanceCreateConfig(): Promise<CreateResourceConfig> {
    // Fetch available commercial types from one zone first — they're mostly uniform
    const zones = [
      "fr-par-1",
      "fr-par-2",
      "fr-par-3",
      "nl-ams-1",
      "nl-ams-2",
      "nl-ams-3",
      "pl-waw-1",
      "pl-waw-2",
      "pl-waw-3",
    ];

    const regionOptions = zones.map((zone) => {
      const info = ScalewayClient.ZONE_INFO[zone];
      return {
        id: zone,
        label: zone,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });

    let sizes: SizeOption[] = [];
    try {
      const data = await this.apiFetch<{
        servers: Record<
          string,
          {
            ncpus: number;
            ram: number;
            monthly_price?: number;
            hourly_price?: number;
            alt_names?: string[];
          }
        >;
      }>(this.instanceUrl("fr-par-1", "/products/servers"));

      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const [slug, info] of Object.entries(data.servers)) {
        // Categorize by prefix: DEV1, GP1, PRO2, ENT1, STARDUST1, etc.
        const category = slug.replace(/-.*$/, "");
        if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
        const monthlyPrice =
          info.monthly_price ?? (info.hourly_price ? info.hourly_price * 730 : undefined);
        sizesByCategory.get(category)!.push({
          id: slug,
          label: slug,
          vcpus: info.ncpus,
          memoryMb: Math.round(info.ram / (1024 * 1024)),
          diskGb: 0, // Scaleway uses separate volumes
          category,
          ...(monthlyPrice != null ? { priceMonthly: Math.round(monthlyPrice * 100) / 100 } : {}),
        });
      }
      sizes = [...sizesByCategory.values()].flat();
    } catch {
      // Fall back to a minimal static list
      sizes = [
        { id: "DEV1-S", label: "DEV1-S", vcpus: 2, memoryMb: 2048, diskGb: 0, category: "DEV1" },
        { id: "DEV1-M", label: "DEV1-M", vcpus: 3, memoryMb: 4096, diskGb: 0, category: "DEV1" },
        { id: "DEV1-L", label: "DEV1-L", vcpus: 4, memoryMb: 8192, diskGb: 0, category: "DEV1" },
        { id: "GP1-XS", label: "GP1-XS", vcpus: 4, memoryMb: 16384, diskGb: 0, category: "GP1" },
        { id: "GP1-S", label: "GP1-S", vcpus: 8, memoryMb: 32768, diskGb: 0, category: "GP1" },
        { id: "GP1-M", label: "GP1-M", vcpus: 16, memoryMb: 65536, diskGb: 0, category: "GP1" },
        {
          id: "PRO2-XXS",
          label: "PRO2-XXS",
          vcpus: 2,
          memoryMb: 8192,
          diskGb: 0,
          category: "PRO2",
        },
        { id: "PRO2-XS", label: "PRO2-XS", vcpus: 4, memoryMb: 16384, diskGb: 0, category: "PRO2" },
        { id: "PRO2-S", label: "PRO2-S", vcpus: 8, memoryMb: 32768, diskGb: 0, category: "PRO2" },
      ];
    }

    let images: ImageOption[] = [];
    try {
      const data = await this.apiFetch<{
        images: Array<{
          id: string;
          name: string;
          arch: string;
          default_bootscript?: Record<string, unknown>;
          organization: string;
          public: boolean;
          creation_date: string;
        }>;
      }>(this.instanceUrl("fr-par-1", "/images?per_page=100&public=true"));

      const imageMap = new Map<string, ImageOption[]>();
      for (const img of data.images) {
        if (img.arch !== "x86_64") continue;
        // Categorize by distro name prefix
        const nameParts = img.name.split(" ");
        const category = nameParts[0] ?? "Other";
        if (!imageMap.has(category)) imageMap.set(category, []);
        imageMap.get(category)!.push({ id: img.id, label: img.name, category });
      }
      images = [...imageMap.values()].flat();
    } catch {
      // Minimal fallback
      images = [
        { id: "ubuntu_jammy", label: "Ubuntu 22.04 Jammy Jellyfish", category: "Ubuntu" },
        { id: "ubuntu_noble", label: "Ubuntu 24.04 Noble Numbat", category: "Ubuntu" },
        { id: "debian_bookworm", label: "Debian 12 Bookworm", category: "Debian" },
      ];
    }

    const defaultImage = images.find((i) => i.category === "Ubuntu")?.id ?? images[0]?.id;
    const firstRegion = regionOptions[0]?.id;
    const firstSize = sizes[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "zone",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
        },
        {
          key: "commercialType",
          label: "Size",
          kind: "size-picker",
          required: true,
          sizes,
          ...(firstSize ? { defaultValue: firstSize } : {}),
        },
        {
          key: "image",
          label: "Image",
          kind: "image-picker",
          required: true,
          images,
          ...(defaultImage ? { defaultValue: defaultImage } : {}),
        },
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
      ],
    };
  }

  private async createInstance(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const zone = fields["zone"] ?? "fr-par-1";

    const body: Record<string, unknown> = {
      name: fields["name"],
      commercial_type: fields["commercialType"],
      image: fields["image"],
      project: this.defaultProjectId || undefined,
      dynamic_ip_required: true,
    };

    const data = await this.apiFetch<{ server: Record<string, unknown> }>(
      this.instanceUrl(zone, "/servers"),
      { method: "POST", body: JSON.stringify(body) },
    );

    const server = data.server;
    const serverId = String(server["id"]);

    // Boot the instance after creation
    try {
      await this.apiFetch<unknown>(this.instanceUrl(zone, `/servers/${serverId}/action`), {
        method: "POST",
        body: JSON.stringify({ action: "poweron" }),
      });
    } catch {
      // Non-fatal — instance was created even if boot fails
    }

    const publicIpObj = server["public_ip"] as Record<string, unknown> | null;
    const publicIp = publicIpObj ? String(publicIpObj["address"] ?? "") : "";
    const externalId = `${zone}/${serverId}`;

    return {
      id: `${accountId}:instance:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "instance",
      accountId,
      displayName: String(server["name"]),
      fields: {
        name: String(server["name"]),
        zone,
        commercialType: String(server["commercial_type"] ?? fields["commercialType"]),
        image: String((server["image"] as Record<string, unknown>)?.["name"] ?? fields["image"]),
        state: String(server["state"] ?? "starting"),
      },
      resolvedOutputs: { publicIp, privateIp: "" },
      secretStates: [],
      externalId,
      createdAt: String(server["creation_date"] ?? new Date().toISOString()),
      updatedAt: String(server["creation_date"] ?? new Date().toISOString()),
    };
  }

  private async listKapsuleClusters(accountId: string): Promise<ResourceInstance[]> {
    const regions = ["fr-par", "nl-ams", "pl-waw"];
    const results: ResourceInstance[] = [];

    const fetches = regions.map(async (region) => {
      try {
        const data = await this.apiFetch<{
          clusters: Array<Record<string, unknown>>;
        }>(this.k8sUrl(region, `/clusters?project_id=${this.defaultProjectId}`));
        return data.clusters.map((c) => this.mapKapsuleCluster(c, region, accountId));
      } catch {
        return [];
      }
    });

    const allResults = await Promise.all(fetches);
    for (const batch of allResults) {
      results.push(...batch);
    }
    return results;
  }

  private mapKapsuleCluster(
    c: Record<string, unknown>,
    region: string,
    accountId: string,
  ): ResourceInstance {
    const clusterId = String(c["id"]);
    const externalId = `${region}/${clusterId}`;
    const pools = c["pools"] as Array<Record<string, unknown>> | undefined;
    const firstPool = pools?.[0];

    return {
      id: `${accountId}:kapsule-cluster:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "kapsule-cluster",
      accountId,
      displayName: String(c["name"]),
      fields: {
        name: String(c["name"]),
        region: String(c["region"] ?? region),
        version: String(c["version"] ?? ""),
        nodeType: String(firstPool?.["node_type"] ?? ""),
        nodeCount: Number(firstPool?.["size"] ?? 0),
        status: String(c["status"] ?? ""),
      },
      resolvedOutputs: {
        clusterUrl: String(c["cluster_url"] ?? ""),
      },
      secretStates: [],
      externalId,
      createdAt: String(c["created_at"] ?? new Date().toISOString()),
      updatedAt: String(c["updated_at"] ?? c["created_at"] ?? new Date().toISOString()),
    };
  }

  private async getKapsuleCreateConfig(): Promise<CreateResourceConfig> {
    const regions = Object.entries(ScalewayClient.REGION_INFO).map(([id, info]) => ({
      id,
      label: id,
      location: info.location,
      flag: info.flag,
    }));

    let versions: { id: string; label: string }[] = [];
    try {
      const data = await this.apiFetch<{
        versions: Array<{ name: string; available_cnis: string[] }>;
      }>(this.k8sUrl("fr-par", "/versions"));
      versions = data.versions.map((v) => ({
        id: v.name,
        label: v.name,
      }));
    } catch {
      versions = [{ id: "1.30.2", label: "1.30.2" }];
    }

    // Reuse instance sizes for node pools
    let sizes: SizeOption[] = [];
    try {
      const data = await this.apiFetch<{
        servers: Record<
          string,
          { ncpus: number; ram: number; monthly_price?: number; hourly_price?: number }
        >;
      }>(this.instanceUrl("fr-par-1", "/products/servers"));

      const sizesByCategory = new Map<string, SizeOption[]>();
      for (const [slug, info] of Object.entries(data.servers)) {
        const category = slug.replace(/-.*$/, "");
        if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
        const monthlyPrice =
          info.monthly_price ?? (info.hourly_price ? info.hourly_price * 730 : undefined);
        sizesByCategory.get(category)!.push({
          id: slug,
          label: slug,
          vcpus: info.ncpus,
          memoryMb: Math.round(info.ram / (1024 * 1024)),
          diskGb: 0,
          category,
          ...(monthlyPrice != null ? { priceMonthly: Math.round(monthlyPrice * 100) / 100 } : {}),
        });
      }
      sizes = [...sizesByCategory.values()].flat();
    } catch {
      sizes = [
        { id: "DEV1-M", label: "DEV1-M", vcpus: 3, memoryMb: 4096, diskGb: 0, category: "DEV1" },
        { id: "GP1-XS", label: "GP1-XS", vcpus: 4, memoryMb: 16384, diskGb: 0, category: "GP1" },
        { id: "GP1-S", label: "GP1-S", vcpus: 8, memoryMb: 32768, diskGb: 0, category: "GP1" },
      ];
    }

    const defaultRegion = regions[0]?.id;
    const defaultSize = sizes[0]?.id;
    const defaultVersion = versions[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
        },
        {
          key: "version",
          label: "Kubernetes Version",
          kind: "select",
          required: true,
          options: versions,
          ...(defaultVersion ? { defaultValue: defaultVersion } : {}),
        },
        {
          key: "nodeType",
          label: "Node Pool Size",
          kind: "size-picker",
          required: true,
          sizes,
          ...(defaultSize ? { defaultValue: defaultSize } : {}),
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "3",
          minValue: 1,
          stepValue: 1,
          description: "Initial number of nodes in the default pool.",
        },
      ],
    };
  }

  private async createKapsuleCluster(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const region = fields["region"] ?? "fr-par";
    const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
    const nodeCount =
      Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 3;

    const poolNameBase = (fields["name"] ?? "cluster").trim() || "cluster";

    const body = {
      name: fields["name"],
      version: fields["version"] ?? "1.30.2",
      cni: "cilium",
      project_id: this.defaultProjectId || undefined,
      pools: [
        {
          name: `${poolNameBase}-default-pool`,
          node_type: fields["nodeType"],
          size: nodeCount,
          autoscaling: false,
          autohealing: true,
        },
      ],
    };

    const data = await this.apiFetch<{ cluster: Record<string, unknown> }>(
      this.k8sUrl(region, "/clusters"),
      { method: "POST", body: JSON.stringify(body) },
    );

    const cluster = data.cluster;
    const clusterId = String(cluster["id"]);
    const externalId = `${region}/${clusterId}`;

    return {
      id: `${accountId}:kapsule-cluster:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "kapsule-cluster",
      accountId,
      displayName: String(cluster["name"] ?? fields["name"]),
      fields: {
        name: String(cluster["name"] ?? fields["name"] ?? ""),
        region,
        version: String(cluster["version"] ?? fields["version"] ?? ""),
        nodeType: fields["nodeType"] ?? "",
        nodeCount,
        status: String(cluster["status"] ?? "creating"),
      },
      resolvedOutputs: {
        clusterUrl: String(cluster["cluster_url"] ?? ""),
      },
      secretStates: [],
      externalId,
      createdAt: String(cluster["created_at"] ?? new Date().toISOString()),
      updatedAt: String(cluster["created_at"] ?? new Date().toISOString()),
    };
  }

  private async listManagedDatabases(accountId: string): Promise<ResourceInstance[]> {
    const regions = ["fr-par", "nl-ams", "pl-waw"];
    const results: ResourceInstance[] = [];

    const fetches = regions.map(async (region) => {
      try {
        const data = await this.apiFetch<{
          instances: Array<Record<string, unknown>>;
        }>(this.rdbUrl(region, `/instances?project_id=${this.defaultProjectId}`));
        return data.instances.map((db) => this.mapManagedDatabase(db, region, accountId));
      } catch {
        return [];
      }
    });

    const allResults = await Promise.all(fetches);
    for (const batch of allResults) {
      results.push(...batch);
    }
    return results;
  }

  private mapManagedDatabase(
    db: Record<string, unknown>,
    region: string,
    accountId: string,
  ): ResourceInstance {
    const instanceId = String(db["id"]);
    const externalId = `${region}/${instanceId}`;
    const engine = String(db["engine"] ?? "");
    // Scaleway engine format: "PostgreSQL-16", "MySQL-8", etc.
    const [engineName, engineVersion] = engine.split("-");

    return {
      id: `${accountId}:rdb-instance:${externalId}`,
      pluginId: "scaleway",
      resourceTypeId: "rdb-instance",
      accountId,
      displayName: String(db["name"]),
      fields: {
        name: String(db["name"]),
        engine: engineName ?? engine,
        engineVersion: engineVersion ?? "",
        region: String(db["region"] ?? region),
        nodeType: String(db["node_type"] ?? ""),
        status: String(db["status"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: String(db["created_at"] ?? new Date().toISOString()),
    };
  }

  private async listObjectStorageBuckets(accountId: string): Promise<ResourceInstance[]> {
    // Scaleway Object Storage uses the S3-compatible API with AWS SigV4 auth.
    // We query each region's S3 endpoint and parse the XML ListBuckets response.
    const regions = ["fr-par", "nl-ams", "pl-waw"];
    const results: ResourceInstance[] = [];

    for (const region of regions) {
      try {
        const buckets = await this.s3Fetch<Array<{ name: string; creationDate: string }>>(
          "GET",
          `s3.${region}.scw.cloud`,
          "/",
          region,
          (xml) => {
            // Minimal XML parsing for <Bucket><Name>…</Name><CreationDate>…</CreationDate></Bucket>
            const out: Array<{ name: string; creationDate: string }> = [];
            const bucketRegex =
              /<Bucket>\s*<Name>([^<]+)<\/Name>\s*<CreationDate>([^<]+)<\/CreationDate>\s*<\/Bucket>/g;
            let m: RegExpExecArray | null;
            while ((m = bucketRegex.exec(xml)) !== null) {
              out.push({ name: m[1]!, creationDate: m[2]! });
            }
            return out;
          },
        );
        for (const b of buckets) {
          results.push({
            id: `${accountId}:object-storage-bucket:${region}/${b.name}`,
            pluginId: "scaleway",
            resourceTypeId: "object-storage-bucket",
            accountId,
            displayName: b.name,
            fields: {
              name: b.name,
              region,
            },
            resolvedOutputs: {
              endpoint: `https://s3.${region}.scw.cloud`,
            },
            secretStates: [],
            externalId: `${region}/${b.name}`,
            createdAt: b.creationDate,
            updatedAt: b.creationDate,
          });
        }
      } catch {
        // Region may not have Object Storage or credentials may lack access — skip
      }
    }
    return results;
  }
}
