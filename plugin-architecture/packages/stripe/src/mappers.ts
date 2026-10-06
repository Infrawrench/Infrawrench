import type { ResourceInstance } from "@infrawrench/plugin-base";
import { currencyExponent, dashboardUrl, formatMoney, keyMode } from "./api.js";
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

// ------------------------------------------------------------------ wire types

export interface StripeRequirements {
  currently_due?: string[] | null;
  past_due?: string[] | null;
  eventually_due?: string[] | null;
  current_deadline?: number | null;
  disabled_reason?: string | null;
}

export interface StripeAccount {
  id?: string;
  object?: string;
  type?: string;
  email?: string | null;
  country?: string;
  default_currency?: string;
  business_type?: string | null;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  created?: number;
  business_profile?: { name?: string | null; url?: string | null } | null;
  settings?: {
    dashboard?: { display_name?: string | null } | null;
    payments?: { statement_descriptor?: string | null } | null;
    payouts?: {
      schedule?: {
        interval?: string;
        delay_days?: number;
        weekly_anchor?: string;
        monthly_anchor?: number;
      };
    } | null;
  } | null;
  controller?: {
    type?: string;
    is_controller?: boolean;
    requirement_collection?: string;
    losses?: { payments?: string };
    fees?: { payer?: string };
    stripe_dashboard?: { type?: string };
  } | null;
  requirements?: StripeRequirements | null;
}

export interface StripeBalanceAmount {
  amount: number;
  currency: string;
}

export interface StripeBalance {
  available?: StripeBalanceAmount[];
  pending?: StripeBalanceAmount[];
  instant_available?: StripeBalanceAmount[];
  connect_reserved?: StripeBalanceAmount[];
}

export interface StripeWebhookEndpoint {
  id?: string;
  url?: string;
  description?: string | null;
  enabled_events?: string[];
  status?: string;
  api_version?: string | null;
  application?: string | null;
  created?: number;
  secret?: string;
  metadata?: Record<string, string>;
}

export interface StripeEventDestination {
  id?: string;
  name?: string;
  description?: string | null;
  type?: string;
  event_payload?: string;
  enabled_events?: string[];
  events_from?: string[] | null;
  snapshot_api_version?: string | null;
  status?: string;
  status_details?: { disabled?: { reason?: string } | null } | null;
  webhook_endpoint?: { url?: string | null; signing_secret?: string | null } | null;
  amazon_eventbridge?: {
    aws_account_id?: string;
    aws_region?: string;
    aws_event_source_arn?: string;
    aws_event_source_status?: string;
  } | null;
  azure_event_grid?: {
    azure_region?: string;
    azure_resource_group_name?: string;
    azure_subscription_id?: string;
    azure_partner_topic_name?: string;
    azure_partner_topic_status?: string;
  } | null;
  created?: string;
  updated?: string;
}

export interface StripeProduct {
  id?: string;
  name?: string;
  description?: string | null;
  active?: boolean;
  type?: string;
  unit_label?: string | null;
  statement_descriptor?: string | null;
  tax_code?: string | { id?: string } | null;
  url?: string | null;
  default_price?: string | { id?: string } | null;
  created?: number;
  updated?: number;
}

export interface StripePrice {
  id?: string;
  product?: string | { id?: string };
  nickname?: string | null;
  currency?: string;
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  billing_scheme?: string;
  type?: string;
  active?: boolean;
  lookup_key?: string | null;
  tax_behavior?: string | null;
  recurring?: {
    interval?: string;
    interval_count?: number;
    usage_type?: string;
    meter?: string | null;
  } | null;
  custom_unit_amount?: unknown;
  tiers_mode?: string | null;
  created?: number;
}

export interface StripeMeter {
  id?: string;
  display_name?: string;
  event_name?: string;
  status?: string;
  default_aggregation?: { formula?: string };
  customer_mapping?: { event_payload_key?: string; type?: string };
  value_settings?: { event_payload_key?: string };
  event_time_window?: string | null;
  status_transitions?: { deactivated_at?: number | null };
  created?: number;
  updated?: number;
}

export interface StripePayout {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  arrival_date?: number;
  method?: string;
  type?: string;
  automatic?: boolean;
  destination?: string | { id?: string } | null;
  reconciliation_status?: string;
  failure_code?: string | null;
  failure_message?: string | null;
  statement_descriptor?: string | null;
  description?: string | null;
  created?: number;
}

export interface StripeFile {
  id?: string;
  size?: number;
  filename?: string | null;
  url?: string | null;
}

export interface StripeReportRun {
  id?: string;
  report_type?: string;
  status?: string;
  error?: string | null;
  parameters?: { interval_start?: number; interval_end?: number; currency?: string };
  result?: StripeFile | null;
  succeeded_at?: number | null;
  created?: number;
}

