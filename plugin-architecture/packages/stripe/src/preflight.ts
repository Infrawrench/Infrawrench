import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightDeclaration,
} from "@infrawrench/plugin-base";
import type { StripeApi } from "./api.js";

/**
 * Credential preflight for restricted keys (`rk_…`). A restricted key can be
 * given None, Read or Write per resource in the Dashboard
 * (https://docs.stripe.com/keys/restricted-api-keys); a request outside its
 * permissions answers 403 with a message naming what to add. A secret key
 * (`sk_…`) passes every check.
 *
 * Each capability is probed with one read, `limit=1` on the lists. Write
 * permissions are not probed (that would mean writing): they are listed so the
 * generated template asks for them.
 */
export interface StripePreflightCapability extends PreflightCapability {
  /** One cheap read. Answers the account's id if that is what it read. */
  probe: (api: StripeApi) => Promise<string | undefined>;
  /** The account may simply not have this product; a 404/400 is not a failure. */
  optionalFeature?: boolean;
}

const perm = (id: string, label: string) => ({ id, label });

/** A probe that only cares whether the read is allowed. */
const reads =
  (read: (api: StripeApi) => Promise<object | undefined>) =>
  async (api: StripeApi): Promise<undefined> => {
    await read(api);
  };

export const PREFLIGHT_CAPABILITIES: StripePreflightCapability[] = [
  {
    id: "account",
    label: "Account",
    description: "Read the account's details, capabilities and verification requirements.",
    requiredPermissions: [perm("account:read", "Account: Read")],
    probe: async (api) => (await api.get("/v1/account"))?.id,
    essential: true,
  },
  {
    id: "balance",
    label: "Balance",
    description: "Show available and pending balance.",
    requiredPermissions: [perm("balance:read", "Balance: Read")],
    probe: reads((api) => api.get("/v1/balance")),
  },
  {
    id: "fees",
    product: "costs",
    label: "Stripe fees (cost)",
    description: "Read balance transactions to report Stripe's fees as cost, and volume metrics.",
    requiredPermissions: [perm("balance_transactions:read", "Balance Transaction Sources: Read")],
    probe: reads((api) => api.get("/v1/balance_transactions", { query: { limit: 1 } })),
  },
  {
    id: "webhooks",
    label: "Webhook endpoints",
    description: "List, create, edit, disable and delete webhook endpoints.",
    requiredPermissions: [perm("webhook_endpoints:write", "Webhook Endpoints: Write")],
    probe: reads((api) => api.get("/v1/webhook_endpoints", { query: { limit: 1 } })),
  },
  {
    id: "event-destinations",
    label: "Event destinations",
    description: "List and manage v2 event destinations (webhooks, EventBridge, Event Grid).",
    requiredPermissions: [perm("event_destinations:write", "Event Destinations: Write")],
    probe: reads((api) => api.get("/v2/core/event_destinations", { query: { limit: 1 } })),
  },
  {
    id: "events",
    label: "Events",
    description: "Show the event stream and failing webhook deliveries.",
    requiredPermissions: [perm("events:read", "Events: Read")],
    probe: reads((api) => api.get("/v1/events", { query: { limit: 1 } })),
  },
  {
    id: "products",
    label: "Products and prices",
    description: "List, create, edit and archive products and prices.",
    requiredPermissions: [
      perm("products:write", "Products: Write"),
      perm("prices:write", "Prices: Write"),
    ],
    probe: reads((api) => api.get("/v1/products", { query: { limit: 1 } })),
  },
  {
    id: "meters",
    label: "Billing meters",
    description: "List, create and deactivate billing meters, and chart their usage.",
    requiredPermissions: [perm("billing_meters:write", "Billing Meters: Write")],
    probe: reads((api) => api.get("/v1/billing/meters", { query: { limit: 1 } })),
  },
  {
    id: "subscriptions",
    label: "Subscriptions overview",
    description: "Count subscriptions by status and compute monthly recurring revenue.",
    requiredPermissions: [perm("subscriptions:read", "Subscriptions: Read")],
    probe: reads((api) => api.get("/v1/subscriptions", { query: { limit: 1 } })),
  },
  {
    id: "payouts",
    label: "Payouts",
    description: "List payouts and cancel a pending manual one.",
    requiredPermissions: [perm("payouts:write", "Payouts: Write")],
    probe: reads((api) => api.get("/v1/payouts", { query: { limit: 1 } })),
  },
  {
    id: "connect",
    label: "Connected accounts",
    description: "List, reject and delete Connect accounts. Platforms only.",
    requiredPermissions: [perm("connect_accounts:write", "Connect Accounts: Write")],
    probe: reads((api) => api.get("/v1/accounts", { query: { limit: 1 } })),
    optionalFeature: true,
  },
  {
    id: "reporting",
    label: "Financial reports",
    description: "List and start Reporting API report runs.",
    requiredPermissions: [
      perm("report_runs:write", "Report Runs and Report Types: Write"),
      perm("files:read", "Files: Read"),
    ],
    probe: reads((api) => api.get("/v1/reporting/report_runs", { query: { limit: 1 } })),
    optionalFeature: true,
  },
  {
    id: "sigma",
    label: "Sigma scheduled queries",
    description: "List scheduled Sigma query runs. Needs Stripe Sigma.",
    requiredPermissions: [perm("sigma:read", "Sigma Scheduled Query Runs: Read")],
    probe: reads((api) => api.get("/v1/sigma/scheduled_query_runs", { query: { limit: 1 } })),
    optionalFeature: true,
  },
];

export const preflight: PreflightDeclaration = {
  capabilities: PREFLIGHT_CAPABILITIES.map(
    ({ probe: _probe, optionalFeature: _optional, ...cap }) => cap,
  ),
  templateFormat: { label: "Restricted key permissions", language: "text" },
};

/** The permissions to tick when creating a restricted key in the Dashboard. */
export function policyTemplate(capabilityIds: string[]): PolicyTemplate {
  const chosen = PREFLIGHT_CAPABILITIES.filter(
    (cap) => capabilityIds.length === 0 || capabilityIds.includes(cap.id),
  );
  const lines = new Set<string>();
  for (const cap of chosen) for (const p of cap.requiredPermissions) lines.add(p.label);
  return {
    formatLabel: "Restricted key permissions",
    language: "text",
    document: [...lines].join("\n"),
    instructions:
      "In the Stripe Dashboard open Developers, API keys, Create restricted key. Set each resource below to the permission shown and leave everything else at None. Write includes Read.",
    helpLink: {
      label: "Restricted API keys",
      url: "https://docs.stripe.com/keys/restricted-api-keys",
    },
  };
}
