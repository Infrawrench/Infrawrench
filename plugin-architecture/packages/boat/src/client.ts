import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type {
  CostEstimate,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  PluginClient,
  PluginEffect,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  buildCostEstimate,
  decodePromptArgs,
  pathEncode,
  type ApiBody,
} from "@infrawrench/plugin-base";
import { createBoatApi, isStatus, listOf, listSandboxes, type BoatApi } from "./api.js";
import type { operations } from "./api-types.gen.js";
import { buildCreateConfig, NONE } from "./create-config.js";
import { fetchBoatCosts } from "./cost-data.js";
import {
  externalOf,
  mapApiKey,
  mapEnvironment,
  mapSandbox,
  mapSavedSnapshot,
  mapWebhook,
  parseEnv,
  parseLabels,
} from "./mappers.js";
import { quotasFrom } from "./quotas.js";
import { COMMANDS, renderBoatDetail, renderBoatSidebarItem } from "./render.js";
import { SANDBOX_SIZES, WEBHOOK_EVENTS } from "./resource-types.js";
import { HOURS_PER_MONTH, hourlyPrice, sizeById } from "./sizes.js";
import type {
  BLimits,
  BSandboxType,
  BSavedSnapshot,
  BSavedSnapshotAllowance,
  BWebhookEvent,
} from "./types.js";

const CACHE_TTL_MS = 60_000;
const MAX_TTL_SECONDS = 2_592_000;
const WEBHOOK_SECRET_FIELD = "signingSecret";
const HOSTED_URLS_FIELD = "hostedUrls";
const SAVED_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function picked(v: string | undefined): string {
  const s = str(v);
  return s === NONE ? "" : s;
}

function notFound(typeId: string, id: string): Error {
  return Object.assign(new Error(`boat plugin: ${typeId} ${id} not found`), { status: 404 });
}

function sizeOf(v: string | undefined): BSandboxType | undefined {
  const s = picked(v);
  if (!s) return undefined;
  if (!(SANDBOX_SIZES as readonly string[]).includes(s))
    throw new Error(`boat plugin: unknown size "${s}"`);
  return s as BSandboxType;
}

/** A form's auto-stop value: seconds, `none` for never (null), empty to leave as is. */
export function ttlOf(v: string | undefined): number | null | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (s === NONE) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TTL_SECONDS)
    throw new Error("boat plugin: auto-stop is 1 to 2592000 seconds (30 days)");
  return n;
}

export function parseEvents(text: string | undefined): BWebhookEvent[] {
  const events = [
    ...new Set(
      (text ?? "")
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter(Boolean),
    ),
  ];
  for (const e of events) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(e))
      throw new Error(`boat plugin: unknown webhook event "${e}"`);
  }
  if (events.length === 0) throw new Error("boat plugin: choose at least one event");
  return events as BWebhookEvent[];
}

export function parsePorts(text: string | undefined): number[] {
  const ports: number[] = [];
  for (const part of (text ?? "").split(/[,\s]+/)) {
    if (!part.trim()) continue;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error(`boat plugin: "${part}" is not a port`);
    if (!ports.includes(n)) ports.push(n);
  }
  return ports;
}

/**
 * boat plugin client. One per account: an API key, optionally narrowed to one
 * organization's wallet. Sandboxes and saved snapshots are private to whoever
 * created them, so a key lists its owner's sandboxes plus the organization
 * sandboxes it can see.
 */
export class BoatClient implements PluginClient {
  readonly api: BoatApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly secrets: SecretHostServices | undefined;
  private limitsCache: { at: number; value: Promise<BLimits> } | undefined;

  constructor(
    credentials: Credentials,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("boat plugin: missing apiKey credential");
    this.api = createBoatApi(
      apiKey,
      str(credentials["org"]),
      credentials["caCert"] ?? "",
      services,
    );
    this.resourceTypes = resourceTypes;
    this.secrets = services?.secrets;
  }

  readonly raw = {
    sandboxes: () => listSandboxes(this.api),
    savedSnapshots: async () => (await this.savedSnapshotList()).snapshots,
    environments: async () =>
      listOf((await this.api.get("/environments"))?.environments, "/environments", "environments"),
    webhooks: async () =>
      listOf((await this.api.get("/webhooks"))?.webhooks, "/webhooks", "webhooks"),
    apiKeys: async () => listOf((await this.api.get("/api-keys"))?.apiKeys, "/api-keys", "apiKeys"),
  };

