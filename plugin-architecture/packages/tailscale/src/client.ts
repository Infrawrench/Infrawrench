import {
  labeledFieldItems,
  type DetailViewSchema,
  type HostServices,
  type PluginClient,
  type ResourceInstance,
  type SidebarItemSchema,
  type SshInstallContext,
} from "@infrawrench/plugin-base";
import { deviceType } from "./plugin.js";
import { installOnSsh } from "./install.js";

// Wire shapes and endpoints verified against https://api.tailscale.com/api/v2
// and Tailscale's official client:
// https://github.com/tailscale/tailscale-client-go-v2/blob/main/devices.go
// https://github.com/tailscale/tailscale-client-go-v2/blob/main/keys.go
interface Device {
  id: string;
  nodeId?: string;
  name: string;
  hostname: string;
  addresses: string[];
  os?: string;
  user?: string;
  tags?: string[];
  authorized?: boolean;
  connectedToControl?: boolean;
  clientVersion?: string;
  lastSeen?: string | null;
  created?: string;
  expires?: string;
  keyExpiryDisabled?: boolean;
}

export class TailscaleClient implements PluginClient {
  private readonly tailnet: string;
  constructor(
    private readonly credentials: Record<string, string>,
    private readonly services?: HostServices,
  ) {
    this.tailnet = encodeURIComponent(credentials.tailnet?.trim() || "-");
  }

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const token = this.credentials.apiKey?.trim() ?? "";
    const url = `https://api.tailscale.com/api/v2${path}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const payload = body === undefined ? {} : { body: JSON.stringify(body) };
    try {
      const response = this.services?.http
        ? await this.services.http.request({ url, method, headers, ...payload })
        : await fetch(url, {
            method,
            headers,
            ...payload,
            signal: AbortSignal.timeout(30_000),
          }).then(async (r) => ({ status: r.status, body: await r.text() }));
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Tailscale API error ${response.status}: ${response.body}`);
      }
      // Several device mutations return 200 with an empty body, not 204.
      return (response.body.trim() ? JSON.parse(response.body) : undefined) as T;
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (token) message = message.replaceAll(token, "[redacted]");
      throw new Error(message.replace(/tskey-[\w-]+/g, "[redacted]"));
    }
  }

  private async devices(): Promise<Device[]> {
    const response = await this.request<{ devices: Device[] }>(
      `/tailnet/${this.tailnet}/devices?fields=all`,
    );
    if (!Array.isArray(response.devices))
      throw new Error("Tailscale returned an invalid device list.");
    return response.devices;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "device") return [];
    return (await this.devices()).map((d) => this.toResource(d, accountId));
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId !== "device") throw new Error("Unknown Tailscale resource type.");
    // Scope every read and mutation to this credential's tailnet, even for shared devices.
    const device = (await this.devices()).find(
      (d) => resourceId === `${accountId}:device:${d.nodeId || d.id}`,
    );
    if (!device) throw new Error("Device not found in this tailnet.");
    return this.toResource(device, accountId);
  }

  private toResource(d: Device, accountId: string): ResourceInstance {
    const externalId = d.nodeId || d.id;
    const ip = d.addresses.find((a) => !a.includes(":")) ?? d.addresses[0] ?? "";
    return {
      id: `${accountId}:device:${externalId}`,
      pluginId: "tailscale",
      resourceTypeId: "device",
      accountId,
      displayName: d.hostname || d.name,
      externalId,
      fields: {
        name: d.name,
        hostname: d.hostname,
        os: d.os ?? "",
        user: d.user ?? "",
        addresses: d.addresses.join(", "),
        tags: (d.tags ?? []).join(", "),
        authorized: d.authorized ?? false,
        connected: d.connectedToControl ?? false,
        clientVersion: d.clientVersion ?? "",
        lastSeen: d.lastSeen ?? "",
        expires: d.expires ?? "",
        keyExpiryDisabled: d.keyExpiryDisabled ?? false,
      },
      resolvedOutputs: { ip, dnsName: d.name },
      secretStates: [],
      createdAt: d.created || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    return (await this.getResource(typeId, resourceId, accountId)).resolvedOutputs[outputKey] ?? "";
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    if (fields.name !== undefined) {
      const name = fields.name.trim();
      if (!name || name.length > 253) throw new Error("Enter a DNS name of up to 253 characters.");
      await this.request(`/device/${encodeURIComponent(resource.externalId!)}/name`, "POST", {
        name,
      });
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    await this.request(`/device/${encodeURIComponent(resource.externalId!)}`, "DELETE");
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (actionId !== "approve" && actionId !== "expire")
      throw new Error("Unknown Tailscale action.");
    const resource = await this.getResource(typeId, resourceId, accountId);
    const path = `/device/${encodeURIComponent(resource.externalId!)}`;
    await this.request(
      `${path}/${actionId === "approve" ? "authorized" : "expire"}`,
      "POST",
      actionId === "approve" ? { authorized: true } : {},
    );
  }

  installOnSsh(context: SshInstallContext) {
    return installOnSsh(context, {
      devices: () => this.devices(),
      createKey: () =>
        this.request<{ id: string; key: string }>(`/tailnet/${this.tailnet}/keys`, "POST", {
          capabilities: {
            // Pre-approved: we enroll the server on the account holder's behalf.
            // https://tailscale.com/kb/1085/auth-keys
            devices: { create: { reusable: false, ephemeral: false, preauthorized: true } },
          },
          expirySeconds: 300,
          description: "Infrawrench server enrollment",
        }),
      // https://tailscale.com/kb/1099/device-approval
      approve: async (deviceId) => {
        await this.request(`/device/${encodeURIComponent(deviceId)}/authorized`, "POST", {
          authorized: true,
        });
      },
      revokeKey: async (id) => {
        try {
          await this.request<void>(
            `/tailnet/${this.tailnet}/keys/${encodeURIComponent(id)}`,
            "DELETE",
          );
        } catch (error) {
          // A consumed one-use key may already have disappeared.
          if (!(error instanceof Error && error.message.startsWith("Tailscale API error 404:")))
            throw error;
        }
      },
    });
  }

  /** Remove the device an enrollment created; `ref` is its node id. */
  async releaseSshInstall(ref: string): Promise<void> {
    const device = (await this.devices()).find((d) => d.nodeId === ref || d.id === ref);
    if (!device) return;
    await this.request(`/device/${encodeURIComponent(device.nodeId || device.id)}`, "DELETE");
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: String(resource.fields.name),
      status: this.status(resource),
      sections: [
        {
          kind: "section",
          title: "Device",
          children: [
            {
              kind: "key-value-list",
              // Fields stay boolean for status logic; show them as Yes/No.
              items: labeledFieldItems(
                Object.fromEntries(
                  Object.entries(resource.fields).map(([k, v]) => [
                    k,
                    typeof v === "boolean" ? (v ? "Yes" : "No") : v,
                  ]),
                ),
                [deviceType],
                "device",
              ),
            },
            {
              kind: "text",
              content:
                "Connect using the Tailscale IP from a machine on this tailnet. Infrawrench Cloud needs a network path to the tailnet; adding an API account alone does not provide one.",
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(!resource.fields.authorized
          ? [
              {
                kind: "action" as const,
                label: "Approve device",
                action: {
                  type: "plugin-action" as const,
                  actionId: "approve",
                  confirmMessage: "Approve this device to connect to your tailnet?",
                  successMessage: "Device approved.",
                },
              },
            ]
          : []),
        {
          kind: "action",
          label: "Expire device key",
          action: {
            type: "plugin-action",
            actionId: "expire",
            destructive: true,
            confirmMessage: "Expire this device's key? It will need to authenticate again.",
            successMessage: "Device key expired.",
          },
        },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return { id: resource.id, label: resource.displayName, status: this.status(resource) };
  }

  async fetchDashboardStats(typeId: string, resourceId: string, accountId: string) {
    const r = await this.getResource(typeId, resourceId, accountId);
    return [
      { label: "Tailscale IP", value: r.resolvedOutputs.ip ?? "" },
      { label: "Status", value: this.status(r).label },
      { label: "Client version", value: String(r.fields.clientVersion) },
    ];
  }

  private status(resource: ResourceInstance) {
    const approved = resource.fields.authorized === true;
    const connected = resource.fields.connected === true;
    return {
      kind: "status-dot" as const,
      status: !approved
        ? ("degraded" as const)
        : connected
          ? ("healthy" as const)
          : ("unknown" as const),
      label: !approved ? "Awaiting approval" : connected ? "Connected" : "Offline",
    };
  }
}
