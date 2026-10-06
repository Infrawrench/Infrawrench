import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PolicyOption,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceCreateReturn,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { FormValue, StripeContext } from "./api.js";
import {
  StripeApiError,
  dashboardUrl,
  isFeatureUnavailable,
  isPermissionError,
  listV1,
  listV2,
  STRIPE_API_VERSION,
  statusOf,
  stripeFetch,
  currencyExponent,
  toMinor,
} from "./api.js";
import { fetchFeeCostRows } from "./balance.js";
import { SNAPSHOT_EVENT_TYPES, THIN_EVENT_TYPES } from "./event-types.js";
import type {
  StripeAccount,
  StripeBalance,
  StripeEvent,
  StripeEventDestination,
  StripeMeter,
  StripePayout,
  StripePrice,
  StripeProduct,
  StripeReportRun,
  StripeSigmaRun,
  StripeWebhookEndpoint,
} from "./mappers.js";
import {
  epochToIso,
  mapAccount,
  mapConnectedAccount,
  mapEventDestination,
  mapMeter,
  mapPayout,
  mapPrice,
  mapProduct,
  mapReportRun,
  mapSigmaRun,
  mapWebhookEndpoint,
} from "./mappers.js";
import { accountMetrics, meterMetrics } from "./metrics.js";
import { PREFLIGHT_CAPABILITIES } from "./preflight.js";
import type { BalanceStash, FailedEventSummary, SubscriptionOverview } from "./render.js";
import { STASH, renderDetail, renderSidebarItem } from "./render.js";
import {
  ACCOUNT,
  CONNECTED_ACCOUNT,
  EVENT_DESTINATION,
  METER,
  PAYOUT,
  PRICE,
  PRODUCT,
  REPORT_RUN,
  SIGMA_RUN,
  WEBHOOK_ENDPOINT,
} from "./resource-types.js";

/** Most recent payouts, report runs and Sigma runs listed (one page each). */
const RECENT_LIMIT = 100;

/** Subscriptions read for the overview: 10 pages of 100, newest first. */
const SUBSCRIPTION_PAGES = 10;

/**
 * AWS regions where EventBridge accepts Stripe partner event sources. Stripe's
 * docs say "any region where EventBridge is available"; this is the commercial
 * region list (https://docs.aws.amazon.com/general/latest/gr/ev.html, 2026-10).
 */
const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "ca-west-1",
  "sa-east-1",
  "mx-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "il-central-1",
  "me-south-1",
  "me-central-1",
  "af-south-1",
  "ap-south-1",
  "ap-south-2",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
];

/** Azure regions with Event Grid partner topics (https://learn.microsoft.com/azure/event-grid/partner-events-overview). */
const AZURE_REGIONS = [
  "eastus",
  "eastus2",
  "centralus",
  "northcentralus",
  "southcentralus",
  "westus",
  "westus2",
  "westus3",
  "canadacentral",
  "brazilsouth",
  "northeurope",
  "westeurope",
  "uksouth",
  "francecentral",
  "germanywestcentral",
  "swedencentral",
  "switzerlandnorth",
  "norwayeast",
  "uaenorth",
  "southafricanorth",
  "centralindia",
  "eastasia",
  "southeastasia",
  "japaneast",
  "koreacentral",
  "australiaeast",
];

/** Event-type picker options, grouped by the resource before the first dot. */
function eventOptions(types: readonly string[], prefix = ""): PolicyOption[] {
  return types.map((id) => {
    const rest = prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
    const category = id === "*" ? "All" : (rest.split(".")[0] ?? "other").replace(/_/g, " ");
    return {
      id,
      label: id === "*" ? "All events (*)" : id,
      category,
    };
  });
}

/** A create-form multi-pick arrives as a JSON array; edits as a comma list. */
export function parseEventList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed))
        return parsed
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
    } catch {
      // Fall through to comma splitting.
    }
  }
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1" || value === "yes";
}

/** Strip the Stripe-allowed metadata-free optional: "" → undefined. */
function opt(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v ? v : undefined;
}

/** Monthly multiplier for a recurring interval. */
function perMonth(interval: string | undefined, count: number | undefined): number {
  const n = count && count > 0 ? count : 1;
  switch (interval) {
    case "day":
      return 365 / 12 / n;
    case "week":
      return 52 / 12 / n;
    case "month":
      return 1 / n;
    case "year":
      return 1 / (12 * n);
    default:
      return 0;
  }
}

interface StripeSubscriptionItem {
  quantity?: number;
  price?: StripePrice;
}

interface StripeSubscription {
  id?: string;
  status?: string;
  cancel_at_period_end?: boolean;
  customer?: string | { id?: string; name?: string | null; email?: string | null };
  items?: { data?: StripeSubscriptionItem[] };
}

/** Summarise subscriptions into counts by status and MRR per currency. */
export function summariseSubscriptions(
  subs: StripeSubscription[],
  truncated: boolean,
): SubscriptionOverview {
  const byStatus: Record<string, number> = {};
  const mrrMinor: Record<string, number> = {};
  let canceling = 0;
  for (const sub of subs) {
    const status = sub.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (sub.cancel_at_period_end) canceling += 1;
    if (!["active", "trialing", "past_due"].includes(status)) continue;
    for (const item of sub.items?.data ?? []) {
      const price = item.price;
      if (!price?.recurring || price.recurring.usage_type === "metered") continue;
      if (typeof price.unit_amount !== "number" || !price.currency) continue;
      const currency = price.currency.toUpperCase();
      const monthly =
        price.unit_amount *
        (item.quantity ?? 1) *
        perMonth(price.recurring.interval, price.recurring.interval_count);
      mrrMinor[currency] = (mrrMinor[currency] ?? 0) + monthly;
    }
  }
  return { total: subs.length, truncated, byStatus, mrrMinor, cancelingAtPeriodEnd: canceling };
}

/** Does `type` match any of the endpoint's enabled events (`*` matches all)? */
function subscribes(enabled: string[], type: string): boolean {
  return enabled.includes("*") || enabled.includes(type);
}

