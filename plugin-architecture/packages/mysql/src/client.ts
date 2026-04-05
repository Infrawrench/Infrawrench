import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";

export class MySQLClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("MySQL plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
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

  async introspect(): Promise<SqlTableMeta[]> {
    const sql = this.services?.sql;
    if (!sql) return [];

    const [tableRows, columnRows, pkRows] = await Promise.all([
      sql.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
      ),
      sql.query(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position",
      ),
      sql.query(
        "SELECT table_name, column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND constraint_name = 'PRIMARY' ORDER BY table_name, ordinal_position",
      ),
    ]);

    const colsByTable = new Map<string, { name: string; type: string }[]>();
    for (const col of columnRows as { table_name: string; column_name: string; data_type: string }[]) {
      if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
      colsByTable.get(col.table_name)!.push({ name: col.column_name, type: col.data_type });
    }
    const pksByTable = new Map<string, string[]>();
    for (const pk of pkRows as { table_name: string; column_name: string }[]) {
      if (!pksByTable.has(pk.table_name)) pksByTable.set(pk.table_name, []);
      pksByTable.get(pk.table_name)!.push(pk.column_name);
    }

    return (tableRows as { table_name: string }[]).map((t) => ({
      name: t.table_name,
      columns: colsByTable.get(t.table_name) ?? [],
      pkColumns: pksByTable.get(t.table_name) ?? [],
    }));
  }

  async fetchStats(): Promise<{ version: string; size: string; tableCount: number }> {
    const sql = this.services?.sql;
    if (!sql) return { version: "", size: "", tableCount: 0 };

    const [versionRows, sizeRows, tableRows] = await Promise.all([
      sql.query("SELECT VERSION() AS version"),
      sql.query(
        `SELECT CONCAT(ROUND(SUM(data_length + index_length) / 1024 / 1024, 1), ' MB') AS size
         FROM information_schema.tables WHERE table_schema = DATABASE()`,
      ),
      sql.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
      ),
    ]);

    const version = String(versionRows[0]?.["version"] ?? "");
    const size = String(sizeRows[0]?.["size"] ?? "");
    const tableCount = Number(tableRows[0]?.["n"] ?? 0);
    return { version, size, tableCount };
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();

    // If host SQL services are available, query the actual server
    if (this.services?.sql) {
      try {
        const rows = await this.services.sql.query("SHOW DATABASES");
        let host = "unknown";
        try {
          host = new URL(this.connectionString).hostname;
        } catch { /* ignore */ }
        return (rows as { Database: string }[])
          .filter((r) => !["information_schema", "performance_schema", "mysql", "sys"].includes(r.Database))
          .map((row) => ({
            id: `${accountId}:mysql-database:${row.Database}`,
            pluginId: "mysql",
            resourceTypeId: "mysql-database",
            accountId,
            displayName: row.Database,
            fields: { host, database: row.Database },
            resolvedOutputs: {},
            secretStates: [],
            createdAt: now,
            updatedAt: now,
          }));
      } catch {
        // Fall through to URL parsing
      }
    }

    // Fallback: parse the connection string
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
