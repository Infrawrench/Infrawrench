import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
  PeerPaneContext,
  PeerPaneSchema,
} from "@infrawrench/plugin-base";

export class RedisClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("Redis plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "redis-instance") {
      throw new Error(`Redis plugin: unknown resource type "${typeId}"`);
    }
    const now = new Date().toISOString();
    let host = "";
    let dbNum = 0;
    try {
      const url = new URL(this.connectionString);
      host = url.hostname + (url.port && url.port !== "6379" ? `:${url.port}` : "");
      dbNum = parseInt(url.pathname.replace(/^\//, "") || "0", 10) || 0;
    } catch {
      /* ignore */
    }

    return [
      {
        id: `${accountId}:redis-instance:db${dbNum}`,
        pluginId: "redis",
        resourceTypeId: "redis-instance",
        accountId,
        displayName: `DB ${dbNum}`,
        fields: { host, db: dbNum },
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
    if (!found) throw new Error(`Redis plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, _resourceId: string, outputKey: string): Promise<string> {
    if (typeId === "redis-instance" && outputKey === "connectionString") {
      return this.connectionString;
    }
    throw new Error(`Redis plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const cs = resource.secretStates.find((s) => s.fieldKey === "connectionString");
    const version = String(resource.resolvedOutputs["__redis_version__"] ?? "");
    const dbCount = String(resource.resolvedOutputs["__db_count__"] ?? "");
    const usedMemory = String(resource.resolvedOutputs["__used_memory__"] ?? "");
    const connectedClients = String(resource.resolvedOutputs["__connected_clients__"] ?? "");
    const host = String(resource.fields["host"] ?? "");
    const db = resource.fields["db"] != null ? Number(resource.fields["db"]) : 0;
    const hasConnection = !!this.connectionString;

    return {
      title: resource.displayName,
      subtitle: host ? `${host} · DB ${db}` : `DB ${db}`,
      status: { kind: "status-dot", status: hasConnection ? "healthy" : "info" },
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Host", value: host || "—" },
                { key: "Database", value: String(db) },
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
          ],
        },
        ...(version || usedMemory || dbCount || connectedClients
          ? [
              {
                kind: "section" as const,
                title: "Stats",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: [
                      ...(version ? [{ key: "Version", value: version }] : []),
                      ...(usedMemory ? [{ key: "Used Memory", value: usedMemory }] : []),
                      ...(dbCount ? [{ key: "Databases", value: dbCount }] : []),
                      ...(connectedClients
                        ? [{ key: "Connected Clients", value: connectedClients }]
                        : []),
                    ],
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
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
    const instances = await this.listResources("redis-instance", context.accountId);
    return {
      resourceGroups: [
        {
          title: `Redis (${instances.length})`,
          resourceTypeId: "redis-instance",
          pluginId: "redis",
          items: instances.map((inst) => ({
            id: inst.id,
            pluginId: inst.pluginId,
            resourceTypeId: inst.resourceTypeId,
            displayName: inst.displayName,
            subtitle: String(inst.fields["host"] ?? ""),
            status: "healthy",
            fields: inst.fields,
          })),
        },
      ],
    };
  }

  async fetchDashboardStats(
    _resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    const kv = this.services?.kv;
    if (!kv) {
      return [
        { label: "Version", value: "" },
        { label: "Memory", value: "" },
        { label: "Databases", value: "0" },
      ];
    }

    try {
      const infoRaw = await kv.command("INFO", "all");
      const info = parseRedisInfo(String(infoRaw));

      const version = info["redis_version"] ?? "";
      const usedMemory = info["used_memory_human"] ?? "";
      // Count databases that have keys
      const dbCount = Object.keys(info).filter((k) => k.startsWith("db")).length;

      return [
        { label: "Version", value: version },
        { label: "Memory", value: usedMemory },
        { label: "Databases", value: String(dbCount) },
      ];
    } catch {
      return [
        { label: "Version", value: "" },
        { label: "Memory", value: "" },
        { label: "Databases", value: "0" },
      ];
    }
  }
}

function parseRedisInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    if (line.startsWith("#") || !line.includes(":")) continue;
    const colon = line.indexOf(":");
    result[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return result;
}
