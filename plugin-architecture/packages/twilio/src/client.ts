import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CreditBalance,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CreditAccessError, externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type { ApiForm } from "@infrawrench/plugin-base";
import type { TwilioContext } from "./api.js";
import { accountPath, isAccessDenied, messaging, pricing, v2010, verify } from "./api.js";
import type { operations as MessagingOps } from "./api-types.messaging.gen.js";
import type { operations as V2010Ops } from "./api-types.v2010.gen.js";
import type { operations as VerifyOps } from "./api-types.verify.gen.js";
import { COMMON_TRIGGER_CATEGORIES, TOTAL_CATEGORY } from "./categories.js";
import type { PeriodSpend, SubaccountRef } from "./cost-data.js";
import { MAX_SUBACCOUNT_SCOPES, fetchPeriodSpend, fetchTwilioCostData } from "./cost-data.js";
import type { AccountSummary, TwAccount } from "./mappers.js";
import {
  mapAccount,
  mapApplication,
  mapKey,
  mapMessagingService,
  mapPhoneNumber,
  mapSubaccount,
  mapUsageTrigger,
  mapVerifyService,
  num,
} from "./mappers.js";
import { rangeOrDefault, usageSeries } from "./metrics.js";
import type { CountryNumberPrices } from "./pricing.js";
import { countryOfNumber, normalizeNumberType, parseCountryPrices } from "./pricing.js";
import type { VerifySummary } from "./render.js";
import {
  SPEND_LAST_MONTH_KEY,
  SPEND_THIS_MONTH_KEY,
  VERIFY_SUMMARY_KEY,
  money,
  renderTwilioDetail,
  renderTwilioSidebar,
  triggerProgress,
} from "./render.js";

const CACHE_MS = 60_000;
const CONCURRENCY = 4;
const MAX_MESSAGING_SERVICES = 200;

