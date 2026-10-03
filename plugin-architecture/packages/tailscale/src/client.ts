import type {
  CreateFieldConfig,
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  PluginClient,
  PolicyOption,
  ResourceInstance,
  SidebarItemSchema,
  SshInstallContext,
} from "@infrawrench/plugin-base";
import type {
  ConfigurationAuditLog,
  Contacts,
  Device,
  DnsConfiguration,
  Key,
  LogStreamConfig,
  LogStreamStatus,
  PostureIntegration,
  Service,
  ServiceHost,
  TailnetSettings,
  User,
  UserInvite,
  Webhook,
} from "./api.js";
import { BOOLEAN_SETTINGS } from "./api.js";
import { installOnSsh } from "./install.js";
import {
  joinList,
  mapDevice,
  mapKey,
  mapPostureIntegration,
  mapService,
  mapTailnet,
  mapUser,
  mapUserInvite,
  mapWebhook,
  splitList,
} from "./mappers.js";
import { renderDetail, sidebarStatus } from "./render.js";
import { INVITE_ROLES, POSTURE_PROVIDERS, WEBHOOK_EVENTS } from "./resource-types.js";

const API = "https://api.tailscale.com/api/v2";

/** Scopes a trust credential (OAuth client) can carry, from the API's per-route OAuth scopes. */
const TRUST_CREDENTIAL_SCOPES = [
  "all",
  "all:read",
  "devices:core",
  "devices:core:read",
  "devices:routes",
  "devices:routes:read",
  "devices:posture_attributes",
  "devices:posture_attributes:read",
  "device_invites",
  "device_invites:read",
  "users",
  "users:read",
  "dns",
  "dns:read",
  "policy_file",
  "policy_file:read",
  "services",
  "services:read",
  "auth_keys",
  "auth_keys:read",
  "oauth_keys",
  "oauth_keys:read",
  "federated_keys",
  "federated_keys:read",
  "api_access_tokens",
  "api_access_tokens:read",
  "webhooks",
  "webhooks:read",
  "log_streaming",
  "log_streaming:read",
  "logs:configuration:read",
  "logs:network",
  "logs:network:read",
  "account_settings",
  "account_settings:read",
  "feature_settings",
  "feature_settings:read",
  "networking_settings",
  "networking_settings:read",
];

/** A boolean edit-form value: the host submits booleans as strings. */
function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true";
}

function sameList(a: string, b: string): boolean {
  return joinList(splitList(a)) === joinList(splitList(b));
}

/** Parse a `policy-picker` value (a JSON array of ids), tolerating a comma list. */
function pickedList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Not JSON: fall through to the comma convention.
  }
  return splitList(value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Tailscale API error 404:");
}

