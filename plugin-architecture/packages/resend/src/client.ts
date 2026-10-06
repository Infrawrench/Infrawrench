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
import type { ResendContext } from "./api.js";
import {
  API_BASE,
  ResendApiError,
  isRestrictedKey,
  listAll,
  resendFetch,
  statusOf,
} from "./api.js";
import type {
  ResendApiKey,
  ResendAutomation,
  ResendBroadcast,
  ResendContact,
  ResendContactProperty,
  ResendDomain,
  ResendEmail,
  ResendOAuthGrant,
  ResendSegment,
  ResendSuppression,
  ResendTemplate,
  ResendTopic,
  ResendUsage,
  ResendWebhook,
} from "./mappers.js";
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
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export function parseList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
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

function eventOptions(): PolicyOption[] {
  return WEBHOOK_EVENTS.map((id) => ({ id, label: id, category: id.split(".")[0] ?? "email" }));
}

/**
 * Resend plugin client. A key belongs to one team; the team's usage is the
 * account root and everything else is listed from it.
 */
export class ResendClient implements PluginClient {
  private readonly ctx: ResendContext;
  private readonly services: HostServices | undefined;
  private domainCache: { at: number; domains: Promise<ResendDomain[]> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Resend plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.services = services;
  }

  private req<T>(
    path: string,
    method = "GET",
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ) {
    return resendFetch<T>(this.ctx, path, {
      method,
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }

  // ---------------------------------------------------------------- listing

  /** Every domain with its records: the list omits records, so each is re-read. */
  private detailedDomains(): Promise<ResendDomain[]> {
    const now = Date.now();
    if (this.domainCache && now - this.domainCache.at < DOMAIN_CACHE_MS)
      return this.domainCache.domains;
    const domains = (async () => {
      const list = await listAll<ResendDomain>(this.ctx, "/domains");
      return mapLimit(list, 3, async (d) =>
        d.id
          ? {
              ...d,
              ...(await this.req<ResendDomain>(`/domains/${encodeURIComponent(d.id)}`).catch(
                () => ({}),
              )),
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const all = <T extends { id?: string }>(path: string, pages = 10) =>
      listAll<T>(this.ctx, path, {}, pages);
    switch (typeId) {
      case ACCOUNT:
        return [await this.fetchAccount(accountId)];
      case DOMAIN:
        return (await this.detailedDomains()).map((d) => mapDomain(accountId, d));
      case DNS_RECORD:
        return (await this.detailedDomains()).flatMap((d) => mapDnsRecords(accountId, d));
      case API_KEY:
        return (await all<ResendApiKey>("/api-keys")).map((k) => mapApiKey(accountId, k));
      case WEBHOOK:
        return (await all<ResendWebhook>("/webhooks")).map((w) => mapWebhook(accountId, w));
      case EMAIL:
        return (await all<ResendEmail>("/emails", 1)).map((e) => mapEmail(accountId, e));
      case BROADCAST:
        return (await all<ResendBroadcast>("/broadcasts")).map((b) => mapBroadcast(accountId, b));
      case TEMPLATE:
        return (await all<ResendTemplate>("/templates")).map((t) => mapTemplate(accountId, t));
      case SEGMENT:
        return (await all<ResendSegment>("/segments")).map((s) => mapSegment(accountId, s));
      case TOPIC:
        return (await all<ResendTopic>("/topics")).map((t) => mapTopic(accountId, t));
      case CONTACT:
        return (await all<ResendContact>("/contacts")).map((c) => mapContact(accountId, c));
      case CONTACT_PROPERTY:
        return (await all<ResendContactProperty>("/contact-properties")).map((p) =>
          mapContactProperty(accountId, p),
        );
      case SUPPRESSION:
        return (await all<ResendSuppression>("/suppressions")).map((s) =>
          mapSuppression(accountId, s),
        );
      case AUTOMATION:
        return (await all<ResendAutomation>("/automations")).map((a) =>
          mapAutomation(accountId, a),
        );
      case OAUTH_GRANT:
        return (await all<ResendOAuthGrant>("/oauth/grants")).map((g) =>
          mapOAuthGrant(accountId, g),
        );
      default:
        throw new Error(`Resend plugin: unknown resource type "${typeId}"`);
    }
  }

  private async fetchAccount(accountId: string): Promise<ResourceInstance> {
    const usage = await this.req<ResendUsage>("/usage").catch((err: unknown) => {
      if (isRestrictedKey(err)) {
        throw new ResendApiError(
          statusOf(err),
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const enc = encodeURIComponent(id);
    switch (typeId) {
      case ACCOUNT:
        return this.fetchAccount(accountId);
      case DOMAIN:
        return mapDomain(accountId, await this.req<ResendDomain>(`/domains/${enc}`));
      case DNS_RECORD: {
        const domainId = id.split("/")[0] ?? "";
        const domain = await this.req<ResendDomain>(`/domains/${encodeURIComponent(domainId)}`);
        const found = mapDnsRecords(accountId, domain).find((r) => r.id === resourceId);
        if (!found) throw new ResendApiError(404, `Resend plugin: DNS record ${id} not found`);
        return found;
      }
      case API_KEY: {
        // There is no single-key GET.
        const found = (await this.listResources(API_KEY, accountId)).find(
          (r) => r.id === resourceId,
        );
        if (!found) throw new ResendApiError(404, `Resend plugin: API key ${id} not found`);
        return found;
      }
      case WEBHOOK:
        return mapWebhook(accountId, await this.req<ResendWebhook>(`/webhooks/${enc}`));
      case EMAIL:
        return mapEmail(accountId, await this.req<ResendEmail>(`/emails/${enc}`));
      case BROADCAST:
        return mapBroadcast(accountId, await this.req<ResendBroadcast>(`/broadcasts/${enc}`));
      case TEMPLATE:
        return mapTemplate(accountId, await this.req<ResendTemplate>(`/templates/${enc}`));
      case SEGMENT:
        return mapSegment(accountId, await this.req<ResendSegment>(`/segments/${enc}`));
      case TOPIC:
        return mapTopic(accountId, await this.req<ResendTopic>(`/topics/${enc}`));
      case CONTACT:
        return mapContact(accountId, await this.req<ResendContact>(`/contacts/${enc}`));
      case CONTACT_PROPERTY:
        return mapContactProperty(
          accountId,
          await this.req<ResendContactProperty>(`/contact-properties/${enc}`),
        );
      case SUPPRESSION:
        return mapSuppression(accountId, await this.req<ResendSuppression>(`/suppressions/${enc}`));
      case AUTOMATION:
        return mapAutomation(accountId, await this.req<ResendAutomation>(`/automations/${enc}`));
      case OAUTH_GRANT: {
        const found = (await this.listResources(OAUTH_GRANT, accountId)).find(
          (r) => r.id === resourceId,
        );
        if (!found) throw new ResendApiError(404, `Resend plugin: OAuth grant ${id} not found`);
        return found;
      }
      default:
        throw new Error(`Resend plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "apiBaseUrl") return API_BASE;
    if (typeId === WEBHOOK && outputKey === "signingSecret") {
      // Unlike most providers, Resend returns the secret on every GET.
      const hook = await this.req<ResendWebhook>(
        `/webhooks/${encodeURIComponent(externalIdOf(resourceId))}`,
      );
      return hook.signing_secret ?? "";
    }
    if (typeId === API_KEY && outputKey === "token") {
      const token = await this.services?.secrets?.getPlaintext(resourceId, "token");
      if (token) return token;
      throw new Error(
        "Resend shows an API key's token only when it is created. This key was created outside Infrawrench; create a new one here to keep its token.",
      );
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey] ?? resource.fields[outputKey];
    return value === undefined || value === null ? "" : String(value);
  }

  // ------------------------------------------------------------- enrichment

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = encodeURIComponent(resource.externalId ?? "");
    const stash = (key: string, value: unknown): ResourceInstance => ({
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [key]: JSON.stringify(value) },
    });
    switch (resource.resourceTypeId) {
      case DOMAIN: {
        const d = await this.req<ResendDomain>(`/domains/${id}`);
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
        const res = await this.req<{
          data?: Array<{ id?: string; type?: string; status?: string; created_at?: string }>;
        }>(`/webhooks/${id}/events`, "GET", undefined, { limit: 50 });
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
          this.req<{ steps?: Array<{ key?: string; type?: string; config?: unknown }> }>(
            `/automations/${id}`,
          ),
          this.req<{ data?: Array<{ id?: string; status?: string; created_at?: string }> }>(
            `/automations/${id}/runs`,
            "GET",
            undefined,
            { limit: 20 },
          ).catch(() => ({ data: [] })),
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
        const res = await this.req<{ data?: ResendContact[] }>(
          `/segments/${id}/contacts`,
          "GET",
          undefined,
          { limit: 100 },
        );
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
  }

  // ---------------------------------------------------------------- create

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
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
        const domains = await listAll<ResendDomain>(this.ctx, "/domains").catch(
          () => [] as ResendDomain[],
        );
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
                { id: "sending_access", label: "Sending access", description: "Only send emails" },
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
          listAll<ResendSegment>(this.ctx, "/segments").catch(() => [] as ResendSegment[]),
          listAll<ResendTopic>(this.ctx, "/topics").catch(() => [] as ResendTopic[]),
          listAll<ResendDomain>(this.ctx, "/domains").catch(() => [] as ResendDomain[]),
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
        const segments = await listAll<ResendSegment>(this.ctx, "/segments").catch(
          () => [] as ResendSegment[],
        );
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const created = <T>(path: string, body: unknown) =>
      this.req<T & { id?: string }>(path, "POST", body);
    const bool = (v: string | undefined) => v === "true";
    switch (typeId) {
      case DOMAIN: {
        const name = opt(fields["name"]);
        if (!name) throw new Error("Resend plugin: a domain name is required");
        const d = await created<ResendDomain>("/domains", {
          name,
          region: fields["region"] || "us-east-1",
          ...(opt(fields["customReturnPath"])
            ? { custom_return_path: opt(fields["customReturnPath"]) }
            : {}),
          open_tracking: bool(fields["openTracking"]),
          click_tracking: bool(fields["clickTracking"]),
          ...(opt(fields["trackingSubdomain"])
            ? { tracking_subdomain: opt(fields["trackingSubdomain"]) }
            : {}),
          tls: fields["tls"] || "opportunistic",
          capabilities: {
            sending: fields["sending"] || "enabled",
            receiving: fields["receiving"] || "disabled",
          },
        });
        this.domainCache = undefined;
        return mapDomain(accountId, d);
      }
      case API_KEY: {
        const name = opt(fields["name"]);
        if (!name) throw new Error("Resend plugin: a key name is required");
        const permission = fields["permission"] || "sending_access";
        const res = await created<{ token?: string }>("/api-keys", {
          name,
          permission,
          ...(permission === "sending_access" && opt(fields["domainId"])
            ? { domain_id: opt(fields["domainId"]) }
            : {}),
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
        const res = await created<ResendWebhook>("/webhooks", { endpoint, events });
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
        const body: Record<string, unknown> = {
          segment_id: segmentId,
          from: opt(fields["from"]),
          subject: opt(fields["subject"]),
          ...(opt(fields["name"]) ? { name: opt(fields["name"]) } : {}),
          ...(opt(fields["topicId"]) ? { topic_id: opt(fields["topicId"]) } : {}),
          ...(parseList(fields["replyTo"]).length
            ? { reply_to: parseList(fields["replyTo"]) }
            : {}),
          ...(opt(fields["previewText"]) ? { preview_text: opt(fields["previewText"]) } : {}),
          ...(opt(fields["html"]) ? { html: fields["html"] } : {}),
          ...(opt(fields["text"]) ? { text: fields["text"] } : {}),
        };
        if (mode !== "draft") body["send"] = true;
        if (mode === "schedule") {
          const at = opt(fields["scheduledAt"]);
          if (!at) throw new Error("Resend plugin: pick when to send");
          body["scheduled_at"] = new Date(Date.parse(at)).toISOString();
        }
        const res = await created<ResendBroadcast>("/broadcasts", body);
        return this.getResource(BROADCAST, `${accountId}:${BROADCAST}:${res.id ?? ""}`, accountId);
      }
      case TEMPLATE: {
        const name = opt(fields["name"]);
        if (!name) throw new Error("Resend plugin: a template name is required");
        const res = await created<ResendTemplate>("/templates", {
          name,
          html: fields["html"] ?? "",
          ...(opt(fields["alias"]) ? { alias: opt(fields["alias"]) } : {}),
          ...(opt(fields["from"]) ? { from: opt(fields["from"]) } : {}),
          ...(opt(fields["subject"]) ? { subject: opt(fields["subject"]) } : {}),
          ...(opt(fields["text"]) ? { text: fields["text"] } : {}),
        });
        return this.getResource(TEMPLATE, `${accountId}:${TEMPLATE}:${res.id ?? ""}`, accountId);
      }
      case SEGMENT: {
        const name = opt(fields["name"]);
        if (!name) throw new Error("Resend plugin: a segment name is required");
        const res = await created<ResendSegment>("/segments", { name });
        return mapSegment(accountId, {
          id: res.id ?? "",
          name,
          created_at: new Date().toISOString(),
        });
      }
      case TOPIC: {
        const name = opt(fields["name"]);
        if (!name) throw new Error("Resend plugin: a topic name is required");
        const res = await created<ResendTopic>("/topics", {
          name,
          default_subscription: fields["defaultSubscription"] || "opt_in",
          ...(opt(fields["description"]) ? { description: opt(fields["description"]) } : {}),
          ...(opt(fields["visibility"]) ? { visibility: opt(fields["visibility"]) } : {}),
        });
        return this.getResource(TOPIC, `${accountId}:${TOPIC}:${res.id ?? ""}`, accountId);
      }
      case CONTACT: {
        const email = opt(fields["email"]);
        if (!email) throw new Error("Resend plugin: an email address is required");
        const segments = parseList(fields["segments"]);
        const res = await created<ResendContact>("/contacts", {
          email,
          ...(opt(fields["firstName"]) ? { first_name: opt(fields["firstName"]) } : {}),
          ...(opt(fields["lastName"]) ? { last_name: opt(fields["lastName"]) } : {}),
          unsubscribed: bool(fields["unsubscribed"]),
          ...(segments.length ? { segments: segments.map((id) => ({ id })) } : {}),
        });
        return this.getResource(CONTACT, `${accountId}:${CONTACT}:${res.id ?? ""}`, accountId);
      }
      case CONTACT_PROPERTY: {
        const key = opt(fields["key"]);
        if (!key || !/^\w{1,50}$/.test(key)) {
          throw new Error("Resend plugin: the key must be 1 to 50 letters, numbers or underscores");
        }
        const type = fields["type"] || "string";
        const fallback = opt(fields["fallbackValue"]);
        const res = await created<ResendContactProperty>("/contact-properties", {
          key,
          type,
          ...(fallback !== undefined
            ? { fallback_value: type === "number" ? Number(fallback) : fallback }
            : {}),
        });
        return mapContactProperty(accountId, {
          id: res.id ?? "",
          key,
          type,
          fallback_value: fallback ?? null,
          created_at: new Date().toISOString(),
        });
      }
      case SUPPRESSION: {
        const email = opt(fields["email"]);
        if (!email) throw new Error("Resend plugin: an email address is required");
        const res = await created<ResendSuppression>("/suppressions", { email });
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
  }

  // ---------------------------------------------------------------- update

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const enc = encodeURIComponent(externalIdOf(resourceId));
    const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
    const patch = (path: string, body: Record<string, unknown>) =>
      this.req<unknown>(path, "PATCH", body);
    const pick = (map: Record<string, string>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [field, param] of Object.entries(map))
        if (has(field)) out[param] = fields[field] ?? "";
      return out;
    };
    switch (typeId) {
      case DOMAIN: {
        const body: Record<string, unknown> = pick({
          trackingSubdomain: "tracking_subdomain",
          tls: "tls",
        });
        if (has("openTracking")) body["open_tracking"] = fields["openTracking"] === "true";
        if (has("clickTracking")) body["click_tracking"] = fields["clickTracking"] === "true";
        if (has("sending") || has("receiving")) {
          const current = await this.req<ResendDomain>(`/domains/${enc}`);
          body["capabilities"] = {
            sending: fields["sending"] || current.capabilities?.sending || "enabled",
            receiving: fields["receiving"] || current.capabilities?.receiving || "disabled",
          };
        }
        await patch(`/domains/${enc}`, body);
        this.domainCache = undefined;
        break;
      }
      case API_KEY:
        if (has("name")) await patch(`/api-keys/${enc}`, { name: fields["name"] });
        break;
      case WEBHOOK: {
        const body: Record<string, unknown> = pick({ endpoint: "endpoint", status: "status" });
        if (has("events")) {
          const events = parseList(fields["events"]);
          if (events.length === 0)
            throw new Error("Resend plugin: a webhook needs at least one event");
          body["events"] = events;
        }
        await patch(`/webhooks/${enc}`, body);
        break;
      }
      case BROADCAST: {
        const body = pick({
          name: "name",
          subject: "subject",
          from: "from",
          previewText: "preview_text",
          segmentId: "segment_id",
          topicId: "topic_id",
        });
        if (has("replyTo")) body["reply_to"] = parseList(fields["replyTo"]);
        await patch(`/broadcasts/${enc}`, body);
        break;
      }
      case TEMPLATE:
        await patch(
          `/templates/${enc}`,
          pick({ name: "name", alias: "alias", from: "from", subject: "subject" }),
        );
        break;
      case SEGMENT:
        await patch(`/segments/${enc}`, pick({ name: "name" }));
        break;
      case TOPIC:
        await patch(
          `/topics/${enc}`,
          pick({ name: "name", description: "description", visibility: "visibility" }),
        );
        break;
      case CONTACT: {
        const body = pick({ email: "email", firstName: "first_name", lastName: "last_name" });
        if (has("unsubscribed")) body["unsubscribed"] = fields["unsubscribed"] === "true";
        await patch(`/contacts/${enc}`, body);
        break;
      }
      case CONTACT_PROPERTY: {
        if (has("fallbackValue")) {
          const current = await this.req<ResendContactProperty>(`/contact-properties/${enc}`);
          const raw = fields["fallbackValue"] ?? "";
          await patch(`/contact-properties/${enc}`, {
            fallback_value: raw === "" ? null : current.type === "number" ? Number(raw) : raw,
          });
        }
        break;
      }
      case AUTOMATION:
        await patch(`/automations/${enc}`, pick({ name: "name", status: "status" }));
        break;
      default:
        throw new Error(`Resend plugin: ${typeId} cannot be edited`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  // ---------------------------------------------------------------- delete

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const enc = encodeURIComponent(externalIdOf(resourceId));
    const paths: Record<string, string> = {
      [DOMAIN]: `/domains/${enc}`,
      [API_KEY]: `/api-keys/${enc}`,
      [WEBHOOK]: `/webhooks/${enc}`,
      [BROADCAST]: `/broadcasts/${enc}`,
      [TEMPLATE]: `/templates/${enc}`,
      [SEGMENT]: `/segments/${enc}`,
      [TOPIC]: `/topics/${enc}`,
      [CONTACT]: `/contacts/${enc}`,
      [CONTACT_PROPERTY]: `/contact-properties/${enc}`,
      [SUPPRESSION]: `/suppressions/${enc}`,
      [AUTOMATION]: `/automations/${enc}`,
      [OAUTH_GRANT]: `/oauth/grants/${enc}`,
    };
    const path = paths[typeId];
    if (!path) throw new Error(`Resend plugin: ${typeId} cannot be deleted`);
    await this.req<unknown>(path, "DELETE");
    if (typeId === DOMAIN) this.domainCache = undefined;
  }

  // ---------------------------------------------------------------- actions

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const enc = encodeURIComponent(id);
    const post = (path: string, body: unknown = {}) => this.req<unknown>(path, "POST", body);
    if (typeId === WEBHOOK && actionId.startsWith("replay:")) {
      const eventId = encodeURIComponent(actionId.slice("replay:".length));
      await post(`/webhooks/${enc}/events/${eventId}/replay`);
      return;
    }
    switch (`${typeId}:${actionId}`) {
      case `${DOMAIN}:verify`:
        await post(`/domains/${enc}/verify`);
        return;
      case `${WEBHOOK}:enable`:
      case `${WEBHOOK}:disable`:
        await this.req(`/webhooks/${enc}`, "PATCH", { status: `${actionId}d` });
        return;
      case `${WEBHOOK}:rotate-secret`:
        await post(`/webhooks/${enc}/signing-secret/rotate`);
        return;
      case `${EMAIL}:cancel`:
        await post(`/emails/${enc}/cancel`);
        return;
      case `${BROADCAST}:send`:
        await post(`/broadcasts/${enc}/send`);
        return;
      case `${BROADCAST}:cancel`:
        await post(`/broadcasts/${enc}/cancel`);
        return;
      case `${BROADCAST}:duplicate`:
        await post(`/broadcasts/${enc}/duplicate`);
        return;
      case `${TEMPLATE}:publish`:
        await post(`/templates/${enc}/publish`);
        return;
      case `${TEMPLATE}:duplicate`:
        await post(`/templates/${enc}/duplicate`);
        return;
      case `${AUTOMATION}:enable`:
      case `${AUTOMATION}:disable`:
        await this.req(`/automations/${enc}`, "PATCH", { status: `${actionId}d` });
        return;
      case `${AUTOMATION}:stop`:
        await post(`/automations/${enc}/stop`);
        return;
      case `${AUTOMATION}:duplicate`:
        await post(`/automations/${enc}/duplicate`);
        return;
      default:
        throw new Error(`Resend plugin: unknown action "${actionId}" for ${typeId}`);
    }
  }

  // -------------------------------------------------------------- telemetry

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 7 * 86_400_000;
    const id = externalIdOf(resourceId);
    if (resourceTypeId === ACCOUNT) return emailMetrics(this.ctx, startMs, endMs);
    if (resourceTypeId === DOMAIN) return emailMetrics(this.ctx, startMs, endMs, { domainId: id });
    if (resourceTypeId === BROADCAST)
      return emailMetrics(this.ctx, startMs, endMs, { broadcastId: id });
    return [];
  }

  /**
   * Plan limits from `GET /usage`. A `null` limit means unlimited (or not on
   * this plan) and is skipped rather than reported as zero.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const u = await this.req<ResendUsage>("/usage");
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
    add("emails/daily", "Emails per day", u.emails?.daily?.used, u.emails?.daily?.limit, "emails");
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
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const limit = Math.min(Math.max(params.tailLines ?? 100, 1), 500);
    const pages = Math.ceil(limit / 100);
    let containers: string[];
    let active: string;
    let lines: string[];
    if (typeId === WEBHOOK) {
      containers = ["Deliveries"];
      active = "Deliveries";
      const events = await listAll<{
        id?: string;
        type?: string;
        status?: string;
        created_at?: string;
      }>(this.ctx, `/webhooks/${encodeURIComponent(externalIdOf(resourceId))}/events`, {}, pages);
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
        const logs = await listAll<{
          id?: string;
          created_at?: string;
          endpoint?: string;
          method?: string;
          response_status?: number;
          user_agent?: string | null;
        }>(this.ctx, "/logs", {}, pages);
        lines = logs
          .slice(0, limit)
          .map((l) =>
            `${toIso(l.created_at)}  ${l.response_status ?? ""}  ${l.method ?? ""} ${l.endpoint ?? ""}  ${l.user_agent ?? ""}`.trimEnd(),
          );
      } else {
        const path = active === "Sent emails" ? "/emails" : "/emails/receiving";
        const emails = await listAll<ResendEmail>(this.ctx, path, {}, pages);
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
  }

  // ----------------------------------------------------------------- render

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }
}
