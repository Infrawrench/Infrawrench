import type { ResourceInstance } from "@infrawrench/plugin-base";
import { currencyExponent, dashboardUrl, formatMoney, keyMode } from "./api.js";
import type { components } from "./api-types.gen.js";
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

type Schemas = components["schemas"];

export type StripeAccount = Schemas["account"];
export type StripeBalanceAmount = Pick<Schemas["balance_amount"], "amount" | "currency">;
export type StripeBalance = Schemas["balance"];
export type StripeWebhookEndpoint = Schemas["webhook_endpoint"];
export type StripeEventDestination = Schemas["v2.core.event_destination"];
export type StripeProduct = Schemas["product"];
export type StripePrice = Schemas["price"];
export type StripeMeter = Schemas["billing.meter"];
export type StripePayout = Schemas["payout"];
export type StripeReportRun = Schemas["reporting.report_run"];
export type StripeSigmaRun = Schemas["scheduled_query_run"];
export type StripeEvent = Schemas["event"];

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
  const req: Partial<NonNullable<StripeAccount["requirements"]>> = acct.requirements ?? {};
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
  const req: Partial<NonNullable<StripeAccount["requirements"]>> = acct.requirements ?? {};
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

/**
 * A destination's AWS region. The document only takes `aws_region` on create and
 * never returns it, so the source of truth is the region segment of the ARN Stripe
 * returns; a stated region is still read first in case a later version returns it.
 */
function eventBridgeRegion(statedRegion: string | undefined, arn: string | undefined): string {
  return statedRegion || (arn?.match(/^arn:[^:]+:[^:]+:([^:]+):/)?.[1] ?? "");
}

export function mapEventDestination(
  accountId: string,
  dest: StripeEventDestination,
): ResourceInstance {
  const id = dest.id ?? "";
  const eb: Partial<NonNullable<StripeEventDestination["amazon_eventbridge"]>> & {
    aws_region?: string;
  } = dest.amazon_eventbridge ?? {};
  const az: Partial<NonNullable<StripeEventDestination["azure_event_grid"]>> =
    dest.azure_event_grid ?? {};
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
      awsRegion: eventBridgeRegion(eb.aws_region, eb.aws_event_source_arn),
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
