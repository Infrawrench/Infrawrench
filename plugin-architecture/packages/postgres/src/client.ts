import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";

/**
 * Postgres plugin client.
 * The connectionString is already resolved (decrypted) by the host's SecretResolver
 * before createClient() is called — the plugin receives the plaintext URI.
 */
export class PostgresClient implements PluginClient {
  private readonly connectionString: string;

  constructor(credentials: Record<string, string>) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("Postgres plugin: missing connectionString credential");
    this.connectionString = cs;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "pg-database":
        return this.listDatabases(accountId);
      case "pg-schema":
        return this.listSchemas(accountId);
      default:
        throw new Error(`Postgres plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Postgres plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    _resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    if (typeId === "pg-database" && outputKey === "serverVersion") {
      // Would query: SELECT version() FROM pg_catalog
      return "PostgreSQL 16.2";
    }
    if (typeId === "pg-database" && outputKey === "schemaNames") {
      // Would query: SELECT schema_name FROM information_schema.schemata
      return JSON.stringify(["public"]);
    }
    throw new Error(
      `Postgres plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const cs = resource.secretStates.find((s) => s.fieldKey === "connectionString");

    // The host pre-fetches table/column metadata and stores it in resolvedOutputs["__tables__"]
    // as a JSON string: Array<{ name: string; columns: Array<{ name: string; type: string }> }>
    let tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }> = [];
    const tablesJson = resource.resolvedOutputs["__tables__"];
    if (typeof tablesJson === "string" && tablesJson.length > 0) {
      try {
        tables = JSON.parse(tablesJson) as typeof tables;
      } catch {
        // ignore parse errors
      }
    }

    return {
      title: resource.displayName,
      subtitle: `${String(resource.fields["host"] ?? "PostgreSQL")} · ${String(resource.fields["database"] ?? "")}`,
      status: { kind: "status-dot", status: "unknown" },
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
                {
                  key: "Connection String",
                  value: cs
                    ? { kind: "secret-placeholder", fieldKey: "connectionString", resolution: cs.resolution }
                    : "(not set)",
                  sensitive: true,
                },
              ],
            },
            { kind: "action", label: "Reroll Connection", action: { type: "reroll-secret", fieldKey: "connectionString" } },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
        tables,
      },
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "unknown" },
    };
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    // Parse the database name from the connection string URI.
    // Real querying (pg_catalog.pg_database) requires native connectivity
    // via a Tauri Rust command — not yet implemented.
    const now = new Date().toISOString();
    let dbName = "postgres";
    let host = "unknown";
    try {
      const url = new URL(this.connectionString);
      dbName = url.pathname.replace(/^\//, "") || "postgres";
      host = url.hostname;
    } catch {
      // connection string may not be a parseable URL
    }
    return [
      {
        id: `${accountId}:pg-database:${dbName}`,
        pluginId: "postgres",
        resourceTypeId: "pg-database",
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

  private async listSchemas(accountId: string): Promise<ResourceInstance[]> {
    return [];
  }
}
