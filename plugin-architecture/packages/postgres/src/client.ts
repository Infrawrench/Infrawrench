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
} from "@infrawrench/plugin-base";

const VISIBLE_SCHEMA_FILTER =
  "schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp_%'";
const VISIBLE_TABLE_SCHEMA_FILTER =
  "table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp_%'";

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tableDisplayName(schemaName: string, tableName: string): string {
  return schemaName === "public" ? tableName : `${schemaName}.${tableName}`;
}

/**
 * Postgres plugin client.
 * The connectionString is already resolved (decrypted) by the host's SecretResolver
 * before createClient() is called — the plugin receives the plaintext URI.
 * When the host injects sql services, the plugin uses them to run introspection and
 * stats queries — keeping all SQL strings inside the plugin, not the host.
 */
export class PostgresClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    // Tolerate a missing/empty connectionString — peer-plugin flows resolve
    // credentials lazily, and the parent may not yet have an endpoint
    // (e.g. AlloyDB cluster without a primary instance). Methods that
    // actually need the connection surface a friendly error themselves.
    this.connectionString = credentials["connectionString"] ?? "";
    this.services = services;
  }

  private requireConnection(): string {
    if (!this.connectionString) {
      throw new Error(
        "PostgreSQL connection is not available yet. The parent resource hasn't published a reachable endpoint — wait for it to come online, or check that a public/private IP and credentials are configured.",
      );
    }
    return this.connectionString;
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
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "pg-database" && outputKey === "connectionString") {
      return this.connectionString;
    }
    if (typeId === "pg-database" && outputKey === "serverVersion") {
      const sql = this.services?.sql;
      if (!sql) return "";
      const rows = await sql.query("SELECT version()");
      return String(rows[0]?.["version"] ?? "")
        .split(" ")
        .slice(0, 2)
        .join(" ");
    }
    if (typeId === "pg-database" && outputKey === "schemaNames") {
      const schemas = await this.listSchemas(accountId);
      return JSON.stringify(schemas.map((schema) => String(schema.fields["name"] ?? "")));
    }
    if (typeId === "pg-schema" && outputKey === "tableCount") {
      const sql = this.services?.sql;
      if (!sql) return "0";
      const schemaName = resourceId.split(":").pop();
      if (!schemaName) throw new Error("Cannot parse schema name");
      const rows = await sql.query(
        `SELECT COUNT(*) AS n
         FROM information_schema.tables
         WHERE table_schema = ${sqlStringLiteral(schemaName)} AND table_type = 'BASE TABLE'`,
      );
      return String(Number(rows[0]?.["n"] ?? 0));
    }
    throw new Error(`Postgres plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const sql = this.services?.sql;
    if (!sql) throw new Error("PostgreSQL SQL service not available");
    const name = resourceId.split(":").pop();
    if (!name) throw new Error("Cannot parse resource name");
    if (name.includes('"')) throw new Error("Invalid identifier");

    switch (typeId) {
      case "pg-database": {
        const systemDbs = ["postgres", "template0", "template1"];
        if (systemDbs.includes(name)) {
          throw new Error(`Cannot delete system database "${name}"`);
        }
        await sql.execute(`DROP DATABASE "${name}"`, []);
        break;
      }
      case "pg-schema": {
        const systemSchemas = ["pg_catalog", "information_schema", "pg_toast", "public"];
        if (systemSchemas.includes(name)) {
          throw new Error(`Cannot delete system schema "${name}"`);
        }
        await sql.execute(`DROP SCHEMA "${name}" CASCADE`, []);
        break;
      }
      default:
        throw new Error(`Postgres plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const cs = resource.secretStates.find((s) => s.fieldKey === "connectionString");
    const hasConnection = !!this.connectionString;

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
      status: { kind: "status-dot", status: hasConnection ? "healthy" : "info" },
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
                    ? {
                        kind: "secret-placeholder",
                        fieldKey: "connectionString",
                        resolution: cs.resolution,
                      }
                    : hasConnection
                      ? this.connectionString
                      : "(not set)",
                  sensitive: true,
                },
              ],
            },
            ...(cs
              ? [
                  {
                    kind: "action" as const,
                    label: "Reroll Connection",
                    action: { type: "reroll-secret" as const, fieldKey: "connectionString" },
                  },
                ]
              : hasConnection
                ? [
                    {
                      kind: "action" as const,
                      label: "Reroll Connection",
                      action: {
                        type: "reroll-parent-output" as const,
                        outputKey: "connectionString",
                        confirmMessage:
                          "This will reset the upstream role password. Open connections may need to reconnect.",
                      },
                    },
                  ]
                : []),
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      sqlEditor: {
        connectionStringOutputKey: "connectionString",
        defaultQuery:
          "SELECT * FROM information_schema.tables WHERE table_schema = 'public' LIMIT 20;",
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
    this.requireConnection();
    const sql = this.services?.sql;
    let host = "";
    try {
      host = new URL(this.connectionString).hostname;
    } catch {
      /* connectionString may not be a parseable URL */
    }

    const databases: PeerPaneResource[] = [];
    if (sql) {
      const rows = (await sql.query(
        "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname",
      )) as { datname: string }[];
      for (const row of rows) {
        databases.push({
          id: `${context.accountId}:pg-database:${row.datname}`,
          pluginId: "postgres",
          resourceTypeId: "pg-database",
          displayName: row.datname,
          subtitle: host,
          status: "healthy",
          fields: { host, database: row.datname },
        });
      }
    }

    const schemas: PeerPaneResource[] = [];
    if (sql) {
      const rows = (await sql.query(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE ${VISIBLE_SCHEMA_FILTER}
         ORDER BY schema_name`,
      )) as { schema_name: string }[];
      for (const row of rows) {
        schemas.push({
          id: `${context.accountId}:pg-schema:${row.schema_name}`,
          pluginId: "postgres",
          resourceTypeId: "pg-schema",
          displayName: row.schema_name,
          status: "healthy",
          fields: { name: row.schema_name, host },
        });
      }
    }

    return {
      resourceGroups: [
        {
          title: `Databases (${databases.length})`,
          resourceTypeId: "pg-database",
          pluginId: "postgres",
          items: databases,
        },
        {
          title: `Schemas (${schemas.length})`,
          resourceTypeId: "pg-schema",
          pluginId: "postgres",
          items: schemas,
        },
      ],
    };
  }

  async introspect(): Promise<SqlTableMeta[]> {
    const sql = this.services?.sql;
    if (!sql) return [];

    const [tableRows, columnRows, pkRows] = await Promise.all([
      sql.query(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND ${VISIBLE_TABLE_SCHEMA_FILTER}
         ORDER BY table_schema, table_name`,
      ),
      sql.query(
        `SELECT table_schema, table_name, column_name, data_type
         FROM information_schema.columns
         WHERE ${VISIBLE_TABLE_SCHEMA_FILTER}
         ORDER BY table_schema, table_name, ordinal_position`,
      ),
      sql.query(
        `SELECT kcu.table_schema, kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_catalog = kcu.constraint_catalog
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY' AND ${VISIBLE_TABLE_SCHEMA_FILTER.replaceAll(
           "table_schema",
           "tc.table_schema",
         )}
         ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position`,
      ),
    ]);

    const colsByTable = new Map<string, { name: string; type: string }[]>();
    for (const col of columnRows as {
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
    }[]) {
      const key = tableDisplayName(col.table_schema, col.table_name);
      if (!colsByTable.has(key)) colsByTable.set(key, []);
      colsByTable.get(key)!.push({ name: col.column_name, type: col.data_type });
    }
    const pksByTable = new Map<string, string[]>();
    for (const pk of pkRows as {
      table_schema: string;
      table_name: string;
      column_name: string;
    }[]) {
      const key = tableDisplayName(pk.table_schema, pk.table_name);
      if (!pksByTable.has(key)) pksByTable.set(key, []);
      pksByTable.get(key)!.push(pk.column_name);
    }

    return (tableRows as { table_schema: string; table_name: string }[]).map((t) => {
      const name = tableDisplayName(t.table_schema, t.table_name);
      return {
        name,
        columns: colsByTable.get(name) ?? [],
        pkColumns: pksByTable.get(name) ?? [],
      };
    });
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
      sql.query("SELECT version()"),
      sql.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
      sql.query(
        `SELECT COUNT(*) AS n
         FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND ${VISIBLE_TABLE_SCHEMA_FILTER}`,
      ),
    ]);

    const ver = String(versionRows[0]?.["version"] ?? "")
      .split(" ")
      .slice(0, 2)
      .join(" ");
    const size = String(sizeRows[0]?.["size"] ?? "");
    const tableCount = Number(tableRows[0]?.["n"] ?? 0);
    return [
      { label: "Version", value: ver },
      { label: "Size", value: size },
      { label: "Tables", value: String(tableCount) },
    ];
  }

  private async listDatabases(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();

    // If host SQL services are available, query the actual catalog
    if (this.services?.sql) {
      try {
        const rows = await this.services.sql.query(
          "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname",
        );
        let host = "unknown";
        try {
          host = new URL(this.connectionString).hostname;
        } catch {
          /* ignore */
        }
        return (rows as { datname: string }[]).map((row) => ({
          id: `${accountId}:pg-database:${row.datname}`,
          pluginId: "postgres",
          resourceTypeId: "pg-database",
          accountId,
          displayName: row.datname,
          fields: { host, database: row.datname },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: now,
          updatedAt: now,
        }));
      } catch {
        // Fall through to URL parsing
      }
    }

    const { database, host } = this.connectionInfo();

    return [
      {
        id: `${accountId}:pg-database:${database}`,
        pluginId: "postgres",
        resourceTypeId: "pg-database",
        accountId,
        displayName: database,
        fields: { host, database },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async listSchemas(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const { database, host } = this.connectionInfo();

    if (this.services?.sql) {
      try {
        const rows = await this.services.sql.query(
          `SELECT schema_name
           FROM information_schema.schemata
           WHERE ${VISIBLE_SCHEMA_FILTER}
           ORDER BY schema_name`,
        );
        return (rows as { schema_name: string }[]).map((row) => ({
          id: `${accountId}:pg-schema:${row.schema_name}`,
          pluginId: "postgres",
          resourceTypeId: "pg-schema",
          accountId,
          displayName: row.schema_name,
          fields: { name: row.schema_name, database, host },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: now,
          updatedAt: now,
        }));
      } catch {
        // Fall through to the default public schema placeholder.
      }
    }

    return [
      {
        id: `${accountId}:pg-schema:public`,
        pluginId: "postgres",
        resourceTypeId: "pg-schema",
        accountId,
        displayName: "public",
        fields: { name: "public", database, host },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private connectionInfo(): { database: string; host: string } {
    let database = "postgres";
    let host = "unknown";
    try {
      const url = new URL(this.connectionString);
      database = url.pathname.replace(/^\//, "") || "postgres";
      host = url.hostname || "unknown";
    } catch {
      /* connection string may not be a parseable URL */
    }
    return { database, host };
  }
}
