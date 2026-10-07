import type {
  CostEstimate,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { buildCostEstimate, CreditAccessError } from "@infrawrench/plugin-base";
import { isStatus, VastApi } from "./api.js";
import { fetchVastCostData } from "./cost-data.js";
import { buildCreateConfig, NONE } from "./create-config.js";
import { buildDockerFlags, buildEnvObject } from "./docker-env.js";
import {
  externalOf,
  mapEndpoint,
  mapEnvVar,
  mapInstance,
  mapSshKey,
  mapTemplate,
  mapVolume,
  mapWorkergroup,
} from "./mappers.js";
import { renderVastDetail, renderVastSidebarItem } from "./render.js";
import type {
  VEndpoint,
  VInstance,
  VOffer,
  VSshKey,
  VTemplate,
  VUser,
  VVolume,
  VVolumeOffer,
  VWorkergroup,
} from "./types.js";

const HOURS_PER_MONTH = 730;
const CACHE_TTL_MS = 60_000;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function picked(v: string | undefined): string {
  const s = str(v);
  return s === NONE ? "" : s;
}

function num(v: string | undefined, fallback?: number): number | undefined {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function notFound(typeId: string, id: string): Error {
  const err = new Error(`Vast.ai plugin: ${typeId} ${id} not found`);
  (err as Error & { status: number }).status = 404;
  return err;
}

/** Default offer search: verified, rentable hosts, best-scored first. */
export const OFFER_QUERY = {
  verified: { eq: true },
  rentable: { eq: true },
  rented: { eq: false },
  external: { eq: false },
  type: "ondemand",
  order: [["score", "desc"]],
  limit: 120,
};

/**
 * Vast.ai plugin client. One per account (API key); a key is a user, or a
 * team when created inside one, so every listing is account-wide.
 */
export class VastClient implements PluginClient {
  readonly api: VastApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private userCache: { at: number; value: Promise<VUser> } | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Vast.ai plugin: missing apiKey credential");
    this.api = new VastApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  user(): Promise<VUser> {
    if (!this.userCache || Date.now() - this.userCache.at > CACHE_TTL_MS) {
      const value = this.api.request<VUser>("/api/v0/users/current/");
      value.catch(() => (this.userCache = undefined));
      this.userCache = { at: Date.now(), value };
    }
    return this.userCache.value;
  }

  readonly raw = {
    instances: () => this.api.paginate<VInstance>("/api/v1/instances/", "instances", { limit: 25 }),
    volumes: async () =>
      (
        await this.api.request<{ volumes?: VVolume[] }>("/api/v0/volumes/", {
          query: { owner: "me", type: "all_volume" },
        })
      )?.volumes ?? [],
    sshKeys: async () => {
      const res = await this.api.request<VSshKey[] | { ssh_keys?: VSshKey[] }>("/api/v0/ssh/");
      const list = Array.isArray(res) ? res : (res?.ssh_keys ?? []);
      return list.filter((k) => !k.deleted_at);
    },
    endpoints: async () =>
      (await this.api.request<{ results?: VEndpoint[] }>("/api/v0/endptjobs/"))?.results ?? [],
    workergroups: async () =>
      (await this.api.request<{ results?: VWorkergroup[] }>("/api/v0/workergroups/"))?.results ??
      [],
  };

  /** Templates you created. */
  async ownTemplates(): Promise<VTemplate[]> {
    const me = await this.user();
    if (!me?.id) return [];
    const res = await this.api.request<{ templates?: VTemplate[] }>("/api/v0/template/", {
      query: { select_filters: { creator_id: { eq: me.id } }, select_cols: ["*"] },
    });
    return res?.templates ?? [];
  }

  /** Your templates first, then Vast's recommended ones. */
  async templatesForPicker(): Promise<VTemplate[]> {
    const [own, recommended] = await Promise.all([
      this.ownTemplates().catch(() => [] as VTemplate[]),
      this.api
        .request<{ templates?: VTemplate[] }>("/api/v0/template/", {
          query: { select_filters: { recommended: { eq: true } }, select_cols: ["*"] },
        })
        .then((r) => (r?.templates ?? []).map((t) => ({ ...t, recommended: true })))
        .catch(() => [] as VTemplate[]),
    ]);
    const seen = new Set(own.map((t) => t.id));
    return [...own, ...recommended.filter((t) => !seen.has(t.id))];
  }

  async searchOffers(extra: Record<string, unknown> = {}): Promise<VOffer[]> {
    const res = await this.api.request<{ offers?: VOffer[] | VOffer }>("/api/v0/bundles/", {
      method: "POST",
      body: { ...OFFER_QUERY, ...extra },
    });
    const offers = res?.offers;
    return Array.isArray(offers) ? offers : offers ? [offers] : [];
  }

  async searchVolumeOffers(): Promise<VVolumeOffer[]> {
    const res = await this.api.request<{ offers?: VVolumeOffer[] }>("/api/v0/volumes/search/", {
      method: "POST",
      body: {
        verified: { eq: true },
        external: { eq: false },
        disk_space: { gte: 1 },
        order: [["score", "desc"]],
        limit: 60,
      },
    });
    return res?.offers ?? [];
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "instance":
        return (await this.raw.instances()).map((i) => mapInstance(i, accountId));
      case "template":
        return (await this.ownTemplates()).map((t) => mapTemplate(t, accountId));
      case "volume":
        return (await this.raw.volumes()).map((v) => mapVolume(v, accountId));
      case "ssh-key":
        return (await this.raw.sshKeys()).map((k) => mapSshKey(k, accountId));
      case "serverless-endpoint":
        return (await this.raw.endpoints()).map((e) => mapEndpoint(e, accountId));
      case "workergroup":
        return (await this.raw.workergroups()).map((w) => mapWorkergroup(w, accountId));
      case "env-var": {
        const res = await this.api.request<{ secrets?: Record<string, unknown> }>(
          "/api/v0/secrets/",
        );
        // Only the names: values are secrets and never enter inventory.
        return Object.keys(res?.secrets ?? {})
          .sort()
          .map((k) => mapEnvVar(k, accountId));
      }
      default:
        throw new Error(`Vast.ai plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    if (typeId === "instance") {
      const res = await this.api.request<{ instances?: VInstance | null }>(
        `/api/v0/instances/${encodeURIComponent(id)}/`,
      );
      if (!res?.instances) throw notFound(typeId, id);
      return mapInstance(res.instances, accountId);
    }
    const found = (await this.listResources(typeId, accountId)).find(
      (r) => r.id === resourceId || r.externalId === id,
    );
    if (!found) throw notFound(typeId, id);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Create / update / delete ─────────────────────────────────────────

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return buildCreateConfig(this, typeId, parentResourceId);
  }

  instanceBody(fields: Record<string, string>, minBid?: number): Record<string, unknown> {
    const template = picked(fields["templateHash"]);
    const image = str(fields["image"]);
    if (!template && !image) {
      throw new Error("Vast.ai plugin: choose a template or enter an image");
    }
    const env = buildEnvObject(fields["env"], fields["ports"]);
    const volume = picked(fields["volumeId"]);
    const onstart = fields["onstart"] ?? "";
    // Mirrors `vastai create instance`: with a template the image and launch
    // mode come from the template unless overridden.
    const body: Record<string, unknown> = {
      client_id: "me",
      disk: num(fields["disk"], 32),
      ...(image ? { image } : {}),
      ...(template
        ? { template_hash_id: template }
        : { runtype: str(fields["runtype"]) || "ssh_direct" }),
      ...(str(fields["label"]) ? { label: str(fields["label"]) } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(onstart.trim() ? { onstart } : {}),
      ...(volume
        ? {
            volume_info: {
              create_new: false,
              volume_id: Number(volume),
              mount_path: str(fields["volumeMountPath"]) || "/workspace",
            },
          }
        : {}),
    };
    if (str(fields["pricing"]) === "interruptible") {
      const bid = num(fields["bidPrice"], 0) ?? 0;
      const price = bid > 0 ? bid : minBid;
      if (!price)
        throw new Error("Vast.ai plugin: enter a bid price for an interruptible instance");
      body["price"] = price;
    }
    return body;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "instance": {
        const offerId = str(fields["offerId"]);
        if (!/^\d+$/.test(offerId)) throw new Error("Vast.ai plugin: choose a machine offer");
        let minBid: number | undefined;
        if (str(fields["pricing"]) === "interruptible" && !(num(fields["bidPrice"], 0)! > 0)) {
          const [offer] = await this.searchOffers({
            id: { eq: Number(offerId) },
            type: "bid",
            limit: 1,
          });
          minBid = offer?.min_bid;
        }
        const res = await this.api.request<{ new_contract?: number }>(`/api/v0/asks/${offerId}/`, {
          method: "PUT",
          body: this.instanceBody(fields, minBid),
        });
        const id = res?.new_contract;
        if (!id)
          throw new Error("Vast.ai plugin: the offer was accepted but no instance id came back");
        try {
          return await this.getResource("instance", String(id), accountId);
        } catch {
          return mapInstance(
            { id, label: str(fields["label"]) || null, actual_status: "loading" },
            accountId,
          );
        }
      }
      case "template": {
        const runtype = str(fields["runtype"]) || "ssh_direct";
        const env = buildDockerFlags(fields["env"], fields["ports"]);
        const res = await this.api.request<{ template?: VTemplate }>("/api/v0/template/", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            image: str(fields["image"]),
            tag: str(fields["tag"]) || "latest",
            desc: str(fields["description"]),
            // Create accepts ssh/jupyter/args plus direct flags.
            runtype: runtype.startsWith("ssh")
              ? "ssh"
              : runtype.startsWith("jupyter")
                ? "jupyter"
                : "args",
            use_ssh: runtype.startsWith("ssh"),
            ssh_direct: runtype === "ssh_direct",
            jup_direct: runtype === "jupyter_direct",
            recommended_disk_space: num(fields["diskGb"], 32),
            private: str(fields["private"]) !== "false",
            ...(env ? { env } : {}),
            ...(str(fields["onstart"]) ? { onstart: fields["onstart"] } : {}),
            ...(str(fields["readme"]) ? { readme: fields["readme"] } : {}),
          },
        });
        const created = res?.template;
        if (created?.id) {
          return mapTemplate(
            { ...created, name: created.name ?? str(fields["name"]), image: str(fields["image"]) },
            accountId,
          );
        }
        throw new Error("Vast.ai plugin: template create returned no template");
      }
      case "volume": {
        const offerId = Number(str(fields["offerId"]));
        if (!offerId) throw new Error("Vast.ai plugin: choose a host for the volume");
        const name = str(fields["name"]);
        await this.api.request("/api/v0/volumes/", {
          method: "PUT",
          body: {
            id: offerId,
            size: Math.round(num(fields["size"], 15) ?? 15),
            ...(name ? { name } : {}),
          },
        });
        const all = await this.raw.volumes().catch(() => [] as VVolume[]);
        const created =
          (name && all.find((v) => v.label === name)) ||
          [...all].sort((a, b) => (b.start_date ?? 0) - (a.start_date ?? 0))[0];
        if (!created)
          throw new Error("Vast.ai plugin: the volume was rented but could not be found");
        return mapVolume(created, accountId);
      }
      case "ssh-key": {
        const key = str(fields["publicKey"]);
        if (!key) throw new Error("Vast.ai plugin: paste or pick a public key");
        const res = await this.api.request<{ key?: VSshKey }>("/api/v0/ssh/", {
          method: "POST",
          body: { ssh_key: key },
        });
        return mapSshKey(res?.key ?? { id: 0, key }, accountId);
      }
      case "serverless-endpoint": {
        const res = await this.api.request<{ result?: number }>("/api/v0/endptjobs/", {
          method: "POST",
          body: this.endpointBody(fields, true),
        });
        return mapEndpoint({ id: res?.result ?? 0, endpoint_name: str(fields["name"]) }, accountId);
      }
      case "workergroup": {
        const endpointId = parentResourceId?.includes(":serverless-endpoint:")
          ? externalOf(parentResourceId)
          : str(fields["endpointId"]);
        const search = str(fields["searchQuery"]);
        const res = await this.api.request<{ id?: number }>("/api/v0/workergroups/", {
          method: "POST",
          body: {
            endpoint_id: Number(endpointId),
            template_hash: str(fields["templateHash"]),
            ...(search ? { search_params: search } : {}),
            gpu_ram: num(fields["gpuRamGb"], 24),
            test_workers: num(fields["testWorkers"], 3),
          },
        });
        return mapWorkergroup(
          {
            id: res?.id ?? 0,
            endpoint_id: Number(endpointId),
            template_hash: str(fields["templateHash"]),
          },
          accountId,
        );
      }
      case "env-var": {
        const key = str(fields["key"]).toUpperCase();
        await this.api.request("/api/v0/secrets/", {
          method: "POST",
          body: { key, value: fields["value"] ?? "" },
        });
        return mapEnvVar(key, accountId);
      }
      default:
        throw new Error(`Vast.ai plugin: cannot create "${typeId}"`);
    }
  }

  private endpointBody(fields: Record<string, string>, create: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const set = (wire: string, key: string, fallback?: number) => {
      const v = num(fields[key], create ? fallback : undefined);
      if (v !== undefined) body[wire] = v;
    };
    if (fields["name"] !== undefined) body["endpoint_name"] = str(fields["name"]);
    set("max_workers", "maxWorkers", 20);
    set("cold_workers", "coldWorkers", 5);
    set("min_load", "minLoad", 10);
    set("target_util", "targetUtil", 0.9);
    set("cold_mult", "coldMult", 2.5);
    return body;
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const raw = externalOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (typeId) {
      case "instance": {
        if (fields["label"] !== undefined) {
          await this.api.request(`/api/v0/instances/${id}/`, {
            method: "PUT",
            body: { label: str(fields["label"]) },
          });
        }
        const bid = num(fields["bidPrice"]);
        if (bid !== undefined && bid > 0) {
          await this.api.request(`/api/v0/instances/bid_price/${id}/`, {
            method: "PUT",
            body: { client_id: "me", price: bid },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "template": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const body: Record<string, unknown> = { hash_id: String(current.fields["hashId"] ?? "") };
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["image"] !== undefined) body["image"] = str(fields["image"]);
        if (fields["description"] !== undefined) body["desc"] = str(fields["description"]);
        if (fields["diskGb"] !== undefined) body["recommended_disk_space"] = num(fields["diskGb"]);
        await this.api.request("/api/v0/template/", { method: "PUT", body });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "ssh-key": {
        if (fields["publicKey"] !== undefined) {
          await this.api.request(`/api/v0/ssh/${id}/`, {
            method: "PUT",
            body: { ssh_key: str(fields["publicKey"]) },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "serverless-endpoint": {
        const body = this.endpointBody(fields, false);
        if (Object.keys(body).length) {
          await this.api.request(`/api/v0/endptjobs/${id}/`, { method: "PUT", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "workergroup": {
        const body: Record<string, unknown> = {};
        if (fields["searchQuery"] !== undefined) body["search_params"] = str(fields["searchQuery"]);
        if (fields["gpuRamGb"] !== undefined) body["gpu_ram"] = num(fields["gpuRamGb"]);
        if (fields["testWorkers"] !== undefined) body["test_workers"] = num(fields["testWorkers"]);
        if (fields["launchArgs"] !== undefined) body["launch_args"] = str(fields["launchArgs"]);
        if (Object.keys(body).length) {
          await this.api.request(`/api/v0/workergroups/${id}/`, { method: "PUT", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "env-var": {
        const value = fields["value"];
        if (value) {
          await this.api.request("/api/v0/secrets/", { method: "PUT", body: { key: raw, value } });
        }
        return mapEnvVar(raw, accountId);
      }
      default:
        throw new Error(`Vast.ai plugin: cannot update "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const raw = externalOf(resourceId);
    const id = encodeURIComponent(raw);
    switch (typeId) {
      case "instance":
        await this.api.request(`/api/v0/instances/${id}/`, { method: "DELETE" });
        return;
      case "template": {
        await this.api.request("/api/v0/template/", {
          method: "DELETE",
          body: { template_id: Number(raw) },
        });
        return;
      }
      case "volume":
        // The CLI sends the id as a query parameter, the spec as a body; send both.
        await this.api.request("/api/v0/volumes/", {
          method: "DELETE",
          query: { id: raw },
          body: { id: Number(raw) },
        });
        return;
      case "ssh-key":
        await this.api.request(`/api/v0/ssh/${id}/`, { method: "DELETE" });
        return;
      case "serverless-endpoint":
        await this.api.request(`/api/v0/endptjobs/${id}/`, { method: "DELETE" });
        return;
      case "workergroup":
        await this.api.request(`/api/v0/workergroups/${id}/`, { method: "DELETE" });
        return;
      case "env-var":
        await this.api.request("/api/v0/secrets/", { method: "DELETE", body: { key: raw } });
        return;
      default:
        void accountId;
        throw new Error(`Vast.ai plugin: cannot delete "${typeId}"`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const raw = externalOf(resourceId);
    const id = encodeURIComponent(raw);
    if (typeId === "instance") {
      switch (actionId) {
        case "start":
        case "stop":
          await this.api.request(`/api/v0/instances/${id}/`, {
            method: "PUT",
            body: { state: actionId === "start" ? "running" : "stopped" },
          });
          return;
        case "reboot":
        case "recycle":
          await this.api.request(`/api/v0/instances/${actionId}/${id}/`, { method: "PUT" });
          return;
      }
    }
    if (typeId === "serverless-endpoint" && (actionId === "start" || actionId === "stop")) {
      // Start/stop is addressed by deployment, which points at its endpoint.
      const res = await this.api.request<{
        deployments?: Array<{ id: number; endpoint_id?: number | null }>;
      }>("/api/v0/deployments/");
      const deployment = (res?.deployments ?? []).find((d) => String(d.endpoint_id) === raw);
      if (!deployment) {
        throw new Error(
          "Vast.ai plugin: this endpoint has no deployment, so Vast cannot start or stop it as a whole. Scale it with Max Workers instead.",
        );
      }
      await this.api.request(`/api/v0/deployment/${deployment.id}/${actionId}/`, {
        method: "POST",
      });
      return;
    }
    throw new Error(`Vast.ai plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  // ── Estimates, cost, credits ─────────────────────────────────────────

  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    if (typeId !== "instance") return null;
    const offerId = Number(str(fields["offerId"]));
    if (!offerId) return null;
    const [offer] = await this.searchOffers({ id: { eq: offerId }, limit: 1 }).catch(() => []);
    if (!offer?.dph_total) return null;
    const bid = num(fields["bidPrice"], 0) ?? 0;
    const rate =
      str(fields["pricing"]) === "interruptible"
        ? bid > 0
          ? bid
          : (offer.min_bid ?? offer.dph_total)
        : offer.dph_total;
    return buildCostEstimate(
      [
        {
          label: `${offer.num_gpus ?? 1}x ${offer.gpu_name ?? "GPU"}`,
          monthlyAmount: rate * HOURS_PER_MONTH,
          detail: `${HOURS_PER_MONTH} h × $${rate.toFixed(3)}/h`,
          quantity: 1,
          unit: "instance",
        },
      ],
      {
        partial: true,
        notes: ["Host's hourly price while running. Bandwidth is billed per GB on top."],
      },
    );
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchVastCostData(this.api, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    let me: VUser;
    try {
      this.userCache = undefined;
      me = await this.user();
    } catch (e) {
      if (isStatus(e, 401, 403)) {
        throw new CreditAccessError(
          "Vast.ai refused the account details for this API key. It needs the user_read permission.",
          { label: "Manage Vast.ai API keys", url: "https://cloud.vast.ai/manage-keys/" },
        );
      }
      throw e;
    }
    const balance = typeof me?.balance === "number" ? me.balance : me?.credit;
    if (typeof balance !== "number" || !Number.isFinite(balance)) return [];
    return [{ key: "default", label: "Vast.ai credit", remaining: balance, currency: "USD" }];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderVastDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderVastSidebarItem(resource);
  }
}