const SID = {
  account: /^AC[0-9a-fA-F]{32}$/,
  key: /^SK[0-9a-fA-F]{32}$/,
};

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const queue = items.entries();
  async function worker() {
    for (const [i, item] of queue) out[i] = await fn(item);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const bool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === "" ? undefined : v === "true";

type Fields = Record<string, string>;

/** A field as the form sent it, or nothing if it did not: an absent key is left unchanged. */
const text = (fields: Fields, key: string): string | undefined =>
  key in fields ? (fields[key] ?? "").trim() : undefined;

/** A toggle: blank means "Twilio default", so it is not sent. */
const flag = (fields: Fields, key: string): boolean | undefined => bool(text(fields, key));

/** A number kept as typed, which Twilio validates. Blank is not sent. */
const unlessBlank = (fields: Fields, key: string): string | undefined =>
  text(fields, key) || undefined;

const callHandlers = (
  fields: Fields,
): ApiForm<V2010Ops["UpdateIncomingPhoneNumber"]> &
  ApiForm<V2010Ops["CreateApplication"]> &
  ApiForm<V2010Ops["UpdateApplication"]> => ({
  FriendlyName: text(fields, "friendlyName"),
  VoiceUrl: text(fields, "voiceUrl"),
  VoiceMethod: text(fields, "voiceMethod"),
  VoiceFallbackUrl: text(fields, "voiceFallbackUrl"),
  SmsUrl: text(fields, "smsUrl"),
  SmsMethod: text(fields, "smsMethod"),
  SmsFallbackUrl: text(fields, "smsFallbackUrl"),
  StatusCallback: text(fields, "statusCallback"),
});

const phoneForm = (fields: Fields): ApiForm<V2010Ops["UpdateIncomingPhoneNumber"]> =>
  callHandlers(fields);

const appForm = (
  fields: Fields,
): ApiForm<V2010Ops["CreateApplication"]> & ApiForm<V2010Ops["UpdateApplication"]> => ({
  ...callHandlers(fields),
  SmsStatusCallback: text(fields, "smsStatusCallback"),
});

const messagingForm = (
  fields: Fields,
): ApiForm<MessagingOps["CreateService"]> & ApiForm<MessagingOps["UpdateService"]> => ({
  FriendlyName: text(fields, "friendlyName"),
  Usecase: text(fields, "usecase"),
  InboundRequestUrl: text(fields, "inboundRequestUrl"),
  FallbackUrl: text(fields, "fallbackUrl"),
  StatusCallback: text(fields, "statusCallback"),
  StickySender: flag(fields, "stickySender"),
  SmartEncoding: flag(fields, "smartEncoding"),
  MmsConverter: flag(fields, "mmsConverter"),
  FallbackToLongCode: flag(fields, "fallbackToLongCode"),
  AreaCodeGeomatch: flag(fields, "areaCodeGeomatch"),
  ValidityPeriod: unlessBlank(fields, "validityPeriod"),
  UseInboundWebhookOnNumber: flag(fields, "useInboundWebhookOnNumber"),
});

const verifyForm = (
  fields: Fields,
): ApiForm<VerifyOps["CreateService"]> & ApiForm<VerifyOps["UpdateService"]> => ({
  FriendlyName: text(fields, "friendlyName"),
  CodeLength: unlessBlank(fields, "codeLength"),
  LookupEnabled: flag(fields, "lookupEnabled"),
  SkipSmsToLandlines: flag(fields, "skipSmsToLandlines"),
  DtmfInputRequired: flag(fields, "dtmfInputRequired"),
  DoNotShareWarningEnabled: flag(fields, "doNotShareWarningEnabled"),
  CustomCodeEnabled: flag(fields, "customCodeEnabled"),
  Psd2Enabled: flag(fields, "psd2Enabled"),
});

/** A trigger's category, measure and threshold are fixed once it exists. */
export const usageTriggerForm = (fields: Fields): ApiForm<V2010Ops["UpdateUsageTrigger"]> => ({
  FriendlyName: text(fields, "friendlyName"),
  CallbackUrl: text(fields, "callbackUrl"),
  CallbackMethod: text(fields, "callbackMethod"),
});

export class TwilioClient implements PluginClient {
  private readonly ctx: TwilioContext;
  private subaccountCache: Cached<TwAccount[] | null> | undefined;
  private membershipCache:
    Cached<Map<string, { sid: string; name: string; count: number }>> | undefined;
  private readonly priceCache = new Map<string, Promise<CountryNumberPrices | null>>();

  constructor(credentials: Credentials, services?: HostServices) {
    const accountSid = (credentials["accountSid"] ?? "").trim();
    const apiKeySid = (credentials["apiKeySid"] ?? "").trim();
    const apiKeySecret = (credentials["apiKeySecret"] ?? "").trim();
    const authToken = (credentials["authToken"] ?? "").trim();
    if (!accountSid) throw new Error("Twilio plugin: missing Account SID");
    if (!SID.account.test(accountSid)) {
      throw new Error(
        "Twilio plugin: the Account SID starts with AC followed by 32 hexadecimal characters",
      );
    }
    const caCert = credentials["caCert"] ?? "";
    const base = {
      accountSid,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    if (apiKeySid || apiKeySecret) {
      if (!apiKeySid || !apiKeySecret) {
        throw new Error("Twilio plugin: an API key needs both its SID and its secret");
      }
      if (!SID.key.test(apiKeySid)) {
        throw new Error(
          "Twilio plugin: the API key SID starts with SK followed by 32 hexadecimal characters",
        );
      }
      this.ctx = { ...base, username: apiKeySid, password: apiKeySecret, authMode: "api-key" };
    } else if (authToken) {
      this.ctx = { ...base, username: accountSid, password: authToken, authMode: "auth-token" };
    } else {
      throw new Error(
        "Twilio plugin: enter an API key SID and secret, or the account's auth token",
      );
    }
  }

  get context(): TwilioContext {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  /**
   * Every subaccount (all statuses), or null when the credential cannot list
   * accounts (a Standard API key). Memoised briefly so one sync does not list
   * them once per resource type.
   */
  private subaccounts(): Promise<TwAccount[] | null> {
    if (this.subaccountCache && Date.now() - this.subaccountCache.at < CACHE_MS) {
      return this.subaccountCache.value;
    }
    const value = v2010(this.ctx)
      .getAll("/2010-04-01/Accounts.json", "accounts")
      .then((all) => all.filter((a) => a.sid && a.sid !== this.ctx.accountSid))
      .catch((err) => {
        if (isAccessDenied(err)) return null;
        throw err;
      });
    this.subaccountCache = { at: Date.now(), value };
    return value;
  }

  private async subaccountRefs(): Promise<SubaccountRef[] | null> {
    const subs = await this.subaccounts();
    if (!subs) return null;
    return subs.map((s) => ({ sid: s.sid ?? "", name: s.friendly_name ?? s.sid ?? "" }));
  }

  /** Subaccounts whose resources this credential can read (only the auth token reaches them). */
  private async readableSubaccounts(): Promise<TwAccount[]> {
    if (this.ctx.authMode !== "auth-token") return [];
    const subs = (await this.subaccounts()) ?? [];
    return subs.filter((s) => s.status !== "closed").slice(0, MAX_SUBACCOUNT_SCOPES);
  }

  /** Messaging services with the phone numbers in each, keyed by phone number SID. */
  private messagingMembership(): Promise<
    Map<string, { sid: string; name: string; count: number }>
  > {
    if (this.membershipCache && Date.now() - this.membershipCache.at < CACHE_MS) {
      return this.membershipCache.value;
    }
    const value = (async () => {
      const out = new Map<string, { sid: string; name: string; count: number }>();
      const services = await this.fetchMessagingServices().catch((err) => {
        if (isAccessDenied(err)) return [];
        throw err;
      });
      await mapLimit(services.slice(0, MAX_MESSAGING_SERVICES), CONCURRENCY, async (s) => {
        if (!s.sid) return;
        const numbers = await messaging(this.ctx)
          .getAll(`/v1/Services/${pathEncode(s.sid)}/PhoneNumbers`, "phone_numbers")
          .catch(() => []);
        out.set(`service:${s.sid}`, {
          sid: s.sid,
          name: s.friendly_name ?? s.sid,
          count: numbers.length,
        });
        for (const n of numbers) {
          if (n.sid)
            out.set(n.sid, { sid: s.sid, name: s.friendly_name ?? s.sid, count: numbers.length });
        }
      });
      return out;
    })();
    this.membershipCache = { at: Date.now(), value };
    return value;
  }

  private fetchMessagingServices() {
    return messaging(this.ctx).getAll("/v1/Services", "services");
  }

  private countryPrices(iso: string): Promise<CountryNumberPrices | null> {
    let cached = this.priceCache.get(iso);
    if (!cached) {
      cached = pricing(this.ctx)
        .get(`/v1/PhoneNumbers/Countries/${pathEncode(iso)}`)
        .then(parseCountryPrices)
        .catch(() => null);
      this.priceCache.set(iso, cached);
    }
    return cached;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /** A 401/403 on one lister means the credential lacks that scope; list it empty. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (isAccessDenied(err)) return [];
      throw err;
    }
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const main = accountPath(this.ctx.accountSid);
      switch (typeId) {
        case "account":
          return [await this.loadAccount(accountId)];
        case "subaccount": {
          const subs = (await this.subaccounts()) ?? [];
          return subs.filter((s) => s.status !== "closed").map((s) => mapSubaccount(accountId, s));
        }
        case "phone-number":
          return this.listPhoneNumbers(accountId);
        case "messaging-service":
          return this.scoped(async () => {
            const [services, membership] = await Promise.all([
              this.fetchMessagingServices(),
              this.messagingMembership(),
            ]);
            return services.map((s) =>
              mapMessagingService(accountId, s, membership.get(`service:${s.sid}`)?.count),
            );
          });
        case "verify-service":
          return this.scoped(async () =>
            (await verify(this.ctx).getAll("/v2/Services", "services")).map((s) =>
              mapVerifyService(accountId, s),
            ),
          );
        case "twiml-app":
          return this.scoped(async () =>
            (await v2010(this.ctx).getAll(`${main}/Applications.json`, "applications")).map((a) =>
              mapApplication(accountId, a),
            ),
          );
        case "usage-trigger":
          return this.scoped(async () =>
            (await v2010(this.ctx).getAll(`${main}/Usage/Triggers.json`, "usage_triggers")).map(
              (t) => mapUsageTrigger(accountId, t),
            ),
          );
        case "api-key":
          return this.scoped(async () =>
            (await v2010(this.ctx).getAll(`${main}/Keys.json`, "keys")).map((k) =>
              mapKey(accountId, k, this.ctx.username),
            ),
          );
        default:
          throw new Error(`Twilio plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async loadAccount(accountId: string): Promise<ResourceInstance> {
    const main = accountPath(this.ctx.accountSid);
    const api = v2010(this.ctx);
    const [account, balance, thisMonth, lastMonth, subs] = await Promise.all([
      api.get(`${main}.json`).catch((err) => {
        // A Standard key cannot read the Accounts resource: keep the SID.
        if (isAccessDenied(err)) return { sid: this.ctx.accountSid };
        throw err;
      }),
      api.get(`${main}/Balance.json`).catch(() => undefined),
      this.totalFor("ThisMonth"),
      this.totalFor("LastMonth"),
      this.subaccounts().catch(() => null),
    ]);
    const balanceValue = num(balance?.balance);
    const summary: AccountSummary = {
      ...(balanceValue !== undefined ? { balance: balanceValue } : {}),
      ...(balance?.currency ? { currency: balance.currency.toUpperCase() } : {}),
      ...(thisMonth ? { monthToDate: thisMonth.price, priceUnit: thisMonth.unit } : {}),
      ...(lastMonth ? { lastMonth: lastMonth.price, priceUnit: lastMonth.unit } : {}),
      ...(subs ? { subaccountCount: subs.filter((s) => s.status !== "closed").length } : {}),
    };
    return mapAccount(accountId, account, summary, this.ctx.authMode);
  }

  private async totalFor(
    period: "ThisMonth" | "LastMonth",
  ): Promise<{ price: number; unit: string } | undefined> {
    try {
      const records = await v2010(this.ctx).getAll(
        `${accountPath(this.ctx.accountSid)}/Usage/Records/${period}.json`,
        "usage_records",
        { query: { Category: TOTAL_CATEGORY, IncludeSubaccounts: true } },
      );
      const r = records[0];
      if (!r) return undefined;
      return { price: num(r.price) ?? 0, unit: (r.price_unit ?? "usd").toUpperCase() };
    } catch {
      return undefined;
    }
  }

  private async listPhoneNumbers(accountId: string): Promise<ResourceInstance[]> {
    const owners = [
      { sid: this.ctx.accountSid, name: "" },
      ...(await this.readableSubaccounts()).map((s) => ({
        sid: s.sid ?? "",
        name: s.friendly_name ?? "",
      })),
    ];
    const subaccountNames = new Map(owners.slice(1).map((o) => [o.sid, o.name || o.sid]));
    const [membership, perOwner] = await Promise.all([
      this.messagingMembership(),
      mapLimit(owners, CONCURRENCY, async (owner) => {
        try {
          return await v2010(this.ctx).getAll(
            `${accountPath(owner.sid)}/IncomingPhoneNumbers.json`,
            "incoming_phone_numbers",
          );
        } catch (err) {
          if (owner.sid !== this.ctx.accountSid && isAccessDenied(err)) return [];
          throw err;
        }
      }),
    ]);
    const numbers = perOwner.flat();
    const countries = [
      ...new Set(
        numbers
          .map((n) => countryOfNumber(n.phone_number ?? ""))
          .filter((iso): iso is string => Boolean(iso)),
      ),
    ];
    const prices = new Map<string, CountryNumberPrices | null>();
    await mapLimit(countries, CONCURRENCY, async (iso) => {
      prices.set(iso, await this.countryPrices(iso));
    });
    return numbers.map((n) => {
      const iso = countryOfNumber(n.phone_number ?? "");
      const table = iso ? prices.get(iso) : undefined;
      const price = table?.prices.get(normalizeNumberType(n.type));
      return mapPhoneNumber(accountId, n, {
        mainAccountSid: this.ctx.accountSid,
        subaccountNames,
        messagingServiceOf: membership,
        ...(iso ? { isoCountry: iso } : {}),
        ...(price !== undefined
          ? { monthlyPrice: price, priceUnit: table?.priceUnit ?? "USD" }
          : {}),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const main = accountPath(this.ctx.accountSid);
      switch (typeId) {
        case "account": {
          const base = await this.loadAccount(accountId);
          const [thisMonth, lastMonth] = await Promise.all([
            fetchPeriodSpend(this.ctx, this.ctx.accountSid, "ThisMonth", true).catch(
              () => undefined,
            ),
            fetchPeriodSpend(this.ctx, this.ctx.accountSid, "LastMonth", true).catch(
              () => undefined,
            ),
          ]);
          return withSpend(base, thisMonth, lastMonth);
        }
        case "subaccount": {
          const a = await v2010(this.ctx).get(`${accountPath(id)}.json`);
          const spend =
            this.ctx.authMode === "auth-token"
              ? await fetchPeriodSpend(this.ctx, id, "ThisMonth", false).catch(() => undefined)
              : undefined;
          return withSpend(mapSubaccount(accountId, a), spend, undefined);
        }
        case "verify-service": {
          const s = await verify(this.ctx).get(`/v2/Services/${pathEncode(id)}`);
          const r = mapVerifyService(accountId, s);
          const summary = await this.verifySummary(id).catch(() => undefined);
          return summary
            ? {
                ...r,
                resolvedOutputs: {
                  ...r.resolvedOutputs,
                  [VERIFY_SUMMARY_KEY]: JSON.stringify(summary),
                },
              }
            : r;
        }
        case "messaging-service": {
          const [s, membership] = await Promise.all([
            messaging(this.ctx).get(`/v1/Services/${pathEncode(id)}`),
            this.messagingMembership(),
          ]);
          return mapMessagingService(accountId, s, membership.get(`service:${id}`)?.count);
        }
        case "twiml-app":
          return mapApplication(
            accountId,
            await v2010(this.ctx).get(`${main}/Applications/${pathEncode(id)}.json`),
          );
        case "usage-trigger":
          return mapUsageTrigger(
            accountId,
            await v2010(this.ctx).get(`${main}/Usage/Triggers/${pathEncode(id)}.json`),
          );
        case "api-key":
          return mapKey(
            accountId,
            await v2010(this.ctx).get(`${main}/Keys/${pathEncode(id)}.json`),
            this.ctx.username,
          );
        default:
          break;
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === id);
      if (!found) throw new Error(`Twilio plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  private async verifySummary(serviceSid: string): Promise<VerifySummary> {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 3600_000);
    const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
    const res = await verify(this.ctx).get("/v2/Attempts/Summary", {
      query: {
        VerifyServiceSid: serviceSid,
        DateCreatedAfter: iso(start),
        DateCreatedBefore: iso(end),
      },
    });
    return {
      totalAttempts: res.total_attempts ?? 0,
      totalConverted: res.total_converted ?? 0,
      totalUnconverted: res.total_unconverted ?? 0,
      ...(res.conversion_rate_percentage ? { conversionRate: res.conversion_rate_percentage } : {}),
    };
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`Twilio plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs and balance
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r =
        resourceTypeId === "account"
          ? await this.loadAccount(accountId)
          : await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      switch (resourceTypeId) {
        case "account":
          return [
            { label: "Balance", value: money(f["balance"], String(f["currency"] ?? "USD")) || "—" },
            {
              label: "This month",
              value: money(f["monthToDate"], String(f["priceUnit"] ?? "USD")) || "—",
            },
          ];
        case "phone-number":
          return [
            { label: "Type", value: String(f["type"] ?? "—") },
            {
              label: "Monthly",
              value: money(f["monthlyPrice"], String(f["priceUnit"] ?? "USD")) || "—",
            },
          ];
        case "usage-trigger": {
          const p = triggerProgress(f);
          return [
            {
              label: "Of threshold",
              value: p !== undefined ? `${Math.round(p * 100)}%` : "—",
              variant:
                p === undefined
                  ? "default"
                  : p >= 1
                    ? "status-error"
                    : p >= 0.8
                      ? "status-degraded"
                      : "status-healthy",
            },
            { label: "Repeats", value: String(f["recurring"] ?? "—") },
          ];
        }
        case "subaccount":
          return [{ label: "Status", value: String(f["status"] ?? "—") }];
        default:
          return [];
      }
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const range = rangeOrDefault(timeRange);
      if (resourceTypeId === "account") {
        return usageSeries(this.ctx, this.ctx.accountSid, true, range);
      }
      if (resourceTypeId === "subaccount") {
        if (this.ctx.authMode !== "auth-token") return [];
        return usageSeries(this.ctx, externalIdOf(resourceId), false, range).catch((err) => {
          if (isAccessDenied(err)) return [];
          throw err;
        });
      }
      return [];
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const subs = await this.subaccountRefs().catch(() => null);
      return fetchTwilioCostData(this.ctx, range, subs);
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      try {
        const b = await v2010(this.ctx).get(`${accountPath(this.ctx.accountSid)}/Balance.json`);
        const remaining = num(b.balance);
        if (remaining === undefined) return [];
        const currency = (b.currency ?? "USD").toUpperCase();
        return [{ key: currency, label: `Account balance (${currency})`, remaining, currency }];
      } catch (err) {
        if (isAccessDenied(err)) {
          throw new CreditAccessError(
            "This Twilio credential cannot read the account balance. Use the auth token or a Main API key.",
            {
              label: "Manage API keys",
              url: "https://console.twilio.com/us1/account/keys-credentials/api-keys",
            },
          );
        }
        throw err;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const methodOptions = [
        { id: "POST", label: "POST" },
        { id: "GET", label: "GET" },
      ];
      const text = (
        key: string,
        label: string,
        opts: Partial<CreateFieldConfig> = {},
      ): CreateFieldConfig => ({ key, label, kind: "text", required: false, ...opts });
      const toggle = (key: string, label: string, description?: string): CreateFieldConfig => ({
        key,
        label,
        kind: "select",
        required: false,
        defaultValue: "",
        options: [
          { id: "", label: "Twilio default" },
          { id: "true", label: "On" },
          { id: "false", label: "Off" },
        ],
        ...(description ? { description } : {}),
      });
      switch (typeId) {
        case "usage-trigger":
          return { fields: await this.usageTriggerFields(methodOptions) };
        case "subaccount":
          return {
            fields: [
              text("friendlyName", "Name", {
                required: true,
                description: "Up to 64 characters. Needs the auth token or a Main API key.",
              }),
            ],
          };
        case "messaging-service":
          return {
            fields: [
              text("friendlyName", "Name", { required: true, description: "Up to 64 characters." }),
              {
                key: "usecase",
                label: "Use case",
                kind: "select",
                required: false,
                defaultValue: "undeclared",
                options: [
                  "notifications",
                  "marketing",
                  "verification",
                  "discussion",
                  "poll",
                  "undeclared",
                ].map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
              },
              text("inboundRequestUrl", "Inbound webhook URL", {
                placeholder: "https://example.com/sms",
              }),
              text("statusCallback", "Delivery status callback URL"),
              toggle(
                "stickySender",
                "Sticky sender",
                "Keep sending to a recipient from the same number.",
              ),
              toggle("smartEncoding", "Smart encoding", "Keep messages in cheaper GSM-7 segments."),
              toggle("areaCodeGeomatch", "Area code geomatch"),
            ],
          };
        case "verify-service":
          return {
            fields: [
              text("friendlyName", "Name", {
                required: true,
                description: "Shown in the verification message. Up to 30 characters.",
              }),
              {
                key: "codeLength",
                label: "Code length",
                kind: "number",
                required: false,
                defaultValue: "6",
                minValue: 4,
                maxValue: 10,
              },
              toggle("lookupEnabled", "Look up numbers first"),
              toggle("skipSmsToLandlines", "Skip SMS to landlines"),
              toggle("doNotShareWarningEnabled", "Do-not-share warning"),
            ],
          };
        case "twiml-app":
          return {
            fields: [
              text("friendlyName", "Name", { required: true, description: "Up to 64 characters." }),
              text("voiceUrl", "Voice URL", { placeholder: "https://example.com/voice" }),
              {
                key: "voiceMethod",
                label: "Voice method",
                kind: "select",
                required: false,
                defaultValue: "POST",
                options: methodOptions,
              },
              text("smsUrl", "Messaging URL", { placeholder: "https://example.com/sms" }),
              {
                key: "smsMethod",
                label: "Messaging method",
                kind: "select",
                required: false,
                defaultValue: "POST",
                options: methodOptions,
              },
              text("statusCallback", "Call status callback URL"),
            ],
          };
        case "api-key":
          return {
            fields: [
              text("friendlyName", "Name", {
                required: true,
                description:
                  "Creates a Standard API key on the main account. The secret is shown once, in the key's outputs.",
              }),
            ],
          };
        default:
          throw new Error(`Twilio plugin: "${typeId}" cannot be created from Infrawrench`);
      }
    });
  }

  /** The usage-trigger form: the category picker lists what Twilio meters on this account. */
  private async usageTriggerFields(
    methodOptions: Array<{ id: string; label: string }>,
  ): Promise<CreateFieldConfig[]> {
    const records = await v2010(this.ctx)
      .getAll(`${accountPath(this.ctx.accountSid)}/Usage/Records/ThisMonth.json`, "usage_records")
      .catch(() => []);
    const common = new Set(COMMON_TRIGGER_CATEGORIES.map((c) => c.id));
    const rest = records
      .filter((r) => r.category && !common.has(r.category))
      .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? ""))
      .map((r) => ({
        id: r.category ?? "",
        label: r.description ? `${r.description} (${r.category})` : (r.category ?? ""),
        ...(num(r.price)
          ? { description: `This month: ${money(num(r.price), r.price_unit ?? "USD")}` }
          : {}),
      }));
    return [
      {
        key: "usageCategory",
        label: "Usage category",
        kind: "select",
        required: true,
        defaultValue: TOTAL_CATEGORY,
        description:
          "What to watch. Total spend with Price and Monthly makes a monthly budget alert.",
        options: [...COMMON_TRIGGER_CATEGORIES, ...rest],
      },
      {
        key: "triggerBy",
        label: "Measure",
        kind: "select",
        required: true,
        defaultValue: "price",
        options: [
          { id: "price", label: "Price", description: "Money billed, in the account's currency." },
          {
            id: "count",
            label: "Count",
            description: "Number of events: messages, calls, lookups.",
          },
          {
            id: "usage",
            label: "Usage",
            description: "Billable units: minutes for calls, messages for SMS.",
          },
        ],
      },
      {
        key: "triggerValue",
        label: "Threshold",
        kind: "number",
        required: true,
        minValue: 0,
        description: "Fire when the measure reaches this value within the period.",
      },
      {
        key: "recurring",
        label: "Repeats",
        kind: "select",
        required: true,
        defaultValue: "monthly",
        options: [
          { id: "daily", label: "Every day" },
          { id: "monthly", label: "Every month" },
          { id: "yearly", label: "Every year" },
          { id: "", label: "Once (all-time usage)" },
        ],
      },
      {
        key: "callbackUrl",
        label: "Webhook URL",
        kind: "text",
        required: true,
        placeholder: "https://example.com/twilio-usage",
        description:
          "Twilio calls this when the trigger fires. An Infrawrench workflow's webhook URL works, and lets the workflow alert through Slack, Teams or paging.",
      },
      {
        key: "callbackMethod",
        label: "Webhook method",
        kind: "select",
        required: false,
        defaultValue: "POST",
        options: methodOptions,
      },
      {
        key: "friendlyName",
        label: "Name",
        kind: "text",
        required: false,
        description: "Up to 64 characters.",
      },
    ];
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const main = accountPath(this.ctx.accountSid);
      const name = (fields["friendlyName"] ?? "").trim();
      switch (typeId) {
        case "usage-trigger": {
          const value = (fields["triggerValue"] ?? "").trim();
          if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) {
            throw new Error("Twilio plugin: the threshold must be a number of zero or more");
          }
          const callback = (fields["callbackUrl"] ?? "").trim();
          if (!/^https?:\/\//i.test(callback)) {
            throw new Error("Twilio plugin: the webhook URL must start with https:// or http://");
          }
          const recurring = (fields["recurring"] ?? "").trim();
          const t = await v2010(this.ctx).post(`${main}/Usage/Triggers.json`, {
            form: {
              UsageCategory: (fields["usageCategory"] ?? TOTAL_CATEGORY).trim() || TOTAL_CATEGORY,
              TriggerBy: (fields["triggerBy"] ?? "price").trim() || "price",
              TriggerValue: value,
              CallbackUrl: callback,
              CallbackMethod: (fields["callbackMethod"] ?? "POST").trim() || "POST",
              ...(recurring ? { Recurring: recurring } : {}),
              ...(name ? { FriendlyName: name } : {}),
            },
          });
          return mapUsageTrigger(accountId, t);
        }
        case "subaccount":
          return mapSubaccount(
            accountId,
            await v2010(this.ctx).post("/2010-04-01/Accounts.json", {
              form: { FriendlyName: name },
            }),
          );
        case "messaging-service": {
          const s = await messaging(this.ctx).post("/v1/Services", { form: messagingForm(fields) });
          return mapMessagingService(accountId, s, 0);
        }
        case "verify-service":
          return mapVerifyService(
            accountId,
            await verify(this.ctx).post("/v2/Services", { form: verifyForm(fields) }),
          );
        case "twiml-app":
          return mapApplication(
            accountId,
            await v2010(this.ctx).post(`${main}/Applications.json`, { form: appForm(fields) }),
          );
        case "api-key":
          return mapKey(
            accountId,
            await v2010(this.ctx).post(`${main}/Keys.json`, { form: { FriendlyName: name } }),
            this.ctx.username,
          );
        default:
          throw new Error(`Twilio plugin: "${typeId}" cannot be created from Infrawrench`);
      }
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      const main = accountPath(this.ctx.accountSid);
      switch (typeId) {
        case "subaccount": {
          const status = text(fields, "status");
          if (status !== undefined && status !== "active" && status !== "suspended") {
            throw new Error(
              "Twilio plugin: a subaccount's status can be active or suspended; delete it to close it",
            );
          }
          return mapSubaccount(
            accountId,
            await v2010(this.ctx).post(`/2010-04-01/Accounts/${id}.json`, {
              form: { FriendlyName: text(fields, "friendlyName"), Status: status },
            }),
          );
        }
        case "phone-number": {
          const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const owner = String(r.fields["ownerAccountSid"] ?? this.ctx.accountSid);
          await v2010(this.ctx).post(`${accountPath(owner)}/IncomingPhoneNumbers/${id}.json`, {
            form: phoneForm(fields),
          });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "messaging-service":
          await messaging(this.ctx).post(`/v1/Services/${id}`, { form: messagingForm(fields) });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        case "verify-service":
          await verify(this.ctx).post(`/v2/Services/${id}`, { form: verifyForm(fields) });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        case "twiml-app":
          return mapApplication(
            accountId,
            await v2010(this.ctx).post(`${main}/Applications/${id}.json`, {
              form: appForm(fields),
            }),
          );
        case "usage-trigger":
          return mapUsageTrigger(
            accountId,
            await v2010(this.ctx).post(`${main}/Usage/Triggers/${id}.json`, {
              form: usageTriggerForm(fields),
            }),
          );
        case "api-key":
          return mapKey(
            accountId,
            await v2010(this.ctx).post(`${main}/Keys/${id}.json`, {
              form: { FriendlyName: text(fields, "friendlyName") },
            }),
            this.ctx.username,
          );
        default:
          throw new Error(`Twilio plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const raw = externalIdOf(resourceId);
      const id = pathEncode(raw);
      const main = accountPath(this.ctx.accountSid);
      switch (typeId) {
        case "subaccount":
          // Twilio has no DELETE for accounts: closing is permanent and releases its numbers.
          await v2010(this.ctx).post(`/2010-04-01/Accounts/${id}.json`, {
            form: { Status: "closed" },
          });
          return;
        case "phone-number": {
          const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const owner = String(r.fields["ownerAccountSid"] ?? this.ctx.accountSid);
          await v2010(this.ctx).delete(`${accountPath(owner)}/IncomingPhoneNumbers/${id}.json`);
          return;
        }
        case "messaging-service":
          await messaging(this.ctx).delete(`/v1/Services/${id}`);
          return;
        case "verify-service":
          await verify(this.ctx).delete(`/v2/Services/${id}`);
          return;
        case "twiml-app":
          await v2010(this.ctx).delete(`${main}/Applications/${id}.json`);
          return;
        case "usage-trigger":
          await v2010(this.ctx).delete(`${main}/Usage/Triggers/${id}.json`);
          return;
        case "api-key":
          if (raw === this.ctx.username) {
            throw new Error(
              "This is the API key this connection signs in with. Change the account's credentials first, then delete it.",
            );
          }
          await v2010(this.ctx).delete(`${main}/Keys/${id}.json`);
          return;
        default:
          throw new Error(`Twilio plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "subaccount" && (actionId === "suspend" || actionId === "reactivate")) {
        await runPluginEffect(
          this.updateResource(typeId, resourceId, accountId, {
            status: actionId === "suspend" ? "suspended" : "active",
          }),
        );
        return;
      }
      throw new Error(`Twilio plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderTwilioDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderTwilioSidebar(resource);
  }
}

function withSpend(
  r: ResourceInstance,
  thisMonth: PeriodSpend | undefined,
  lastMonth: PeriodSpend | undefined,
): ResourceInstance {
  return {
    ...r,
    resolvedOutputs: {
      ...r.resolvedOutputs,
      ...(thisMonth ? { [SPEND_THIS_MONTH_KEY]: JSON.stringify(thisMonth) } : {}),
      ...(lastMonth ? { [SPEND_LAST_MONTH_KEY]: JSON.stringify(lastMonth) } : {}),
    },
  };
}
