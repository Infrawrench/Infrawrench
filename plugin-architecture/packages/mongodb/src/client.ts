import type { Credentials } from "./plugin.js";
import { attempt } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
  MetricSeries,
  PeerPaneContext,
  PeerPaneSchema,
  PeerPaneResource,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";
import { joinSubtitle, reportUnreadListPart } from "@infrawrench/plugin-base";

/**
 * Whether this login may not run `listDatabases`, as opposed to a failed read: code 13,
 * or Atlas's wording, which comes with its catch-all code 8000. Current servers narrow
 * the list for a login without the action, so this is an anonymous login or an old
 * server. The desktop's IPC keeps only the message, so `code` is not always there.
 */
function isListDatabasesRefused(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  return (
    code === 13 ||
    /not authorized on|requires authentication|is not allowed to do action/i.test(String(err))
  );
}

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

  constructor(credentials: Credentials, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("MongoDB plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(() => this.list(typeId, accountId, false));
  }

  /** `lookup` is for finding one row, which a refused list of the rest says nothing about. */
  private async list(
    typeId: string,
    accountId: string,
    lookup: boolean,
  ): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "mongodb-database":
        return this.listDatabases(accountId, lookup);
      default:
        throw new Error(`MongoDB plugin: unknown resource type "${typeId}"`);
    }
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const all = await this.list(typeId, accountId, true);
      const found = all.find((r) => r.id === resourceId);
      if (!found) throw new Error(`MongoDB plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  resolveOutput(typeId: string, resourceId: string, outputKey: string): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "mongodb-database" && outputKey === "connectionString") {
        return this.connectionString;
      }
      if (typeId === "mongodb-database" && outputKey === "serverVersion") {
        const kv = this.services?.kv;
        if (!kv) throw new Error("MongoDB KV service not available");
        const dbName = resourceId.split(":").pop() ?? this.parseDatabaseName();
        return String(await kv.command("serverVersion", dbName));
      }
      throw new Error(`MongoDB plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      if (typeId !== "mongodb-database") {
        throw new Error(`MongoDB plugin: deleteResource not supported for type "${typeId}"`);
      }
      const kv = this.services?.kv;
      if (!kv) throw new Error("MongoDB KV service not available");
      const dbName = resourceId.split(":").pop();
      if (!dbName) throw new Error("Cannot parse database name");
      await kv.command("dropDatabase", dbName);
    });
  }

  getCreateConfig(_typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      // Mongo has no "create database" call: a database springs into existence
      // when its first collection is created. So we ask for both and create the
      // collection.
      return Promise.resolve({
        fields: [
          {
            key: "database",
            label: "Database name",
            kind: "text",
            required: true,
            description: "New database to create. Materialised by its first collection.",
          },
          {
            key: "collection",
            label: "First collection",
            kind: "text",
            required: true,
            defaultValue: "documents",
            description: "MongoDB needs at least one collection for the database to exist.",
          },
        ],
      });
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId !== "mongodb-database") {
        throw new Error(`MongoDB plugin: createResource not supported for type "${typeId}"`);
      }
      const kv = this.services?.kv;
      if (!kv) throw new Error("MongoDB KV service not available");
      const dbName = String(fields["database"] ?? "").trim();
      const collection = String(fields["collection"] ?? "").trim() || "documents";
      if (!dbName) throw new Error("Database name is required");
      await kv.command("createCollection", dbName, collection);
      let host = "";
      try {
        host = new URL(this.connectionString).hostname;
      } catch {
        /* connectionString may not be parseable */
      }
      const now = new Date().toISOString();
      return {
        id: `${accountId}:mongodb-database:${dbName}`,
        pluginId: "mongodb",
        resourceTypeId: "mongodb-database",
        accountId,
        displayName: dbName,
        fields: { host, database: dbName },
        resolvedOutputs: { connectionString: this.connectionString },
        secretStates: [],
        externalId: dbName,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        String(resource.fields["host"] ?? "MongoDB"),
        resource.fields["database"],
      ),
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
      // `mongodb-database` declares `supportsMetrics`, so the host fetches the
      // `dbStats` series for this view; without the capability it had nowhere
      // to put them. No default window: `dbStats` is a reading taken now, not
      // a range.
      metricsCapability: {},
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "healthy" },
    };
  }

  renderPeerPane(context: PeerPaneContext): PluginEffect<PeerPaneSchema> {
    return attempt(async () => {
      let host = "";
      try {
        host = new URL(this.connectionString).hostname;
      } catch {
        /* connectionString may not be a parseable URI */
      }

      const databases: PeerPaneResource[] = [];
      const kv = this.services?.kv;
      if (kv) {
        const raw = await kv.command("listDatabases", "admin");
        const result = raw as { databases?: Array<{ name: string }> };
        for (const db of result.databases ?? []) {
          if (["admin", "local", "config"].includes(db.name)) continue;
          databases.push({
            id: `${context.accountId}:mongodb-database:${db.name}`,
            pluginId: "mongodb",
            resourceTypeId: "mongodb-database",
            displayName: db.name,
            subtitle: host,
            status: "healthy",
            fields: { host, database: db.name },
          });
        }
      }

      return {
        resourceGroups: [
          {
            title: `Databases (${databases.length})`,
            resourceTypeId: "mongodb-database",
            pluginId: "mongodb",
            items: databases,
            // Surface a "+ Create" button (incl. when empty) so users can mint a
            // database + first collection right here instead of hitting a
            // dead-end on a fresh cluster.
            supportsCreate: true,
          },
        ],
      };
    });
  }

  fetchDashboardStats(
    _resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const kv = this.services?.kv;
      if (!kv) {
        return [
          { label: "Version", value: "" },
          { label: "Size", value: "" },
          { label: "Collections", value: "0" },
        ];
      }

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

        return [
          { label: "Version", value: version },
          { label: "Size", value: `${sizeMb} MB` },
          { label: "Collections", value: String(stats.collections ?? 0) },
        ];
      } catch {
        return [
          { label: "Version", value: "" },
          { label: "Size", value: "" },
          { label: "Collections", value: "0" },
        ];
      }
    });
  }

  fetchMetricSeries(
    _resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const kv = this.services?.kv;
      if (!kv) return [];
      const dbName = resourceId.split(":").pop() ?? this.parseDatabaseName();
      const raw = await kv.command("dbStats", dbName);
      const stats = raw as {
        collections?: number;
        objects?: number;
        indexes?: number;
        dataSize?: number;
        storageSize?: number;
        indexSize?: number;
      };
      const ts = Date.now();
      const mb = (b: number | undefined) => Number((((b ?? 0) / 1024 / 1024) as number).toFixed(3));
      return [
        {
          label: "Storage size",
          unit: "MB",
          points: [{ timestamp: ts, value: mb(stats.storageSize) }],
        },
        { label: "Data size", unit: "MB", points: [{ timestamp: ts, value: mb(stats.dataSize) }] },
        {
          label: "Index size",
          unit: "MB",
          points: [{ timestamp: ts, value: mb(stats.indexSize) }],
        },
        { label: "Collections", points: [{ timestamp: ts, value: stats.collections ?? 0 }] },
        { label: "Objects", points: [{ timestamp: ts, value: stats.objects ?? 0 }] },
        { label: "Indexes", points: [{ timestamp: ts, value: stats.indexes ?? 0 }] },
      ];
    });
  }

  private async listDatabases(accountId: string, lookup: boolean): Promise<ResourceInstance[]> {
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
      } catch (err) {
        if (!isListDatabasesRefused(err)) throw err;
        // Shows only the database the login connects to, which says nothing about the rest.
        // A host that keeps no track answers false, and there the refusal shows instead.
        if (!lookup && !reportUnreadListPart({ idPrefixes: [""] })) throw err;
      }
    }

    // No host KV service, or refused: parse DB name from connection string
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