export class TailscaleClient implements PluginClient {
  private readonly tailnet: string;
  private readonly tailnetId: string;
  constructor(
    private readonly credentials: Record<string, string>,
    private readonly services?: HostServices,
  ) {
    this.tailnetId = credentials.tailnet?.trim() || "-";
    this.tailnet = encodeURIComponent(this.tailnetId);
  }

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    accept?: string,
  ): Promise<T> {
    const token = this.credentials.apiKey?.trim() ?? "";
    const url = `${API}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(accept ? { Accept: accept } : {}),
    };
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

  private tailnetPath(suffix: string): string {
    return `/tailnet/${this.tailnet}${suffix}`;
  }

  // ---------------------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------------------

  private async devices(): Promise<Device[]> {
    const response = await this.request<{ devices: Device[] }>(
      this.tailnetPath("/devices?fields=all"),
    );
    if (!Array.isArray(response.devices))
      throw new Error("Tailscale returned an invalid device list.");
    // The list includes devices shared *into* this tailnet. They are not
    // members (enrollment must not treat them as "already here") and this
    // token cannot approve, expire, rename or remove them.
    return response.devices.filter((d) => !d.isExternal);
  }

  private async users(): Promise<User[]> {
    return (await this.request<{ users?: User[] }>(this.tailnetPath("/users"))).users ?? [];
  }

  private async userInvites(): Promise<UserInvite[]> {
    const response = await this.request<UserInvite[] | null>(this.tailnetPath("/user-invites"));
    return Array.isArray(response) ? response : [];
  }

  private async keys(): Promise<Key[]> {
    // `all=true` widens the list from the caller's auth keys to every auth
    // key, API access token, OAuth client and federated identity.
    const response = await this.request<{ keys?: Key[] }>(this.tailnetPath("/keys?all=true"));
    return response.keys ?? [];
  }

  private async webhooks(): Promise<Webhook[]> {
    return (
      (await this.request<{ webhooks?: Webhook[] }>(this.tailnetPath("/webhooks"))).webhooks ?? []
    );
  }

  private async servicesList(): Promise<Service[]> {
    return (
      (await this.request<{ vipServices?: Service[] }>(this.tailnetPath("/services")))
        .vipServices ?? []
    );
  }

  private async postureIntegrations(): Promise<PostureIntegration[]> {
    return (
      (
        await this.request<{ integrations?: PostureIntegration[] }>(
          this.tailnetPath("/posture/integrations"),
        )
      ).integrations ?? []
    );
  }

  private async dnsConfiguration(): Promise<DnsConfiguration> {
    return this.request<DnsConfiguration>(this.tailnetPath("/dns/configuration"));
  }

  private async tailnetSnapshot(accountId: string): Promise<ResourceInstance> {
    const [settings, dns, contacts, devices] = await Promise.allSettled([
      this.request<TailnetSettings>(this.tailnetPath("/settings")),
      this.dnsConfiguration(),
      this.request<Contacts>(this.tailnetPath("/contacts")),
      this.devices(),
    ]);
    // Settings are the one read the type cannot do without; DNS, contacts and
    // the device list each need their own scope and only enrich the record.
    if (settings.status === "rejected") throw settings.reason;
    const firstName = devices.status === "fulfilled" ? devices.value[0]?.name : undefined;
    const dnsName = firstName?.includes(".")
      ? firstName.slice(firstName.indexOf(".") + 1).replace(/\.$/, "")
      : "";
    return mapTailnet(
      {
        id: this.tailnetId,
        dnsName,
        settings: settings.value ?? {},
        ...(dns.status === "fulfilled" ? { dns: dns.value } : {}),
        ...(contacts.status === "fulfilled" ? { contacts: contacts.value } : {}),
      },
      accountId,
    );
  }

  /**
   * Tags a picker can offer: those declared in the policy file's `tagOwners`
   * plus any already on a device or Service. Best effort; a token without
   * policy-file access still sees the tags in use.
   */
  private async knownTags(): Promise<PolicyOption[]> {
    const [policy, devices, services] = await Promise.allSettled([
      this.request<{ tagOwners?: Record<string, unknown> }>(
        this.tailnetPath("/acl"),
        "GET",
        undefined,
        "application/json",
      ),
      this.devices(),
      this.servicesList(),
    ]);
    const declared = new Set(
      policy.status === "fulfilled" ? Object.keys(policy.value?.tagOwners ?? {}) : [],
    );
    const inUse = new Set<string>();
    if (devices.status === "fulfilled")
      devices.value.forEach((d) => d.tags?.forEach((t) => inUse.add(t)));
    if (services.status === "fulfilled")
      services.value.forEach((s) => s.tags?.forEach((t) => inUse.add(t)));
    return [...new Set([...declared, ...inUse])].sort().map((tag) => ({
      id: tag,
      label: tag,
      category: declared.has(tag) ? "Defined in tagOwners" : "In use",
    }));
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "tailnet":
        return [await this.tailnetSnapshot(accountId)];
      case "device":
        return (await this.devices()).map((d) => mapDevice(d, accountId));
      case "user":
        return (await this.users()).map((u) => mapUser(u, accountId));
      case "user-invite":
        return (await this.userInvites()).map((i) => mapUserInvite(i, accountId));
      case "key":
        return (await this.keys()).map((k) => mapKey(k, accountId));
      case "webhook":
        return (await this.webhooks()).map((w) => mapWebhook(w, accountId));
      case "service":
        return (await this.servicesList()).map((s) => mapService(s, accountId));
      case "posture-integration":
        return (await this.postureIntegrations()).map((p) => mapPostureIntegration(p, accountId));
      default:
        return [];
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const prefix = `${accountId}:${typeId}:`;
    if (!resourceId.startsWith(prefix))
      throw new Error(`${this.label(typeId)} not found in this tailnet.`);
    const id = resourceId.slice(prefix.length);
    switch (typeId) {
      case "tailnet":
        return this.tailnetSnapshot(accountId);
      case "key": {
        // Tailnet-scoped route, so a single GET cannot reach another tailnet.
        try {
          const key = await this.request<Key>(this.tailnetPath(`/keys/${encodeURIComponent(id)}`));
          return mapKey(key, accountId);
        } catch (error) {
          if (isNotFound(error)) throw new Error("Key not found in this tailnet.");
          throw error;
        }
      }
      case "service": {
        try {
          const service = await this.request<Service>(
            this.tailnetPath(`/services/${encodeURIComponent(id)}`),
          );
          return mapService(service, accountId);
        } catch (error) {
          if (isNotFound(error)) throw new Error("Service not found in this tailnet.");
          throw error;
        }
      }
      default: {
        // Device, user, invite, webhook and posture routes are not
        // tailnet-scoped, so every read and mutation resolves through this
        // credential's tailnet listing first.
        const match = (await this.listResources(typeId, accountId)).find(
          (r) => r.id === resourceId,
        );
        if (!match) throw new Error(`${this.label(typeId)} not found in this tailnet.`);
        return match;
      }
    }
  }

  private label(typeId: string): string {
    const labels: Record<string, string> = {
      device: "Device",
      user: "User",
      "user-invite": "Invite",
      key: "Key",
      webhook: "Webhook",
      service: "Service",
      "posture-integration": "Posture integration",
      tailnet: "Tailnet",
    };
    return labels[typeId] ?? "Resource";
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    return (await this.getResource(typeId, resourceId, accountId)).resolvedOutputs[outputKey] ?? "";
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = encodeURIComponent(resource.externalId ?? "");
    const extra: Record<string, string> = {};
    if (resource.resourceTypeId === "device") {
      const [attributes, device] = await Promise.allSettled([
        this.request<{ attributes?: Record<string, unknown>; expiries?: Record<string, string> }>(
          `/device/${id}/attributes`,
        ),
        this.request<Device>(`/device/${id}?fields=all`),
      ]);
      if (attributes.status === "fulfilled")
        extra.__attributes__ = JSON.stringify(attributes.value?.attributes ?? {});
      if (device.status === "fulfilled")
        extra.__connectivity__ = JSON.stringify(device.value?.clientConnectivity ?? {});
    } else if (resource.resourceTypeId === "service") {
      const [hosts, devices] = await Promise.allSettled([
        this.request<{ hosts?: ServiceHost[] }>(this.tailnetPath(`/services/${id}/devices`)),
        this.devices(),
      ]);
      if (hosts.status === "fulfilled") {
        const names = new Map(
          (devices.status === "fulfilled" ? devices.value : []).map((d) => [
            d.nodeId || d.id,
            d.hostname || d.name,
          ]),
        );
        extra.__hosts__ = JSON.stringify(
          (hosts.value?.hosts ?? []).map((h) => ({
            ...h,
            hostname: names.get(h.stableNodeID) ?? "",
          })),
        );
      }
    } else if (resource.resourceTypeId === "tailnet") {
      const streams = await Promise.all(
        (["configuration", "network"] as const).map(async (logType) => {
          const [config, status] = await Promise.allSettled([
            this.request<LogStreamConfig>(this.tailnetPath(`/logging/${logType}/stream`)),
            this.request<LogStreamStatus>(this.tailnetPath(`/logging/${logType}/stream/status`)),
          ]);
          return {
            logType,
            ...(config.status === "fulfilled" ? { config: config.value } : {}),
            ...(status.status === "fulfilled" ? { status: status.value } : {}),
          };
        }),
      );
      extra.__streams__ = JSON.stringify(streams);
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "user-invite":
        return {
          fields: [
            {
              key: "email",
              label: "Email",
              kind: "text",
              required: false,
              placeholder: "person@example.com",
              description:
                "Leave blank to create a shareable invite link without sending an email.",
            },
            {
              key: "role",
              label: "Role",
              kind: "select",
              required: true,
              defaultValue: "member",
              options: INVITE_ROLES.map((role) => ({ id: role, label: role })),
            },
          ],
        };
      case "key": {
        const tags = await this.knownTags();
        const tagField = (showFor: string, required: boolean): CreateFieldConfig => ({
          key: showFor === "auth" ? "tags" : "clientTags",
          label: "Tags",
          kind: "policy-picker",
          required,
          policies: tags,
          showWhen: { fieldKey: "keyType", fieldValue: showFor },
          description:
            showFor === "auth"
              ? "Devices that join with this key are tagged instead of owned by you."
              : "Tags the client may assign. Required when the client has the devices:core or auth_keys scope.",
        });
        return {
          fields: [
            {
              key: "keyType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "auth",
              options: [
                { id: "auth", label: "Auth key", description: "Joins devices to the tailnet." },
                {
                  id: "client",
                  label: "OAuth client",
                  description: "A scoped client ID and secret for automation.",
                },
              ],
            },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: false,
              description: "Up to 50 letters, numbers, spaces and hyphens.",
            },
            {
              key: "reusable",
              label: "Reusable",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "One-off: one device" },
                { id: "true", label: "Reusable: any number of devices" },
              ],
              showWhen: { fieldKey: "keyType", fieldValue: "auth" },
            },
            {
              key: "ephemeral",
              label: "Ephemeral",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes: remove devices soon after they go offline" },
              ],
              showWhen: { fieldKey: "keyType", fieldValue: "auth" },
            },
            {
              key: "preauthorized",
              label: "Pre-approved",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No: devices wait for device approval" },
                { id: "true", label: "Yes: skip device approval" },
              ],
              showWhen: { fieldKey: "keyType", fieldValue: "auth" },
            },
            tagField("auth", false),
            {
              key: "expiryDays",
              label: "Expires in (days)",
              kind: "number",
              required: false,
              defaultValue: "90",
              minValue: 1,
              maxValue: 90,
              showWhen: { fieldKey: "keyType", fieldValue: "auth" },
            },
            {
              key: "scopes",
              label: "Scopes",
              kind: "policy-picker",
              required: false,
              policies: TRUST_CREDENTIAL_SCOPES.map((scope) => ({
                id: scope,
                label: scope,
                category: scope.endsWith(":read") ? "Read" : "Read and write",
              })),
              showWhen: { fieldKey: "keyType", fieldValue: "client" },
              description: "At least one scope is required.",
            },
            tagField("client", false),
          ],
        };
      }
      case "webhook":
        return {
          fields: [
            {
              key: "endpointUrl",
              label: "Endpoint URL",
              kind: "text",
              required: true,
              placeholder: "https://example.com/tailscale",
            },
            {
              key: "providerType",
              label: "Format",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "Generic JSON" },
                { id: "slack", label: "Slack" },
                { id: "mattermost", label: "Mattermost" },
                { id: "googlechat", label: "Google Chat" },
                { id: "discord", label: "Discord" },
              ],
            },
            {
              key: "subscriptions",
              label: "Events",
              kind: "policy-picker",
              required: true,
              policies: WEBHOOK_EVENTS.map((event) => ({
                id: event,
                label: event,
                category: event.startsWith("user")
                  ? "Users"
                  : event.startsWith("node")
                    ? "Devices"
                    : "Tailnet",
              })),
            },
          ],
        };
      case "service": {
        const tags = await this.knownTags();
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "web",
              description:
                "Becomes svc:<name> and the Service's MagicDNS name. Must not match a device name.",
            },
            { key: "displayName", label: "Display name", kind: "text", required: false },
            {
              key: "ports",
              label: "Ports",
              kind: "string-list",
              required: true,
              addLabel: "+ Add port",
              placeholder: "tcp:443",
              defaultValue: "tcp:443",
            },
            {
              key: "tags",
              label: "Tags",
              kind: "policy-picker",
              required: false,
              policies: tags,
              description: "Grants and auto-approvers can match the Service by tag.",
            },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
        };
      }
      case "posture-integration":
        return {
          fields: [
            {
              key: "provider",
              label: "Provider",
              kind: "select",
              required: true,
              defaultValue: "falcon",
              options: [
                { id: "falcon", label: "CrowdStrike Falcon" },
                { id: "intune", label: "Microsoft Intune" },
                { id: "jamfpro", label: "Jamf Pro" },
                { id: "kandji", label: "Kandji" },
                { id: "kolide", label: "Kolide" },
                { id: "sentinelone", label: "SentinelOne" },
              ],
            },
            {
              key: "falconCloud",
              label: "Cloud",
              kind: "select",
              required: true,
              defaultValue: "us-1",
              options: ["us-1", "us-2", "eu-1", "us-gov"].map((id) => ({ id, label: id })),
              showWhen: { fieldKey: "provider", fieldValue: "falcon" },
            },
            {
              key: "intuneCloud",
              label: "Cloud",
              kind: "select",
              required: true,
              defaultValue: "global",
              options: [
                { id: "global", label: "Global" },
                { id: "us-gov", label: "US Government" },
              ],
              showWhen: { fieldKey: "provider", fieldValue: "intune" },
            },
            {
              key: "subdomain",
              label: "Tenant domain",
              kind: "text",
              required: true,
              placeholder: "mydomain.sentinelone.net",
              description:
                "The fully qualified domain of your Jamf Pro, Kandji or SentinelOne tenant.",
              showWhen: { fieldKey: "provider", fieldValues: ["jamfpro", "kandji", "sentinelone"] },
            },
            {
              key: "clientId",
              label: "Client ID",
              kind: "text",
              required: true,
              description: "For Intune, the application (client) UUID.",
              showWhen: { fieldKey: "provider", fieldValues: ["falcon", "intune", "jamfpro"] },
            },
            {
              key: "tenantId",
              label: "Directory (tenant) ID",
              kind: "text",
              required: true,
              showWhen: { fieldKey: "provider", fieldValue: "intune" },
            },
            {
              key: "clientSecret",
              label: "Secret",
              kind: "password",
              required: true,
              description: "The client secret, API token or auth key the provider issued.",
            },
          ],
        };
      default:
        throw new Error(`Tailscale cannot create ${typeId} resources.`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "user-invite": {
        const email = fields.email?.trim();
        const created = await this.request<UserInvite[]>(
          this.tailnetPath("/user-invites"),
          "POST",
          [{ role: fields.role || "member", ...(email ? { email } : {}) }],
        );
        const invite = Array.isArray(created) ? created[0] : undefined;
        if (!invite) throw new Error("Tailscale did not return the new invite.");
        return mapUserInvite(invite, accountId);
      }
      case "key": {
        const description = fields.description?.trim();
        if (description && !/^[A-Za-z0-9 -]{1,50}$/.test(description))
          throw new Error(
            "Use at most 50 letters, numbers, spaces and hyphens in the description.",
          );
        let body: Record<string, unknown>;
        if (fields.keyType === "client") {
          const scopes = pickedList(fields.scopes);
          if (scopes.length === 0)
            throw new Error("Choose at least one scope for the OAuth client.");
          const tags = pickedList(fields.clientTags);
          body = { keyType: "client", scopes, ...(tags.length ? { tags } : {}) };
        } else {
          const days = Number(fields.expiryDays || 90);
          if (!Number.isInteger(days) || days < 1 || days > 90)
            throw new Error("Auth keys expire after 1 to 90 days.");
          const tags = pickedList(fields.tags);
          body = {
            keyType: "auth",
            capabilities: {
              devices: {
                create: {
                  reusable: fields.reusable === "true",
                  ephemeral: fields.ephemeral === "true",
                  preauthorized: fields.preauthorized === "true",
                  ...(tags.length ? { tags } : {}),
                },
              },
            },
            expirySeconds: days * 86_400,
          };
        }
        const key = await this.request<Key>(this.tailnetPath("/keys"), "POST", {
          ...body,
          ...(description ? { description } : {}),
        });
        const created = mapKey(key, accountId);
        // The secret appears on this response only.
        if (key.key) created.resolvedOutputs = { ...created.resolvedOutputs, key: key.key };
        return created;
      }
      case "webhook": {
        const subscriptions = pickedList(fields.subscriptions);
        if (subscriptions.length === 0) throw new Error("Choose at least one event.");
        const webhook = await this.request<Webhook>(this.tailnetPath("/webhooks"), "POST", {
          endpointUrl: fields.endpointUrl?.trim(),
          ...(fields.providerType ? { providerType: fields.providerType } : {}),
          subscriptions,
        });
        const created = mapWebhook(webhook, accountId);
        if (webhook.secret)
          created.resolvedOutputs = { ...created.resolvedOutputs, secret: webhook.secret };
        return created;
      }
      case "service": {
        const bare = (fields.name ?? "").trim().replace(/^svc:/, "");
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(bare))
          throw new Error("Use lowercase letters, numbers and hyphens for the Service name.");
        const name = `svc:${bare}`;
        const service = await this.request<Service>(
          this.tailnetPath(`/services/${encodeURIComponent(name)}`),
          "PUT",
          this.serviceBody(name, fields, []),
        );
        return mapService(service ?? { name }, accountId);
      }
      case "posture-integration": {
        const provider = fields.provider ?? "";
        if (!POSTURE_PROVIDERS.includes(provider)) throw new Error("Choose a posture provider.");
        const integration = await this.request<PostureIntegration>(
          this.tailnetPath("/posture/integrations"),
          "POST",
          {
            provider,
            ...this.postureBody(provider, fields),
            clientSecret: fields.clientSecret ?? "",
          },
        );
        return mapPostureIntegration(integration, accountId);
      }
      default:
        throw new Error(`Tailscale cannot create ${typeId} resources.`);
    }
  }

  private serviceBody(
    name: string,
    fields: Record<string, string>,
    addrs: string[],
    current?: ResourceInstance,
  ): Record<string, unknown> {
    const pick = (key: string) => fields[key] ?? String(current?.fields[key] ?? "");
    const ports = pickedList(pick("ports"));
    if (ports.some((port) => !/^(tcp:\d{1,5}(-\d{1,5})?|do-not-validate)$/.test(port)))
      throw new Error("Ports must look like tcp:443 or tcp:8000-8010.");
    return {
      name,
      displayName: pick("displayName"),
      comment: pick("comment"),
      ports,
      tags: pickedList(pick("tags")),
      ...(addrs.length ? { addrs } : {}),
    };
  }

  /** The provider-specific identifiers; the API wants blanks for the others. */
  private postureBody(provider: string, fields: Record<string, string>): Record<string, string> {
    const cloudId =
      provider === "falcon"
        ? fields.falconCloud
        : provider === "intune"
          ? fields.intuneCloud
          : provider === "kolide"
            ? ""
            : fields.subdomain;
    return {
      cloudId: (cloudId ?? fields.cloudId ?? "").trim(),
      clientId: ["falcon", "intune", "jamfpro"].includes(provider)
        ? (fields.clientId ?? "").trim()
        : "",
      tenantId: provider === "intune" ? (fields.tenantId ?? "").trim() : "",
    };
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const id = encodeURIComponent(resource.externalId!);
    const changed = (key: string) =>
      fields[key] !== undefined && fields[key] !== String(resource.fields[key] ?? "");
    switch (typeId) {
      case "device":
        await this.updateDevice(resource, fields);
        break;
      case "user":
        if (changed("role")) await this.request(`/users/${id}/role`, "POST", { role: fields.role });
        break;
      case "webhook":
        if (
          fields.subscriptions !== undefined &&
          !sameList(fields.subscriptions, String(resource.fields.subscriptions))
        ) {
          const subscriptions = splitList(fields.subscriptions);
          const unknown = subscriptions.filter((event) => !WEBHOOK_EVENTS.includes(event));
          if (unknown.length) throw new Error(`Unknown webhook events: ${unknown.join(", ")}.`);
          if (subscriptions.length === 0) throw new Error("Keep at least one event.");
          await this.request(`/webhooks/${id}`, "PATCH", { subscriptions });
        }
        break;
      case "service": {
        const name = resource.externalId!;
        await this.request(
          this.tailnetPath(`/services/${id}`),
          "PUT",
          this.serviceBody(name, fields, splitList(String(resource.fields.addresses)), resource),
        );
        break;
      }
      case "posture-integration": {
        await this.request(`/posture/integrations/${id}`, "PATCH", {
          cloudId: fields.cloudId ?? resource.fields.cloudId,
          clientId: fields.clientId ?? resource.fields.clientId,
          tenantId: fields.tenantId ?? resource.fields.tenantId,
          // Omitted keeps the stored secret.
          ...(fields.clientSecret ? { clientSecret: fields.clientSecret } : {}),
        });
        break;
      }
      case "tailnet":
        await this.updateTailnet(resource, fields, changed);
        break;
      default:
        throw new Error(`Tailscale cannot update ${typeId} resources.`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  private async updateDevice(resource: ResourceInstance, fields: Record<string, string>) {
    const path = `/device/${encodeURIComponent(resource.externalId!)}`;
    const current = resource.fields;
    if (fields.name !== undefined && fields.name.trim() !== String(current.name)) {
      const name = fields.name.trim();
      // A base name is one DNS label (63 max); a full name is at most 253.
      if (!name || name.length > 253 || name.split(".").some((label) => label.length > 63))
        throw new Error("Enter a DNS name whose parts are each at most 63 characters.");
      await this.request(`${path}/name`, "POST", { name });
    }
    if (fields.tags !== undefined && !sameList(fields.tags, String(current.tags))) {
      const tags = splitList(fields.tags);
      if (tags.some((tag) => !/^tag:[A-Za-z0-9-]+$/.test(tag)))
        throw new Error("Tags look like tag:name (letters, numbers and hyphens).");
      await this.request(`${path}/tags`, "POST", { tags });
    }
    const keyExpiryDisabled = bool(fields.keyExpiryDisabled);
    if (keyExpiryDisabled !== undefined && keyExpiryDisabled !== current.keyExpiryDisabled)
      await this.request(`${path}/key`, "POST", { keyExpiryDisabled });
    if (
      fields.enabledRoutes !== undefined &&
      !sameList(fields.enabledRoutes, String(current.enabledRoutes))
    )
      await this.request(`${path}/routes`, "POST", { routes: splitList(fields.enabledRoutes) });
    if (fields.ipv4 !== undefined && fields.ipv4.trim() && fields.ipv4.trim() !== current.ipv4) {
      const ipv4 = fields.ipv4.trim();
      // The tailnet's CGNAT range is 100.64.0.0/10.
      const octets = ipv4.split(".").map(Number);
      if (
        octets.length !== 4 ||
        octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255) ||
        octets[0] !== 100 ||
        octets[1]! < 64 ||
        octets[1]! > 127
      )
        throw new Error("Choose an address inside 100.64.0.0/10.");
      await this.request(`${path}/ip`, "POST", { ipv4 });
    }
  }

  private async updateTailnet(
    resource: ResourceInstance,
    fields: Record<string, string>,
    changed: (key: string) => boolean,
  ) {
    const settings: Record<string, unknown> = {};
    for (const key of BOOLEAN_SETTINGS) {
      if (changed(key)) settings[key] = fields[key] === "true";
    }
    if (changed("devicesKeyDurationDays")) {
      const days = Number(fields.devicesKeyDurationDays);
      if (!Number.isInteger(days) || days < 1 || days > 180)
        throw new Error("Key expiry must be 1 to 180 days.");
      settings.devicesKeyDurationDays = days;
    }
    if (changed("usersRoleAllowedToJoinExternalTailnets"))
      settings.usersRoleAllowedToJoinExternalTailnets =
        fields.usersRoleAllowedToJoinExternalTailnets;
    if (changed("aclsExternalLink")) settings.aclsExternalLink = fields.aclsExternalLink;
    if (Object.keys(settings).length)
      await this.request(this.tailnetPath("/settings"), "PATCH", settings);

    const dnsChanged =
      changed("magicDNS") ||
      changed("overrideLocalDNS") ||
      (fields.nameservers !== undefined &&
        !sameList(fields.nameservers, String(resource.fields.nameservers))) ||
      (fields.searchPaths !== undefined &&
        !sameList(fields.searchPaths, String(resource.fields.searchPaths)));
    if (!dnsChanged) return;
    // The configuration route replaces the whole document: read it, change
    // only what the form edits, and keep split DNS and per-resolver flags.
    const dns = await this.dnsConfiguration();
    const flags = new Map((dns.nameservers ?? []).map((n) => [n.address, n.useWithExitNode]));
    const nameservers =
      fields.nameservers !== undefined
        ? splitList(fields.nameservers).map((address) => ({
            address,
            ...(flags.get(address) !== undefined ? { useWithExitNode: flags.get(address) } : {}),
          }))
        : (dns.nameservers ?? []);
    await this.request(this.tailnetPath("/dns/configuration"), "POST", {
      ...dns,
      nameservers,
      searchPaths:
        fields.searchPaths !== undefined ? splitList(fields.searchPaths) : (dns.searchPaths ?? []),
      preferences: {
        ...dns.preferences,
        ...(changed("magicDNS") ? { magicDNS: fields.magicDNS === "true" } : {}),
        ...(changed("overrideLocalDNS")
          ? { overrideLocalDNS: fields.overrideLocalDNS === "true" }
          : {}),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Delete and actions
  // ---------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const id = encodeURIComponent(resource.externalId!);
    switch (typeId) {
      case "device":
        await this.request(`/device/${id}`, "DELETE");
        return;
      case "user":
        // Users are deleted with a POST; it also removes their devices.
        await this.request(`/users/${id}/delete`, "POST");
        return;
      case "user-invite":
        await this.request(`/user-invites/${id}`, "DELETE");
        return;
      case "key":
        await this.request(this.tailnetPath(`/keys/${id}`), "DELETE");
        return;
      case "webhook":
        await this.request(`/webhooks/${id}`, "DELETE");
        return;
      case "service":
        await this.request(this.tailnetPath(`/services/${id}`), "DELETE");
        return;
      case "posture-integration":
        await this.request(`/posture/integrations/${id}`, "DELETE");
        return;
      default:
        throw new Error(`Tailscale cannot delete ${typeId} resources.`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const actions: Record<string, Record<string, [string, unknown?]>> = {
      device: {
        approve: ["authorized", { authorized: true }],
        deauthorize: ["authorized", { authorized: false }],
        expire: ["expire", {}],
      },
      user: { approve: ["approve"], suspend: ["suspend"], restore: ["restore"] },
      "user-invite": { resend: ["resend"] },
      webhook: { test: ["test"] },
    };
    const action = actions[typeId]?.[actionId];
    if (!action) throw new Error("Unknown Tailscale action.");
    const resource = await this.getResource(typeId, resourceId, accountId);
    const base = {
      device: "/device",
      user: "/users",
      "user-invite": "/user-invites",
      webhook: "/webhooks",
    }[typeId as "device" | "user" | "user-invite" | "webhook"];
    await this.request(
      `${base}/${encodeURIComponent(resource.externalId!)}/${action[0]}`,
      "POST",
      action[1],
    );
  }

  /** Form-driven actions: approving or withdrawing a Service host. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId !== "service" || (command !== "approve-host" && command !== "revoke-host"))
      throw new Error("Unknown Tailscale command.");
    const values = JSON.parse(String(args[0] ?? "{}")) as Record<string, string>;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const hosts =
      (
        await this.request<{ hosts?: ServiceHost[] }>(
          this.tailnetPath(`/services/${encodeURIComponent(resource.externalId!)}/devices`),
        )
      ).hosts ?? [];
    // Only act on a device that actually advertises this Service.
    if (!hosts.some((h) => h.stableNodeID === values.deviceId))
      throw new Error("That device does not host this Service.");
    return this.request(
      this.tailnetPath(
        `/services/${encodeURIComponent(resource.externalId!)}/device/${encodeURIComponent(values.deviceId!)}/approved`,
      ),
      "POST",
      { approved: command === "approve-host" },
    );
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "webhook" || formatId !== "rotate-secret")
      throw new Error("Unknown Tailscale credential format.");
    const resource = await this.getResource(typeId, resourceId, accountId);
    const rotated = await this.request<Webhook>(
      `/webhooks/${encodeURIComponent(resource.externalId!)}/rotate`,
      "POST",
    );
    if (!rotated?.secret) throw new Error("Tailscale did not return a new secret.");
    return {
      content: rotated.secret,
      filename: `tailscale-webhook-${resource.externalId}.secret`,
      mimeType: "text/plain",
      fields: [
        {
          label: "Signing secret",
          value: rotated.secret,
          sensitive: true,
          hint: "Only shown once",
        },
      ],
      warning:
        "Update your receiver now: the previous secret no longer verifies, and Tailscale will not show this one again.",
    };
  }

  // ---------------------------------------------------------------------------
  // Logs, stats, rendering
  // ---------------------------------------------------------------------------

  /** The configuration audit log: who changed what in the tailnet. */
  async getLogs(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "tailnet") throw new Error("Only the tailnet has logs.");
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
    const response = await this.request<{ logs?: ConfigurationAuditLog[] }>(
      this.tailnetPath(`/logging/configuration?${query.toString()}`),
    );
    const lines = (response.logs ?? []).map(formatAuditLog);
    const tail = params.tailLines ? lines.slice(-params.tailLines) : lines;
    return {
      text: tail.map((line) => `${line}\n`).join(""),
      containers: ["configuration"],
      activeContainer: "configuration",
    };
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (typeId === "tailnet") {
      const [devices, users] = await Promise.allSettled([this.devices(), this.users()]);
      const list = devices.status === "fulfilled" ? devices.value : [];
      return [
        { label: "Devices", value: String(list.length) },
        { label: "Connected", value: String(list.filter((d) => d.connectedToControl).length) },
        { label: "Awaiting approval", value: String(list.filter((d) => !d.authorized).length) },
        { label: "Updates available", value: String(list.filter((d) => d.updateAvailable).length) },
        ...(users.status === "fulfilled"
          ? [{ label: "Users", value: String(users.value.length) }]
          : []),
      ];
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    if (typeId === "device") {
      return [
        { label: "Tailscale IP", value: r.resolvedOutputs.ip ?? "" },
        { label: "Status", value: sidebarStatus(r).label ?? "" },
        { label: "Client version", value: String(r.fields.clientVersion) },
      ];
    }
    if (typeId === "user") {
      return [
        { label: "Role", value: String(r.fields.role) },
        { label: "Devices", value: String(r.fields.deviceCount) },
        { label: "Status", value: String(r.fields.status) },
      ];
    }
    if (typeId === "posture-integration") {
      return [
        { label: "Matched devices", value: String(r.fields.matchedCount) },
        { label: "Devices at provider", value: String(r.fields.providerHostCount) },
      ];
    }
    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return { id: resource.id, label: resource.displayName, status: sidebarStatus(resource) };
  }

  // ---------------------------------------------------------------------------
  // SSH enrollment
  // ---------------------------------------------------------------------------

  installOnSsh(context: SshInstallContext) {
    return installOnSsh(context, {
      devices: () => this.devices(),
      createKey: () =>
        this.request<{ id: string; key: string }>(this.tailnetPath("/keys"), "POST", {
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
          await this.request<void>(this.tailnetPath(`/keys/${encodeURIComponent(id)}`), "DELETE");
        } catch (error) {
          // A consumed one-use key may already have disappeared.
          if (!isNotFound(error)) throw error;
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
}

function formatAuditLog(entry: ConfigurationAuditLog): string {
  const actor = entry.actor?.loginName || entry.actor?.displayName || entry.actor?.type || "system";
  const target = [entry.target?.type, entry.target?.name || entry.target?.id]
    .filter(Boolean)
    .join(" ");
  const property = entry.target?.property ? ` ${entry.target.property}` : "";
  const change =
    entry.old !== undefined || entry.new !== undefined
      ? ` ${JSON.stringify(entry.old ?? null)} -> ${JSON.stringify(entry.new ?? null)}`
      : "";
  const error = entry.error ? ` [failed: ${entry.error}]` : "";
  const details = entry.actionDetails ? ` (${entry.actionDetails})` : "";
  return `${entry.eventTime ?? ""} ${actor} ${entry.action ?? ""} ${target}${property}${change}${details}${error}`.trim();
}
