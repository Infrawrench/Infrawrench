import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  SqlTableMeta,
  DashboardStat,
} from "@infrawrench/plugin-base";

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
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("Postgres plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
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
    if (typeId === "pg-database" && outputKey === "connectionString") {
      return this.connectionString;
    }
    if (typeId === "pg-database" && outputKey === "serverVersion") {
      return "PostgreSQL 16.2";
    }
    if (typeId === "pg-database" && outputKey === "schemaNames") {
      return JSON.stringify(["public"]);
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
                {
                  key: "Connection String",
                  value: cs
                    ? {
                        kind: "secret-placeholder",
                        fieldKey: "connectionString",
                        resolution: cs.resolution,
                      }
                    : "(not set)",
                  sensitive: true,
                },
              ],
            },
            {
              kind: "action",
              label: "Reroll Connection",
              action: { type: "reroll-secret", fieldKey: "connectionString" },
            },
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

  async introspect(): Promise<SqlTableMeta[]> {
    const sql = this.services?.sql;
    if (!sql) return [];

    const [tableRows, columnRows, pkRows] = await Promise.all([
      sql.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      ),
      sql.query(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
      ),
      sql.query(
        `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
         ORDER BY kcu.table_name, kcu.ordinal_position`,
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
      sql.query("SELECT version()"),
      sql.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
      sql.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'",
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

    // Fallback: parse the connection string
    let dbName = "postgres";
    let host = "unknown";
    try {
      const url = new URL(this.connectionString);
      dbName = url.pathname.replace(/^\//, "") || "postgres";
      host = url.hostname;
    } catch {
      /* connection string may not be a parseable URL */
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

  private async listSchemas(_accountId: string): Promise<ResourceInstance[]> {
    return [];
  }
}
