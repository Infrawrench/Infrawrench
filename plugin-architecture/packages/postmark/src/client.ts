import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { PostmarkTransport, QueryValue, TokenKind } from "./api.js";
import { isAccessDenied, listPaged, postmarkFetch, statusOf } from "./api.js";
import type {
  PmDomain,
  PmInboundRule,
  PmMessageStream,
  PmSenderSignature,
  PmServer,
  PmTemplate,
  PmWebhook,
  ServerRef,
} from "./mappers.js";
import {
  mapDnsRecords,
  mapDomain,
  mapInboundRule,
  mapMessageStream,
  mapSenderSignature,
  mapServer,
  mapTemplate,
  mapWebhook,
  splitScoped,
  triggersFrom,
} from "./mappers.js";
import type { OutboundOverview } from "./metrics.js";
import { outboundOverview, rangeOrDefault, statsSeries } from "./metrics.js";
import type {
  BounceRow,
  DeliveryStats,
  MessageRow,
  SuppressionRow,
  WebhookStats,
} from "./render.js";
import {
  BOUNCES_KEY,
  COMMANDS,
  DELIVERY_KEY,
  MESSAGES_KEY,
  OVERVIEW_KEY,
  SUPPRESSIONS_KEY,
  WEBHOOK_STATS_KEY,
  renderPostmarkDetail,
  renderPostmarkSidebar,
} from "./render.js";
import { SERVER_COLORS, TRACK_LINKS, UNSUBSCRIBE_HANDLING } from "./resource-types.js";

const CACHE_MS = 60_000;
const CONCURRENCY = 4;
/** Postmark accepts at most 50 addresses per suppression call. */
const SUPPRESSION_BATCH = 50;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

interface ServerEntry {
  server: PmServer;
  ref: ServerRef;
  /** A server API token, or "" when the account token sees no token for it. */
  token: string;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const bool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === "" ? undefined : v === "true";

const trimmed = (fields: Record<string, string>, key: string): string => (fields[key] ?? "").trim();

/** Parse a prompt form's values (the host sends them JSON-encoded in `args[0]`). */
export function parsePromptValues(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]));
  } catch {
    return {};
  }
}

/** Split a pasted list of addresses (newlines, commas, spaces) and de-duplicate. */
export function parseAddresses(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.includes("@")),
    ),
  ];
}

