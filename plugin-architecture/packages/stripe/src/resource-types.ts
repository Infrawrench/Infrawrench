import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Stripe resource types. Field names follow the API reference
 * (https://docs.stripe.com/api, version 2026-09-30.endive).
 *
 * Ids are prefixed `stripe-` because several are generic words (account,
 * product, price) that other plugins also use.
 */

export const ACCOUNT = "stripe-account";
export const CONNECTED_ACCOUNT = "stripe-connected-account";
export const WEBHOOK_ENDPOINT = "stripe-webhook-endpoint";
export const EVENT_DESTINATION = "stripe-event-destination";
export const PRODUCT = "stripe-product";
export const PRICE = "stripe-price";
export const METER = "stripe-meter";
export const PAYOUT = "stripe-payout";
export const REPORT_RUN = "stripe-report-run";
export const SIGMA_RUN = "stripe-sigma-query-run";

const ro = { required: false, editable: false } as const;

export const AccountResourceType = rt({
  name: "Account",
  id: ACCOUNT,
  description:
    "The Stripe account the API key belongs to: country, currency, payouts and charges state, outstanding verification requirements, balance by currency, a subscriptions overview, failing webhook deliveries, Stripe fees and payment volume per day, and the event stream as logs.",
  fields: [
    f("accountId", "Account ID", ro),
    f("name", "Name", ro),
    f("email", "Email", ro),
    f("country", "Country", ro),
    f("defaultCurrency", "Default Currency", ro),
    f("mode", "Mode", ro),
    f("businessType", "Business Type", ro),
    f("chargesEnabled", "Charges Enabled", { ...ro, kind: "boolean" }),
    f("payoutsEnabled", "Payouts Enabled", { ...ro, kind: "boolean" }),
    f("detailsSubmitted", "Details Submitted", { ...ro, kind: "boolean" }),
    f("requirementsDue", "Requirements Due", { ...ro, kind: "number" }),
    f("requirementsPastDue", "Requirements Past Due", { ...ro, kind: "number" }),
    f("requirementsDeadline", "Requirements Deadline", ro),
    f("disabledReason", "Disabled Reason", ro),
    f("availableBalance", "Available Balance", ro),
    f("pendingBalance", "Pending Balance", ro),
    f("payoutSchedule", "Payout Schedule", ro),
    f("statementDescriptor", "Statement Descriptor", ro),
  ],
  outputs: [
    o("accountId", "Account ID"),
    o("dashboardUrl", "Dashboard URL"),
    o("apiVersion", "Pinned API Version"),
  ],
  expiryFields: [
    {
      fieldKey: "requirementsDeadline",
      from: "expiry",
      kind: "other",
      label: "Verification information due",
    },
  ],
  accountRoot: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

export const ConnectedAccountResourceType = rt({
  name: "Connected Account",
  id: CONNECTED_ACCOUNT,
  description:
    "A Connect account on your platform: who controls its dashboard and requirement collection, whether it can take charges and receive payouts, and what verification information is due and by when. Platforms only; other accounts list none.",
  fields: [
    f("accountId", "Account ID", ro),
    f("name", "Name", ro),
    f("email", "Email", ro),
    f("country", "Country", ro),
    f("defaultCurrency", "Default Currency", ro),
    f("type", "Type", ro),
    f("dashboard", "Dashboard Access", ro),
    f("requirementCollection", "Requirement Collection", ro),
    f("lossesPayer", "Losses Liability", ro),
    f("feesPayer", "Fees Payer", ro),
    f("chargesEnabled", "Charges Enabled", { ...ro, kind: "boolean" }),
    f("payoutsEnabled", "Payouts Enabled", { ...ro, kind: "boolean" }),
    f("detailsSubmitted", "Details Submitted", { ...ro, kind: "boolean" }),
    f("requirementsDue", "Requirements Due", { ...ro, kind: "number" }),
    f("requirementsPastDue", "Requirements Past Due", { ...ro, kind: "number" }),
    f("requirementsDeadline", "Requirements Deadline", ro),
    f("disabledReason", "Disabled Reason", ro),
    f("created", "Created", ro),
  ],
  outputs: [o("accountId", "Account ID"), o("dashboardUrl", "Dashboard URL")],
  expiryFields: [
    {
      fieldKey: "requirementsDeadline",
      from: "expiry",
      kind: "other",
      label: "Verification information due",
    },
  ],
  supportsDelete: true,
  iconKey: "users",
});

export const WebhookEndpointResourceType = rt({
  name: "Webhook Endpoint",
  id: WEBHOOK_ENDPOINT,
  description:
    "A URL Stripe posts events to. Create one with an event picker, change its URL, description and events, enable or disable it, or delete it. The signing secret is kept as a sensitive output when the endpoint is created here, because Stripe only returns it once.",
  fields: [
    f("url", "URL", { description: "HTTPS URL Stripe delivers events to." }),
    f("description", "Description", { required: false }),
    f("enabledEvents", "Enabled Events", {
      description:
        "Comma-separated event types, for example `checkout.session.completed, invoice.paid`. `*` subscribes to every event.",
    }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
      description: "Disabled endpoints keep their configuration but receive nothing.",
    }),
    f("apiVersion", "API Version", ro),
    f("connect", "Connected Accounts' Events", { ...ro, kind: "boolean" }),
    f("application", "Connect Application", ro),
    f("endpointId", "Endpoint ID", ro),
    f("created", "Created", ro),
  ],
  outputs: [
    o("endpointId", "Endpoint ID"),
    o("url", "URL"),
    o("signingSecret", "Signing Secret", {
      sensitive: true,
      description:
        "The whsec_… secret for verifying signatures. Only available for endpoints created from Infrawrench; Stripe never returns it again.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  secretExportTemplates: [
    {
      id: "stripe-webhook-secret",
      displayName: "Webhook signing secret",
      entries: [{ envKey: "STRIPE_WEBHOOK_SECRET", outputKey: "signingSecret" }],
    },
  ],
  iconKey: "webhook",
});

export const EventDestinationResourceType = rt({
  name: "Event Destination",
  id: EVENT_DESTINATION,
  description:
    "A v2 event destination: a webhook endpoint, Amazon EventBridge source or Azure Event Grid topic receiving snapshot or thin events, from this account or the accounts it manages. Create, rename, change events, enable, disable, ping or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Type", ro),
    f("eventPayload", "Payload", ro),
    f("enabledEvents", "Enabled Events", {
      description:
        "Comma-separated event types, for example `v1.billing.meter.error_report_triggered`.",
    }),
    f("eventsFrom", "Events From", ro),
    f("url", "Webhook URL", {
      required: false,
      description: "Only for webhook destinations.",
    }),
    f("snapshotApiVersion", "Snapshot API Version", ro),
    f("status", "Status", ro),
    f("disabledReason", "Disabled Reason", ro),
    f("awsAccountId", "AWS Account", ro),
    f("awsRegion", "AWS Region", ro),
    f("awsEventSourceArn", "EventBridge Event Source", ro),
    f("awsEventSourceStatus", "EventBridge Source Status", ro),
    f("azureSubscriptionId", "Azure Subscription", ro),
    f("azureResourceGroup", "Azure Resource Group", ro),
    f("azureRegion", "Azure Region", ro),
    f("azurePartnerTopicName", "Azure Partner Topic", ro),
    f("azurePartnerTopicStatus", "Azure Partner Topic Status", ro),
    f("destinationId", "Destination ID", ro),
    f("created", "Created", ro),
    f("updated", "Updated", ro),
  ],
  outputs: [
    o("destinationId", "Destination ID"),
    o("url", "Webhook URL"),
    o("awsEventSourceArn", "EventBridge Event Source ARN"),
    o("signingSecret", "Signing Secret", {
      sensitive: true,
      description:
        "The webhook signing secret. Only available for webhook destinations created from Infrawrench; Stripe never returns it again.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  secretExportTemplates: [
    {
      id: "stripe-webhook-secret",
      displayName: "Webhook signing secret",
      entries: [{ envKey: "STRIPE_WEBHOOK_SECRET", outputKey: "signingSecret" }],
    },
  ],
  iconKey: "webhook",
});

export const ProductResourceType = rt({
  name: "Product",
  id: PRODUCT,
  description:
    "Something you sell. Create, edit, archive and unarchive it; its prices are listed underneath. A product that has prices cannot be deleted, only archived.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("unitLabel", "Unit Label", {
      required: false,
      description: "Shown on receipts and invoices, for example `seat` or `GB`.",
    }),
    f("statementDescriptor", "Statement Descriptor", {
      required: false,
      description: "Up to 22 characters shown on card statements for subscription payments.",
    }),
    f("taxCode", "Tax Code", {
      required: false,
      description:
        "A Stripe tax code id, for example `txcd_10000000` (general electronically supplied services).",
    }),
    f("url", "URL", { required: false }),
    f("defaultPrice", "Default Price", ro),
    f("type", "Type", ro),
    f("productId", "Product ID", ro),
    f("created", "Created", ro),
    f("updated", "Updated", ro),
  ],
  outputs: [o("productId", "Product ID"), o("dashboardUrl", "Dashboard URL")],
  dependsOn: [{ fieldKey: "defaultPrice", targetTypeId: PRICE, label: "sells at" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "app",
});

export const PriceResourceType = rt({
  name: "Price",
  id: PRICE,
  parentTypeId: PRODUCT,
  showInSidebar: true,
  description:
    "How much and how often a product costs: one-time, recurring per seat, or metered against a billing meter. Create one with a product and meter picker; rename it, change its lookup key or archive it. Amounts are fixed once created.",
  fields: [
    f("nickname", "Nickname", { required: false }),
    f("productId", "Product", ro),
    f("currency", "Currency", ro),
    f("amount", "Amount", ro),
    f("unitAmount", "Unit Amount (minor units)", { ...ro, kind: "number" }),
    f("billingScheme", "Billing Scheme", ro),
    f("type", "Type", ro),
    f("interval", "Interval", ro),
    f("intervalCount", "Interval Count", { ...ro, kind: "number" }),
    f("usageType", "Usage Type", ro),
    f("meterId", "Meter", ro),
    f("lookupKey", "Lookup Key", {
      required: false,
      description: "A stable name your code can fetch this price by, instead of its id.",
    }),
    f("taxBehavior", "Tax Behavior", {
      kind: "enum",
      enumValues: ["unspecified", "inclusive", "exclusive"],
      required: false,
      description: "Can only be set once: after inclusive or exclusive it cannot change.",
    }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("priceId", "Price ID", ro),
    f("created", "Created", ro),
  ],
  outputs: [o("priceId", "Price ID"), o("lookupKey", "Lookup Key")],
  dependsOn: [
    { fieldKey: "productId", targetTypeId: PRODUCT, label: "prices" },
    { fieldKey: "meterId", targetTypeId: METER, label: "bills usage from" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "tag",
});

export const MeterResourceType = rt({
  name: "Billing Meter",
  id: METER,
  description:
    "A usage meter for usage-based billing: which event name it counts, how it aggregates (sum, count or last) and which payload keys carry the customer and the value. Charts usage per day for the customers subscribed to its prices. Rename, deactivate or reactivate it.",
  fields: [
    f("displayName", "Display Name"),
    f("eventName", "Event Name", ro),
    f("aggregation", "Aggregation", ro),
    f("customerPayloadKey", "Customer Payload Key", ro),
    f("valuePayloadKey", "Value Payload Key", ro),
    f("eventTimeWindow", "Pre-aggregation Window", ro),
    f("status", "Status", ro),
    f("deactivatedAt", "Deactivated", ro),
    f("meterId", "Meter ID", ro),
    f("created", "Created", ro),
    f("updated", "Updated", ro),
  ],
  outputs: [o("meterId", "Meter ID"), o("eventName", "Event Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "dashboard",
});

export const PayoutResourceType = rt({
  name: "Payout",
  id: PAYOUT,
  description:
    "A transfer of your Stripe balance to your bank account or debit card. The 100 most recent are listed with status, arrival date and failure reason; a pending manual payout can be cancelled.",
  fields: [
    f("payoutId", "Payout ID", ro),
    f("amount", "Amount", ro),
    f("currency", "Currency", ro),
    f("status", "Status", ro),
    f("arrivalDate", "Arrival Date", ro),
    f("method", "Method", ro),
    f("type", "Destination Type", ro),
    f("automatic", "Automatic", { ...ro, kind: "boolean" }),
    f("destination", "Destination", ro),
    f("reconciliationStatus", "Reconciliation", ro),
    f("failureCode", "Failure Code", ro),
    f("failureMessage", "Failure Message", ro),
    f("statementDescriptor", "Statement Descriptor", ro),
    f("description", "Description", ro),
    f("created", "Created", ro),
  ],
  outputs: [o("payoutId", "Payout ID")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "stream",
});

export const ReportRunResourceType = rt({
  name: "Report Run",
  id: REPORT_RUN,
  description:
    "A financial report run from the Reporting API (balance summaries, itemized balance changes, payout reconciliation, fees). Start one with a report type picker and a date range; the 100 most recent runs are listed.",
  fields: [
    f("reportType", "Report Type", ro),
    f("status", "Status", ro),
    f("intervalStart", "From", ro),
    f("intervalEnd", "To", ro),
    f("currency", "Currency", ro),
    f("fileId", "Result File", ro),
    f("fileSize", "Result Size (bytes)", { ...ro, kind: "number" }),
    f("error", "Error", ro),
    f("succeededAt", "Succeeded", ro),
    f("reportRunId", "Report Run ID", ro),
    f("created", "Created", ro),
  ],
  outputs: [o("reportRunId", "Report Run ID"), o("fileId", "Result File ID")],
  supportsCreate: true,
  supportsDelete: false,
  pinnable: false,
  iconKey: "file",
});

export const SigmaRunResourceType = rt({
  name: "Sigma Query Run",
  id: SIGMA_RUN,
  description:
    "A run of a scheduled Stripe Sigma query: its SQL, status, data freshness and result file. Accounts without Sigma list none.",
  fields: [
    f("title", "Title", ro),
    f("status", "Status", ro),
    f("sql", "SQL", ro),
    f("dataLoadTime", "Data As Of", ro),
    f("resultAvailableUntil", "Result Available Until", ro),
    f("fileId", "Result File", ro),
    f("fileSize", "Result Size (bytes)", { ...ro, kind: "number" }),
    f("error", "Error", ro),
    f("runId", "Run ID", ro),
    f("created", "Created", ro),
  ],
  outputs: [o("runId", "Run ID"), o("fileId", "Result File ID")],
  supportsDelete: false,
  pinnable: false,
  iconKey: "database",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  ConnectedAccountResourceType,
  WebhookEndpointResourceType,
  EventDestinationResourceType,
  ProductResourceType,
  PriceResourceType,
  MeterResourceType,
  PayoutResourceType,
  ReportRunResourceType,
  SigmaRunResourceType,
];
