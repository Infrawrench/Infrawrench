import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type {
  CiComputeStatus,
  CiCredentialRequest,
  CiExecutorKind,
  CiHandle,
  CiLentMaterial,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
  HostServices,
  PluginEffect,
} from "@infrawrench/plugin-base";
import { lendSshHost } from "./ci-credential.js";
import { ciListTagged, ciPreflight, ciStart, ciStatus, ciTeardown } from "./ci-executor.js";
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
  connectThroughAccountId?: string;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._~@%+=:,/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class SshClient implements PluginClient {
  constructor(
    private readonly creds: SshCredentials,
    private readonly services?: HostServices,
  ) {}

  lendCiCredential(request: CiCredentialRequest): PluginEffect<CiLentMaterial> {
    return attempt(() => lendSshHost(this.creds, request));
  }

  ciPreflight(kind: CiExecutorKind): PluginEffect<CiPreflightResult> {
    return attempt(() => ciPreflight(this.services?.ssh, kind));
  }

  ciStart(spec: CiStartSpec): PluginEffect<CiHandle> {
    return attempt(() => ciStart(this.services?.ssh, this.creds.host, spec));
  }

  ciStatus(handle: CiHandle): PluginEffect<CiComputeStatus> {
    return attempt(() => ciStatus(this.services?.ssh, handle));
  }

  ciTeardown(handle: CiHandle): PluginEffect<void> {
    return attempt(() => ciTeardown(this.services?.ssh, handle));
  }

  ciListTagged(tagKey: string, _regions: readonly string[]): PluginEffect<CiTaggedCompute[]> {
    return attempt(() => ciListTagged(this.services?.ssh, this.creds.host, tagKey));
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const resources = await runPluginEffect(this.listResources(typeId, accountId));
      const found = resources.find((r) => r.id === resourceId) ?? resources[0];
      if (!found) throw new Error("Resource not found");
      return found;
    });
  }

  resolveOutput(typeId: string, _resourceId: string, outputKey: string): PluginEffect<string> {
    return attempt(async () => {
      if (typeId !== "ssh-target") return "";
      const { host, port = "22", username = "root" } = this.creds;
      switch (outputKey) {
        case "host":
          return host;
        case "port":
          return String(port);
        case "username":
          return username;
        case "sshCommand":
          return `ssh -p ${shellQuote(String(port))} ${shellQuote(`${username}@${host}`)}`;
        default:
          return "";
      }
    });
  }

  fetchDashboardStats(): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const { host, port = "22", username = "root" } = this.creds;
      return [
        { label: "Host", value: `${host}:${port}` },
        { label: "User", value: String(username) },
      ];
    });
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
