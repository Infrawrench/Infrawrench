import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  DashboardStat,
  CreateResourceConfig,
} from "@infrawrench/plugin-base";

const SYSTEM_DBS = new Set(["master", "tempdb", "model", "msdb"]);

export class MSSQLClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("MSSQL plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "mssql-database") {
      throw new Error(`MSSQL plugin: unknown resource type "${typeId}"`);
    }
    const now = new Date().toISOString();

    if (this.services?.sql) {
      try {
        const rows = await this.services.sql.query(
          "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name",
        );
        let host = "unknown";
        try {
          host = new URL(this.connectionString).hostname;
        } catch {
          /* ignore */
        }
        return (rows as { name: string }[]).map((row) => ({
          id: `${accountId}:mssql-database:${row.name}`,
          pluginId: "mssql",
          resourceTypeId: "mssql-database",
          accountId,
          displayName: row.name,
          externalId: row.name,
          fields: { host, database: row.name },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: now,
          updatedAt: now,
        }));
      } catch {
        // fall through to URL parsing
      }
    }

    let dbName = "master";
    let host = "unknown";
    try {
      const url = new URL(this.connectionString);
      dbName = url.pathname.replace(/^\//, "") || "master";
      host = url.hostname;
    } catch {
      /* connection string may not be a parseable URL */
    }

    return [
      {
        id: `${accountId}:mssql-database:${dbName}`,
        pluginId: "mssql",
        resourceTypeId: "mssql-database",
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`MSSQL plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string> {
    if (typeId === "mssql-database") {
      if (outputKey === "connectionString") {
        return this.connectionStringForDatabase(this.databaseNameFromResourceId(resourceId));
      }
      if (outputKey === "serverVersion") {
        const sql = this.services?.sql;
        if (!sql) return "";
        const rows = (await sql.query("SELECT @@VERSION AS version")) as Array<{
          version?: unknown;
        }>;
        return String(rows[0]?.version ?? "").split("\n")[0] ?? "";
      }
    }
    throw new Error(`MSSQL plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "mssql-database") {
      throw new Error(`MSSQL plugin: no create config for type "${typeId}"`);
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
          key: "collation",
          label: "Collation",
          kind: "text",
          required: false,
          placeholder: "SQL_Latin1_General_CP1_CI_AS",
        },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "mssql-database") {
      throw new Error(`MSSQL plugin: createResource not supported for type "${typeId}"`);
    }
    const sql = this.services?.sql;
    if (!sql) throw new Error("MSSQL SQL service not available");

    const dbName = this.validateDatabaseName(fields["name"] ?? "");
    const collation = this.optionalIdentifier(fields["collation"] ?? "");
    let statement = `CREATE DATABASE [${dbName}]`;
    if (collation) statement += ` COLLATE ${collation}`;
    await sql.execute(statement, []);

    const now = new Date().toISOString();
    return {
      id: `${accountId}:mssql-database:${dbName}`,
      pluginId: "mssql",
      resourceTypeId: "mssql-database",
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
    if (typeId !== "mssql-database") {
      throw new Error(`MSSQL plugin: deleteResource not supported for type "${typeId}"`);
    }
    const sql = this.services?.sql;
    if (!sql) throw new Error("MSSQL SQL service not available");
    const dbName = this.databaseNameFromResourceId(resourceId);
    if (SYSTEM_DBS.has(dbName)) {
      throw new Error(`Cannot delete system database "${dbName}"`);
    }
    this.validateDatabaseName(dbName);
    await sql.execute(`DROP DATABASE [${dbName}]`, []);
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
      subtitle: `${String(resource.fields["host"] ?? "SQL Server")} · ${String(resource.fields["database"] ?? "")}`,
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
          "SELECT TOP 20 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = DB_NAME() ORDER BY TABLE_SCHEMA, TABLE_NAME;",
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

  async introspect(): Promise<SqlTableMeta[]> {
    const sql = this.services?.sql;
    if (!sql) return [];

    const [tableRows, columnRows, pkRows] = await Promise.all([
      sql.query(
        "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = DB_NAME() AND TABLE_TYPE = 'BASE TABLE' ORDER BY name",
      ),
      sql.query(
        "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_CATALOG = DB_NAME() ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
      ),
      sql.query(
        `SELECT kcu.TABLE_SCHEMA + '.' + kcu.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
          AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND kcu.TABLE_CATALOG = DB_NAME()
         ORDER BY kcu.ORDINAL_POSITION`,
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

    return (tableRows as { name: string }[]).map((t) => ({
      name: t.name,
      columns: colsByTable.get(t.name) ?? [],
      pkColumns: pksByTable.get(t.name) ?? [],
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
        { label: "Tables", value: "0" },
      ];
    }

    const [versionRows, tableRows] = await Promise.all([
      sql.query("SELECT @@VERSION AS version"),
      sql.query(
        "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_CATALOG = DB_NAME() AND TABLE_TYPE = 'BASE TABLE'",
      ),
    ]);

    const versionRaw = String(versionRows[0]?.["version"] ?? "");
    const version = versionRaw.split("\n")[0] ?? versionRaw;
    const tableCount = Number(tableRows[0]?.["n"] ?? 0);
    return [
      { label: "Version", value: version },
      { label: "Tables", value: String(tableCount) },
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
    if (dbName.length > 128 || dbName.includes("]") || dbName.includes("\0")) {
      throw new Error("Invalid database name");
    }
    if (SYSTEM_DBS.has(dbName)) {
      throw new Error(`Cannot create system database "${dbName}"`);
    }
    return dbName;
  }

  private optionalIdentifier(value: string): string {
    const identifier = value.trim();
    if (!identifier) return "";
    if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
      throw new Error("Invalid SQL Server identifier");
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
