import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";

/**
 * MongoDB plugin client.
 *
 * Uses the KV host services channel to execute Mongo operations. The driver
 * (driver.ts) interprets the `cmd` string as a Mongo operation name and
 * parses JSON-encoded arguments.
 *
 * Command protocol:
 *   cmd = operation name (e.g. "listDatabases", "find", "dbStats")
 *   args[0] = database name (always required)
 *   args[1..] = operation-specific JSON-encoded params
 */
export class MongoDBClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("MongoDB plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "mongodb-database":
        return this.listDatabases(accountId);
      default:
        throw new Error(`MongoDB plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`MongoDB plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, _resourceId: string, outputKey: string): Promise<string> {
    if (typeId === "mongodb-database" && outputKey === "connectionString") {
      return this.connectionString;
    }
    throw new Error(`MongoDB plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: `${String(resource.fields["host"] ?? "MongoDB")} · ${String(resource.fields["database"] ?? "")}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Host", value: String(resource.fields["host"] ?? "—") },
                { key: "Database", value: String(resource.fields["database"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "healthy" },
    };
  }

  async fetchStats(): Promise<{ version: string; size: string; tableCount: number }> {
    const kv = this.services?.kv;
    if (!kv) return { version: "", size: "", tableCount: 0 };

    const dbName = this.parseDatabaseName();
    try {
      const raw = await kv.command("dbStats", dbName);
      const stats = raw as {
        db: string;
        collections: number;
        dataSize: number;
        storageSize: number;
        ok: number;
      };
      const sizeMb = ((stats.storageSize ?? stats.dataSize ?? 0) / 1024 / 1024).toFixed(1);

      const versionRaw = await kv.command("serverVersion", dbName);
      const version = String(versionRaw ?? "");

      return {
        version,
        size: `${sizeMb} MB`,
        tableCount: stats.collections ?? 0,
      };
    } catch {
      return { version: "", size: "", tableCount: 0 };
    }
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    let host = "unknown";
    try {
      const url = new URL(this.connectionString);
      host = url.hostname;
    } catch {
      /* may not be parseable */
    }

    if (this.services?.kv) {
      try {
        const raw = await this.services.kv.command("listDatabases", "admin");
        const result = raw as { databases: Array<{ name: string; sizeOnDisk: number }> };
        return result.databases
          .filter((db) => !["admin", "local", "config"].includes(db.name))
          .map((db) => ({
            id: `${accountId}:mongodb-database:${db.name}`,
            pluginId: "mongodb",
            resourceTypeId: "mongodb-database",
            accountId,
            displayName: db.name,
            fields: { host, database: db.name },
            resolvedOutputs: {},
            secretStates: [],
            createdAt: now,
            updatedAt: now,
          }));
      } catch {
        // Fall through to URL parsing
      }
    }

    // Fallback: parse DB name from connection string
    let dbName = "test";
    try {
      const url = new URL(this.connectionString);
      dbName = url.pathname.replace(/^\//, "") || "test";
    } catch {
      /* ignore */
    }

    return [
      {
        id: `${accountId}:mongodb-database:${dbName}`,
        pluginId: "mongodb",
        resourceTypeId: "mongodb-database",
        accountId,
        displayName: dbName,
        fields: { host, database: dbName },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private parseDatabaseName(): string {
    try {
      const url = new URL(this.connectionString);
      return url.pathname.replace(/^\//, "") || "test";
    } catch {
      return "test";
    }
  }
}
