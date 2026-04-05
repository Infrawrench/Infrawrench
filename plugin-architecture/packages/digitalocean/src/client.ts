import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";

/**
 * DigitalOcean plugin client.
 * Created per account (per API token) by the host.
 * All API calls are made server-side — the token never reaches the browser.
 */
export class DigitalOceanClient implements PluginClient {
  private readonly token: string;
  private readonly baseUrl = "https://api.digitalocean.com/v2";

  constructor(credentials: Record<string, string>) {
    const token = credentials["apiToken"];
    if (!token) throw new Error("DigitalOcean plugin: missing apiToken credential");
    this.token = token;
  }

  private async fetch<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`DO API error ${res.status} for ${path}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
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
        database: { connection: Record<string, string> };
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
      }
    }

    throw new Error(
      `DigitalOcean plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} · ${String(fields["region"] ?? "")}`,
      status: { kind: "status-dot", status: "unknown" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  // ─── Private list helpers ─────────────────────────────────────────────────

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
      const nodePool = (
        c["node_pools"] as Array<Record<string, unknown>> | undefined
      )?.[0];
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
    // Spaces uses S3-compatible API — stub for now
    return [];
  }

  // Satisfy the required fields from DOKSClusterResourceType and ManagedDatabaseResourceType
  // so TypeScript knows they are used
  static readonly _resourceTypes = [DOKSClusterResourceType, ManagedDatabaseResourceType];
}
