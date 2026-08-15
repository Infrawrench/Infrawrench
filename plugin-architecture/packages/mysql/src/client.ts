import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  DashboardStat,
  PeerPaneContext,
  PeerPaneSchema,
  PeerPaneResource,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";

const SYSTEM_DATABASES = new Set(["information_schema", "performance_schema", "mysql", "sys"]);

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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`MySQL plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string> {
    if (typeId === "mysql-database") {
      if (outputKey === "connectionString") {
        return this.connectionStringForDatabase(this.databaseNameFromResourceId(resourceId));
      }
      if (outputKey === "serverVersion") {
        const sql = this.services?.sql;
        if (!sql) return "";
        const rows = (await sql.query("SELECT VERSION() AS version")) as Array<{
          version?: unknown;
        }>;
        return String(rows[0]?.version ?? "");
      }
    }
    throw new Error(`MySQL plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "mysql-database") {
      throw new Error(`MySQL plugin: no create config for type "${typeId}"`);
    }
    return {
      fields: [
        {
          key: "name",
          label: "Database name",
          kind: "text",
          required: true,
          placeholder: "appdb",
        },
        {
          key: "characterSet",
          label: "Character set",
          kind: "text",
          required: false,
          defaultValue: "utf8mb4",
          placeholder: "utf8mb4",
        },
        {
          key: "collation",
          label: "Collation",
          kind: "text",
          required: false,
          placeholder: "utf8mb4_0900_ai_ci",
        },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "mysql-database") {
      throw new Error(`MySQL plugin: createResource not supported for type "${typeId}"`);
    }
    const sql = this.services?.sql;
    if (!sql) throw new Error("MySQL SQL service not available");

    const dbName = this.validateDatabaseName(fields["name"] ?? "");
    const characterSet = this.optionalIdentifier(fields["characterSet"] ?? "");
    const collation = this.optionalIdentifier(fields["collation"] ?? "");

    let statement = `CREATE DATABASE \`${dbName}\``;
    if (characterSet) statement += ` CHARACTER SET ${characterSet}`;
    if (collation) statement += ` COLLATE ${collation}`;
    await sql.execute(statement, []);

    const now = new Date().toISOString();
    return {
      id: `${accountId}:mysql-database:${dbName}`,
      pluginId: "mysql",
      resourceTypeId: "mysql-database",
      accountId,
      displayName: dbName,
      externalId: dbName,
      fields: { host: this.hostFromConnectionString(), database: dbName },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "mysql-database") {
      throw new Error(`MySQL plugin: deleteResource not supported for type "${typeId}"`);
    }
    const sql = this.services?.sql;
    if (!sql) throw new Error("MySQL SQL service not available");
    const dbName = this.databaseNameFromResourceId(resourceId);
    if (SYSTEM_DATABASES.has(dbName)) {
      throw new Error(`Cannot delete system database "${dbName}"`);
    }
    this.validateDatabaseName(dbName);
    await sql.execute(`DROP DATABASE \`${dbName}\``, []);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    let tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }> = [];
    const tablesJson = resource.resolvedOutputs["__tables__"];
    if (typeof tablesJson === "string" && tablesJson.length > 0) {
      try {
        tables = JSON.parse(tablesJson) as typeof tables;
      } catch {
        /* ignore */
      }
    }

    return {
      title: resource.displayName,
      subtitle: joinSubtitle(
        String(resource.fields["host"] ?? "MySQL"),
        resource.fields["database"],
      ),
      status: { kind: "status-dot", status: "info" },
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
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery:
          "SELECT * FROM information_schema.tables WHERE table_schema = DATABASE() LIMIT 20;",
        tables,
      },
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  async renderPeerPane(context: PeerPaneContext): Promise<PeerPaneSchema> {
    let host = "";
    try {
      host = new URL(this.connectionString).hostname;
    } catch {
      /* connectionString may not be a parseable URL */
    }

    const databases: PeerPaneResource[] = [];
    const sql = this.services?.sql;
    if (sql) {
      const rows = (await sql.query("SHOW DATABASES")) as { Database: string }[];
      const systemDbs = new Set(["information_schema", "performance_schema", "mysql", "sys"]);
      for (const row of rows) {
        if (systemDbs.has(row.Database)) continue;
        databases.push({
          id: `${context.accountId}:mysql-database:${row.Database}`,
          pluginId: "mysql",
          resourceTypeId: "mysql-database",
          displayName: row.Database,
          subtitle: host,
          status: "healthy",
          fields: { host, database: row.Database },
        });
      }
    }

    return {
      resourceGroups: [
        {
          title: `Databases (${databases.length})`,
          resourceTypeId: "mysql-database",
          pluginId: "mysql",
          items: databases,
        },
      ],
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
    for (const col of columnRows as {
      table_name: string;
      column_name: string;
      data_type: string;
    }[]) {
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

  async fetchDashboardStats(
    _resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    const sql = this.services?.sql;
    if (!sql) {
      return [
        { label: "Version", value: "" },
        { label: "Size", value: "" },
        { label: "Tables", value: "0" },
      ];
    }

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
    return [
      { label: "Version", value: version },
      { label: "Size", value: size },
      { label: "Tables", value: String(tableCount) },
    ];
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();

    // If host SQL services are available, query the actual server
    if (this.services?.sql) {
      try {
        const rows = await this.services.sql.query("SHOW DATABASES");
        const host = this.hostFromConnectionString();
        return (rows as { Database: string }[])
          .filter((r) => !SYSTEM_DATABASES.has(r.Database))
          .map((row) => ({
            id: `${accountId}:mysql-database:${row.Database}`,
            pluginId: "mysql",
            resourceTypeId: "mysql-database",
            accountId,
            displayName: row.Database,
            externalId: row.Database,
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
    } catch {
      /* connection string may not be a parseable URL */
    }

    return [
      {
        id: `${accountId}:mysql-database:${dbName}`,
        pluginId: "mysql",
        resourceTypeId: "mysql-database",
        accountId,
        displayName: dbName,
        externalId: dbName,
        fields: { host, database: dbName },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private databaseNameFromResourceId(resourceId: string): string {
    const dbName = resourceId.split(":").pop();
    if (!dbName) throw new Error("Cannot parse database name");
    return dbName;
  }

  private validateDatabaseName(value: string): string {
    const dbName = value.trim();
    if (!dbName) throw new Error("Database name is required");
    if (dbName.length > 64 || dbName.includes("`") || dbName.includes("\0")) {
      throw new Error("Invalid database name");
    }
    if (SYSTEM_DATABASES.has(dbName)) {
      throw new Error(`Cannot create system database "${dbName}"`);
    }
    return dbName;
  }

  private optionalIdentifier(value: string): string {
    const identifier = value.trim();
    if (!identifier) return "";
    if (!/^[A-Za-z0-9_$]+$/.test(identifier)) {
      throw new Error("Invalid MySQL identifier");
    }
    return identifier;
  }

  private hostFromConnectionString(): string {
    try {
      return new URL(this.connectionString).hostname;
    } catch {
      return "unknown";
    }
  }

  private connectionStringForDatabase(dbName: string): string {
    try {
      const url = new URL(this.connectionString);
      url.pathname = `/${dbName}`;
      return url.toString();
    } catch {
      return this.connectionString;
    }
  }
}
