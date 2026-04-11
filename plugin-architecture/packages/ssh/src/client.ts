import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
} from "@infrawrench/plugin-base";

export interface SshCredentials {
  host: string;
  port?: string;
  username?: string;
  privateKey?: string;
  password?: string;
}

export class SshClient implements PluginClient {
  constructor(private readonly creds: SshCredentials) {}

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "ssh-target") return [];
    const { host, port = "22", username = "root" } = this.creds;
    return [
      {
        id: `${accountId}:ssh-target:${host}`,
        pluginId: "ssh",
        resourceTypeId: "ssh-target",
        accountId,
        displayName: host,
        externalId: host,
        fields: { host, port, username },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const resources = await this.listResources(typeId, accountId);
    const found = resources.find((r) => r.id === resourceId) ?? resources[0];
    if (!found) throw new Error("Resource not found");
    return found;
  }

  async resolveOutput(): Promise<string> {
    return "";
  }

  async fetchDashboardStats(): Promise<DashboardStat[]> {
    const { host, port = "22", username = "root" } = this.creds;
    return [
      { label: "Host", value: `${host}:${port}` },
      { label: "User", value: String(username) },
    ];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const { host, port = "22", username = "root" } = this.creds;
    return {
      title: resource.displayName,
      sections: [
        {
          kind: "section",
          title: "Connection",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Host", value: host },
                { key: "Port", value: String(port) },
                { key: "Username", value: String(username) },
              ],
            },
          ],
        },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
    };
  }

  getSshConfig(): { host: string; port: number; username: string; privateKey: string } {
    return {
      host: this.creds.host,
      port: Number(this.creds.port ?? 22),
      username: this.creds.username ?? "root",
      privateKey: this.creds.privateKey ?? "",
    };
  }
}
