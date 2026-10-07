import type {
  CostEstimate,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { buildCostEstimate } from "@infrawrench/plugin-base";
import { LambdaApi } from "./api.js";
import { buildCreateConfig, DEFAULT_IMAGE, NONE } from "./create-config.js";
import { parseRules } from "./firewall.js";
import {
  externalOf,
  GLOBAL_FIREWALL_ID,
  mapFilesystem,
  mapInstance,
  mapRuleset,
  mapSshKey,
  parseTags,
} from "./mappers.js";
import { renderLambdaDetail, renderLambdaSidebarItem } from "./render.js";
import type {
  LFilesystem,
  LFirewallRuleset,
  LImage,
  LInstance,
  LInstanceTypeItem,
  LRegion,
  LSshKey,
} from "./types.js";

const CACHE_TTL_MS = 60_000;
const HOURS_PER_MONTH = 730;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function picked(v: string | undefined): string {
  const s = str(v);
  return s === NONE ? "" : s;
}

function notFound(typeId: string, id: string): Error {
  const err = new Error(`Lambda Cloud plugin: ${typeId} ${id} not found`);
  (err as Error & { status: number }).status = 404;
  return err;
}

/**
 * Lambda Cloud plugin client. One per account (API key). A key belongs to a
 * Lambda team, so every listing is team-wide.
 */
export class LambdaCloudClient implements PluginClient {
  readonly api: LambdaApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private typesCache: { at: number; value: Promise<LInstanceTypeItem[]> } | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Lambda Cloud plugin: missing apiKey credential");
    this.api = new LambdaApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  readonly raw = {
    instances: () => this.api.listAll<LInstance>("/instances"),
    filesystems: () => this.api.request<LFilesystem[]>("/filesystems"),
    rulesets: () => this.api.request<LFirewallRuleset[]>("/firewall-rulesets"),
    sshKeys: () => this.api.request<LSshKey[]>("/ssh-keys"),
    images: () => this.api.request<LImage[]>("/images"),
  };

  /** Instance types with live capacity, cached for a minute (the API allows ~1 request/s). */
  instanceTypes(): Promise<LInstanceTypeItem[]> {
    if (!this.typesCache || Date.now() - this.typesCache.at > CACHE_TTL_MS) {
      const value = this.api
        .request<Record<string, LInstanceTypeItem>>("/instance-types")
        .then((r) => Object.values(r ?? {}));
      value.catch(() => (this.typesCache = undefined));
      this.typesCache = { at: Date.now(), value };
    }
    return this.typesCache.value;
  }

  async regions(): Promise<LRegion[]> {
    return (await this.api.request<LRegion[]>("/regions")) ?? [];
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "instance":
        return (await this.raw.instances()).map((i) => mapInstance(i, accountId));
      case "filesystem":
        return ((await this.raw.filesystems()) ?? []).map((fs) => mapFilesystem(fs, accountId));
      case "firewall-ruleset":
        return ((await this.raw.rulesets()) ?? []).map((r) => mapRuleset(r, accountId));
      case "global-firewall": {
        const g = await this.api.request<LFirewallRuleset>("/firewall-rulesets/global");
        return g ? [mapRuleset(g, accountId, true)] : [];
      }
      case "ssh-key":
        return ((await this.raw.sshKeys()) ?? []).map((k) => mapSshKey(k, accountId));
      default:
        throw new Error(`Lambda Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "instance":
        return mapInstance(
          await this.api.request<LInstance>(`/instances/${encodeURIComponent(id)}`),
          accountId,
        );
      case "firewall-ruleset":
        return mapRuleset(
          await this.api.request<LFirewallRuleset>(`/firewall-rulesets/${encodeURIComponent(id)}`),
          accountId,
        );
      default: {
        const found = (await this.listResources(typeId, accountId)).find(
          (r) => r.id === resourceId || r.externalId === id,
        );
        if (!found) throw notFound(typeId, id);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "instance" && (outputKey === "jupyterUrl" || outputKey === "jupyterToken")) {
      const i = await this.api.request<LInstance>(
        `/instances/${encodeURIComponent(externalOf(resourceId))}`,
      );
      return (outputKey === "jupyterUrl" ? i?.jupyter_url : i?.jupyter_token) ?? "";
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Create / update / delete ─────────────────────────────────────────

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return buildCreateConfig(this, typeId);
  }

  launchBody(fields: Record<string, string>): Record<string, unknown> {
    const region = str(fields["regionName"]);
    const type = str(fields["instanceTypeName"]);
    const key = str(fields["sshKeyName"]);
    if (!region || !type)
      throw new Error("Lambda Cloud plugin: choose an instance type and region");
    if (!key) throw new Error("Lambda Cloud plugin: choose an SSH key");
    const image = str(fields["image"]);
    const fs = picked(fields["filesystemName"]);
    const ruleset = picked(fields["firewallRulesetId"]);
    const tags = parseTags(fields["tags"]);
    const userData = fields["userData"] ?? "";
    return {
      region_name: region,
      instance_type_name: type,
      ssh_key_names: [key],
      ...(str(fields["name"]) ? { name: str(fields["name"]) } : {}),
      ...(str(fields["hostname"]) ? { hostname: str(fields["hostname"]) } : {}),
      ...(image && image !== DEFAULT_IMAGE ? { image: { family: image } } : {}),
      // By name: Lambda mounts it at the filesystem's default mount point.
      ...(fs ? { file_system_names: [fs] } : {}),
      ...(ruleset ? { firewall_rulesets: [{ id: ruleset }] } : {}),
      ...(tags.length ? { tags } : {}),
      ...(userData.trim() ? { user_data: userData } : {}),
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = str(fields["name"]);
    switch (typeId) {
      case "instance": {
        const body = this.launchBody(fields);
        const res = await this.api.request<{ instance_ids?: string[] }>(
          "/instance-operations/launch",
          { method: "POST", body },
        );
        const id = res?.instance_ids?.[0];
        if (!id) throw new Error("Lambda Cloud plugin: launch returned no instance id");
        try {
          return await this.getResource("instance", id, accountId);
        } catch {
          const now = new Date().toISOString();
          return {
            id: `${accountId}:instance:${id}`,
            pluginId: "lambda-cloud",
            resourceTypeId: "instance",
            accountId,
            displayName: name || id,
            fields: {
              name,
              status: "booting",
              region: str(fields["regionName"]),
              instanceType: str(fields["instanceTypeName"]),
            },
            resolvedOutputs: {},
            secretStates: [],
            externalId: id,
            createdAt: now,
            updatedAt: now,
          };
        }
      }
      case "filesystem": {
        const fs = await this.api.request<LFilesystem>("/filesystems", {
          method: "POST",
          body: { name, region: str(fields["region"]) },
        });
        return mapFilesystem(fs, accountId);
      }
      case "firewall-ruleset": {
        const r = await this.api.request<LFirewallRuleset>("/firewall-rulesets", {
          method: "POST",
          body: { name, region: str(fields["region"]), rules: parseRules(fields["rules"] ?? "") },
        });
        return mapRuleset(r, accountId);
      }
      case "ssh-key": {
        const publicKey = str(fields["publicKey"]);
        if (!publicKey) throw new Error("Lambda Cloud plugin: paste or pick a public key");
        const k = await this.api.request<LSshKey>("/ssh-keys", {
          method: "POST",
          body: { name, public_key: publicKey },
        });
        return mapSshKey(k, accountId);
      }
      default:
        throw new Error(`Lambda Cloud plugin: cannot create "${typeId}"`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalOf(resourceId));
    switch (typeId) {
      case "instance": {
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["tags"] !== undefined) body["tags"] = parseTags(fields["tags"]);
        if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);
        return mapInstance(
          await this.api.request<LInstance>(`/instances/${id}`, { method: "POST", body }),
          accountId,
        );
      }
      case "firewall-ruleset": {
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["rules"] !== undefined) body["rules"] = parseRules(fields["rules"]);
        if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);
        return mapRuleset(
          await this.api.request<LFirewallRuleset>(`/firewall-rulesets/${id}`, {
            method: "PATCH",
            body,
          }),
          accountId,
        );
      }
      case "global-firewall": {
        if (fields["rules"] === undefined) return this.getResource(typeId, resourceId, accountId);
        return mapRuleset(
          await this.api.request<LFirewallRuleset>(`/firewall-rulesets/${GLOBAL_FIREWALL_ID}`, {
            method: "PATCH",
            body: { rules: parseRules(fields["rules"]) },
          }),
          accountId,
          true,
        );
      }
      default:
        throw new Error(`Lambda Cloud plugin: cannot update "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const raw = externalOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (typeId) {
      case "instance":
        await this.api.request("/instance-operations/terminate", {
          method: "POST",
          body: { instance_ids: [raw] },
        });
        return;
      case "filesystem":
        await this.api.request(`/filesystems/${id}`, { method: "DELETE" });
        return;
      case "firewall-ruleset":
        await this.api.request(`/firewall-rulesets/${id}`, { method: "DELETE" });
        return;
      case "ssh-key":
        await this.api.request(`/ssh-keys/${id}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Lambda Cloud plugin: cannot delete "${typeId}"`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "instance" && actionId === "restart") {
      await this.api.request("/instance-operations/restart", {
        method: "POST",
        body: { instance_ids: [externalOf(resourceId)] },
      });
      return;
    }
    throw new Error(`Lambda Cloud plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    if (typeId !== "instance") return null;
    const name = str(fields["instanceTypeName"] ?? fields["instanceType"]);
    if (!name) return null;
    const item = (await this.instanceTypes().catch(() => [])).find(
      (t) => t.instance_type.name === name,
    );
    const cents = item?.instance_type.price_cents_per_hour;
    if (!cents) return null;
    const rate = cents / 100;
    return buildCostEstimate(
      [
        {
          label: `${name}${item.instance_type.gpu_description ? ` (${item.instance_type.gpu_description})` : ""}`,
          monthlyAmount: rate * HOURS_PER_MONTH,
          detail: `${HOURS_PER_MONTH} h × $${rate.toFixed(2)}/h`,
          quantity: 1,
          unit: "instance",
        },
      ],
      {
        partial: true,
        notes: ["On-demand list price. Filesystem storage is billed separately."],
      },
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderLambdaDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderLambdaSidebarItem(resource);
  }
}