/**
 * Stripe plugin client.
 *
 * The API key belongs to exactly one Stripe account, which is the account
 * root; every other type is listed from it. v1 covers the account, Connect,
 * webhook endpoints, products, prices, meters, payouts, Reporting and Sigma;
 * v2 covers event destinations and thin events.
 */
export class StripeClient implements PluginClient {
  private readonly ctx: StripeContext;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Stripe plugin: missing apiKey credential");
    if (apiKey.startsWith("pk_")) {
      throw new Error(
        "Stripe plugin: that is a publishable key (pk_…). Use a secret (sk_…) or restricted (rk_…) key.",
      );
    }
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.services = services;
  }

  private dash(path = ""): string {
    return dashboardUrl(this.ctx.apiKey, path).replace(/\/$/, "");
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return stripeFetch<T>(this.ctx, path, query ? { query } : {});
  }

  private post<T>(path: string, form: Record<string, FormValue> = {}) {
    return stripeFetch<T>(this.ctx, path, { method: "POST", form });
  }

  // -------------------------------------------------------------- preflight

  /**
   * One cheap read per capability. A restricted key without the permission
   * gets a 403 naming it; anything else that fails is "unknown".
   */
  async verifyCredentials(): Promise<PreflightResult> {
    let identity: string | undefined;
    const checks: PreflightCapabilityCheck[] = [];
    for (const cap of PREFLIGHT_CAPABILITIES) {
      try {
        const isAccount = cap.probe === "/v1/account";
        const res = await this.get<StripeAccount>(cap.probe, isAccount ? undefined : { limit: 1 });
        if (isAccount) identity = res?.id;
        checks.push({ capabilityId: cap.id, status: "ok" });
      } catch (err) {
        if (statusOf(err) === 403) {
          checks.push({
            capabilityId: cap.id,
            status: "missing",
            missingPermissions: cap.requiredPermissions,
            message: err instanceof Error ? err.message : String(err),
            helpLink: { label: "Edit the restricted key", url: this.dash("/apikeys") },
          });
        } else if (cap.optionalFeature && isFeatureUnavailable(err)) {
          checks.push({
            capabilityId: cap.id,
            status: "unknown",
            message: "This account does not use the feature, so there is nothing to read.",
          });
        } else {
          checks.push({
            capabilityId: cap.id,
            status: "unknown",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return { checks, ...(identity ? { identity } : {}) };
  }

  // ---------------------------------------------------------------- listing

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case ACCOUNT:
        return [await this.fetchAccount(accountId)];
      case CONNECTED_ACCOUNT:
        return this.optional(async () =>
          (await listV1<StripeAccount>(this.ctx, "/v1/accounts")).map((a) =>
            mapConnectedAccount(accountId, this.ctx.apiKey, a),
          ),
        );
      case WEBHOOK_ENDPOINT:
        return (await listV1<StripeWebhookEndpoint>(this.ctx, "/v1/webhook_endpoints")).map((e) =>
          mapWebhookEndpoint(accountId, e),
        );
      case EVENT_DESTINATION:
        return this.listEventDestinations(accountId);
      case PRODUCT:
        return (await listV1<StripeProduct>(this.ctx, "/v1/products")).map((p) =>
          mapProduct(accountId, this.ctx.apiKey, p),
        );
      case PRICE:
        return (await listV1<StripePrice>(this.ctx, "/v1/prices", {}, 20)).map((p) =>
          mapPrice(accountId, p),
        );
      case METER:
        return this.optional(async () =>
          (await listV1<StripeMeter>(this.ctx, "/v1/billing/meters")).map((m) =>
            mapMeter(accountId, m),
          ),
        );
      case PAYOUT:
        return (await listV1<StripePayout>(this.ctx, "/v1/payouts", {}, 1)).map((p) =>
          mapPayout(accountId, p),
        );
      case REPORT_RUN:
        return this.optional(async () =>
          (await listV1<StripeReportRun>(this.ctx, "/v1/reporting/report_runs", {}, 1)).map((r) =>
            mapReportRun(accountId, r),
          ),
        );
      case SIGMA_RUN:
        return this.optional(async () =>
          (await listV1<StripeSigmaRun>(this.ctx, "/v1/sigma/scheduled_query_runs", {}, 1)).map(
            (r) => mapSigmaRun(accountId, r),
          ),
        );
      default:
        throw new Error(`Stripe plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * Listers for features an account may simply not have (Connect, Sigma,
   * Reporting, meters on accounts without Billing): "not available" is an
   * empty list, not a failed sync. A key that is plainly wrong (401) still
   * throws.
   */
  private async optional(fn: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await fn();
    } catch (err) {
      if (statusOf(err) !== 401 && isFeatureUnavailable(err)) return [];
      throw err;
    }
  }

  private async fetchAccount(accountId: string): Promise<ResourceInstance> {
    const [acct, balance] = await Promise.all([
      this.get<StripeAccount>("/v1/account"),
      this.get<StripeBalance>("/v1/balance").catch((err: unknown) => {
        if (isPermissionError(err)) return null;
        throw err;
      }),
    ]);
    const resource = mapAccount(accountId, this.ctx.apiKey, acct, balance);
    resource.resolvedOutputs["apiVersion"] = STRIPE_API_VERSION;
    return resource;
  }

  /**
   * `GET /v2/core/event_destinations` with the normally redacted URL included.
   */
  private async listEventDestinations(accountId: string): Promise<ResourceInstance[]> {
    const dests = await listV2<StripeEventDestination>(this.ctx, "/v2/core/event_destinations", {
      include: ["webhook_endpoint.url"],
    });
    return dests.map((d) => mapEventDestination(accountId, d));
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
      case CONNECTED_ACCOUNT:
        return mapConnectedAccount(
          accountId,
          this.ctx.apiKey,
          await this.get(`/v1/accounts/${enc}`),
        );
      case WEBHOOK_ENDPOINT:
        return mapWebhookEndpoint(accountId, await this.get(`/v1/webhook_endpoints/${enc}`));
      case EVENT_DESTINATION:
        return mapEventDestination(
          accountId,
          await stripeFetch<StripeEventDestination>(
            this.ctx,
            `/v2/core/event_destinations/${enc}`,
            { query: { include: ["webhook_endpoint.url"] } },
          ),
        );
      case PRODUCT:
        return mapProduct(accountId, this.ctx.apiKey, await this.get(`/v1/products/${enc}`));
      case PRICE:
        return mapPrice(accountId, await this.get(`/v1/prices/${enc}`));
      case METER:
        return mapMeter(accountId, await this.get(`/v1/billing/meters/${enc}`));
      case PAYOUT:
        return mapPayout(accountId, await this.get(`/v1/payouts/${enc}`));
      case REPORT_RUN:
        return mapReportRun(accountId, await this.get(`/v1/reporting/report_runs/${enc}`));
      case SIGMA_RUN:
        return mapSigmaRun(accountId, await this.get(`/v1/sigma/scheduled_query_runs/${enc}`));
      default:
        throw new Error(`Stripe plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "signingSecret") {
      const secret = await this.services?.secrets?.getPlaintext(resourceId, "signingSecret");
      if (secret) return secret;
      throw new Error(
        "Stripe only returns a signing secret when the endpoint is created. This one was created outside Infrawrench, so reveal or roll its secret in the Stripe Dashboard.",
      );
    }
    if (outputKey === "apiVersion") return STRIPE_API_VERSION;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey] ?? resource.fields[outputKey];
    return value === undefined || value === null ? "" : String(value);
  }

  // ------------------------------------------------------------- enrichment

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId === ACCOUNT) return this.enrichAccount(resource);
    if (resource.resourceTypeId === WEBHOOK_ENDPOINT) {
      const enabled = parseEventList(String(resource.fields["enabledEvents"] ?? ""));
      const failed = await this.failedEvents().catch(() => null);
      if (!failed) return resource;
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          [STASH.failedEvents]: JSON.stringify(failed.filter((e) => subscribes(enabled, e.type))),
        },
      };
    }
    return resource;
  }

  /** Events from the last 30 days that at least one endpoint failed to take. */
  private async failedEvents(): Promise<FailedEventSummary[]> {
    const since = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const res = await this.get<{ data?: StripeEvent[] }>("/v1/events", {
      delivery_success: false,
      "created[gte]": since,
      limit: 50,
    });
    return (res?.data ?? []).map((e) => ({
      id: e.id ?? "",
      type: e.type ?? "",
      created: epochToIso(e.created),
      pendingWebhooks: e.pending_webhooks ?? 0,
    }));
  }

  private async enrichAccount(resource: ResourceInstance): Promise<ResourceInstance> {
    const errors: string[] = [];
    const note = (what: string) => (err: unknown) => {
      errors.push(
        isPermissionError(err)
          ? `${what}: the API key lacks the permission to read it.`
          : `${what}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    };
    const [balance, subs, failed] = await Promise.all([
      this.get<StripeBalance>("/v1/balance").catch(note("Balance")),
      listV1<StripeSubscription & { id?: string }>(
        this.ctx,
        "/v1/subscriptions",
        { status: "all" },
        SUBSCRIPTION_PAGES,
      ).catch(note("Subscriptions")),
      this.failedEvents().catch(note("Failing webhook deliveries")),
    ]);
    const outputs: Record<string, string> = { ...resource.resolvedOutputs };
    if (balance) {
      const stash: BalanceStash = {
        available: balance.available ?? [],
        pending: balance.pending ?? [],
        instantAvailable: balance.instant_available ?? [],
        connectReserved: balance.connect_reserved ?? [],
      };
      outputs[STASH.balance] = JSON.stringify(stash);
    }
    if (subs) {
      outputs[STASH.subscriptions] = JSON.stringify(
        summariseSubscriptions(subs, subs.length >= SUBSCRIPTION_PAGES * 100),
      );
    }
    if (failed) outputs[STASH.failedEvents] = JSON.stringify(failed);
    if (errors.length > 0) outputs[STASH.enrichError] = errors.join(" ");
    return { ...resource, resolvedOutputs: outputs };
  }

  // --------------------------------------------------------------- create

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case WEBHOOK_ENDPOINT:
        return { fields: this.webhookCreateFields() };
      case EVENT_DESTINATION:
        return { fields: this.destinationCreateFields() };
      case PRODUCT:
        return { fields: await this.productCreateFields() };
      case PRICE:
        return { fields: await this.priceCreateFields(parentResourceId) };
      case METER:
        return { fields: this.meterCreateFields() };
      case REPORT_RUN:
        return { fields: await this.reportRunCreateFields() };
      default:
        throw new Error(`Stripe plugin: ${typeId} cannot be created`);
    }
  }

  private webhookCreateFields(): CreateFieldConfig[] {
    return [
      {
        key: "url",
        label: "Endpoint URL",
        kind: "text",
        required: true,
        placeholder: "https://example.com/webhooks/stripe",
        description: "Live mode requires HTTPS. Stripe posts each event here as JSON.",
      },
      {
        key: "description",
        label: "Description",
        kind: "text",
        required: false,
        placeholder: "Order fulfilment",
      },
      {
        key: "enabledEvents",
        label: "Events",
        kind: "policy-picker",
        required: true,
        policies: eventOptions(["*", ...SNAPSHOT_EVENT_TYPES.filter((e) => e !== "*")]),
        description:
          "The events to send. Pick only what the receiver handles: every extra event is a request it has to acknowledge.",
      },
      {
        key: "connect",
        label: "Events From",
        kind: "select",
        required: true,
        defaultValue: "false",
        options: [
          { id: "false", label: "This account" },
          { id: "true", label: "Connected accounts", description: "Connect platforms only" },
        ],
      },
      {
        key: "apiVersion",
        label: "Event API Version",
        kind: "select",
        required: false,
        defaultValue: "",
        options: [
          { id: "", label: "Account default", description: "Whatever the account is pinned to" },
          { id: STRIPE_API_VERSION, label: STRIPE_API_VERSION, description: "Latest" },
        ],
        description: "The API version event payloads are rendered in. It cannot be changed later.",
      },
    ];
  }

  private destinationCreateFields(): CreateFieldConfig[] {
    const option = (id: string, label: string, description?: string): SelectOption => ({
      id,
      label,
      ...(description ? { description } : {}),
    });
    return [
      { key: "name", label: "Name", kind: "text", required: true, placeholder: "billing-events" },
      { key: "description", label: "Description", kind: "text", required: false },
      {
        key: "type",
        label: "Destination",
        kind: "select",
        required: true,
        defaultValue: "webhook_endpoint",
        options: [
          option("webhook_endpoint", "Webhook endpoint", "An HTTPS URL"),
          option(
            "amazon_eventbridge",
            "Amazon EventBridge",
            "A partner event source in your AWS account",
          ),
          option(
            "azure_event_grid",
            "Azure Event Grid",
            "A partner topic in your Azure subscription",
          ),
        ],
      },
      {
        key: "eventPayload",
        label: "Payload",
        kind: "select",
        required: true,
        defaultValue: "thin",
        options: [
          option(
            "thin",
            "Thin",
            "A small notification; fetch the object for details. Needed for v2 events.",
          ),
          option("snapshot", "Snapshot", "The full object as it was when the event happened"),
        ],
      },
      {
        key: "thinEvents",
        label: "Events",
        kind: "policy-picker",
        required: false,
        policies: eventOptions(THIN_EVENT_TYPES),
        showWhen: { fieldKey: "eventPayload", fieldValue: "thin" },
      },
      {
        key: "snapshotEvents",
        label: "Events",
        kind: "policy-picker",
        required: false,
        policies: eventOptions(["*", ...SNAPSHOT_EVENT_TYPES.filter((e) => e !== "*")]),
        showWhen: { fieldKey: "eventPayload", fieldValue: "snapshot" },
      },
      {
        key: "eventsFrom",
        label: "Events From",
        kind: "select",
        required: true,
        defaultValue: "@self",
        options: [
          option("@self", "This account"),
          option("@accounts", "Accounts this account manages", "Connect platforms"),
          option("@self,@accounts", "Both"),
        ],
      },
      {
        key: "url",
        label: "Endpoint URL",
        kind: "text",
        required: false,
        placeholder: "https://example.com/webhooks/stripe",
        showWhen: { fieldKey: "type", fieldValue: "webhook_endpoint" },
      },
      {
        key: "awsAccountId",
        label: "AWS Account ID",
        kind: "text",
        required: false,
        placeholder: "123456789012",
        description:
          "Stripe creates a partner event source here; associate it with a bus in EventBridge.",
        showWhen: { fieldKey: "type", fieldValue: "amazon_eventbridge" },
      },
      {
        key: "awsRegion",
        label: "AWS Region",
        kind: "select",
        required: false,
        defaultValue: "us-east-1",
        options: AWS_REGIONS.map((r) => option(r, r)),
        showWhen: { fieldKey: "type", fieldValue: "amazon_eventbridge" },
      },
      {
        key: "azureSubscriptionId",
        label: "Azure Subscription ID",
        kind: "text",
        required: false,
        placeholder: "00000000-0000-0000-0000-000000000000",
        showWhen: { fieldKey: "type", fieldValue: "azure_event_grid" },
      },
      {
        key: "azureResourceGroup",
        label: "Azure Resource Group",
        kind: "text",
        required: false,
        showWhen: { fieldKey: "type", fieldValue: "azure_event_grid" },
      },
      {
        key: "azureRegion",
        label: "Azure Region",
        kind: "select",
        required: false,
        defaultValue: "eastus",
        options: AZURE_REGIONS.map((r) => option(r, r)),
        showWhen: { fieldKey: "type", fieldValue: "azure_event_grid" },
      },
    ];
  }

  private async taxCodeOptions(): Promise<SelectOption[]> {
    const codes = await listV1<{ id?: string; name?: string; description?: string }>(
      this.ctx,
      "/v1/tax_codes",
      {},
      10,
    ).catch(() => []);
    return [
      { id: "", label: "Account default" },
      ...codes
        .filter((c) => c.id)
        .map((c) => ({
          id: String(c.id),
          label: c.name || String(c.id),
          description: String(c.id),
        })),
    ];
  }

  private async currencyOptions(): Promise<{ options: SelectOption[]; defaultCurrency: string }> {
    const acct = await this.get<StripeAccount>("/v1/account").catch(() => null);
    const defaultCurrency = (acct?.default_currency ?? "usd").toLowerCase();
    let currencies: string[] = [];
    if (acct?.country) {
      const spec = await this.get<{ supported_payment_currencies?: string[] }>(
        `/v1/country_specs/${encodeURIComponent(acct.country)}`,
      ).catch(() => null);
      currencies = spec?.supported_payment_currencies ?? [];
    }
    if (currencies.length === 0) currencies = [defaultCurrency, "usd", "eur", "gbp"];
    const unique = [defaultCurrency, ...currencies.filter((c) => c !== defaultCurrency)];
    return {
      options: [...new Set(unique)].map((c) => ({ id: c, label: c.toUpperCase() })),
      defaultCurrency,
    };
  }

  private async productCreateFields(): Promise<CreateFieldConfig[]> {
    const [taxCodes, currencies] = await Promise.all([
      this.taxCodeOptions(),
      this.currencyOptions(),
    ]);
    return [
      { key: "name", label: "Name", kind: "text", required: true, placeholder: "Pro plan" },
      { key: "description", label: "Description", kind: "text", required: false, multiline: true },
      {
        key: "unitLabel",
        label: "Unit Label",
        kind: "text",
        required: false,
        placeholder: "seat",
        description: "Shown on receipts and invoices next to the quantity.",
      },
      {
        key: "statementDescriptor",
        label: "Statement Descriptor",
        kind: "text",
        required: false,
        placeholder: "ACME PRO",
        description: "Up to 22 characters on card statements for subscription payments.",
      },
      {
        key: "taxCode",
        label: "Tax Code",
        kind: "select",
        required: false,
        options: taxCodes,
        defaultValue: "",
      },
      {
        key: "url",
        label: "Product URL",
        kind: "text",
        required: false,
        placeholder: "https://example.com/pro",
      },
      {
        key: "priceAmount",
        label: "Default Price (optional)",
        kind: "number",
        required: false,
        placeholder: "20.00",
        description:
          "Creates a price and makes it the product's default. Leave blank to add prices later.",
      },
      {
        key: "priceCurrency",
        label: "Currency",
        kind: "select",
        required: false,
        options: currencies.options,
        defaultValue: currencies.defaultCurrency,
      },
      {
        key: "priceInterval",
        label: "Billing",
        kind: "select",
        required: false,
        defaultValue: "month",
        options: [
          { id: "", label: "One-time" },
          { id: "day", label: "Daily" },
          { id: "week", label: "Weekly" },
          { id: "month", label: "Monthly" },
          { id: "year", label: "Yearly" },
        ],
      },
    ];
  }

  private async priceCreateFields(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    const [products, meters, currencies] = await Promise.all([
      listV1<StripeProduct>(this.ctx, "/v1/products", { active: true }).catch(
        () => [] as StripeProduct[],
      ),
      listV1<StripeMeter>(this.ctx, "/v1/billing/meters", { status: "active" }).catch(
        () => [] as StripeMeter[],
      ),
      this.currencyOptions(),
    ]);
    const parentProduct = parentResourceId ? externalIdOf(parentResourceId) : "";
    return [
      {
        key: "productId",
        label: "Product",
        kind: "select",
        required: true,
        options: products
          .filter((p) => p.id)
          .map((p) => ({
            id: String(p.id),
            label: p.name || String(p.id),
            description: String(p.id),
          })),
        defaultValue: parentProduct || (products[0]?.id ?? ""),
      },
      {
        key: "nickname",
        label: "Nickname",
        kind: "text",
        required: false,
        placeholder: "Pro monthly",
      },
      {
        key: "currency",
        label: "Currency",
        kind: "select",
        required: true,
        options: currencies.options,
        defaultValue: currencies.defaultCurrency,
      },
      {
        key: "amount",
        label: "Amount",
        kind: "number",
        required: true,
        placeholder: "20.00",
        description:
          "In the currency's major unit (dollars, euros, yen). For metered prices, the amount per unit.",
      },
      {
        key: "type",
        label: "Billing",
        kind: "select",
        required: true,
        defaultValue: "recurring",
        options: [
          { id: "recurring", label: "Recurring" },
          { id: "one_time", label: "One-time" },
        ],
      },
      {
        key: "interval",
        label: "Interval",
        kind: "select",
        required: false,
        defaultValue: "month",
        options: [
          { id: "day", label: "Day" },
          { id: "week", label: "Week" },
          { id: "month", label: "Month" },
          { id: "year", label: "Year" },
        ],
        showWhen: { fieldKey: "type", fieldValue: "recurring" },
      },
      {
        key: "intervalCount",
        label: "Every",
        kind: "number",
        required: false,
        defaultValue: "1",
        minValue: 1,
        maxValue: 365,
        description:
          "Bill every N intervals, for example 3 with Month for quarterly. At most one year.",
        showWhen: { fieldKey: "type", fieldValue: "recurring" },
      },
      {
        key: "usageType",
        label: "Usage",
        kind: "select",
        required: false,
        defaultValue: "licensed",
        options: [
          {
            id: "licensed",
            label: "Per seat / quantity",
            description: "Charged up front for the quantity",
          },
          {
            id: "metered",
            label: "Metered",
            description: "Charged in arrears from a billing meter",
          },
        ],
        showWhen: { fieldKey: "type", fieldValue: "recurring" },
      },
      {
        key: "meterId",
        label: "Meter",
        kind: "select",
        required: false,
        options: meters
          .filter((m) => m.id)
          .map((m) => ({
            id: String(m.id),
            label: m.display_name || String(m.id),
            description: m.event_name ?? "",
          })),
        defaultValue: meters[0]?.id ?? "",
        ...(meters.length === 0
          ? { description: "No active meters yet: create a billing meter first." }
          : {}),
        showWhen: { fieldKey: "usageType", fieldValue: "metered" },
      },
      {
        key: "lookupKey",
        label: "Lookup Key",
        kind: "text",
        required: false,
        placeholder: "pro_monthly",
        description: "A stable name your code can fetch the price by.",
      },
      {
        key: "taxBehavior",
        label: "Tax Behavior",
        kind: "select",
        required: false,
        defaultValue: "",
        options: [
          { id: "", label: "Account default" },
          { id: "exclusive", label: "Exclusive", description: "Tax is added on top" },
          { id: "inclusive", label: "Inclusive", description: "Tax is included in the amount" },
        ],
      },
    ];
  }

  private meterCreateFields(): CreateFieldConfig[] {
    return [
      {
        key: "displayName",
        label: "Display Name",
        kind: "text",
        required: true,
        placeholder: "API requests",
      },
      {
        key: "eventName",
        label: "Event Name",
        kind: "text",
        required: true,
        placeholder: "api_requests",
        description:
          "The `event_name` your code sends meter events with. It cannot be changed later.",
      },
      {
        key: "aggregation",
        label: "Aggregation",
        kind: "select",
        required: true,
        defaultValue: "sum",
        options: [
          { id: "sum", label: "Sum", description: "Add up the values in the period" },
          { id: "count", label: "Count", description: "Count the events in the period" },
          { id: "last", label: "Last", description: "Use the most recent value in the period" },
        ],
      },
      {
        key: "customerPayloadKey",
        label: "Customer Payload Key",
        kind: "text",
        required: false,
        defaultValue: "stripe_customer_id",
        description: "The payload key holding the customer id.",
      },
      {
        key: "valuePayloadKey",
        label: "Value Payload Key",
        kind: "text",
        required: false,
        defaultValue: "value",
        description: "The payload key holding the quantity. Ignored for Count.",
      },
      {
        key: "eventTimeWindow",
        label: "Pre-aggregated Events",
        kind: "select",
        required: false,
        defaultValue: "",
        options: [
          { id: "", label: "No", description: "Each event is one occurrence" },
          { id: "hour", label: "Per hour", description: "Events already sum an hour" },
          { id: "day", label: "Per day", description: "Events already sum a day" },
        ],
      },
    ];
  }

  private async reportRunCreateFields(): Promise<CreateFieldConfig[]> {
    const res = await this.get<{
      data?: Array<{
        id?: string;
        name?: string;
        data_available_end?: number;
        data_available_start?: number;
      }>;
    }>("/v1/reporting/report_types");
    const types = (res?.data ?? []).filter((t) => t.id);
    // Default to the previous full calendar month, clipped to what is available.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return [
      {
        key: "reportType",
        label: "Report Type",
        kind: "select",
        required: true,
        options: types.map((t) => ({
          id: String(t.id),
          label: t.name || String(t.id),
          description: [
            String(t.id),
            t.data_available_end
              ? `data until ${epochToIso(t.data_available_end).slice(0, 10)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        defaultValue: types.find((t) => t.id === "balance.summary.1")?.id ?? types[0]?.id ?? "",
      },
      {
        key: "intervalStart",
        label: "From",
        kind: "datetime",
        datetimeMode: "date",
        required: true,
        defaultValue: prevStart.toISOString().slice(0, 10),
      },
      {
        key: "intervalEnd",
        label: "To (exclusive)",
        kind: "datetime",
        datetimeMode: "date",
        required: true,
        defaultValue: monthStart.toISOString().slice(0, 10),
        description: "Clipped to the newest data Stripe has for the report type.",
      },
      {
        key: "currency",
        label: "Currency",
        kind: "text",
        required: false,
        placeholder: "usd",
        description: "Limit to one settlement currency. Leave blank for all.",
      },
    ];
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    switch (typeId) {
      case WEBHOOK_ENDPOINT:
        return this.createWebhookEndpoint(accountId, fields);
      case EVENT_DESTINATION:
        return this.createEventDestination(accountId, fields);
      case PRODUCT:
        return this.createProduct(accountId, fields);
      case PRICE:
        return this.createPrice(accountId, fields, parentResourceId);
      case METER:
        return this.createMeter(accountId, fields);
      case REPORT_RUN:
        return this.createReportRun(accountId, fields);
      default:
        throw new Error(`Stripe plugin: ${typeId} cannot be created`);
    }
  }

  /** `POST /v1/webhook_endpoints`: the response is the only time `secret` is sent. */
  private async createWebhookEndpoint(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const url = opt(fields["url"]);
    const events = parseEventList(fields["enabledEvents"]);
    if (!url) throw new Error("Stripe plugin: an endpoint URL is required");
    if (events.length === 0) throw new Error("Stripe plugin: pick at least one event");
    const created = await this.post<StripeWebhookEndpoint>("/v1/webhook_endpoints", {
      url,
      enabled_events: events,
      description: opt(fields["description"]),
      api_version: opt(fields["apiVersion"]),
      connect: bool(fields["connect"]) ? true : undefined,
    });
    const resource = mapWebhookEndpoint(accountId, created);
    await this.keepSecret(resource, created.secret);
    return resource;
  }

  /** `POST /v2/core/event_destinations`, asking for the signing secret back. */
  private async createEventDestination(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = opt(fields["name"]);
    if (!name) throw new Error("Stripe plugin: a name is required");
    const type = fields["type"] || "webhook_endpoint";
    const payload = fields["eventPayload"] || "thin";
    const events = parseEventList(
      payload === "thin" ? fields["thinEvents"] : fields["snapshotEvents"],
    );
    if (events.length === 0) throw new Error("Stripe plugin: pick at least one event");
    const body: Record<string, unknown> = {
      name,
      type,
      event_payload: payload,
      enabled_events: events,
      events_from: (fields["eventsFrom"] || "@self")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const description = opt(fields["description"]);
    if (description) body["description"] = description;
    if (payload === "snapshot") body["snapshot_api_version"] = STRIPE_API_VERSION;
    if (type === "webhook_endpoint") {
      const url = opt(fields["url"]);
      if (!url) throw new Error("Stripe plugin: a webhook URL is required");
      body["webhook_endpoint"] = { url };
      body["include"] = ["webhook_endpoint.signing_secret", "webhook_endpoint.url"];
    } else if (type === "amazon_eventbridge") {
      const account = opt(fields["awsAccountId"]);
      if (!account || !/^\d{12}$/.test(account)) {
        throw new Error("Stripe plugin: enter the 12-digit AWS account ID");
      }
      body["amazon_eventbridge"] = {
        aws_account_id: account,
        aws_region: fields["awsRegion"] || "us-east-1",
      };
    } else if (type === "azure_event_grid") {
      const sub = opt(fields["azureSubscriptionId"]);
      const group = opt(fields["azureResourceGroup"]);
      if (!sub || !group)
        throw new Error("Stripe plugin: enter the Azure subscription and resource group");
      body["azure_event_grid"] = {
        azure_subscription_id: sub,
        azure_resource_group_name: group,
        azure_region: fields["azureRegion"] || "eastus",
      };
    }
    const created = await stripeFetch<StripeEventDestination>(
      this.ctx,
      "/v2/core/event_destinations",
      {
        method: "POST",
        json: body,
      },
    );
    const resource = mapEventDestination(accountId, created);
    await this.keepSecret(resource, created.webhook_endpoint?.signing_secret ?? undefined);
    return resource;
  }

  /**
   * Persist a one-time signing secret. It goes back on the instance as a
   * plaintext secret state (the host encrypts it) and, where the host can,
   * straight into the secret store so `resolveOutput` finds it.
   */
  private async keepSecret(resource: ResourceInstance, secret: string | undefined): Promise<void> {
    if (!secret) return;
    resource.secretStates = [
      { fieldKey: "signingSecret", resolution: { kind: "plaintext", value: secret } },
    ];
    await this.services?.secrets
      ?.setPlaintext?.(resource.id, "signingSecret", secret)
      .catch(() => undefined);
  }

  private async createProduct(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = opt(fields["name"]);
    if (!name) throw new Error("Stripe plugin: a product name is required");
    const form: Record<string, FormValue> = {
      name,
      description: opt(fields["description"]),
      unit_label: opt(fields["unitLabel"]),
      statement_descriptor: opt(fields["statementDescriptor"]),
      tax_code: opt(fields["taxCode"]),
      url: opt(fields["url"]),
    };
    const amount = opt(fields["priceAmount"]);
    if (amount !== undefined) {
      const currency = (fields["priceCurrency"] || "usd").toLowerCase();
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 0)
        throw new Error("Stripe plugin: the default price must be a number");
      const interval = opt(fields["priceInterval"]);
      form["default_price_data"] = {
        currency,
        unit_amount: toMinor(value, currency),
        ...(interval ? { recurring: { interval } } : {}),
      };
    }
    return mapProduct(
      accountId,
      this.ctx.apiKey,
      await this.post<StripeProduct>("/v1/products", form),
    );
  }

  private async createPrice(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const product =
      opt(fields["productId"]) ?? (parentResourceId ? externalIdOf(parentResourceId) : undefined);
    if (!product) throw new Error("Stripe plugin: pick a product");
    const currency = (fields["currency"] || "usd").toLowerCase();
    const amount = Number(fields["amount"]);
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("Stripe plugin: the amount must be a number");
    const form: Record<string, FormValue> = {
      product,
      currency,
      nickname: opt(fields["nickname"]),
      lookup_key: opt(fields["lookupKey"]),
      tax_behavior: opt(fields["taxBehavior"]),
    };
    // Sub-cent amounts (common for metered prices) need the decimal form,
    // which Stripe takes in minor units with up to 12 decimal places.
    const minor = Number((amount * Math.pow(10, currencyExponent(currency))).toFixed(10));
    if (Number.isInteger(minor)) form["unit_amount"] = minor;
    else form["unit_amount_decimal"] = String(minor);
    if ((fields["type"] || "recurring") === "recurring") {
      const usage = fields["usageType"] || "licensed";
      const meter = opt(fields["meterId"]);
      if (usage === "metered" && !meter)
        throw new Error("Stripe plugin: a metered price needs a meter");
      const count = Number(fields["intervalCount"] || "1");
      form["recurring"] = {
        interval: fields["interval"] || "month",
        interval_count: Number.isFinite(count) && count > 1 ? count : undefined,
        usage_type: usage,
        meter: usage === "metered" ? meter : undefined,
      };
    }
    const created = await this.post<StripePrice>("/v1/prices", form);
    return mapPrice(accountId, created, parentResourceId);
  }

  private async createMeter(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const displayName = opt(fields["displayName"]);
    const eventName = opt(fields["eventName"]);
    if (!displayName || !eventName)
      throw new Error("Stripe plugin: a display name and event name are required");
    const formula = fields["aggregation"] || "sum";
    const created = await this.post<StripeMeter>("/v1/billing/meters", {
      display_name: displayName,
      event_name: eventName,
      default_aggregation: { formula },
      customer_mapping: {
        type: "by_id",
        event_payload_key: opt(fields["customerPayloadKey"]) ?? "stripe_customer_id",
      },
      value_settings:
        formula === "count"
          ? undefined
          : { event_payload_key: opt(fields["valuePayloadKey"]) ?? "value" },
      event_time_window: opt(fields["eventTimeWindow"]),
    });
    return mapMeter(accountId, created);
  }

  private async createReportRun(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const reportType = opt(fields["reportType"]);
    if (!reportType) throw new Error("Stripe plugin: pick a report type");
    const toEpoch = (value: string | undefined): number | undefined => {
      if (!value) return undefined;
      const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
    };
    let start = toEpoch(fields["intervalStart"]);
    let end = toEpoch(fields["intervalEnd"]);
    // Clip to the report type's availability window; Stripe rejects anything outside it.
    const type = await this.get<{ data_available_start?: number; data_available_end?: number }>(
      `/v1/reporting/report_types/${encodeURIComponent(reportType)}`,
    ).catch(() => null);
    if (type?.data_available_end && end && end > type.data_available_end)
      end = type.data_available_end;
    if (type?.data_available_start && start && start < type.data_available_start)
      start = type.data_available_start;
    if (start && end && start >= end) {
      throw new Error(
        "Stripe plugin: the date range is empty once clipped to the data Stripe has for this report",
      );
    }
    const created = await this.post<StripeReportRun>("/v1/reporting/report_runs", {
      report_type: reportType,
      parameters: {
        interval_start: start,
        interval_end: end,
        currency: opt(fields["currency"])?.toLowerCase(),
      },
    });
    return mapReportRun(accountId, created);
  }

  // --------------------------------------------------------------- update

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const enc = encodeURIComponent(externalIdOf(resourceId));
    const has = (key: string) => Object.prototype.hasOwnProperty.call(fields, key);
    switch (typeId) {
      case WEBHOOK_ENDPOINT: {
        const form: Record<string, FormValue> = {};
        if (has("url")) form["url"] = fields["url"];
        if (has("description")) form["description"] = fields["description"] ?? "";
        if (has("enabledEvents")) {
          const events = parseEventList(fields["enabledEvents"]);
          if (events.length === 0)
            throw new Error("Stripe plugin: an endpoint needs at least one event");
          form["enabled_events"] = events;
        }
        if (has("status")) form["disabled"] = fields["status"] === "disabled";
        return mapWebhookEndpoint(accountId, await this.post(`/v1/webhook_endpoints/${enc}`, form));
      }
      case EVENT_DESTINATION: {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = fields["name"];
        if (has("description")) body["description"] = fields["description"] ?? "";
        if (has("enabledEvents")) {
          const events = parseEventList(fields["enabledEvents"]);
          if (events.length === 0)
            throw new Error("Stripe plugin: a destination needs at least one event");
          body["enabled_events"] = events;
        }
        if (has("url") && fields["url"]) body["webhook_endpoint"] = { url: fields["url"] };
        body["include"] = ["webhook_endpoint.url"];
        const updated = await stripeFetch<StripeEventDestination>(
          this.ctx,
          `/v2/core/event_destinations/${enc}`,
          { method: "POST", json: body },
        );
        return mapEventDestination(accountId, updated);
      }
      case PRODUCT: {
        const form: Record<string, FormValue> = {};
        const map: Record<string, string> = {
          name: "name",
          description: "description",
          unitLabel: "unit_label",
          statementDescriptor: "statement_descriptor",
          taxCode: "tax_code",
          url: "url",
        };
        for (const [key, param] of Object.entries(map))
          if (has(key)) form[param] = fields[key] ?? "";
        if (has("active")) form["active"] = fields["active"] === "true";
        return mapProduct(accountId, this.ctx.apiKey, await this.post(`/v1/products/${enc}`, form));
      }
      case PRICE: {
        const form: Record<string, FormValue> = {};
        if (has("nickname")) form["nickname"] = fields["nickname"] ?? "";
        if (has("lookupKey")) {
          form["lookup_key"] = fields["lookupKey"] ?? "";
          // Moving a lookup key from another price is what users mean by setting it.
          if (fields["lookupKey"]) form["transfer_lookup_key"] = true;
        }
        if (
          has("taxBehavior") &&
          fields["taxBehavior"] &&
          fields["taxBehavior"] !== "unspecified"
        ) {
          form["tax_behavior"] = fields["taxBehavior"];
        }
        if (has("active")) form["active"] = fields["active"] === "true";
        return mapPrice(accountId, await this.post(`/v1/prices/${enc}`, form));
      }
      case METER: {
        if (!has("displayName")) return this.getResource(typeId, resourceId, accountId);
        return mapMeter(
          accountId,
          await this.post(`/v1/billing/meters/${enc}`, { display_name: fields["displayName"] }),
        );
      }
      default:
        throw new Error(`Stripe plugin: ${typeId} cannot be edited`);
    }
  }

  // --------------------------------------------------------------- delete

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const enc = encodeURIComponent(externalIdOf(resourceId));
    const del = (path: string) => stripeFetch<unknown>(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case WEBHOOK_ENDPOINT:
        await del(`/v1/webhook_endpoints/${enc}`);
        return;
      case EVENT_DESTINATION:
        await del(`/v2/core/event_destinations/${enc}`);
        return;
      case CONNECTED_ACCOUNT:
        await del(`/v1/accounts/${enc}`);
        return;
      case PRODUCT:
        try {
          await del(`/v1/products/${enc}`);
        } catch (err) {
          if (err instanceof StripeApiError && err.status === 400) {
            throw new StripeApiError(
              400,
              "Stripe only deletes products that have no prices. Archive it instead: it stays on existing subscriptions but cannot be sold.",
              err.type,
              err.code,
            );
          }
          throw err;
        }
        return;
      default:
        throw new Error(`Stripe plugin: ${typeId} cannot be deleted`);
    }
  }

  // --------------------------------------------------------------- actions

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const enc = encodeURIComponent(externalIdOf(resourceId));
    const key = `${typeId}:${actionId}`;
    switch (key) {
      case `${WEBHOOK_ENDPOINT}:enable`:
      case `${WEBHOOK_ENDPOINT}:disable`:
        await this.post(`/v1/webhook_endpoints/${enc}`, { disabled: actionId === "disable" });
        return;
      case `${EVENT_DESTINATION}:enable`:
      case `${EVENT_DESTINATION}:disable`:
      case `${EVENT_DESTINATION}:ping`:
        await stripeFetch(this.ctx, `/v2/core/event_destinations/${enc}/${actionId}`, {
          method: "POST",
          json: {},
        });
        return;
      case `${PRODUCT}:archive`:
      case `${PRODUCT}:unarchive`:
        await this.post(`/v1/products/${enc}`, { active: actionId === "unarchive" });
        return;
      case `${PRICE}:archive`:
      case `${PRICE}:unarchive`:
        await this.post(`/v1/prices/${enc}`, { active: actionId === "unarchive" });
        return;
      case `${METER}:deactivate`:
      case `${METER}:reactivate`:
        await this.post(`/v1/billing/meters/${enc}/${actionId}`);
        return;
      case `${PAYOUT}:cancel`:
        await this.post(`/v1/payouts/${enc}/cancel`);
        return;
      case `${CONNECTED_ACCOUNT}:reject`:
        await this.post(`/v1/accounts/${enc}/reject`, { reason: "other" });
        return;
      case `${CONNECTED_ACCOUNT}:unreject`:
        await this.post(`/v1/accounts/${enc}/unreject`);
        return;
      default:
        throw new Error(`Stripe plugin: unknown action "${actionId}" for ${typeId}`);
    }
  }

  // ------------------------------------------------------------- telemetry

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchFeeCostRows(this.ctx, range.fromDate, range.toDate);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 30 * 86_400_000;
    if (resourceTypeId === ACCOUNT) return accountMetrics(this.ctx, startMs, endMs);
    if (resourceTypeId === METER)
      return meterMetrics(this.ctx, externalIdOf(resourceId), startMs, endMs);
    return [];
  }

  /**
   * The account's event stream as logs: v1 snapshot events, the subset whose
   * webhook deliveries failed, or v2 thin events.
   */
  async getLogs(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== ACCOUNT) throw new Error(`Stripe plugin: no logs for ${typeId}`);
    const containers = ["Events", "Failed webhook deliveries", "Thin events (v2)"];
    const active =
      params.container && containers.includes(params.container) ? params.container : containers[0]!;
    const limit = Math.min(Math.max(params.tailLines ?? 100, 1), 500);
    const pages = Math.ceil(limit / 100);
    let lines: string[];
    if (active === "Thin events (v2)") {
      const events = await listV2<{
        id?: string;
        type?: string;
        created?: string;
        related_object?: { id?: string };
      }>(this.ctx, "/v2/core/events", {}, pages);
      lines = events
        .slice(0, limit)
        .map(
          (e) =>
            `${e.created ?? ""}  ${e.type ?? ""}  ${e.related_object?.id ?? ""}  ${e.id ?? ""}`,
        );
    } else {
      const events = await listV1<StripeEvent>(
        this.ctx,
        "/v1/events",
        active === "Failed webhook deliveries" ? { delivery_success: false } : {},
        pages,
      );
      lines = events.slice(0, limit).map((e) => {
        const obj = e.data?.object;
        const pending = e.pending_webhooks ? `  pending_webhooks=${e.pending_webhooks}` : "";
        const acct = e.account ? `  account=${e.account}` : "";
        return `${epochToIso(e.created)}  ${e.type ?? ""}  ${obj?.id ?? ""}  ${e.id ?? ""}${pending}${acct}`;
      });
    }
    // Stripe lists newest first; logs read oldest first.
    lines.reverse();
    return { text: lines.map((l) => `${l}\n`).join(""), containers, activeContainer: active };
  }

  // ----------------------------------------------------------------- render

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.dash());
  }
}