export class PostmarkClient implements PluginClient {
  private readonly transport: PostmarkTransport;
  private readonly accountToken: string;
  private readonly serverToken: string;
  private serverCache: Cached<ServerEntry[]> | undefined;
  private domainCache: Cached<PmDomain[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.accountToken = (credentials["accountToken"] ?? "").trim();
    this.serverToken = (credentials["serverToken"] ?? "").trim();
    if (!this.accountToken && !this.serverToken) {
      throw new Error(
        "Postmark plugin: enter the account API token, or a server API token to manage a single server",
      );
    }
    const caCert = credentials["caCert"] ?? "";
    this.transport = {
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  get hasAccountToken(): boolean {
    return Boolean(this.accountToken);
  }

  private account<T>(path: string, req: Parameters<typeof postmarkFetch>[4] = {}): Promise<T> {
    if (!this.accountToken) {
      throw new Error(
        "Postmark plugin: this needs the account API token (Account, API Tokens in Postmark), not a server token",
      );
    }
    return postmarkFetch<T>(this.transport, "account", this.accountToken, path, req);
  }

  private server<T>(
    token: string,
    path: string,
    req: Parameters<typeof postmarkFetch>[4] = {},
  ): Promise<T> {
    return postmarkFetch<T>(this.transport, "server", token, path, req);
  }

  private paged<T>(
    kind: TokenKind,
    token: string,
    path: string,
    key: string,
    query: Record<string, QueryValue> = {},
  ): Promise<T[]> {
    return listPaged<T>(this.transport, kind, token, path, key, query);
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  /** Every server with a token to reach it. Memoised briefly across listers. */
  private servers(): Promise<ServerEntry[]> {
    if (this.serverCache && Date.now() - this.serverCache.at < CACHE_MS) {
      return this.serverCache.value;
    }
    const value = (async (): Promise<ServerEntry[]> => {
      if (this.accountToken) {
        const all = await this.paged<PmServer>("account", this.accountToken, "/servers", "Servers");
        return all.map((s) => ({
          server: s,
          ref: { id: String(s.ID ?? ""), name: s.Name ?? String(s.ID ?? "") },
          token: s.ApiTokens?.[0] ?? "",
        }));
      }
      const s = await this.server<PmServer>(this.serverToken, "/server");
      return [
        {
          server: s,
          ref: { id: String(s.ID ?? ""), name: s.Name ?? String(s.ID ?? "") },
          token: this.serverToken,
        },
      ];
    })();
    value.catch(() => {
      if (this.serverCache?.value === value) this.serverCache = undefined;
    });
    this.serverCache = { at: Date.now(), value };
    return value;
  }

  private async serverEntry(serverId: string): Promise<ServerEntry> {
    const entry = (await this.servers()).find((s) => s.ref.id === serverId);
    if (!entry) throw new Error(`Postmark plugin: server ${serverId} not found for this token`);
    if (!entry.token) {
      throw new Error(`Postmark plugin: Postmark returned no API token for server ${serverId}`);
    }
    return entry;
  }

  /** Run `fn` against each server that has a token; a server refusing access is skipped. */
  private async perServer(
    fn: (entry: ServerEntry) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const entries = (await this.servers()).filter((e) => e.token);
    const results = await mapLimit(entries, CONCURRENCY, async (entry) => {
      try {
        return await fn(entry);
      } catch (err) {
        if (isAccessDenied(err)) return [];
        throw err;
      }
    });
    return results.flat();
  }

  /** Every domain with its DNS details (the list endpoint carries no records). */
  private domains(): Promise<PmDomain[]> {
    if (!this.accountToken) return Promise.resolve([]);
    if (this.domainCache && Date.now() - this.domainCache.at < CACHE_MS) {
      return this.domainCache.value;
    }
    const value = (async () => {
      const list = await this.paged<PmDomain>("account", this.accountToken, "/domains", "Domains");
      return mapLimit(list, CONCURRENCY, async (d) =>
        d.ID === undefined ? d : this.account<PmDomain>(`/domains/${d.ID}`).catch(() => d),
      );
    })();
    value.catch(() => {
      if (this.domainCache?.value === value) this.domainCache = undefined;
    });
    this.domainCache = { at: Date.now(), value };
    return value;
  }

  private invalidate(): void {
    this.serverCache = undefined;
    this.domainCache = undefined;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "postmark-server":
        return (await this.servers()).map((e) => mapServer(accountId, e.server));
      case "postmark-message-stream":
        return this.perServer(async (e) => {
          const res = await this.server<{ MessageStreams?: PmMessageStream[] }>(
            e.token,
            "/message-streams",
            { query: { MessageStreamType: "All", IncludeArchivedStreams: true } },
          );
          return (res?.MessageStreams ?? []).map((s) => mapMessageStream(accountId, e.ref, s));
        });
      case "postmark-webhook":
        return this.perServer(async (e) => {
          const res = await this.server<{ Webhooks?: PmWebhook[] }>(e.token, "/webhooks");
          return (res?.Webhooks ?? []).map((w) => mapWebhook(accountId, e.ref, w));
        });
      case "postmark-template":
        return this.perServer(async (e) =>
          (
            await this.paged<PmTemplate>("server", e.token, "/templates", "Templates", {
              TemplateType: "All",
            })
          ).map((t) => mapTemplate(accountId, e.ref, t)),
        );
      case "postmark-inbound-rule":
        return this.perServer(async (e) =>
          (
            await this.paged<PmInboundRule>(
              "server",
              e.token,
              "/triggers/inboundrules",
              "InboundRules",
            )
          ).map((r) => mapInboundRule(accountId, e.ref, r)),
        );
      case "postmark-domain":
        return (await this.domains()).map((d) => mapDomain(accountId, d));
      case "postmark-dns-record":
        return (await this.domains()).flatMap((d) => mapDnsRecords(accountId, d));
      case "postmark-sender-signature":
        if (!this.accountToken) return [];
        return (
          await this.paged<PmSenderSignature>(
            "account",
            this.accountToken,
            "/senders",
            "SenderSignatures",
          )
        ).map((s) => mapSenderSignature(accountId, s));
      default:
        throw new Error(`Postmark plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    switch (typeId) {
      case "postmark-server":
        return this.loadServer(accountId, ext);
      case "postmark-message-stream": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        const s = await this.server<PmMessageStream>(
          e.token,
          `/message-streams/${encodeURIComponent(id)}`,
        );
        const r = mapMessageStream(accountId, e.ref, s);
        if (s.MessageStreamType === "Inbound") return r;
        const [overview, suppressions] = await Promise.all([
          outboundOverview(this.transport, e.token, id).catch(() => undefined),
          this.server<{ Suppressions?: SuppressionRow[] }>(
            e.token,
            `/message-streams/${encodeURIComponent(id)}/suppressions/dump`,
          )
            .then((d) => d?.Suppressions ?? [])
            .catch(() => undefined),
        ]);
        return stash(r, {
          [OVERVIEW_KEY]: overview,
          [SUPPRESSIONS_KEY]: suppressions?.slice(0, 200),
        });
      }
      case "postmark-webhook": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        const [w, stats] = await Promise.all([
          this.server<PmWebhook>(e.token, `/webhooks/${encodeURIComponent(id)}`),
          this.server<WebhookStats>(
            e.token,
            `/webhooks/${encodeURIComponent(id)}/statistics`,
          ).catch(() => undefined),
        ]);
        return stash(mapWebhook(accountId, e.ref, w), { [WEBHOOK_STATS_KEY]: stats });
      }
      case "postmark-template": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        return mapTemplate(
          accountId,
          e.ref,
          await this.server<PmTemplate>(e.token, `/templates/${encodeURIComponent(id)}`),
        );
      }
      case "postmark-domain":
        return mapDomain(
          accountId,
          await this.account<PmDomain>(`/domains/${encodeURIComponent(ext)}`),
        );
      case "postmark-dns-record": {
        const { serverId: domainId } = splitScoped(ext);
        const d = await this.account<PmDomain>(`/domains/${encodeURIComponent(domainId)}`);
        const found = mapDnsRecords(accountId, d).find((r) => r.externalId === ext);
        if (!found) throw notFound(typeId, resourceId);
        return found;
      }
      case "postmark-sender-signature":
        return mapSenderSignature(
          accountId,
          await this.account<PmSenderSignature>(`/senders/${encodeURIComponent(ext)}`),
        );
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === ext);
        if (!found) throw notFound(typeId, resourceId);
        return found;
      }
    }
  }

  private async loadServer(accountId: string, serverId: string): Promise<ResourceInstance> {
    const e = await this.serverEntry(serverId);
    const server = this.accountToken
      ? await this.account<PmServer>(`/servers/${encodeURIComponent(serverId)}`)
      : await this.server<PmServer>(e.token, "/server");
    const [overview, delivery, bounces, messages] = await Promise.all([
      outboundOverview(this.transport, e.token).catch(() => undefined),
      this.server<DeliveryStats>(e.token, "/deliverystats").catch(() => undefined),
      this.server<{ Bounces?: BounceRow[] }>(e.token, "/bounces", {
        query: { count: 25, offset: 0 },
      })
        .then((b) => b?.Bounces ?? [])
        .catch(() => undefined),
      this.server<{ Messages?: MessageRow[] }>(e.token, "/messages/outbound", {
        query: { count: 25, offset: 0 },
      })
        .then((m) => m?.Messages ?? [])
        .catch(() => undefined),
    ]);
    return stash(mapServer(accountId, server), {
      [OVERVIEW_KEY]: overview,
      [DELIVERY_KEY]: delivery,
      [BOUNCES_KEY]: bounces,
      [MESSAGES_KEY]: messages,
    });
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "postmark-server" && outputKey === "serverToken") {
      return (await this.serverEntry(externalIdOf(resourceId))).token;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Postmark plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats and metrics
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId !== "postmark-server" && resourceTypeId !== "postmark-message-stream") {
      return [];
    }
    const ext = externalIdOf(resourceId);
    const { serverId, id } =
      resourceTypeId === "postmark-server" ? { serverId: ext, id: "" } : splitScoped(ext);
    const e = await this.serverEntry(serverId);
    const o: OutboundOverview = await outboundOverview(this.transport, e.token, id || undefined);
    const rate = o.BounceRate ?? 0;
    return [
      { label: "Sent (30d)", value: (o.Sent ?? 0).toLocaleString("en-US") },
      {
        label: "Bounce rate",
        value: `${rate.toFixed(2)}%`,
        variant: rate >= 10 ? "status-error" : rate >= 5 ? "status-degraded" : "status-healthy",
      },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange);
    const ext = externalIdOf(resourceId);
    if (resourceTypeId === "postmark-server") {
      return statsSeries(this.transport, (await this.serverEntry(ext)).token, range);
    }
    if (resourceTypeId === "postmark-message-stream") {
      const { serverId, id } = splitScoped(ext);
      return statsSeries(this.transport, (await this.serverEntry(serverId)).token, range, id);
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async serverOptions(): Promise<SelectOption[]> {
    return (await this.servers())
      .filter((e) => e.token)
      .map((e) => ({ id: e.ref.id, label: e.ref.name, description: e.server.DeliveryType ?? "" }));
  }

  /** The server picker, or nothing when the form was opened from a server's page. */
  private async serverField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const options = await this.serverOptions();
    return [
      {
        key: "serverId",
        label: "Server",
        kind: "select",
        required: true,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
        options,
      },
    ];
  }

  private parentServerId(fields: Record<string, string>, parentResourceId?: string): string {
    const fromParent = parentResourceId ? externalIdOf(parentResourceId) : "";
    const id = fromParent || trimmed(fields, "serverId");
    if (!id) throw new Error("Postmark plugin: pick a server");
    return id;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const text = (
      key: string,
      label: string,
      opts: Partial<CreateFieldConfig> = {},
    ): CreateFieldConfig => ({
      key,
      label,
      kind: "text",
      required: false,
      ...opts,
    });
    const toggle = (
      key: string,
      label: string,
      defaultValue: boolean,
      description?: string,
    ): CreateFieldConfig => ({
      key,
      label,
      kind: "select",
      required: false,
      defaultValue: String(defaultValue),
      options: [
        { id: "true", label: "On" },
        { id: "false", label: "Off" },
      ],
      ...(description ? { description } : {}),
    });
    switch (typeId) {
      case "postmark-server":
        return {
          fields: [
            text("name", "Name", { required: true, description: "Needs the account API token." }),
            {
              key: "color",
              label: "Color",
              kind: "select",
              required: false,
              defaultValue: "Blue",
              options: SERVER_COLORS.map((c) => ({ id: c, label: c })),
            },
            {
              key: "deliveryType",
              label: "Delivery",
              kind: "select",
              required: true,
              defaultValue: "Live",
              description:
                "Sandbox servers accept mail but never deliver it. This cannot be changed later.",
              options: [
                { id: "Live", label: "Live" },
                { id: "Sandbox", label: "Sandbox" },
              ],
            },
            toggle("trackOpens", "Track opens", false),
            {
              key: "trackLinks",
              label: "Track links",
              kind: "select",
              required: false,
              defaultValue: "None",
              options: TRACK_LINKS.map((t) => ({ id: t, label: t })),
            },
            toggle("smtpApiActivated", "SMTP", true, "Allow sending over SMTP as well as the API."),
          ],
        };
      case "postmark-message-stream":
        return {
          fields: [
            ...(await this.serverField(parentResourceId)),
            text("streamId", "Stream ID", {
              required: true,
              placeholder: "newsletters",
              description:
                "What your app passes as MessageStream when sending. Lowercase letters, numbers and dashes; it cannot be changed later.",
            }),
            text("name", "Name", { required: true }),
            {
              key: "messageStreamType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "Transactional",
              options: [
                {
                  id: "Transactional",
                  label: "Transactional",
                  description: "One-to-one mail your app triggers.",
                },
                {
                  id: "Broadcasts",
                  label: "Broadcasts",
                  description: "Newsletters and announcements to many recipients.",
                },
              ],
            },
            text("description", "Description"),
            {
              key: "unsubscribeHandlingType",
              label: "Unsubscribe handling",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "Postmark default for the type" },
                ...UNSUBSCRIBE_HANDLING.map((u) => ({ id: u, label: u })),
              ],
            },
          ],
        };
      case "postmark-domain":
        return {
          fields: [
            text("name", "Domain", { required: true, placeholder: "example.com" }),
            text("returnPathDomain", "Return-Path domain", {
              placeholder: "pm-bounces.example.com",
              description:
                "Optional subdomain with a CNAME to pm.mtasv.net, for DMARC-aligned SPF.",
            }),
          ],
        };
      case "postmark-sender-signature":
        return {
          fields: [
            text("emailAddress", "From address", {
              required: true,
              placeholder: "support@example.com",
            }),
            text("name", "From name", { required: true }),
            text("replyToEmailAddress", "Reply-To"),
            text("returnPathDomain", "Return-Path domain"),
            text("confirmationPersonalNote", "Note in the confirmation email", {
              description: "Up to 400 characters, shown to whoever confirms the address.",
            }),
          ],
        };
      case "postmark-webhook":
        return { fields: await this.webhookFields(parentResourceId) };
      case "postmark-template":
        return {
          fields: [
            ...(await this.serverField(parentResourceId)),
            text("name", "Name", { required: true }),
            text("alias", "Alias", {
              placeholder: "welcome-email",
              description: "Lets your app send by name instead of ID.",
            }),
            {
              key: "templateType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "Standard",
              options: [
                { id: "Standard", label: "Standard" },
                {
                  id: "Layout",
                  label: "Layout",
                  description:
                    "A wrapper other templates render inside; must contain {{{@content}}}.",
                },
              ],
            },
            text("layoutTemplate", "Layout alias", {
              showWhen: { fieldKey: "templateType", fieldValue: "Standard" },
              description: "Optional alias of a layout on the same server.",
            }),
            text("subject", "Subject", {
              required: true,
              showWhen: { fieldKey: "templateType", fieldValue: "Standard" },
            }),
            {
              key: "htmlBody",
              label: "HTML body",
              kind: "code",
              codeLanguage: "html",
              required: false,
            },
            text("textBody", "Text body", { multiline: true }),
          ],
        };
      case "postmark-inbound-rule":
        return {
          fields: [
            ...(await this.serverField(parentResourceId)),
            text("rule", "Address or domain to block", {
              required: true,
              placeholder: "spammer@example.com or example.com",
            }),
          ],
        };
      default:
        throw new Error(`Postmark plugin: "${typeId}" cannot be created from Infrawrench`);
    }
  }

  private async webhookFields(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    const parentId = parentResourceId ? externalIdOf(parentResourceId) : "";
    const entries = (await this.servers()).filter(
      (e) => e.token && (!parentId || e.ref.id === parentId),
    );
    const options: SelectOption[] = [];
    await mapLimit(entries, CONCURRENCY, async (e) => {
      const res = await this.server<{ MessageStreams?: PmMessageStream[] }>(
        e.token,
        "/message-streams",
        {
          query: { MessageStreamType: "All" },
        },
      ).catch(() => ({ MessageStreams: [] as PmMessageStream[] }));
      for (const s of res?.MessageStreams ?? []) {
        if (!s.ID) continue;
        options.push({
          id: `${e.ref.id}|${s.ID}`,
          label: parentId ? (s.Name ?? s.ID) : `${e.ref.name}: ${s.Name ?? s.ID}`,
          description: s.MessageStreamType ?? "",
        });
      }
    });
    const event = (key: string, label: string, on: boolean): CreateFieldConfig => ({
      key,
      label,
      kind: "select",
      required: false,
      defaultValue: String(on),
      options: [
        { id: "true", label: "On" },
        { id: "false", label: "Off" },
      ],
    });
    return [
      {
        key: "serverStream",
        label: "Message stream",
        kind: "select",
        required: true,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
        options,
      },
      {
        key: "url",
        label: "URL",
        kind: "text",
        required: true,
        placeholder: "https://example.com/postmark",
      },
      event("delivery", "Delivery", true),
      event("bounce", "Bounce", true),
      event("bounceIncludeContent", "Include bounce content", false),
      event("spamComplaint", "Spam complaint", true),
      event("open", "Open", false),
      event("postFirstOpenOnly", "Only the first open", false),
      event("click", "Click", false),
      event("subscriptionChange", "Subscription change", false),
      { key: "httpAuthUsername", label: "Basic auth username", kind: "text", required: false },
      { key: "httpAuthPassword", label: "Basic auth password", kind: "password", required: false },
    ];
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case "postmark-server": {
        const s = await this.account<PmServer>("/servers", {
          body: {
            Name: trimmed(fields, "name"),
            ...(trimmed(fields, "color") ? { Color: trimmed(fields, "color") } : {}),
            DeliveryType: trimmed(fields, "deliveryType") || "Live",
            ...(bool(fields["trackOpens"]) !== undefined
              ? { TrackOpens: bool(fields["trackOpens"]) }
              : {}),
            ...(trimmed(fields, "trackLinks") ? { TrackLinks: trimmed(fields, "trackLinks") } : {}),
            ...(bool(fields["smtpApiActivated"]) !== undefined
              ? { SmtpApiActivated: bool(fields["smtpApiActivated"]) }
              : {}),
          },
        });
        return mapServer(accountId, s);
      }
      case "postmark-message-stream": {
        const e = await this.serverEntry(this.parentServerId(fields, parentResourceId));
        const handling = trimmed(fields, "unsubscribeHandlingType");
        const s = await this.server<PmMessageStream>(e.token, "/message-streams", {
          body: {
            ID: trimmed(fields, "streamId").toLowerCase(),
            Name: trimmed(fields, "name"),
            MessageStreamType: trimmed(fields, "messageStreamType") || "Transactional",
            ...(trimmed(fields, "description")
              ? { Description: trimmed(fields, "description") }
              : {}),
            ...(handling
              ? { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: handling } }
              : {}),
          },
        });
        return mapMessageStream(accountId, e.ref, s);
      }
      case "postmark-domain": {
        const d = await this.account<PmDomain>("/domains", {
          body: {
            Name: trimmed(fields, "name"),
            ...(trimmed(fields, "returnPathDomain")
              ? { ReturnPathDomain: trimmed(fields, "returnPathDomain") }
              : {}),
          },
        });
        return mapDomain(accountId, d);
      }
      case "postmark-sender-signature": {
        const s = await this.account<PmSenderSignature>("/senders", {
          body: {
            FromEmail: trimmed(fields, "emailAddress"),
            Name: trimmed(fields, "name"),
            ...(trimmed(fields, "replyToEmailAddress")
              ? { ReplyToEmail: trimmed(fields, "replyToEmailAddress") }
              : {}),
            ...(trimmed(fields, "returnPathDomain")
              ? { ReturnPathDomain: trimmed(fields, "returnPathDomain") }
              : {}),
            ...(trimmed(fields, "confirmationPersonalNote")
              ? {
                  ConfirmationPersonalNote: trimmed(fields, "confirmationPersonalNote").slice(
                    0,
                    400,
                  ),
                }
              : {}),
          },
        });
        return mapSenderSignature(accountId, s);
      }
      case "postmark-webhook": {
        const [serverId, stream] = trimmed(fields, "serverStream").split("|");
        const e = await this.serverEntry(serverId || this.parentServerId(fields, parentResourceId));
        const url = trimmed(fields, "url");
        if (!/^https?:\/\//i.test(url))
          throw new Error("Postmark plugin: the webhook URL must start with https://");
        const user = trimmed(fields, "httpAuthUsername");
        const w = await this.server<PmWebhook>(e.token, "/webhooks", {
          body: {
            Url: url,
            MessageStream: stream || "outbound",
            ...(user
              ? { HttpAuth: { Username: user, Password: fields["httpAuthPassword"] ?? "" } }
              : {}),
            Triggers: triggersFrom(fields),
          },
        });
        return mapWebhook(accountId, e.ref, w);
      }
      case "postmark-template": {
        const e = await this.serverEntry(this.parentServerId(fields, parentResourceId));
        const layout = trimmed(fields, "templateType") === "Layout";
        const res = await this.server<PmTemplate>(e.token, "/templates", {
          body: {
            Name: trimmed(fields, "name"),
            TemplateType: layout ? "Layout" : "Standard",
            ...(trimmed(fields, "alias") ? { Alias: trimmed(fields, "alias") } : {}),
            ...(!layout && trimmed(fields, "subject")
              ? { Subject: trimmed(fields, "subject") }
              : {}),
            ...(!layout && trimmed(fields, "layoutTemplate")
              ? { LayoutTemplate: trimmed(fields, "layoutTemplate") }
              : {}),
            ...(fields["htmlBody"] ? { HtmlBody: fields["htmlBody"] } : {}),
            ...(fields["textBody"] ? { TextBody: fields["textBody"] } : {}),
          },
        });
        return mapTemplate(accountId, e.ref, { ...res, Name: res.Name ?? trimmed(fields, "name") });
      }
      case "postmark-inbound-rule": {
        const e = await this.serverEntry(this.parentServerId(fields, parentResourceId));
        const r = await this.server<PmInboundRule>(e.token, "/triggers/inboundrules", {
          body: { Rule: trimmed(fields, "rule") },
        });
        return mapInboundRule(accountId, e.ref, r);
      }
      default:
        throw new Error(`Postmark plugin: "${typeId}" cannot be created from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case "postmark-server": {
        const body = serverBody(fields);
        if (this.accountToken) {
          await this.account<PmServer>(`/servers/${encodeURIComponent(ext)}`, {
            method: "PUT",
            body,
          });
        } else {
          await this.server<PmServer>(this.serverToken, "/server", { method: "PUT", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "postmark-message-stream": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["Name"] = trimmed(fields, "name");
        if ("description" in fields) body["Description"] = trimmed(fields, "description");
        if (trimmed(fields, "unsubscribeHandlingType")) {
          body["SubscriptionManagementConfiguration"] = {
            UnsubscribeHandlingType: trimmed(fields, "unsubscribeHandlingType"),
          };
        }
        const s = await this.server<PmMessageStream>(
          e.token,
          `/message-streams/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body,
          },
        );
        return mapMessageStream(accountId, e.ref, s);
      }
      case "postmark-domain": {
        const d = await this.account<PmDomain>(`/domains/${encodeURIComponent(ext)}`, {
          method: "PUT",
          body: { ReturnPathDomain: trimmed(fields, "returnPathDomain") },
        });
        return mapDomain(accountId, d);
      }
      case "postmark-sender-signature": {
        const current = await this.account<PmSenderSignature>(
          `/senders/${encodeURIComponent(ext)}`,
        );
        const s = await this.account<PmSenderSignature>(`/senders/${encodeURIComponent(ext)}`, {
          method: "PUT",
          body: {
            Name: "name" in fields ? trimmed(fields, "name") : (current.Name ?? ""),
            ...("replyToEmailAddress" in fields
              ? { ReplyToEmail: trimmed(fields, "replyToEmailAddress") }
              : {}),
            ...("returnPathDomain" in fields
              ? { ReturnPathDomain: trimmed(fields, "returnPathDomain") }
              : {}),
          },
        });
        return mapSenderSignature(accountId, s);
      }
      case "postmark-webhook": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        const current = await this.server<PmWebhook>(
          e.token,
          `/webhooks/${encodeURIComponent(id)}`,
        );
        const merged = { ...mapWebhook(accountId, e.ref, current).fields, ...fields } as Record<
          string,
          string | boolean
        >;
        const body: Record<string, unknown> = { Triggers: triggersFrom(merged) };
        if ("url" in fields) body["Url"] = trimmed(fields, "url");
        if ("httpAuthUsername" in fields || fields["httpAuthPassword"]) {
          const user =
            "httpAuthUsername" in fields
              ? trimmed(fields, "httpAuthUsername")
              : (current.HttpAuth?.Username ?? "");
          body["HttpAuth"] = user
            ? {
                Username: user,
                Password: fields["httpAuthPassword"] || current.HttpAuth?.Password || "",
              }
            : { Username: "", Password: "" };
        }
        const w = await this.server<PmWebhook>(e.token, `/webhooks/${encodeURIComponent(id)}`, {
          method: "PUT",
          body,
        });
        return mapWebhook(accountId, e.ref, w);
      }
      case "postmark-template": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        const map: Record<string, string> = {
          name: "Name",
          alias: "Alias",
          subject: "Subject",
          htmlBody: "HtmlBody",
          textBody: "TextBody",
          layoutTemplate: "LayoutTemplate",
        };
        const body: Record<string, string> = {};
        for (const [key, param] of Object.entries(map)) {
          if (key in fields)
            body[param] =
              key === "htmlBody" || key === "textBody" ? (fields[key] ?? "") : trimmed(fields, key);
        }
        await this.server<PmTemplate>(e.token, `/templates/${encodeURIComponent(id)}`, {
          method: "PUT",
          body,
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Postmark plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete and actions
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case "postmark-server":
        await this.account(`/servers/${encodeURIComponent(ext)}`, { method: "DELETE" });
        return;
      case "postmark-message-stream": {
        // Postmark has no delete: archiving stops the stream and purges it after 45 days.
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        await this.server(e.token, `/message-streams/${encodeURIComponent(id)}/archive`, {
          method: "POST",
        });
        return;
      }
      case "postmark-domain":
        await this.account(`/domains/${encodeURIComponent(ext)}`, { method: "DELETE" });
        return;
      case "postmark-sender-signature":
        await this.account(`/senders/${encodeURIComponent(ext)}`, { method: "DELETE" });
        return;
      case "postmark-webhook":
      case "postmark-template":
      case "postmark-inbound-rule": {
        const { serverId, id } = splitScoped(ext);
        const e = await this.serverEntry(serverId);
        const base =
          typeId === "postmark-webhook"
            ? "/webhooks"
            : typeId === "postmark-template"
              ? "/templates"
              : "/triggers/inboundrules";
        await this.server(e.token, `${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
        return;
      }
      default:
        throw new Error(`Postmark plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === "postmark-domain") {
      const base = `/domains/${encodeURIComponent(ext)}`;
      if (actionId === "verify-dkim") {
        const d = await this.account<PmDomain>(`${base}/verifyDkim`, { method: "PUT" });
        if (!d?.DKIMVerified && !d?.DKIMPendingHost) {
          throw new Error(
            "Postmark has not found the DKIM TXT record yet. DNS changes can take a while to show up.",
          );
        }
        return;
      }
      if (actionId === "verify-return-path") {
        const d = await this.account<PmDomain>(`${base}/verifyReturnPath`, { method: "PUT" });
        if (d && d.ReturnPathDomainVerified === false) {
          throw new Error(
            "Postmark has not found the Return-Path CNAME yet. DNS changes can take a while to show up.",
          );
        }
        return;
      }
      if (actionId === "rotate-dkim") {
        await this.account(`${base}/rotatedkim`, { method: "POST" });
        return;
      }
    }
    if (typeId === "postmark-sender-signature" && actionId === "resend-confirmation") {
      await this.account(`/senders/${encodeURIComponent(ext)}/resend`, { method: "POST" });
      return;
    }
    if (
      typeId === "postmark-message-stream" &&
      (actionId === "archive" || actionId === "unarchive")
    ) {
      const { serverId, id } = splitScoped(ext);
      const e = await this.serverEntry(serverId);
      await this.server(e.token, `/message-streams/${encodeURIComponent(id)}/${actionId}`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "postmark-webhook" && actionId === "verify") {
      const { serverId, id } = splitScoped(ext);
      const e = await this.serverEntry(serverId);
      const res = await this.server<{
        Success?: boolean;
        Message?: string;
        Results?: Array<{ TriggerType?: string; Success?: boolean; Message?: string }>;
      }>(e.token, `/webhooks/${encodeURIComponent(id)}/verify`, { method: "POST" });
      if (res && res.Success === false) {
        const failed = (res.Results ?? [])
          .filter((r) => r.Success === false)
          .map((r) => `${r.TriggerType}: ${r.Message ?? "failed"}`);
        throw new Error(
          `Postmark could not reach the endpoint. ${failed.join("; ") || res.Message || ""}`.trim(),
        );
      }
      return;
    }
    throw new Error(`Postmark plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = parsePromptValues(args);
    const ext = externalIdOf(resourceId);
    if (
      typeId === "postmark-message-stream" &&
      (command === COMMANDS.addSuppressions || command === COMMANDS.removeSuppressions)
    ) {
      const { serverId, id } = splitScoped(ext);
      const e = await this.serverEntry(serverId);
      const emails = parseAddresses(values["emails"] ?? "");
      if (emails.length === 0) throw new Error("Enter at least one email address.");
      const path = `/message-streams/${encodeURIComponent(id)}/suppressions${command === COMMANDS.removeSuppressions ? "/delete" : ""}`;
      const failed: string[] = [];
      for (let i = 0; i < emails.length; i += SUPPRESSION_BATCH) {
        const batch = emails.slice(i, i + SUPPRESSION_BATCH);
        const res = await this.server<{
          Suppressions?: Array<{ EmailAddress?: string; Status?: string; Message?: string | null }>;
        }>(e.token, path, {
          body: { Suppressions: batch.map((EmailAddress) => ({ EmailAddress })) },
        });
        for (const s of res?.Suppressions ?? []) {
          if (s.Status === "Failed") failed.push(`${s.EmailAddress}: ${s.Message ?? "failed"}`);
        }
      }
      if (failed.length > 0)
        throw new Error(`Some addresses were not changed. ${failed.join("; ")}`);
      return { ok: true, count: emails.length };
    }
    if (typeId === "postmark-server" && command === COMMANDS.reactivateBounce) {
      const e = await this.serverEntry(ext);
      const bounceId = (values["bounceId"] ?? "").trim();
      if (!bounceId) throw new Error("Pick a bounce to reactivate.");
      return this.server(e.token, `/bounces/${encodeURIComponent(bounceId)}/activate`, {
        method: "PUT",
      });
    }
    throw new Error(`Postmark plugin: unknown command "${command}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPostmarkDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPostmarkSidebar(resource);
  }
}

function notFound(typeId: string, resourceId: string): Error {
  return Object.assign(new Error(`Postmark plugin: ${typeId} ${resourceId} not found`), {
    status: 404,
  });
}

function stash(r: ResourceInstance, extras: Record<string, unknown>): ResourceInstance {
  const out: Record<string, string> = { ...r.resolvedOutputs };
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return { ...r, resolvedOutputs: out };
}

const SERVER_FIELDS: Record<string, string> = {
  name: "Name",
  color: "Color",
  smtpApiActivated: "SmtpApiActivated",
  rawEmailEnabled: "RawEmailEnabled",
  trackOpens: "TrackOpens",
  trackLinks: "TrackLinks",
  inboundHookUrl: "InboundHookUrl",
  inboundDomain: "InboundDomain",
  inboundSpamThreshold: "InboundSpamThreshold",
  postFirstOpenOnly: "PostFirstOpenOnly",
  includeBounceContentInHook: "IncludeBounceContentInHook",
  enableSmtpApiErrorHooks: "EnableSmtpApiErrorHooks",
};

const SERVER_BOOLEANS = new Set([
  "smtpApiActivated",
  "rawEmailEnabled",
  "trackOpens",
  "postFirstOpenOnly",
  "includeBounceContentInHook",
  "enableSmtpApiErrorHooks",
]);

/** Edited server fields → Postmark's PUT body (only what changed). */
export function serverBody(fields: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(SERVER_FIELDS)) {
    if (!(key in fields)) continue;
    const raw = (fields[key] ?? "").trim();
    if (SERVER_BOOLEANS.has(key)) {
      const b = bool(raw);
      if (b !== undefined) body[param] = b;
    } else if (key === "inboundSpamThreshold") {
      if (raw !== "") {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0)
          throw new Error("Postmark plugin: the spam threshold must be 0 or more");
        body[param] = n;
      }
    } else {
      body[param] = raw;
    }
  }
  return body;
}

export { statusOf };
