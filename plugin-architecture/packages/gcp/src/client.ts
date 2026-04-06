import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { fetchAccessToken, type ServiceAccountKey } from "./auth.js";

// ─── Token cache ─────────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number; // ms
}

// ─── GCP status → UI status ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function gcpStatus(
  s: string | undefined,
): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
  switch ((s ?? "").toUpperCase()) {
    case "RUNNING":
    case "ACTIVE":
    case "READY":
    case "SERVING":
    case "DEPLOYED":
    case "SUCCEEDED":
      return "healthy";
    case "SUSPENDED":
    case "MAINTENANCE":
    case "FAILED_TO_START":
    case "DEGRADED":
      return "degraded";
    case "FAILED":
    case "STOPPING":
    case "TERMINATED":
    case "DELETED":
      return "error";
    case "CREATING":
    case "UPDATING":
    case "DEPLOYING":
    case "PROVISIONING":
    case "PENDING":
    case "STAGING":
      return "provisioning";
    default:
      return "unknown";
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class GcpClient implements PluginClient {
  private readonly key: ServiceAccountKey;
  private readonly project: string;
  private tokenCache: TokenCache | null = null;

  constructor(credentials: Record<string, string>) {
    const raw = credentials["serviceAccountJson"];
    if (!raw) throw new Error("GCP plugin: missing serviceAccountJson credential");
    this.key = JSON.parse(raw) as ServiceAccountKey;
    this.project = credentials["project"]?.trim() || this.key.project_id;
    if (!this.project) throw new Error("GCP plugin: could not determine project ID");
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const t = await fetchAccessToken(this.key);
    this.tokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  private async get<T>(url: string): Promise<T> {
    const tok = await this.token();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      throw new Error(`GCP API ${res.status} for ${url}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  /** Follow nextPageToken until exhausted, collecting `key` array from each page. */
  private async paginate<T>(
    baseUrl: string,
    key: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(baseUrl);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<Record<string, unknown>>(url.toString());
      const items = page[key];
      if (Array.isArray(items)) results.push(...(items as T[]));
      pageToken = page["nextPageToken"] as string | undefined;
    } while (pageToken);
    return results;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const p = this.project;
    switch (typeId) {
      case "gce-instance":       return this.listGceInstances(accountId, p);
      case "gce-disk":           return this.listGceDisks(accountId, p);
      case "gke-cluster":        return this.listGkeClusters(accountId, p);
      case "cloudsql-instance":  return this.listCloudSqlInstances(accountId, p);
      case "spanner-instance":   return this.listSpannerInstances(accountId, p);
      case "bigtable-instance":  return this.listBigtableInstances(accountId, p);
      case "firestore-database": return this.listFirestoreDatabases(accountId, p);
      case "memorystore-redis":  return this.listMemorystoreRedis(accountId, p);
      case "alloydb-cluster":    return this.listAlloyDbClusters(accountId, p);
      case "gcs-bucket":         return this.listGcsBuckets(accountId, p);
      case "pubsub-topic":       return this.listPubSubTopics(accountId, p);
      case "pubsub-subscription":return this.listPubSubSubscriptions(accountId, p);
      case "cloud-run-service":  return this.listCloudRunServices(accountId, p);
      case "cloud-function":     return this.listCloudFunctions(accountId, p);
      case "vpc-network":        return this.listVpcNetworks(accountId, p);
      case "bigquery-dataset":   return this.listBigQueryDatasets(accountId, p);
      case "artifact-registry-repo": return this.listArtifactRegistryRepos(accountId, p);
      case "gcp-service-account":return this.listServiceAccounts(accountId, p);
      case "cloud-armor-policy": return this.listCloudArmorPolicies(accountId, p);
      case "secret-manager-secret": return this.listSecretManagerSecrets(accountId, p);
      case "dataflow-job":       return this.listDataflowJobs(accountId, p);
      default:
        throw new Error(`GCP plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`GCP plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, resourceId: string, outputKey: string, accountId: string): Promise<string> {
    const p = this.project;

    if (typeId === "gke-cluster" && outputKey === "kubeconfig") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const endpoint = resource.resolvedOutputs["clusterEndpoint"] ?? "";
      const cluster = await this.get<Record<string, unknown>>(
        `https://container.googleapis.com/v1/projects/${p}/locations/${String(resource.fields["location"])}/clusters/${resource.externalId}`,
      );
      const caCert = ((cluster["masterAuth"] as Record<string, unknown> | undefined)?.["clusterCaCertificate"] as string) ?? "";
      const tok = await this.token();
      const kubeconfig = [
        "apiVersion: v1",
        "kind: Config",
        `clusters:`,
        `- cluster:`,
        `    server: https://${endpoint}`,
        `    certificate-authority-data: ${caCert}`,
        `  name: ${String(cluster["name"])}`,
        `contexts:`,
        `- context:`,
        `    cluster: ${String(cluster["name"])}`,
        `    user: ${String(cluster["name"])}`,
        `  name: ${String(cluster["name"])}`,
        `current-context: ${String(cluster["name"])}`,
        `users:`,
        `- name: ${String(cluster["name"])}`,
        `  user:`,
        `    token: ${tok}`,
      ].join("\n");
      return kubeconfig;
    }

    if (typeId === "memorystore-redis" && outputKey === "authString") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = resource.externalId ?? "";
      const data = await this.get<Record<string, unknown>>(
        `https://redis.googleapis.com/v1/${name}/authString`,
      );
      return (data["authString"] as string) ?? "";
    }

    if (typeId === "secret-manager-secret" && outputKey === "latestVersion") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const secretName = resource.externalId ?? "";
      const data = await this.get<Record<string, unknown>>(
        `https://secretmanager.googleapis.com/v1/${secretName}/versions/latest:access`,
      );
      const payload = data["payload"] as Record<string, unknown> | undefined;
      const b64 = (payload?.["data"] as string) ?? "";
      return atob(b64);
    }

    throw new Error(`GCP plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const statusVal = String(fields["status"] ?? fields["state"] ?? "");
    const subtitle = String(
      fields["region"] ?? fields["location"] ?? fields["zone"] ?? resource.resourceTypeId,
    );
    const base: DetailViewSchema = {
      title: resource.displayName,
      subtitle,
      status: { kind: "status-dot", status: gcpStatus(statusVal), label: statusVal || undefined },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields)
                .filter(([, v]) => v !== "" && v !== undefined)
                .map(([key, value]) => ({ key, value: String(value) })),
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };

    if (resource.resourceTypeId === "gcs-bucket") {
      base.storageBrowser = { bucketName: resource.externalId ?? resource.displayName };
      base.status = undefined;
    }

    return base;
  }

  async getStorageAccessToken(): Promise<string> {
    return this.token();
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const tok = await this.token();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (onProgress) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        });
      }
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload network error")));
      xhr.send(file);
    });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const tok = await this.token();

    if (key.endsWith("/")) {
      // Folder — list all objects with this prefix (flat, no delimiter) and delete each
      const allKeys: string[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        );
        url.searchParams.set("prefix", key);
        url.searchParams.set("maxResults", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await this.get<{ items?: Array<{ name: string }>; nextPageToken?: string }>(
          url.toString(),
        );
        for (const item of page.items ?? []) allKeys.push(item.name);
        pageToken = page.nextPageToken;
      } while (pageToken);

      await Promise.all(
        allKeys.map((k) =>
          fetch(
            `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(k)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
          ),
        ),
      );
      return;
    }

    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Delete failed: ${res.status}`);
    }
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const tok = await this.token();
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(folderKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) throw new Error(`Make folder failed: ${res.status}`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("maxResults", "1000");
    if (prefix) url.searchParams.set("prefix", prefix);

    const results: StorageObject[] = [];
    let pageToken: string | undefined;

    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<{
        items?: Array<{ name: string; size: string; updated: string; contentType?: string }>;
        prefixes?: string[];
        nextPageToken?: string;
      }>(url.toString());

      // Directories (common prefixes)
      for (const p of page.prefixes ?? []) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        results.push({ key: p, name, size: 0, lastModified: "", isDirectory: true });
      }

      // Objects
      for (const obj of page.items ?? []) {
        if (obj.name === prefix) continue; // skip the "folder" placeholder object
        const name = obj.name.slice(prefix.length);
        results.push({
          key: obj.name,
          name,
          size: Number(obj.size ?? 0),
          lastModified: obj.updated ?? "",
          isDirectory: false,
          contentType: obj.contentType,
        });
      }

      pageToken = page.nextPageToken;
    } while (pageToken);

    return results;
  }

  async fetchStorageStats(bucketName: string): Promise<{ count: number; size: string }> {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`);
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("fields", "nextPageToken,items/size");

    let count = 0;
    let totalBytes = 0;
    let pageToken: string | undefined;

    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<{ items?: Array<{ size?: string }>; nextPageToken?: string }>(url.toString());
      for (const item of page.items ?? []) {
        count++;
        totalBytes += Number(item.size ?? 0);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return { count, size: formatBytes(totalBytes) };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const statusVal = String(resource.fields["status"] ?? resource.fields["state"] ?? "");
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: gcpStatus(statusVal) },
    };
  }

  // ─── Private list helpers ─────────────────────────────────────────────────

  private id(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async listGceInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ items?: Record<string, { instances?: unknown[] }> }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instances`,
    );
    const results: ResourceInstance[] = [];
    for (const zone of Object.values(data.items ?? {})) {
      for (const inst of (zone.instances ?? []) as Record<string, unknown>[]) {
        const name = String(inst["name"]);
        const zone_ = String(inst["zone"]).split("/").pop() ?? "";
        const machineType = String(inst["machineType"]).split("/").pop() ?? "";
        const status = String(inst["status"] ?? "");
        const nets = inst["networkInterfaces"] as Array<Record<string, unknown>> | undefined;
        const externalIp =
          ((nets?.[0]?.["accessConfigs"] as Array<Record<string, unknown>> | undefined)?.[0]?.["natIP"] as string) ?? "";
        const internalIp = (nets?.[0]?.["networkIP"] as string) ?? "";
        results.push({
          id: this.id(accountId, "gce-instance", `${p}/${zone_}/${name}`),
          pluginId: "gcp",
          resourceTypeId: "gce-instance",
          accountId,
          displayName: name,
          fields: { name, zone: zone_, machineType, status },
          resolvedOutputs: { externalIp, internalIp },
          secretStates: [],
          externalId: `${p}/${zone_}/${name}`,
          createdAt: String(inst["creationTimestamp"] ?? this.now()),
          updatedAt: this.now(),
        });
      }
    }
    return results;
  }

  private async listGceDisks(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ items?: Record<string, { disks?: unknown[] }> }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/disks`,
    );
    const results: ResourceInstance[] = [];
    for (const zone of Object.values(data.items ?? {})) {
      for (const disk of (zone.disks ?? []) as Record<string, unknown>[]) {
        const name = String(disk["name"]);
        const zone_ = String(disk["zone"]).split("/").pop() ?? "";
        const type = String(disk["type"]).split("/").pop() ?? "";
        results.push({
          id: this.id(accountId, "gce-disk", `${p}/${zone_}/${name}`),
          pluginId: "gcp",
          resourceTypeId: "gce-disk",
          accountId,
          displayName: name,
          fields: {
            name,
            zone: zone_,
            sizeGb: Number(disk["sizeGb"] ?? 0),
            type,
            status: String(disk["status"] ?? ""),
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${p}/${zone_}/${name}`,
          createdAt: String(disk["creationTimestamp"] ?? this.now()),
          updatedAt: this.now(),
        });
      }
    }
    return results;
  }

  private async listGkeClusters(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ clusters?: Record<string, unknown>[] }>(
      `https://container.googleapis.com/v1/projects/${p}/locations/-/clusters`,
    );
    return (data.clusters ?? []).map((c) => {
      const name = String(c["name"]);
      const location = String(c["location"] ?? "");
      const nodePool = (c["nodePools"] as Array<Record<string, unknown>> | undefined)?.[0];
      const nodeCount = Number(
        (nodePool?.["initialNodeCount"] as number | undefined) ?? 0,
      );
      return {
        id: this.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "gke-cluster",
        accountId,
        displayName: name,
        fields: {
          name,
          location,
          version: String(c["currentMasterVersion"] ?? ""),
          nodeCount,
          status: String(c["status"] ?? ""),
        },
        resolvedOutputs: {
          clusterEndpoint: String(c["endpoint"] ?? ""),
        },
        secretStates: [],
        externalId: name,
        createdAt: String(c["createTime"] ?? this.now()),
        updatedAt: String(c["updateTime"] ?? this.now()),
      };
    });
  }

  private async listCloudSqlInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://sqladmin.googleapis.com/v1/projects/${p}/instances`,
      "items",
    );
    return items.map((db) => {
      const ip = (db["ipAddresses"] as Array<Record<string, unknown>> | undefined)?.find(
        (a) => a["type"] === "PRIMARY",
      );
      return {
        id: this.id(accountId, "cloudsql-instance", String(db["name"])),
        pluginId: "gcp",
        resourceTypeId: "cloudsql-instance",
        accountId,
        displayName: String(db["name"]),
        fields: {
          name: String(db["name"]),
          databaseVersion: String(db["databaseVersion"] ?? ""),
          region: String(db["region"] ?? ""),
          tier: String(
            (db["settings"] as Record<string, unknown> | undefined)?.["tier"] ?? "",
          ),
          state: String(db["state"] ?? ""),
          availabilityType: String(
            (db["settings"] as Record<string, unknown> | undefined)?.["availabilityType"] ?? "",
          ),
        },
        resolvedOutputs: {
          connectionName: String(db["connectionName"] ?? ""),
          ipAddress: String(ip?.["ipAddress"] ?? ""),
        },
        secretStates: [],
        externalId: String(db["name"]),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listSpannerInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://spanner.googleapis.com/v1/projects/${p}/instances`,
      "instances",
    );
    return items.map((inst) => {
      const name = String(inst["name"]).split("/").pop() ?? "";
      return {
        id: this.id(accountId, "spanner-instance", name),
        pluginId: "gcp",
        resourceTypeId: "spanner-instance",
        accountId,
        displayName: String(inst["displayName"] ?? name),
        fields: {
          name,
          displayName: String(inst["displayName"] ?? ""),
          config: String(inst["config"] ?? "").split("/").pop() ?? "",
          nodeCount: Number(inst["nodeCount"] ?? 0),
          processingUnits: Number(inst["processingUnits"] ?? 0),
          state: String(inst["state"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listBigtableInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ instances?: Record<string, unknown>[] }>(
      `https://bigtableadmin.googleapis.com/v2/projects/${p}/instances`,
    );
    return (data.instances ?? []).map((inst) => {
      const name = String(inst["name"]).split("/").pop() ?? "";
      return {
        id: this.id(accountId, "bigtable-instance", name),
        pluginId: "gcp",
        resourceTypeId: "bigtable-instance",
        accountId,
        displayName: String(inst["displayName"] ?? name),
        fields: {
          name,
          displayName: String(inst["displayName"] ?? ""),
          type: String(inst["type"] ?? ""),
          state: String(inst["state"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listFirestoreDatabases(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ databases?: Record<string, unknown>[] }>(
      `https://firestore.googleapis.com/v1/projects/${p}/databases`,
    );
    return (data.databases ?? []).map((db) => {
      const name = String(db["name"]).split("/").pop() ?? "";
      return {
        id: this.id(accountId, "firestore-database", `${p}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "firestore-database",
        accountId,
        displayName: name === "(default)" ? `${p} (default)` : name,
        fields: {
          name,
          locationId: String(db["locationId"] ?? ""),
          type: String(db["type"] ?? ""),
          concurrencyMode: String(db["concurrencyMode"] ?? ""),
          state: String(db["state"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: String(db["createTime"] ?? this.now()),
        updatedAt: String(db["updateTime"] ?? this.now()),
      };
    });
  }

  private async listMemorystoreRedis(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://redis.googleapis.com/v1/projects/${p}/locations/-/instances`,
      "instances",
    );
    return items.map((inst) => {
      const fullName = String(inst["name"]);
      const name = fullName.split("/").pop() ?? "";
      const region = fullName.split("/")[3] ?? "";
      return {
        id: this.id(accountId, "memorystore-redis", fullName),
        pluginId: "gcp",
        resourceTypeId: "memorystore-redis",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          tier: String(inst["tier"] ?? ""),
          memorySizeGb: Number(inst["memorySizeGb"] ?? 0),
          redisVersion: String(inst["redisVersion"] ?? ""),
          state: String(inst["state"] ?? ""),
        },
        resolvedOutputs: {
          host: String(inst["host"] ?? ""),
          port: String(inst["port"] ?? "6379"),
        },
        secretStates: [],
        externalId: fullName,
        createdAt: String(inst["createTime"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listAlloyDbClusters(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://alloydb.googleapis.com/v1/projects/${p}/locations/-/clusters`,
      "clusters",
    );
    return items.map((c) => {
      const fullName = String(c["name"]);
      const name = fullName.split("/").pop() ?? "";
      const location = fullName.split("/")[3] ?? "";
      const primary = c["primaryConfig"] as Record<string, unknown> | undefined;
      const endpoint = String(
        (primary?.["nodes"] as Array<Record<string, unknown>> | undefined)?.[0]?.["ipAddress"] ?? "",
      );
      return {
        id: this.id(accountId, "alloydb-cluster", fullName),
        pluginId: "gcp",
        resourceTypeId: "alloydb-cluster",
        accountId,
        displayName: String(c["displayName"] ?? name),
        fields: {
          name,
          location,
          databaseVersion: String(c["databaseVersion"] ?? ""),
          state: String(c["state"] ?? ""),
          clusterType: String(c["clusterType"] ?? ""),
        },
        resolvedOutputs: { primaryEndpoint: endpoint },
        secretStates: [],
        externalId: fullName,
        createdAt: String(c["createTime"] ?? this.now()),
        updatedAt: String(c["updateTime"] ?? this.now()),
      };
    });
  }

  private async listGcsBuckets(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://storage.googleapis.com/storage/v1/b`,
      "items",
      { project: p },
    );
    return items.map((b) => {
      const name = String(b["name"]);
      const versioning = !!(b["versioning"] as Record<string, unknown> | undefined)?.["enabled"];
      return {
        id: this.id(accountId, "gcs-bucket", name),
        pluginId: "gcp",
        resourceTypeId: "gcs-bucket",
        accountId,
        displayName: name,
        fields: {
          name,
          location: String(b["location"] ?? ""),
          storageClass: String(b["storageClass"] ?? ""),
          publicAccessPrevention: String(
            (b["iamConfiguration"] as Record<string, unknown> | undefined)?.["publicAccessPrevention"] ?? "",
          ),
          versioning,
        },
        resolvedOutputs: { endpoint: `https://storage.googleapis.com/${name}` },
        secretStates: [],
        externalId: name,
        createdAt: String(b["timeCreated"] ?? this.now()),
        updatedAt: String(b["updated"] ?? this.now()),
      };
    });
  }

  private async listPubSubTopics(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://pubsub.googleapis.com/v1/projects/${p}/topics`,
      "topics",
    );
    return items.map((t) => {
      const fullName = String(t["name"]);
      const name = fullName.split("/").pop() ?? "";
      return {
        id: this.id(accountId, "pubsub-topic", fullName),
        pluginId: "gcp",
        resourceTypeId: "pubsub-topic",
        accountId,
        displayName: name,
        fields: {
          name,
          kmsKeyName: String(t["kmsKeyName"] ?? ""),
          messageRetentionDuration: String(t["messageRetentionDuration"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listPubSubSubscriptions(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://pubsub.googleapis.com/v1/projects/${p}/subscriptions`,
      "subscriptions",
    );
    return items.map((s) => {
      const fullName = String(s["name"]);
      const name = fullName.split("/").pop() ?? "";
      const topicFull = String(s["topic"] ?? "");
      const topic = topicFull.split("/").pop() ?? topicFull;
      return {
        id: this.id(accountId, "pubsub-subscription", fullName),
        pluginId: "gcp",
        resourceTypeId: "pubsub-subscription",
        accountId,
        displayName: name,
        fields: {
          name,
          topic,
          ackDeadlineSeconds: Number(s["ackDeadlineSeconds"] ?? 10),
          messageRetentionDuration: String(s["messageRetentionDuration"] ?? ""),
          filter: String(s["filter"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listCloudRunServices(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://run.googleapis.com/v2/projects/${p}/locations/-/services`,
      "services",
    );
    return items.map((svc) => {
      const fullName = String(svc["name"]);
      const name = fullName.split("/").pop() ?? "";
      const region = fullName.split("/")[3] ?? "";
      const cond = (svc["conditions"] as Array<Record<string, unknown>> | undefined)?.find(
        (c) => c["type"] === "Ready",
      );
      const state = cond ? String(cond["state"] ?? "") : "UNKNOWN";
      return {
        id: this.id(accountId, "cloud-run-service", fullName),
        pluginId: "gcp",
        resourceTypeId: "cloud-run-service",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          latestRevision: String(svc["latestReadyRevision"] ?? "").split("/").pop() ?? "",
          state,
          ingress: String(svc["ingress"] ?? ""),
        },
        resolvedOutputs: { url: String(svc["uri"] ?? "") },
        secretStates: [],
        externalId: fullName,
        createdAt: String(svc["createTime"] ?? this.now()),
        updatedAt: String(svc["updateTime"] ?? this.now()),
      };
    });
  }

  private async listCloudFunctions(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/-/functions`,
      "functions",
    );
    return items.map((fn) => {
      const fullName = String(fn["name"]);
      const name = fullName.split("/").pop() ?? "";
      const region = fullName.split("/")[3] ?? "";
      const serviceConfig = fn["serviceConfig"] as Record<string, unknown> | undefined;
      const buildConfig = fn["buildConfig"] as Record<string, unknown> | undefined;
      return {
        id: this.id(accountId, "cloud-function", fullName),
        pluginId: "gcp",
        resourceTypeId: "cloud-function",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          runtime: String(buildConfig?.["runtime"] ?? ""),
          state: String(fn["state"] ?? ""),
          availableMemory: String(serviceConfig?.["availableMemory"] ?? ""),
          timeout: String(serviceConfig?.["timeoutSeconds"] ?? ""),
        },
        resolvedOutputs: {
          url: String(serviceConfig?.["uri"] ?? ""),
        },
        secretStates: [],
        externalId: fullName,
        createdAt: String(fn["createTime"] ?? this.now()),
        updatedAt: String(fn["updateTime"] ?? this.now()),
      };
    });
  }

  private async listVpcNetworks(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
      "items",
    );
    return items.map((net) => {
      const name = String(net["name"]);
      const subnetCount = (net["subnetworks"] as unknown[] | undefined)?.length ?? 0;
      return {
        id: this.id(accountId, "vpc-network", `${p}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "vpc-network",
        accountId,
        displayName: name,
        fields: {
          name,
          description: String(net["description"] ?? ""),
          autoCreateSubnetworks: Boolean(net["autoCreateSubnetworks"]),
          mtu: Number(net["mtu"] ?? 1460),
          subnetCount,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}/${name}`,
        createdAt: String(net["creationTimestamp"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listBigQueryDatasets(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`,
      "datasets",
    );
    return items.map((ds) => {
      const ref = ds["datasetReference"] as Record<string, string> | undefined;
      const datasetId = ref?.["datasetId"] ?? String(ds["id"]).split(":").pop() ?? "";
      const meta = ds["friendlyName"] as string | undefined;
      return {
        id: this.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
        pluginId: "gcp",
        resourceTypeId: "bigquery-dataset",
        accountId,
        displayName: meta ?? datasetId,
        fields: {
          name: datasetId,
          location: String(ds["location"] ?? ""),
          description: String(ds["description"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}:${datasetId}`,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listArtifactRegistryRepos(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://artifactregistry.googleapis.com/v1/projects/${p}/locations/-/repositories`,
      "repositories",
    );
    return items.map((repo) => {
      const fullName = String(repo["name"]);
      const name = fullName.split("/").pop() ?? "";
      const location = fullName.split("/")[3] ?? "";
      const sizeBytes = Number(repo["sizeBytes"] ?? 0);
      const sizeLabel =
        sizeBytes > 1_073_741_824
          ? `${(sizeBytes / 1_073_741_824).toFixed(1)} GB`
          : sizeBytes > 1_048_576
          ? `${(sizeBytes / 1_048_576).toFixed(1)} MB`
          : `${Math.round(sizeBytes / 1024)} KB`;
      return {
        id: this.id(accountId, "artifact-registry-repo", fullName),
        pluginId: "gcp",
        resourceTypeId: "artifact-registry-repo",
        accountId,
        displayName: name,
        fields: {
          name,
          location,
          format: String(repo["format"] ?? ""),
          description: String(repo["description"] ?? ""),
          sizeBytes: sizeLabel,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: String(repo["createTime"] ?? this.now()),
        updatedAt: String(repo["updateTime"] ?? this.now()),
      };
    });
  }

  private async listServiceAccounts(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://iam.googleapis.com/v1/projects/${p}/serviceAccounts`,
      "accounts",
    );
    return items.map((sa) => {
      const email = String(sa["email"]);
      return {
        id: this.id(accountId, "gcp-service-account", email),
        pluginId: "gcp",
        resourceTypeId: "gcp-service-account",
        accountId,
        displayName: String(sa["displayName"] ?? email.split("@")[0] ?? email),
        fields: {
          name: String(sa["name"]).split("/").pop() ?? "",
          email,
          displayName: String(sa["displayName"] ?? ""),
          disabled: Boolean(sa["disabled"]),
          description: String(sa["description"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: email,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listCloudArmorPolicies(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies`,
      "items",
    );
    return items.map((policy) => {
      const name = String(policy["name"]);
      const rules = policy["rules"] as unknown[] | undefined;
      return {
        id: this.id(accountId, "cloud-armor-policy", `${p}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "cloud-armor-policy",
        accountId,
        displayName: name,
        fields: {
          name,
          description: String(policy["description"] ?? ""),
          type: String(policy["type"] ?? "CLOUD_ARMOR"),
          ruleCount: rules?.length ?? 0,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}/${name}`,
        createdAt: String(policy["creationTimestamp"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listSecretManagerSecrets(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://secretmanager.googleapis.com/v1/projects/${p}/secrets`,
      "secrets",
    );
    return items.map((secret) => {
      const fullName = String(secret["name"]);
      const name = fullName.split("/").pop() ?? "";
      const replication = secret["replication"] as Record<string, unknown> | undefined;
      const replicationType = replication?.["automatic"]
        ? "automatic"
        : replication?.["userManaged"]
        ? "user-managed"
        : "unknown";
      return {
        id: this.id(accountId, "secret-manager-secret", fullName),
        pluginId: "gcp",
        resourceTypeId: "secret-manager-secret",
        accountId,
        displayName: name,
        fields: {
          name,
          replicationType,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: String(secret["createTime"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listDataflowJobs(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs`,
      "jobs",
      { filter: "ACTIVE" },
    );
    return items.map((job) => {
      const name = String(job["name"]);
      const region = String(job["location"] ?? "");
      const sdkVersion = (job["jobMetadata"] as Record<string, unknown> | undefined)?.["sdkVersion"] as
        | Record<string, string>
        | undefined;
      return {
        id: this.id(accountId, "dataflow-job", String(job["id"])),
        pluginId: "gcp",
        resourceTypeId: "dataflow-job",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          type: String(job["type"] ?? ""),
          state: String(job["currentState"] ?? ""),
          sdkVersion: sdkVersion?.["version"] ?? "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(job["id"]),
        createdAt: String(job["createTime"] ?? this.now()),
        updatedAt: String(job["currentStateTime"] ?? this.now()),
      };
    });
  }
}