export interface StripeSigmaRun {
  id?: string;
  title?: string;
  status?: string;
  sql?: string;
  data_load_time?: number;
  result_available_until?: number;
  file?: StripeFile | null;
  error?: { message?: string } | null;
  created?: number;
}

export interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  pending_webhooks?: number;
  account?: string;
  request?: { id?: string | null } | null;
  data?: { object?: { id?: string; object?: string } };
}

// ---------------------------------------------------------------------- helpers

export function epochToIso(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString();
}

export function idOf(value: string | { id?: string } | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : (value.id ?? "");
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean>,
  createdAt: string,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "stripe",
    resourceTypeId: typeId,
    accountId,
    displayName,
    externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: createdAt || now,
    updatedAt: now,
    ...extra,
  };
}

export function balanceSummary(amounts: StripeBalanceAmount[] | undefined): string {
  return (amounts ?? [])
    .filter((a) => typeof a.amount === "number" && a.currency)
    .map((a) => formatMoney(a.amount, a.currency))
    .join(", ");
}

function accountName(acct: StripeAccount): string {
  return (
    acct.business_profile?.name ||
    acct.settings?.dashboard?.display_name ||
    acct.email ||
    acct.id ||
    "Stripe account"
  );
}

function payoutSchedule(acct: StripeAccount): string {
  const s = acct.settings?.payouts?.schedule;
  if (!s?.interval) return "";
  const parts = [s.interval];
  if (s.interval === "weekly" && s.weekly_anchor) parts.push(`on ${s.weekly_anchor}`);
  if (s.interval === "monthly" && s.monthly_anchor) parts.push(`on day ${s.monthly_anchor}`);
  if (typeof s.delay_days === "number") parts.push(`${s.delay_days}-day delay`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------- mappers

export function mapAccount(
  accountId: string,
  apiKey: string,
  acct: StripeAccount,
  balance: StripeBalance | null,
): ResourceInstance {
  const id = acct.id ?? "";
  const req = acct.requirements ?? {};
  return instance(
    accountId,
    ACCOUNT,
    id,
    accountName(acct),
    {
      accountId: id,
      name: accountName(acct),
      email: acct.email ?? "",
      country: acct.country ?? "",
      defaultCurrency: (acct.default_currency ?? "").toUpperCase(),
      mode: keyMode(apiKey),
      businessType: acct.business_type ?? "",
      chargesEnabled: acct.charges_enabled ?? false,
      payoutsEnabled: acct.payouts_enabled ?? false,
      detailsSubmitted: acct.details_submitted ?? false,
      requirementsDue: req.currently_due?.length ?? 0,
      requirementsPastDue: req.past_due?.length ?? 0,
      requirementsDeadline: epochToIso(req.current_deadline),
      disabledReason: req.disabled_reason ?? "",
      availableBalance: balanceSummary(balance?.available),
      pendingBalance: balanceSummary(balance?.pending),
      payoutSchedule: payoutSchedule(acct),
      statementDescriptor: acct.settings?.payments?.statement_descriptor ?? "",
    },
    epochToIso(acct.created),
    { resolvedOutputs: { dashboardUrl: dashboardUrl(apiKey, "/dashboard") } },
  );
}

export function mapConnectedAccount(
  accountId: string,
  apiKey: string,
  acct: StripeAccount,
): ResourceInstance {
  const id = acct.id ?? "";
  const req = acct.requirements ?? {};
  return instance(
    accountId,
    CONNECTED_ACCOUNT,
    id,
    accountName(acct),
    {
      accountId: id,
      name: accountName(acct),
      email: acct.email ?? "",
      country: acct.country ?? "",
      defaultCurrency: (acct.default_currency ?? "").toUpperCase(),
      type: acct.type ?? "",
      dashboard: acct.controller?.stripe_dashboard?.type ?? "",
      requirementCollection: acct.controller?.requirement_collection ?? "",
      lossesPayer: acct.controller?.losses?.payments ?? "",
      feesPayer: acct.controller?.fees?.payer ?? "",
      chargesEnabled: acct.charges_enabled ?? false,
      payoutsEnabled: acct.payouts_enabled ?? false,
      detailsSubmitted: acct.details_submitted ?? false,
      requirementsDue: req.currently_due?.length ?? 0,
      requirementsPastDue: req.past_due?.length ?? 0,
      requirementsDeadline: epochToIso(req.current_deadline),
      disabledReason: req.disabled_reason ?? "",
      created: epochToIso(acct.created),
    },
    epochToIso(acct.created),
    { resolvedOutputs: { dashboardUrl: dashboardUrl(apiKey, `/connect/accounts/${id}`) } },
  );
}

export function mapWebhookEndpoint(accountId: string, ep: StripeWebhookEndpoint): ResourceInstance {
  const id = ep.id ?? "";
  return instance(
    accountId,
    WEBHOOK_ENDPOINT,
    id,
    ep.description || ep.url || id,
    {
      url: ep.url ?? "",
      description: ep.description ?? "",
      enabledEvents: (ep.enabled_events ?? []).join(", "),
      status: ep.status ?? "",
      apiVersion: ep.api_version ?? "",
      // Stripe exposes no `connect` flag on the object: an endpoint created
      // with `connect=true` carries an `application`.
      connect: Boolean(ep.application),
      application: ep.application ?? "",
      endpointId: id,
      created: epochToIso(ep.created),
    },
    epochToIso(ep.created),
  );
}

export function mapEventDestination(
  accountId: string,
  dest: StripeEventDestination,
): ResourceInstance {
  const id = dest.id ?? "";
  const eb = dest.amazon_eventbridge ?? {};
  const az = dest.azure_event_grid ?? {};
  return instance(
    accountId,
    EVENT_DESTINATION,
    id,
    dest.name || id,
    {
      name: dest.name ?? "",
      description: dest.description ?? "",
      type: dest.type ?? "",
      eventPayload: dest.event_payload ?? "",
      enabledEvents: (dest.enabled_events ?? []).join(", "),
      eventsFrom: (dest.events_from ?? []).join(", "),
      url: dest.webhook_endpoint?.url ?? "",
      snapshotApiVersion: dest.snapshot_api_version ?? "",
      status: dest.status ?? "",
      disabledReason: dest.status_details?.disabled?.reason ?? "",
      awsAccountId: eb.aws_account_id ?? "",
      awsRegion: eb.aws_region ?? "",
      awsEventSourceArn: eb.aws_event_source_arn ?? "",
      awsEventSourceStatus: eb.aws_event_source_status ?? "",
      azureSubscriptionId: az.azure_subscription_id ?? "",
      azureResourceGroup: az.azure_resource_group_name ?? "",
      azureRegion: az.azure_region ?? "",
      azurePartnerTopicName: az.azure_partner_topic_name ?? "",
      azurePartnerTopicStatus: az.azure_partner_topic_status ?? "",
      destinationId: id,
      created: dest.created ?? "",
      updated: dest.updated ?? "",
    },
    dest.created ?? "",
  );
}

export function mapProduct(accountId: string, apiKey: string, p: StripeProduct): ResourceInstance {
  const id = p.id ?? "";
  return instance(
    accountId,
    PRODUCT,
    id,
    p.name || id,
    {
      name: p.name ?? "",
      description: p.description ?? "",
      active: p.active ?? true,
      unitLabel: p.unit_label ?? "",
      statementDescriptor: p.statement_descriptor ?? "",
      taxCode: idOf(p.tax_code),
      url: p.url ?? "",
      defaultPrice: idOf(p.default_price),
      type: p.type ?? "",
      productId: id,
      created: epochToIso(p.created),
      updated: epochToIso(p.updated),
    },
    epochToIso(p.created),
    { resolvedOutputs: { dashboardUrl: dashboardUrl(apiKey, `/products/${id}`) } },
  );
}

/** "19.99 USD / month", "0.002 USD per unit / month (metered)", "Tiered (graduated)". */
export function describePriceAmount(p: StripePrice): string {
  const currency = p.currency ?? "";
  let amount: string;
  if (p.billing_scheme === "tiered") {
    amount = `Tiered${p.tiers_mode ? ` (${p.tiers_mode})` : ""}`;
  } else if (p.custom_unit_amount) {
    amount = "Customer chooses";
  } else if (typeof p.unit_amount === "number") {
    amount = formatMoney(p.unit_amount, currency);
  } else if (p.unit_amount_decimal) {
    // Sub-cent prices only exist as a decimal string of minor units.
    const exp = currencyExponent(currency || "usd");
    amount = `${Number(p.unit_amount_decimal) / Math.pow(10, exp)} ${currency.toUpperCase()}`;
  } else {
    amount = "";
  }
  if (p.recurring?.interval) {
    const n = p.recurring.interval_count ?? 1;
    const per = n > 1 ? `${n} ${p.recurring.interval}s` : p.recurring.interval;
    amount += `${p.recurring.usage_type === "metered" ? " per unit" : ""} / ${per}`;
  }
  return amount.trim();
}

export function mapPrice(
  accountId: string,
  p: StripePrice,
  productResourceId?: string,
): ResourceInstance {
  const id = p.id ?? "";
  const productId = idOf(p.product);
  const amount = describePriceAmount(p);
  const parent = productResourceId ?? (productId ? `${accountId}:${PRODUCT}:${productId}` : "");
  return instance(
    accountId,
    PRICE,
    id,
    p.nickname || p.lookup_key || amount || id,
    {
      nickname: p.nickname ?? "",
      productId,
      currency: (p.currency ?? "").toUpperCase(),
      amount,
      unitAmount: typeof p.unit_amount === "number" ? p.unit_amount : 0,
      billingScheme: p.billing_scheme ?? "",
      type: p.type ?? "",
      interval: p.recurring?.interval ?? "",
      intervalCount: p.recurring?.interval_count ?? 0,
      usageType: p.recurring?.usage_type ?? "",
      meterId: p.recurring?.meter ?? "",
      lookupKey: p.lookup_key ?? "",
      taxBehavior: p.tax_behavior ?? "",
      active: p.active ?? true,
      priceId: id,
      created: epochToIso(p.created),
    },
    epochToIso(p.created),
    parent ? { parentResourceId: parent } : {},
  );
}

export function mapMeter(accountId: string, m: StripeMeter): ResourceInstance {
  const id = m.id ?? "";
  return instance(
    accountId,
    METER,
    id,
    m.display_name || m.event_name || id,
    {
      displayName: m.display_name ?? "",
      eventName: m.event_name ?? "",
      aggregation: m.default_aggregation?.formula ?? "",
      customerPayloadKey: m.customer_mapping?.event_payload_key ?? "",
      valuePayloadKey: m.value_settings?.event_payload_key ?? "",
      eventTimeWindow: m.event_time_window ?? "",
      status: m.status ?? "",
      deactivatedAt: epochToIso(m.status_transitions?.deactivated_at),
      meterId: id,
      created: epochToIso(m.created),
      updated: epochToIso(m.updated),
    },
    epochToIso(m.created),
  );
}

export function mapPayout(accountId: string, p: StripePayout): ResourceInstance {
  const id = p.id ?? "";
  const currency = p.currency ?? "";
  const amount = typeof p.amount === "number" ? formatMoney(p.amount, currency) : "";
  const arrival = epochToIso(p.arrival_date);
  return instance(
    accountId,
    PAYOUT,
    id,
    [amount, arrival.slice(0, 10)].filter(Boolean).join(" · ") || id,
    {
      payoutId: id,
      amount,
      currency: currency.toUpperCase(),
      status: p.status ?? "",
      arrivalDate: arrival,
      method: p.method ?? "",
      type: p.type ?? "",
      automatic: p.automatic ?? false,
      destination: idOf(p.destination),
      reconciliationStatus: p.reconciliation_status ?? "",
      failureCode: p.failure_code ?? "",
      failureMessage: p.failure_message ?? "",
      statementDescriptor: p.statement_descriptor ?? "",
      description: p.description ?? "",
      created: epochToIso(p.created),
    },
    epochToIso(p.created),
  );
}

export function mapReportRun(accountId: string, r: StripeReportRun): ResourceInstance {
  const id = r.id ?? "";
  const from = epochToIso(r.parameters?.interval_start);
  const to = epochToIso(r.parameters?.interval_end);
  const range = from && to ? ` (${from.slice(0, 10)} to ${to.slice(0, 10)})` : "";
  return instance(
    accountId,
    REPORT_RUN,
    id,
    `${r.report_type ?? id}${range}`,
    {
      reportType: r.report_type ?? "",
      status: r.status ?? "",
      intervalStart: from,
      intervalEnd: to,
      currency: (r.parameters?.currency ?? "").toUpperCase(),
      fileId: r.result?.id ?? "",
      fileSize: r.result?.size ?? 0,
      error: r.error ?? "",
      succeededAt: epochToIso(r.succeeded_at),
      reportRunId: id,
      created: epochToIso(r.created),
    },
    epochToIso(r.created),
  );
}

export function mapSigmaRun(accountId: string, r: StripeSigmaRun): ResourceInstance {
  const id = r.id ?? "";
  return instance(
    accountId,
    SIGMA_RUN,
    id,
    r.title || id,
    {
      title: r.title ?? "",
      status: r.status ?? "",
      sql: r.sql ?? "",
      dataLoadTime: epochToIso(r.data_load_time),
      resultAvailableUntil: epochToIso(r.result_available_until),
      fileId: r.file?.id ?? "",
      fileSize: r.file?.size ?? 0,
      error: r.error?.message ?? "",
      runId: id,
      created: epochToIso(r.created),
    },
    epochToIso(r.created),
  );
}
