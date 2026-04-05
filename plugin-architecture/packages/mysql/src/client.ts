import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";

export class MySQLClient implements PluginClient {
  private readonly connectionString: string;

  constructor(credentials: Record<string, string>) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("MySQL plugin: missing connectionString credential");
    this.connectionString = cs;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "mysql-database":
        return this.listDatabases(accountId);
      default:
        throw new Error(`MySQL plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`MySQL plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, _resourceId: string, outputKey: string): Promise<string> {
    throw new Error(`MySQL plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    let tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }> = [];
    const tablesJson = resource.resolvedOutputs["__tables__"];
    if (typeof tablesJson === "string" && tablesJson.length > 0) {
      try { tables = JSON.parse(tablesJson) as typeof tables; } catch { /* ignore */ }
    }

    return {
      title: resource.displayName,
      subtitle: `${String(resource.fields["host"] ?? "MySQL")} · ${String(resource.fields["database"] ?? "")}`,
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
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery: "SELECT * FROM information_schema.tables WHERE table_schema = DATABASE() LIMIT 20;",
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
    const now = new Date().toISOString();
    let dbName = "mysql";
    let host = "unknown";
    try {
      const url = new URL(this.connectionString);
      dbName = url.pathname.replace(/^\//, "") || "mysql";
      host = url.hostname;
    } catch { /* connection string may not be a parseable URL */ }

    return [
      {
        id: `${accountId}:mysql-database:${dbName}`,
        pluginId: "mysql",
        resourceTypeId: "mysql-database",
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
}