  async savedSnapshotList(): Promise<{
    snapshots: BSavedSnapshot[];
    allowance: BSavedSnapshotAllowance | undefined;
  }> {
    const res = await this.api.get("/saved-snapshots");
    return {
      snapshots: listOf(res?.snapshots, "/saved-snapshots", "snapshots"),
      allowance: res?.allowance,
    };
  }

  /** Plan, wallet and start limits, cached for a minute (create forms and quotas share it). */
  limits(): Promise<BLimits> {
    if (!this.limitsCache || Date.now() - this.limitsCache.at > CACHE_TTL_MS) {
      const value = this.api.get("/limits");
      value.catch(() => (this.limitsCache = undefined));
      this.limitsCache = { at: Date.now(), value };
    }
    return this.limitsCache.value;
  }

  private async sandbox(id: string) {
    const res = await this.api.get(`/sandboxes/${pathEncode(id)}`);
    if (!res?.sandbox) throw notFound("sandbox", id);
    return res.sandbox;
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "sandbox":
          return (await this.raw.sandboxes()).map((s) => mapSandbox(s, accountId));
        case "saved-snapshot":
          return (await this.raw.savedSnapshots()).map((s) => mapSavedSnapshot(s, accountId));
        case "environment":
          return (await this.raw.environments()).map((e) => mapEnvironment(e, accountId));
        case "webhook":
          return (await this.raw.webhooks()).map((w) => mapWebhook(w, accountId));
        case "api-key":
          // boat answers a scoped key with `apiKeys: []`, not a 403, so a scoped
          // account lists none; only an unrestricted key sees the inventory.
          return (await this.raw.apiKeys()).map((k) => mapApiKey(k, accountId));
        default:
          throw new Error(`boat plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "sandbox":
          return mapSandbox(await this.sandbox(id), accountId);
        case "saved-snapshot": {
          const res = await this.api.get(`/saved-snapshots/${pathEncode(id)}`);
          if (!res?.snapshot) throw notFound(typeId, id);
          return mapSavedSnapshot(res.snapshot, accountId);
        }
        case "webhook": {
          const res = await this.api.get(`/webhooks/${pathEncode(id)}`);
          if (!res?.webhook) throw notFound(typeId, id);
          return mapWebhook(res.webhook, accountId);
        }
        default: {
          // Environments and API keys have no single-item GET.
          const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
            (r) => r.id === resourceId || r.externalId === id,
          );
          if (!found) throw notFound(typeId, id);
          return found;
        }
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      if (typeId === "sandbox" && outputKey === "desktopUrl") {
        return (await this.sandbox(id)).desktopUrl ?? "";
      }
      if (typeId === "sandbox" && outputKey === "hostedUrls") {
        return Object.values(await this.hostedUrls(resourceId)).join("\n");
      }
      if (typeId === "webhook" && outputKey === "signingSecret") {
        const secret = this.secrets
          ? await this.secrets.getPlaintext(resourceId, WEBHOOK_SECRET_FIELD)
          : null;
        if (secret?.trim()) return secret.trim();
        throw new Error(
          "boat shows a webhook's signing secret only when it is created or rotated. Rotate it from Infrawrench to store a new one.",
        );
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return resource.resolvedOutputs[outputKey] ?? "";
    });
  }

  // ── Create / update / delete ─────────────────────────────────────────

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => buildCreateConfig(this, typeId));
  }

  createBody(fields: Record<string, string>): ApiBody<operations["create"]> {
    const name = str(fields["name"]);
    if (name.length > 120) throw new Error("boat plugin: a name is at most 120 characters");
    const environment = str(fields["environment"]);
    const visibility = picked(fields["visibility"]);
    const labels = parseLabels(fields["labels"]);
    const env = parseEnv(fields["env"]);
    const ports = parsePorts(fields["hostedPorts"]);
    const ttl = ttlOf(fields["ttlSeconds"]);
    const from = picked(fields["from"]);
    const size = sizeOf(fields["size"]);
    const setup = fields["setupScript"] ?? "";
    return {
      ...(name ? { name } : {}),
      ...(size ? { type: size } : {}),
      ...(from ? { from } : {}),
      // `none` is a sandbox with nothing of the account's in it, which boat calls noEnv.
      ...(environment === NONE ? { noEnv: true } : environment ? { environment } : {}),
      ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
      ...(visibility === "shared" || visibility === "private" ? { visibility } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(setup.trim() ? { setupScript: setup } : {}),
      ...(ports.length ? { hostedPorts: ports.map((port) => ({ port })) } : {}),
    };
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = str(fields["name"]);
      switch (typeId) {
        case "sandbox": {
          const res = await this.api.post("/sandboxes", {
            body: this.createBody(fields),
            // A lost answer retried by the host must not start a second, billed machine.
            headers: { "Idempotency-Key": crypto.randomUUID() },
          });
          if (!res?.sandbox) throw new Error("boat plugin: create returned no sandbox");
          return mapSandbox(res.sandbox, accountId);
        }
        case "saved-snapshot": {
          if (!SAVED_SNAPSHOT_NAME.test(name))
            throw new Error(
              "boat plugin: a snapshot name is lowercase letters, digits and dashes, up to 63",
            );
          const sandboxId = str(fields["sandboxId"]);
          if (!sandboxId) throw new Error("boat plugin: choose the sandbox to save");
          const res = await this.api.post("/saved-snapshots", { body: { name, sandboxId } });
          if (!res?.snapshot) throw new Error("boat plugin: save returned no snapshot");
          return mapSavedSnapshot(res.snapshot, accountId);
        }
        case "environment": {
          if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name))
            throw new Error(
              "boat plugin: an environment name is letters, numbers, dot, dash and underscore, up to 64",
            );
          const res = await this.api.post("/environments", { body: { name } });
          const env = (res?.environments ?? []).find((e) => e.name === name);
          if (!env) throw new Error("boat plugin: the new environment was not in boat's answer");
          return mapEnvironment(env, accountId);
        }
        case "webhook": {
          const url = str(fields["url"]);
          if (!url.startsWith("https://")) throw new Error("boat plugin: the URL must be HTTPS");
          const res = await this.api.post("/webhooks", {
            body: { url, events: parseEvents(fields["events"]), ...(name ? { name } : {}) },
          });
          if (!res?.webhook) throw new Error("boat plugin: create returned no webhook");
          const resource = mapWebhook(res.webhook, accountId);
          await this.storeWebhookSecret(resource.id, res.secret);
          return resource;
        }
        default:
          throw new Error(`boat plugin: cannot create "${typeId}"`);
      }
    });
  }

  /** Port to URL for the ports hosted from Infrawrench (boat lists no hosted ports). */
  private async hostedUrls(resourceId: string): Promise<Record<string, string>> {
    const raw = this.secrets
      ? await this.secrets.getPlaintext(resourceId, HOSTED_URLS_FIELD)
      : null;
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private async storeWebhookSecret(resourceId: string, secret: string | undefined) {
    if (secret && this.secrets?.setPlaintext) {
      await this.secrets.setPlaintext(resourceId, WEBHOOK_SECRET_FIELD, secret);
    }
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const raw = externalOf(resourceId);
      const id = pathEncode(raw);
      switch (typeId) {
        case "sandbox": {
          // Only what changed goes out: boat restarts the auto-stop clock whenever
          // `ttlSeconds` is sent, so a rename must not carry it along.
          const current = await this.sandbox(raw);
          const body: ApiBody<operations["update"]> = {};
          if (fields["name"] !== undefined && str(fields["name"]) !== current.name) {
            const name = str(fields["name"]);
            if (!name || name.length > 120)
              throw new Error("boat plugin: a name is 1 to 120 characters");
            body.name = name;
          }
          if (fields["ttlSeconds"] !== undefined) {
            // An emptied auto-stop field turns auto-stop off, as the field says.
            const ttl = str(fields["ttlSeconds"]) ? ttlOf(fields["ttlSeconds"]) : null;
            if (ttl !== undefined && ttl !== (current.ttlSeconds ?? null)) body.ttlSeconds = ttl;
          }
          const sub = str(fields["subdomain"]);
          if (fields["subdomain"] !== undefined && sub && sub !== (current.subdomain ?? "")) {
            if (sub.length < 3 || sub.length > 40 || !SUBDOMAIN.test(sub))
              throw new Error(
                "boat plugin: a subdomain is 3 to 40 lowercase letters, digits and dashes",
              );
            body.subdomain = sub;
          }
          if (Object.keys(body).length === 0) return mapSandbox(current, accountId);
          const res = await this.api.patch(`/sandboxes/${id}`, { body });
          return res?.sandbox
            ? mapSandbox(res.sandbox, accountId)
            : mapSandbox(await this.sandbox(raw), accountId);
        }
        case "environment": {
          const body: ApiBody<operations["updateEnvironment"]> = {};
          if (fields["name"] !== undefined && str(fields["name"])) body.name = str(fields["name"]);
          for (const flag of [
            "isDefault",
            "safeForThirdParties",
            "passGithub",
            "passSecrets",
            "passSandboxCredentials",
            "passAgentsCredentials",
            "proxyAiCredentials",
          ] as const) {
            if (fields[flag] !== undefined) body[flag] = str(fields[flag]) === "true";
          }
          if (Object.keys(body).length > 0) await this.api.put(`/environments/${id}`, { body });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "webhook": {
          const body: ApiBody<operations["updateWebhook"]> = {};
          if (fields["name"] !== undefined) body.name = str(fields["name"]) || null;
          if (fields["url"] !== undefined) {
            const url = str(fields["url"]);
            if (!url.startsWith("https://")) throw new Error("boat plugin: the URL must be HTTPS");
            body.url = url;
          }
          if (fields["events"] !== undefined) body.events = parseEvents(fields["events"]);
          if (Object.keys(body).length === 0)
            return runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const res = await this.api.patch(`/webhooks/${id}`, { body });
          if (!res?.webhook)
            return runPluginEffect(this.getResource(typeId, resourceId, accountId));
          return mapWebhook(res.webhook, accountId);
        }
        default:
          throw new Error(`boat plugin: cannot update "${typeId}"`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const raw = externalOf(resourceId);
      const id = pathEncode(raw);
      switch (typeId) {
        case "sandbox":
          // boat refuses a delete unless the header repeats the id, so nothing deletes by accident.
          await this.api.delete(`/sandboxes/${id}`, {
            headers: { "X-Ascii-Confirm-Delete": raw },
          });
          return;
        case "saved-snapshot":
          await this.api.delete(`/saved-snapshots/${id}`);
          return;
        case "environment":
          await this.api.delete(`/environments/${id}`);
          return;
        case "webhook":
          await this.api.delete(`/webhooks/${id}`);
          return;
        case "api-key":
          await this.api.delete(`/api-keys/${id}`);
          return;
        default:
          throw new Error(`boat plugin: cannot delete "${typeId}"`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalOf(resourceId));
      if (typeId === "sandbox") {
        switch (actionId) {
          case "stop":
            await this.api.post(`/sandboxes/${id}/stop`, { body: { force: false } });
            return;
          case "force-stop":
            await this.api.post(`/sandboxes/${id}/stop`, { body: { force: true } });
            return;
          case "share":
            await this.api.post(`/sandboxes/${id}/share`);
            return;
          case "unshare":
            await this.api.post(`/sandboxes/${id}/unshare`);
            return;
          case "interrupt":
            await this.api.post(`/sandboxes/${id}/interrupt`);
            return;
        }
      }
      if (typeId === "environment" && actionId === "upgrade") {
        await this.api.post(`/environments/${id}/upgrade`, { body: {} });
        return;
      }
      if (typeId === "webhook" && actionId === "rotate-secret") {
        const res = await this.api.post(`/webhooks/${id}/rotate`);
        await this.storeWebhookSecret(resourceId, res?.secret);
        return;
      }
      throw new Error(`boat plugin: action "${actionId}" is not supported for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const values = decodePromptArgs(args);
      const raw = externalOf(resourceId);
      const id = pathEncode(raw);
      if (typeId === "sandbox") {
        switch (command) {
          case COMMANDS.authorizeSshKey: {
            const key = str(values["publicKey"]);
            if (!key) throw new Error("Paste or pick a public key.");
            const res = await this.api.post(`/sandboxes/${id}/sshkey`, { body: { key } });
            return {
              sshUser: res?.sshUser ?? "user",
              machineIp: res?.machineIp ?? null,
              sshEndpoint: res?.sshEndpoint ?? null,
              hostKey: res?.hostKey ?? null,
            };
          }
          case COMMANDS.hostPort: {
            const port = Number(values["port"]);
            if (!Number.isInteger(port) || port < 1 || port > 65535)
              throw new Error("A port is 1 to 65535.");
            const res = await this.api.post(`/sandboxes/${id}/host`, {
              body: {
                port,
                public: values["access"] === "public",
                localhost: values["localhost"] === "true",
              },
            });
            // The host discards a prompt's result, and a private URL carries a token,
            // so the URL is kept as a secret and shown as the Hosted Port URLs output.
            if (res?.url && this.secrets?.setPlaintext) {
              const urls = { ...(await this.hostedUrls(resourceId)), [String(port)]: res.url };
              await this.secrets.setPlaintext(resourceId, HOSTED_URLS_FIELD, JSON.stringify(urls));
            }
            return { url: res?.url ?? null, access: res?.access ?? null };
          }
          case COMMANDS.resume: {
            const type = sizeOf(values["size"]);
            const ttl = ttlOf(values["ttlSeconds"]);
            return this.api.post(`/sandboxes/${id}/resume`, {
              body: {
                ...(type ? { type } : {}),
                ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
              },
            });
          }
          case COMMANDS.fork: {
            const type = sizeOf(values["size"]);
            const ttl = ttlOf(values["ttlSeconds"]);
            return this.api.post(`/sandboxes/${id}/fork`, {
              body: {
                ...(type ? { type } : {}),
                ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
              },
              headers: { "Idempotency-Key": crypto.randomUUID() },
            });
          }
          case COMMANDS.saveSnapshot: {
            const name = str(values["name"]);
            if (!SAVED_SNAPSHOT_NAME.test(name))
              throw new Error("A snapshot name is lowercase letters, digits and dashes, up to 63.");
            return this.api.post("/saved-snapshots", { body: { name, sandboxId: raw } });
          }
          case COMMANDS.prompt: {
            const prompt = values["prompt"] ?? "";
            if (!prompt.trim()) throw new Error("Write a prompt.");
            const provider = str(values["provider"]) || "claude-code";
            const model = str(values["model"]);
            return this.api.post(`/sandboxes/${id}/prompt`, {
              body: {
                provider: provider as ApiBody<operations["prompt"]>["provider"],
                prompt,
                ...(model ? { model } : {}),
                ...(values["new"] === "true" ? { new: true } : {}),
              },
            });
          }
        }
      }
      if (typeId === "environment") {
        const key = str(values["key"]);
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
          throw new Error(`"${key}" is not a valid variable name.`);
        if (command === COMMANDS.setEnvVar) {
          return this.api.put(`/environments/${id}/vars/${pathEncode(key)}`, {
            body: { value: values["value"] ?? "" },
          });
        }
        if (command === COMMANDS.deleteEnvVar) {
          return this.api.delete(`/environments/${id}/vars/${pathEncode(key)}`);
        }
      }
      throw new Error(`boat plugin: command "${command}" is not supported for "${typeId}"`);
    });
  }

  // ── Money ────────────────────────────────────────────────────────────

  estimateCost(typeId: string, fields: Record<string, string>): PluginEffect<CostEstimate | null> {
    return attempt(async () => {
      if (typeId !== "sandbox") return null;
      const size = sizeById(str(fields["size"]) || "default");
      if (!size) return null;
      const limits = await this.limits().catch(() => undefined);
      const rate = hourlyPrice(size, limits);
      return buildCostEstimate(
        [
          {
            label: `${size.id} sandbox (${size.vcpus} vCPU, ${size.memoryGb} GB)`,
            monthlyAmount: rate * HOURS_PER_MONTH,
            detail: `${HOURS_PER_MONTH} h × $${rate.toFixed(4)}/h if it never stops`,
            quantity: 1,
            unit: "sandbox",
          },
        ],
        {
          partial: true,
          notes: [
            "Billed per second while running and nothing while stopped; auto-stop usually keeps the real figure far lower.",
            "Machine time inside your plan's included hours is already paid for by the plan.",
          ],
        },
      );
    });
  }

  fetchCostData(accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => fetchBoatCosts(this, accountId, range));
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      const wallet = (await this.limits()).wallet;
      // An unlimited account has no wallet, which is not a balance of zero.
      if (!wallet || typeof wallet.balanceDollars !== "number") return [];
      return [
        { key: "wallet", label: "Wallet", remaining: wallet.balanceDollars, currency: "USD" },
      ];
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const [limits, saved] = await Promise.all([
        this.limits(),
        this.savedSnapshotList().catch((err: unknown) => {
          if (isStatus(err, 403)) return undefined;
          throw err;
        }),
      ]);
      return quotasFrom(limits, saved?.allowance);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderBoatDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBoatSidebarItem(resource);
  }
}
