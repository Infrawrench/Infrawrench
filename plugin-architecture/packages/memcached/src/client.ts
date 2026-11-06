import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
} from "@infrawrench/plugin-base";

export class MemcachedClient implements PluginClient {
  private readonly connectionString: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const cs = credentials["connectionString"];
    if (!cs) throw new Error("Memcached plugin: missing connectionString credential");
    this.connectionString = cs;
    this.services = services;
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      if (typeId !== "memcached-instance") {
        throw new Error(`Memcached plugin: unknown resource type "${typeId}"`);
      }
      const now = new Date().toISOString();
      // Strip scheme if present, use first server as display host
      const servers = this.connectionString.replace(/^memcacheds?:\/\//, "");
      const firstServer = servers.split(",")[0]?.trim() ?? servers;

      return [
        {
          id: `${accountId}:memcached-instance:default`,
          pluginId: "memcached",
          resourceTypeId: "memcached-instance",
          accountId,
          displayName: firstServer,
          fields: { host: firstServer },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId);
      if (!found) throw new Error(`Memcached plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  resolveOutput(_typeId: string, _resourceId: string, outputKey: string): PluginEffect<string> {
    return attempt(async () => {
      if (outputKey === "connectionString") return this.connectionString;
      throw new Error(`Memcached plugin: cannot resolve output "${outputKey}"`);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const host = String(resource.fields["host"] ?? this.connectionString);

    return {
      title: resource.displayName,
      subtitle: host,
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [{ key: "Server(s)", value: host }],
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
      status: { kind: "status-dot", status: "info" },
    };
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
          { label: "Memory", value: "" },
          { label: "Items", value: "0" },
        ];
      }

      try {
        const raw = String(await kv.command("STATS"));
        const version = extractStat(raw, "version");
        const bytes = parseInt(extractStat(raw, "bytes") || "0", 10);
        const currItems = parseInt(extractStat(raw, "curr_items") || "0", 10);
        return [
          { label: "Version", value: version },
          { label: "Memory", value: formatBytes(bytes) },
          { label: "Items", value: String(currItems) },
        ];
      } catch {
        return [
          { label: "Version", value: "" },
          { label: "Memory", value: "" },
          { label: "Items", value: "0" },
        ];
      }
    });
  }
}

function extractStat(raw: string, key: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+)`).exec(raw);
  return match?.[1]?.trim() ?? "";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
