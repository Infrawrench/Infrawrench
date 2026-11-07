import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import { pathEncode, type ApiBody, type PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PolicyOption,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { ResendApi } from "./api.js";
import { API_BASE, ResendApiError, createResendApi, isRestrictedKey, listAll } from "./api.js";
import type { operations } from "./api-types.gen.js";
import type { ResendDomain } from "./mappers.js";
import {
  mapAccount,
  mapApiKey,
  mapAutomation,
  mapBroadcast,
  mapContact,
  mapContactProperty,
  mapDnsRecords,
  mapDomain,
  mapEmail,
  mapOAuthGrant,
  mapSegment,
  mapSuppression,
  mapTemplate,
  mapTopic,
  mapWebhook,
  qualify,
  toIso,
} from "./mappers.js";
import { emailMetrics } from "./metrics.js";
import type { DeliveryStash, RecordStash } from "./render.js";
import { STASH, renderDetail, renderSidebarItem } from "./render.js";
import {
  ACCOUNT,
  API_KEY,
  AUTOMATION,
  BROADCAST,
  CONTACT,
  CONTACT_PROPERTY,
  DNS_RECORD,
  DOMAIN,
  EMAIL,
  OAUTH_GRANT,
  SEGMENT,
  SUPPRESSION,
  TEMPLATE,
  TOPIC,
  WEBHOOK,
} from "./resource-types.js";

/**
 * Event types a webhook can subscribe to: the `webhooks` section of Resend's
 * OpenAPI spec (1.5.1) and https://resend.com/docs/webhooks/event-types.
 */
export const WEBHOOK_EVENTS = [
  "email.sent",
  "email.scheduled",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
];

/** Sending regions `POST /domains` accepts. */
const REGIONS = [
  { id: "us-east-1", label: "North Virginia (us-east-1)" },
  { id: "eu-west-1", label: "Ireland (eu-west-1)" },
  { id: "sa-east-1", label: "São Paulo (sa-east-1)" },
  { id: "ap-northeast-1", label: "Tokyo (ap-northeast-1)" },
];

/** Domain details are reused by the domain and DNS-record listers within a sync. */
const DOMAIN_CACHE_MS = 60_000;

/** Run `fn` over `items` with at most `limit` in flight (Resend allows 10 req/s per team). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const queue = items.entries();
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (const [i, item] of queue) out[i] = await fn(item);
    }),
  );
  return out;
}

export function parseList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed))
        return parsed
          .map(String)
          .map((v) => v.trim())
          .filter(Boolean);
    } catch {
      // Fall through.
    }
  }
  return text
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const opt = (v: string | undefined): string | undefined => {
  const t = (v ?? "").trim();
  return t ? t : undefined;
};

/** What a line of the email logs reads, from a sent or a received email. */
interface LoggedEmail {
  id?: string;
  to?: string[] | string;
  from?: string;
  subject?: string | null;
  created_at?: string;
  last_event?: string;
}

function eventOptions(): PolicyOption[] {
  return WEBHOOK_EVENTS.map((id) => ({ id, label: id, category: id.split(".")[0] ?? "email" }));
}

/**
 * Resend plugin client. A key belongs to one team; the team's usage is the
 * account root and everything else is listed from it.
 */
export class ResendClient implements PluginClient {
  private readonly api: ResendApi;
  private readonly services: HostServices | undefined;
  private domainCache: { at: number; domains: Promise<ResendDomain[]> } | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Resend plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    const oauth = services?.oauth;
    this.api = createResendApi({
      apiKey,
      ...(oauth ? { getToken: () => oauth.getAccessToken() } : {}),
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    });
    this.services = services;
  }

  private listDomains() {
    return listAll((query) => this.api.get("/domains", { query }));
  }

  private listSegments() {
    return listAll((query) => this.api.get("/segments", { query }));
  }

  // ---------------------------------------------------------------- listing

  /** Every domain with its records: the list omits records, so each is re-read. */
  private detailedDomains(): Promise<ResendDomain[]> {
    const now = Date.now();
    if (this.domainCache && now - this.domainCache.at < DOMAIN_CACHE_MS)
      return this.domainCache.domains;
    const domains = (async () => {
      const list = await this.listDomains();
      return mapLimit(list, 3, async (d) =>
        d.id
          ? {
              ...d,
              ...(await this.api.get(`/domains/${pathEncode(d.id)}`).catch(() => ({}))),
            }
          : d,
      );
    })();
    domains.catch(() => {
      this.domainCache = undefined;
    });
    this.domainCache = { at: now, domains };
    return domains;
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const { api } = this;
      switch (typeId) {
        case ACCOUNT:
          return [await this.fetchAccount(accountId)];
        case DOMAIN:
          return (await this.detailedDomains()).map((d) => mapDomain(accountId, d));
        case DNS_RECORD:
          return (await this.detailedDomains()).flatMap((d) => mapDnsRecords(accountId, d));
        case API_KEY:
          return (await listAll((query) => api.get("/api-keys", { query }))).map((k) =>
            mapApiKey(accountId, k),
          );
        case WEBHOOK:
          return (await listAll((query) => api.get("/webhooks", { query }))).map((w) =>
            mapWebhook(accountId, w),
          );
        case EMAIL:
          return (await listAll((query) => api.get("/emails", { query }), 1)).map((e) =>
            mapEmail(accountId, e),
          );
        case BROADCAST:
          return (await listAll((query) => api.get("/broadcasts", { query }))).map((b) =>
            mapBroadcast(accountId, b),
          );
        case TEMPLATE:
          return (await listAll((query) => api.get("/templates", { query }))).map((t) =>
            mapTemplate(accountId, t),
          );
        case SEGMENT:
          return (await this.listSegments()).map((s) => mapSegment(accountId, s));
        case TOPIC:
          return (await listAll((query) => api.get("/topics", { query }))).map((t) =>
            mapTopic(accountId, t),
          );
        case CONTACT:
          return (await listAll((query) => api.get("/contacts", { query }))).map((c) =>
            mapContact(accountId, c),
          );
        case CONTACT_PROPERTY:
          return (await listAll((query) => api.get("/contact-properties", { query }))).map((p) =>
            mapContactProperty(accountId, p),
          );
        case SUPPRESSION:
          return (await listAll((query) => api.get("/suppressions", { query }))).map((s) =>
            mapSuppression(accountId, s),
          );
        case AUTOMATION:
          return (await listAll((query) => api.get("/automations", { query }))).map((a) =>
            mapAutomation(accountId, a),
          );
        case OAUTH_GRANT:
          return (await listAll((query) => api.get("/oauth/grants", { query }))).map((g) =>
            mapOAuthGrant(accountId, g),
          );
        default:
          throw new Error(`Resend plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async fetchAccount(accountId: string): Promise<ResourceInstance> {
    const usage = await this.api.get("/usage").catch((err: unknown) => {
      if (isRestrictedKey(err)) {
        throw new ResendApiError(
          err.status,
          "This is a sending-only Resend API key. Infrawrench needs a Full access key to manage the account.",
          "restricted_api_key",
        );
      }
      throw err;
    });
    const resource = mapAccount(accountId, usage);
    resource.resolvedOutputs["apiBaseUrl"] = API_BASE;
    return resource;
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const enc = pathEncode(id);
      const { api } = this;
      switch (typeId) {
        case ACCOUNT:
          return this.fetchAccount(accountId);
        case DOMAIN:
          return mapDomain(accountId, await api.get(`/domains/${enc}`));
        case DNS_RECORD: {
          const domainId = id.split("/")[0] ?? "";
          const domain = await api.get(`/domains/${pathEncode(domainId)}`);
          const found = mapDnsRecords(accountId, domain).find((r) => r.id === resourceId);
          if (!found) throw new ResendApiError(404, `Resend plugin: DNS record ${id} not found`);
          return found;
        }
        case API_KEY: {
          // There is no single-key GET.
          const found = (await runPluginEffect(this.listResources(API_KEY, accountId))).find(
            (r) => r.id === resourceId,
          );
          if (!found) throw new ResendApiError(404, `Resend plugin: API key ${id} not found`);
          return found;
        }
        case WEBHOOK:
          return mapWebhook(accountId, await api.get(`/webhooks/${enc}`));
        case EMAIL:
          return mapEmail(accountId, await api.get(`/emails/${enc}`));
        case BROADCAST:
          return mapBroadcast(accountId, await api.get(`/broadcasts/${enc}`));
        case TEMPLATE:
          return mapTemplate(accountId, await api.get(`/templates/${enc}`));
        case SEGMENT:
          return mapSegment(accountId, await api.get(`/segments/${enc}`));
        case TOPIC:
          return mapTopic(accountId, await api.get(`/topics/${enc}`));
        case CONTACT:
          return mapContact(accountId, await api.get(`/contacts/${enc}`));
        case CONTACT_PROPERTY:
          return mapContactProperty(accountId, await api.get(`/contact-properties/${enc}`));
        case SUPPRESSION:
          return mapSuppression(accountId, await api.get(`/suppressions/${enc}`));
        case AUTOMATION:
          return mapAutomation(accountId, await api.get(`/automations/${enc}`));
        case OAUTH_GRANT: {
          const found = (await runPluginEffect(this.listResources(OAUTH_GRANT, accountId))).find(
            (r) => r.id === resourceId,
          );
          if (!found) throw new ResendApiError(404, `Resend plugin: OAuth grant ${id} not found`);
          return found;
        }
        default:
          throw new Error(`Resend plugin: unknown resource type "${typeId}"`);
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
      if (outputKey === "apiBaseUrl") return API_BASE;
      if (typeId === WEBHOOK && outputKey === "signingSecret") {
        // Unlike most providers, Resend returns the secret on every GET.
        const hook = await this.api.get(`/webhooks/${pathEncode(externalIdOf(resourceId))}`);
        return hook.signing_secret ?? "";
      }
      if (typeId === API_KEY && outputKey === "token") {
        const token = await this.services?.secrets?.getPlaintext(resourceId, "token");
        if (token) return token;
        throw new Error(
          "Resend shows an API key's token only when it is created. This key was created outside Infrawrench; create a new one here to keep its token.",
        );
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey] ?? resource.fields[outputKey];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  // ------------------------------------------------------------- enrichment

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(resource.externalId ?? "");
      const { api } = this;
      const stash = <V>(key: string, value: V): ResourceInstance => ({
        ...resource,
        resolvedOutputs: { ...resource.resolvedOutputs, [key]: JSON.stringify(value) },
      });
      switch (resource.resourceTypeId) {
        case DOMAIN: {
          const d = await api.get(`/domains/${id}`);
          const records: RecordStash[] = (d.records ?? []).map((r) => ({
            purpose: r.record ?? "",
            name: qualify(r.name, d.name ?? ""),
            type: r.type ?? "",
            value: r.value ?? "",
            priority: typeof r.priority === "number" ? String(r.priority) : "",
            status: r.status ?? "",
          }));
          return stash(STASH.records, records);
        }
        case WEBHOOK: {
          const res = await api.get(`/webhooks/${id}/events`, { query: { limit: 50 } });
          const deliveries: DeliveryStash[] = (res?.data ?? []).map((e) => ({
            id: e.id ?? "",
            type: e.type ?? "",
            status: e.status ?? "",
            createdAt: toIso(e.created_at),
          }));
          return stash(STASH.deliveries, deliveries);
        }
        case AUTOMATION: {
          const [detail, runs] = await Promise.all([
            api.get(`/automations/${id}`),
            api
              .get(`/automations/${id}/runs`, { query: { limit: 20 } })
              .catch(() => ({ data: [] })),
          ]);
          const withSteps = stash(
            STASH.steps,
            (detail.steps ?? []).map((st) => ({
              key: st.key ?? "",
              type: st.type ?? "",
              config: st.config ? JSON.stringify(st.config) : "",
            })),
          );
          return {
            ...withSteps,
            resolvedOutputs: {
              ...withSteps.resolvedOutputs,
              [STASH.runs]: JSON.stringify(
                (runs.data ?? []).map((r) => ({
                  id: r.id ?? "",
                  status: r.status ?? "",
                  createdAt: toIso(r.created_at),
                })),
              ),
            },
          };
        }
        case SEGMENT: {
          const res = await api.get(`/segments/${id}/contacts`, { query: { limit: 100 } });
          return stash(
            STASH.contacts,
            (res?.data ?? []).map((c) => ({
              email: c.email ?? "",
              unsubscribed: c.unsubscribed ?? false,
            })),
          );
        }
        default:
          return resource;
      }
    });
  }

  // ---------------------------------------------------------------- create

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const text = (
        key: string,
        label: string,
        required: boolean,
        extra: Partial<CreateFieldConfig> = {},
      ): CreateFieldConfig => ({
        key,
        label,
        kind: "text",
        required,
        ...extra,
      });
      const select = (
        key: string,
        label: string,
        options: Array<{ id: string; label: string; description?: string }>,
        defaultValue: string,
        extra: Partial<CreateFieldConfig> = {},
      ): CreateFieldConfig => ({
        key,
        label,
        kind: "select",
        required: true,
        options,
        defaultValue,
        ...extra,
      });
      const onOff = [
        { id: "enabled", label: "Enabled" },
        { id: "disabled", label: "Disabled" },
      ];
      const yesNo = [
        { id: "false", label: "Off" },
        { id: "true", label: "On" },
      ];
      switch (typeId) {
        case DOMAIN:
          return {
            fields: [
              text("name", "Domain", true, {
                placeholder: "mail.example.com",
                description:
                  "A subdomain keeps your root domain's reputation separate from transactional mail.",
              }),
              select("region", "Region", REGIONS, "us-east-1", {
                description:
                  "Where Resend sends from. Pick the one closest to your recipients. It cannot be changed later.",
              }),
              select("sending", "Sending", onOff, "enabled"),
              select("receiving", "Receiving", onOff, "disabled", {
                description: "Adds an MX record so Resend accepts inbound mail for the domain.",
              }),
              select("openTracking", "Open Tracking", yesNo, "false"),
              select("clickTracking", "Click Tracking", yesNo, "false"),
              text("trackingSubdomain", "Tracking Subdomain", false, { placeholder: "links" }),
              text("customReturnPath", "Return-Path Subdomain", false, {
                placeholder: "send",
                description: "The bounce subdomain for SPF. Defaults to `send`.",
              }),
              select(
                "tls",
                "TLS",
                [
                  {
                    id: "opportunistic",
                    label: "Opportunistic",
                    description: "Use TLS when the receiving server offers it",
                  },
                  { id: "enforced", label: "Enforced", description: "Never deliver without TLS" },
                ],
                "opportunistic",
              ),
            ],
          };
        case API_KEY: {
          const domains = await this.listDomains().catch(() => []);
          return {
            fields: [
              text("name", "Name", true, { placeholder: "production-api" }),
              select(
                "permission",
                "Permission",
                [
                  {
                    id: "full_access",
                    label: "Full access",
                    description: "Manage everything, including other keys",
                  },
                  {
                    id: "sending_access",
                    label: "Sending access",
                    description: "Only send emails",
                  },
                ],
                "sending_access",
              ),
              {
                key: "domainId",
                label: "Domain",
                kind: "select",
                required: false,
                options: [
                  { id: "", label: "Any domain" },
                  ...domains
                    .filter((d) => d.id)
                    .map((d) => ({ id: String(d.id), label: d.name ?? String(d.id) })),
                ],
                defaultValue: "",
                description: "Restrict a sending key to one domain.",
                showWhen: { fieldKey: "permission", fieldValue: "sending_access" },
              },
            ],
          };
        }
        case WEBHOOK:
          return {
            fields: [
              text("endpoint", "Endpoint URL", true, {
                placeholder: "https://example.com/webhooks/resend",
              }),
              {
                key: "events",
                label: "Events",
                kind: "policy-picker",
                required: true,
                policies: eventOptions(),
              },
            ],
          };
        case BROADCAST: {
          const [segments, topics, domains] = await Promise.all([
            this.listSegments().catch(() => []),
            listAll((query) => this.api.get("/topics", { query })).catch(() => []),
            this.listDomains().catch(() => []),
          ]);
          const verified = domains
            .filter((d) => d.status === "verified")
            .map((d) => d.name)
            .filter(Boolean);
          return {
            fields: [
              text("name", "Name", false, { placeholder: "October newsletter" }),
              select(
                "segmentId",
                "Segment",
                segments
                  .filter((s) => s.id)
                  .map((s) => ({ id: String(s.id), label: s.name ?? String(s.id) })),
                segments[0]?.id ?? "",
              ),
              {
                key: "topicId",
                label: "Topic",
                kind: "select",
                required: false,
                options: [
                  { id: "", label: "None" },
                  ...topics
                    .filter((t) => t.id)
                    .map((t) => ({ id: String(t.id), label: t.name ?? String(t.id) })),
                ],
                defaultValue: "",
                description: "Only contacts subscribed to the topic receive it.",
              },
              text("from", "From", true, {
                placeholder: verified[0] ? `Acme <news@${verified[0]}>` : "Acme <news@example.com>",
                description: verified.length
                  ? `Use an address on a verified domain: ${verified.join(", ")}.`
                  : "No verified domains yet: add and verify a domain first.",
              }),
              text("subject", "Subject", true),
              text("replyTo", "Reply-To", false, { placeholder: "support@example.com" }),
              text("previewText", "Preview Text", false),
              { key: "html", label: "HTML", kind: "code", codeLanguage: "html", required: false },
              text("text", "Plain Text", false, { multiline: true }),
              select(
                "sendMode",
                "Send",
                [
                  { id: "draft", label: "Save as draft" },
                  { id: "now", label: "Send now" },
                  { id: "schedule", label: "Schedule" },
                ],
                "draft",
              ),
              {
                key: "scheduledAt",
                label: "Send At",
                kind: "datetime",
                datetimeMode: "datetime",
                required: false,
                showWhen: { fieldKey: "sendMode", fieldValue: "schedule" },
              },
            ],
          };
        }
        case TEMPLATE:
          return {
            fields: [
              text("name", "Name", true),
              text("alias", "Alias", false, { placeholder: "welcome-email" }),
              text("from", "From", false, { placeholder: "Acme <hello@example.com>" }),
              text("subject", "Subject", false),
              { key: "html", label: "HTML", kind: "code", codeLanguage: "html", required: true },
              text("text", "Plain Text", false, { multiline: true }),
            ],
          };
        case SEGMENT:
          return { fields: [text("name", "Name", true, { placeholder: "Registered users" })] };
        case TOPIC:
          return {
            fields: [
              text("name", "Name", true, {
                placeholder: "Product updates",
                description: "Up to 50 characters.",
              }),
              text("description", "Description", false, { description: "Up to 200 characters." }),
              select(
                "defaultSubscription",
                "Default",
                [
                  {
                    id: "opt_in",
                    label: "Opted in",
                    description: "Contacts receive it unless they opt out",
                  },
                  { id: "opt_out", label: "Opted out", description: "Contacts must opt in" },
                ],
                "opt_in",
                { description: "Cannot be changed later." },
              ),
              select(
                "visibility",
                "Visibility",
                [
                  { id: "public", label: "Public", description: "Shown on the unsubscribe page" },
                  { id: "private", label: "Private", description: "Hidden from contacts" },
                ],
                "public",
              ),
            ],
          };
        case CONTACT: {
          const segments = await this.listSegments().catch(() => []);
          return {
            fields: [
              text("email", "Email", true, { placeholder: "jane@example.com" }),
              text("firstName", "First Name", false),
              text("lastName", "Last Name", false),
              select(
                "unsubscribed",
                "Subscribed",
                [
                  { id: "false", label: "Subscribed" },
                  { id: "true", label: "Unsubscribed from all broadcasts" },
                ],
                "false",
              ),
              {
                key: "segments",
                label: "Segments",
                kind: "policy-picker",
                required: false,
                policies: segments
                  .filter((s) => s.id)
                  .map((s) => ({ id: String(s.id), label: s.name ?? String(s.id) })),
              },
            ],
          };
        }
        case CONTACT_PROPERTY:
          return {
            fields: [
              text("key", "Key", true, {
                placeholder: "company_name",
                description: "Letters, numbers and underscores, up to 50 characters.",
              }),
              select(
                "type",
                "Type",
                [
                  { id: "string", label: "Text" },
                  { id: "number", label: "Number" },
                ],
                "string",
              ),
              text("fallbackValue", "Fallback Value", false, {
                description: "Used when a contact has no value.",
              }),
            ],
          };
        case SUPPRESSION:
          return { fields: [text("email", "Email", true, { placeholder: "someone@example.com" })] };
        default:
          throw new Error(`Resend plugin: ${typeId} cannot be created`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const { api } = this;
      const bool = (v: string | undefined) => v === "true";
      switch (typeId) {
        case DOMAIN: {
          const name = opt(fields["name"]);
          if (!name) throw new Error("Resend plugin: a domain name is required");
          const d = await api.post("/domains", {
            body: {
              name,
              region: fields["region"] || "us-east-1",
              custom_return_path: opt(fields["customReturnPath"]),
              open_tracking: bool(fields["openTracking"]),
              click_tracking: bool(fields["clickTracking"]),
              tracking_subdomain: opt(fields["trackingSubdomain"]),
              tls: fields["tls"] || "opportunistic",
              capabilities: {
                sending: fields["sending"] || "enabled",
                receiving: fields["receiving"] || "disabled",
              },
            },
          });
          this.domainCache = undefined;
          return mapDomain(accountId, d);
        }
        case API_KEY: {
          const name = opt(fields["name"]);
          if (!name) throw new Error("Resend plugin: a key name is required");
          const permission = fields["permission"] || "sending_access";
          const res = await api.post("/api-keys", {
            body: {
              name,
              permission,
              domain_id: permission === "sending_access" ? opt(fields["domainId"]) : undefined,
            },
          });
          const resource = mapApiKey(accountId, {
            id: res.id ?? "",
            name,
            created_at: new Date().toISOString(),
          });
          if (res.token) {
            resource.secretStates = [
              { fieldKey: "token", resolution: { kind: "plaintext", value: res.token } },
            ];
            await this.services?.secrets
              ?.setPlaintext?.(resource.id, "token", res.token)
              .catch(() => undefined);
          }
          return resource;
        }
        case WEBHOOK: {
          const endpoint = opt(fields["endpoint"]);
          const events = parseList(fields["events"]);
          if (!endpoint) throw new Error("Resend plugin: an endpoint URL is required");
          if (events.length === 0) throw new Error("Resend plugin: pick at least one event");
          const res = await api.post("/webhooks", { body: { endpoint, events } });
          return mapWebhook(accountId, {
            id: res.id ?? "",
            endpoint,
            events,
            status: "enabled",
            created_at: new Date().toISOString(),
          });
        }
        case BROADCAST: {
          const segmentId = opt(fields["segmentId"]);
          if (!segmentId) throw new Error("Resend plugin: pick a segment");
          const mode = fields["sendMode"] || "draft";
          const replyTo = parseList(fields["replyTo"]);
          const body: ApiBody<operations["broadcasts/create"]> = {
            segment_id: segmentId,
            from: opt(fields["from"]),
            subject: opt(fields["subject"]),
            name: opt(fields["name"]),
            topic_id: opt(fields["topicId"]),
            reply_to: replyTo.length ? replyTo : undefined,
            preview_text: opt(fields["previewText"]),
            html: opt(fields["html"]) ? fields["html"] : undefined,
            text: opt(fields["text"]) ? fields["text"] : undefined,
          };
          if (mode !== "draft") body.send = true;
          if (mode === "schedule") {
            const at = opt(fields["scheduledAt"]);
            if (!at) throw new Error("Resend plugin: pick when to send");
            body.scheduled_at = new Date(Date.parse(at)).toISOString();
          }
          const res = await api.post("/broadcasts", { body });
          return runPluginEffect(
            this.getResource(BROADCAST, `${accountId}:${BROADCAST}:${res.id ?? ""}`, accountId),
          );
        }
        case TEMPLATE: {
          const name = opt(fields["name"]);
          if (!name) throw new Error("Resend plugin: a template name is required");
          const res = await api.post("/templates", {
            body: {
              name,
              html: fields["html"] ?? "",
              alias: opt(fields["alias"]),
              from: opt(fields["from"]),
              subject: opt(fields["subject"]),
              text: opt(fields["text"]) ? fields["text"] : undefined,
            },
          });
          return runPluginEffect(
            this.getResource(TEMPLATE, `${accountId}:${TEMPLATE}:${res.id ?? ""}`, accountId),
          );
        }
        case SEGMENT: {
          const name = opt(fields["name"]);
          if (!name) throw new Error("Resend plugin: a segment name is required");
          const res = await api.post("/segments", { body: { name } });
          return mapSegment(accountId, {
            id: res.id ?? "",
            name,
            created_at: new Date().toISOString(),
          });
        }
        case TOPIC: {
          const name = opt(fields["name"]);
          if (!name) throw new Error("Resend plugin: a topic name is required");
          const res = await api.post("/topics", {
            body: {
              name,
              default_subscription: fields["defaultSubscription"] || "opt_in",
              description: opt(fields["description"]),
              visibility: opt(fields["visibility"]),
            },
          });
          return runPluginEffect(
            this.getResource(TOPIC, `${accountId}:${TOPIC}:${res.id ?? ""}`, accountId),
          );
        }
        case CONTACT: {
          const email = opt(fields["email"]);
          if (!email) throw new Error("Resend plugin: an email address is required");
          const segments = parseList(fields["segments"]);
          const res = await api.post("/contacts", {
            body: {
              email,
              first_name: opt(fields["firstName"]),
              last_name: opt(fields["lastName"]),
              unsubscribed: bool(fields["unsubscribed"]),
              segments: segments.length ? segments.map((id) => ({ id })) : undefined,
            },
          });
          return runPluginEffect(
            this.getResource(CONTACT, `${accountId}:${CONTACT}:${res.id ?? ""}`, accountId),
          );
        }
        case CONTACT_PROPERTY: {
          const key = opt(fields["key"]);
          if (!key || !/^\w{1,50}$/.test(key)) {
            throw new Error(
              "Resend plugin: the key must be 1 to 50 letters, numbers or underscores",
            );
          }
          const type = fields["type"] || "string";
          const fallback = opt(fields["fallbackValue"]);
          const res = await api.post("/contact-properties", {
            body: {
              key,
              type,
              fallback_value:
                fallback !== undefined
                  ? type === "number"
                    ? Number(fallback)
                    : fallback
                  : undefined,
            },
          });
          return mapContactProperty(accountId, {
            id: res.id ?? "",
            key,
            type,
            ...(fallback !== undefined ? { fallback_value: fallback } : {}),
            created_at: new Date().toISOString(),
          });
        }
        case SUPPRESSION: {
          const email = opt(fields["email"]);
          if (!email) throw new Error("Resend plugin: an email address is required");
          const res = await api.post("/suppressions", { body: { email } });
          return mapSuppression(accountId, {
            id: res.id ?? "",
            email,
            origin: "manual",
            created_at: new Date().toISOString(),
          });
        }
        default:
          throw new Error(`Resend plugin: ${typeId} cannot be created`);
      }
    });
  }

  // ---------------------------------------------------------------- update

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const enc = pathEncode(externalIdOf(resourceId));
      const { api } = this;
      const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
      /** A field the form sent, as typed; `undefined` is not sent at all. */
      const sent = (k: string) => (has(k) ? (fields[k] ?? "") : undefined);
      const flag = (k: string) => (has(k) ? fields[k] === "true" : undefined);
      switch (typeId) {
        case DOMAIN: {
          const body: ApiBody<operations["domains/update"]> = {
            tracking_subdomain: sent("trackingSubdomain"),
            tls: sent("tls"),
            open_tracking: flag("openTracking"),
            click_tracking: flag("clickTracking"),
          };
          if (has("sending") || has("receiving")) {
            const current = await api.get(`/domains/${enc}`);
            body.capabilities = {
              sending: fields["sending"] || current.capabilities?.sending || "enabled",
              receiving: fields["receiving"] || current.capabilities?.receiving || "disabled",
            };
          }
          await api.patch(`/domains/${enc}`, { body });
          this.domainCache = undefined;
          break;
        }
        case API_KEY:
          if (has("name")) await api.patch(`/api-keys/${enc}`, { body: { name: fields["name"] } });
          break;
        case WEBHOOK: {
          const events = has("events") ? parseList(fields["events"]) : undefined;
          if (events?.length === 0)
            throw new Error("Resend plugin: a webhook needs at least one event");
          await api.patch(`/webhooks/${enc}`, {
            body: { endpoint: sent("endpoint"), status: sent("status"), events },
          });
          break;
        }
        case BROADCAST:
          await api.patch(`/broadcasts/${enc}`, {
            body: {
              name: sent("name"),
              subject: sent("subject"),
              from: sent("from"),
              preview_text: sent("previewText"),
              segment_id: sent("segmentId"),
              topic_id: sent("topicId"),
              reply_to: has("replyTo") ? parseList(fields["replyTo"]) : undefined,
            },
          });
          break;
        case TEMPLATE:
          await api.patch(`/templates/${enc}`, {
            body: {
              name: sent("name"),
              alias: sent("alias"),
              from: sent("from"),
              subject: sent("subject"),
            },
          });
          break;
        case SEGMENT:
          await api.patch(`/segments/${enc}`, { body: { name: sent("name") } });
          break;
        case TOPIC:
          await api.patch(`/topics/${enc}`, {
            body: {
              name: sent("name"),
              description: sent("description"),
              visibility: sent("visibility"),
            },
          });
          break;
        case CONTACT:
          await api.patch(`/contacts/${enc}`, {
            body: {
              email: sent("email"),
              first_name: sent("firstName"),
              last_name: sent("lastName"),
              unsubscribed: flag("unsubscribed"),
            },
          });
          break;
        case CONTACT_PROPERTY: {
          if (has("fallbackValue")) {
            const current = await api.get(`/contact-properties/${enc}`);
            const raw = fields["fallbackValue"] ?? "";
            await api.patch(`/contact-properties/${enc}`, {
              body: {
                fallback_value: raw === "" ? null : current.type === "number" ? Number(raw) : raw,
              },
            });
          }
          break;
        }
        case AUTOMATION:
          await api.patch(`/automations/${enc}`, {
            body: { name: sent("name"), status: sent("status") },
          });
          break;
        default:
          throw new Error(`Resend plugin: ${typeId} cannot be edited`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  // ---------------------------------------------------------------- delete

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const enc = pathEncode(externalIdOf(resourceId));
      const { api } = this;
      switch (typeId) {
        case DOMAIN:
          await api.delete(`/domains/${enc}`);
          break;
        case API_KEY:
          await api.delete(`/api-keys/${enc}`);
          break;
        case WEBHOOK:
          await api.delete(`/webhooks/${enc}`);
          break;
        case BROADCAST:
          await api.delete(`/broadcasts/${enc}`);
          break;
        case TEMPLATE:
          await api.delete(`/templates/${enc}`);
          break;
        case SEGMENT:
          await api.delete(`/segments/${enc}`);
          break;
        case TOPIC:
          await api.delete(`/topics/${enc}`);
          break;
        case CONTACT:
          await api.delete(`/contacts/${enc}`);
          break;
        case CONTACT_PROPERTY:
          await api.delete(`/contact-properties/${enc}`);
          break;
        case SUPPRESSION:
          await api.delete(`/suppressions/${enc}`);
          break;
        case AUTOMATION:
          await api.delete(`/automations/${enc}`);
          break;
        case OAUTH_GRANT:
          await api.delete(`/oauth/grants/${enc}`);
          break;
        default:
          throw new Error(`Resend plugin: ${typeId} cannot be deleted`);
      }
      if (typeId === DOMAIN) this.domainCache = undefined;
    });
  }

  // ---------------------------------------------------------------- actions

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const enc = pathEncode(externalIdOf(resourceId));
      const { api } = this;
      // Every action posts an empty object, whatever the document says it takes.
      const body = {};
      if (typeId === WEBHOOK && actionId.startsWith("replay:")) {
        const eventId = pathEncode(actionId.slice("replay:".length));
        await api.post(`/webhooks/${enc}/events/${eventId}/replay`, { body });
        return;
      }
      switch (`${typeId}:${actionId}`) {
        case `${DOMAIN}:verify`:
          await api.post(`/domains/${enc}/verify`, { body });
          return;
        case `${WEBHOOK}:enable`:
        case `${WEBHOOK}:disable`:
          await api.patch(`/webhooks/${enc}`, { body: { status: `${actionId}d` } });
          return;
        case `${WEBHOOK}:rotate-secret`:
          await api.post(`/webhooks/${enc}/signing-secret/rotate`, { body });
          return;
        case `${EMAIL}:cancel`:
          await api.post(`/emails/${enc}/cancel`, { body });
          return;
        case `${BROADCAST}:send`:
          await api.post(`/broadcasts/${enc}/send`, { body });
          return;
        case `${BROADCAST}:cancel`:
          await api.post(`/broadcasts/${enc}/cancel`, { body });
          return;
        case `${BROADCAST}:duplicate`:
          await api.post(`/broadcasts/${enc}/duplicate`, { body });
          return;
        case `${TEMPLATE}:publish`:
          await api.post(`/templates/${enc}/publish`, { body });
          return;
        case `${TEMPLATE}:duplicate`:
          await api.post(`/templates/${enc}/duplicate`, { body });
          return;
        case `${AUTOMATION}:enable`:
        case `${AUTOMATION}:disable`:
          await api.patch(`/automations/${enc}`, { body: { status: `${actionId}d` } });
          return;
        case `${AUTOMATION}:stop`:
          await api.post(`/automations/${enc}/stop`, { body });
          return;
        case `${AUTOMATION}:duplicate`:
          await api.post(`/automations/${enc}/duplicate`, { body });
          return;
        default:
          throw new Error(`Resend plugin: unknown action "${actionId}" for ${typeId}`);
      }
    });
  }

  // -------------------------------------------------------------- telemetry

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - 7 * 86_400_000;
      const id = externalIdOf(resourceId);
      if (resourceTypeId === ACCOUNT) return emailMetrics(this.api, startMs, endMs);
      if (resourceTypeId === DOMAIN)
        return emailMetrics(this.api, startMs, endMs, { domainId: id });
      if (resourceTypeId === BROADCAST)
        return emailMetrics(this.api, startMs, endMs, { broadcastId: id });
      return [];
    });
  }

  /**
   * Plan limits from `GET /usage`. A `null` limit means unlimited (or not on
   * this plan) and is skipped rather than reported as zero.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const u = await this.api.get("/usage");
      const out: QuotaUsage[] = [];
      const add = (
        id: string,
        name: string,
        used: number | undefined,
        limit: number | null | undefined,
        unit: string,
      ) => {
        if (typeof limit !== "number" || limit <= 0) return;
        out.push({
          id,
          service: "resend",
          name,
          used: used ?? 0,
          limit,
          unit,
          adjustable: true,
          docsUrl: "https://resend.com/docs/api-reference/rate-limit",
        });
      };
      add(
        "emails/daily",
        "Emails per day",
        u.emails?.daily?.used,
        u.emails?.daily?.limit,
        "emails",
      );
      add(
        "emails/monthly",
        "Emails per billing period",
        u.emails?.monthly?.used,
        u.emails?.monthly?.limit,
        "emails",
      );
      add("contacts", "Marketing contacts", u.contacts?.used, u.contacts?.limit, "contacts");
      add("segments", "Segments", u.segments?.used, u.segments?.limit, "segments");
      add("domains", "Domains", u.domains?.used, u.domains?.limit, "domains");
      add(
        "automation-runs",
        "Automation runs per billing period",
        u.automation_runs?.used,
        u.automation_runs?.limit,
        "runs",
      );
      add("ai-credits", "AI credits", u.ai_credits?.used, u.ai_credits?.limit, "credits");
      return out;
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const { api } = this;
      const limit = Math.min(Math.max(params.tailLines ?? 100, 1), 500);
      const pages = Math.ceil(limit / 100);
      let containers: string[];
      let active: string;
      let lines: string[];
      if (typeId === WEBHOOK) {
        containers = ["Deliveries"];
        active = "Deliveries";
        const events = await listAll(
          (query) => api.get(`/webhooks/${pathEncode(externalIdOf(resourceId))}/events`, { query }),
          pages,
        );
        lines = events
          .slice(0, limit)
          .map((e) => `${toIso(e.created_at)}  ${e.status ?? ""}  ${e.type ?? ""}  ${e.id ?? ""}`);
      } else if (typeId === ACCOUNT) {
        containers = ["API requests", "Sent emails", "Received emails"];
        active =
          params.container && containers.includes(params.container)
            ? params.container
            : "API requests";
        if (active === "API requests") {
          const logs = await listAll((query) => api.get("/logs", { query }), pages);
          lines = logs
            .slice(0, limit)
            .map((l) =>
              `${toIso(l.created_at)}  ${l.response_status ?? ""}  ${l.method ?? ""} ${l.endpoint ?? ""}  ${l.user_agent ?? ""}`.trimEnd(),
            );
        } else {
          const emails: LoggedEmail[] =
            active === "Sent emails"
              ? await listAll((query) => api.get("/emails", { query }), pages)
              : await listAll((query) => api.get("/emails/receiving", { query }), pages);
          lines = emails.slice(0, limit).map((e) => {
            const to = Array.isArray(e.to) ? e.to.join(",") : (e.to ?? "");
            const ev = e.last_event ? `  ${e.last_event}` : "";
            return `${toIso(e.created_at)}${ev}  ${e.from ?? ""} -> ${to}  "${e.subject ?? ""}"  ${e.id ?? ""}`;
          });
        }
      } else {
        throw new Error(`Resend plugin: no logs for ${typeId}`);
      }
      lines.reverse();
      return { text: lines.map((l) => `${l}\n`).join(""), containers, activeContainer: active };
    });
  }

  // ----------------------------------------------------------------- render

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }
}
