import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { STRIPE_API_VERSION, formatMoney } from "./api.js";
import {
  ACCOUNT,
  CONNECTED_ACCOUNT,
  EVENT_DESTINATION,
  METER,
  PAYOUT,
  PRICE,
  PRODUCT,
  REPORT_RUN,
  RESOURCE_TYPES,
  SIGMA_RUN,
  WEBHOOK_ENDPOINT,
} from "./resource-types.js";

/** Window the Metrics tab opens on. */
export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------- enrichment stash

/** Shapes `enrichDetail` stashes in `resolvedOutputs` for the synchronous renderer. */
export interface SubscriptionOverview {
  /** Subscriptions read (capped). */
  total: number;
  truncated: boolean;
  byStatus: Record<string, number>;
  /** Monthly recurring revenue of active, trialing and past-due subscriptions, minor units per currency. */
  mrrMinor: Record<string, number>;
  /** Subscriptions ending at period end. */
  cancelingAtPeriodEnd: number;
}

export interface FailedEventSummary {
  id: string;
  type: string;
  created: string;
  pendingWebhooks: number;
}

export interface BalanceStash {
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
  instantAvailable: Array<{ amount: number; currency: string }>;
  connectReserved: Array<{ amount: number; currency: string }>;
}

export const STASH = {
  subscriptions: "__subscriptions__",
  failedEvents: "__failedEvents__",
  balance: "__balance__",
  enrichError: "__enrichError__",
} as const;

function parseStash<T>(resource: ResourceInstance, key: string): T | undefined {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------- helpers

const s = (resource: ResourceInstance, key: string): string => {
  const v = resource.fields[key];
  return v === undefined || v === null ? "" : String(v);
};
const dash = (value: string): string => value || "—";
const yesNo = (value: unknown): string => (value === true ? "Yes" : value === false ? "No" : "—");

function kv(items: Array<[string, string]>, copyable: string[] = []): SchemaNode {
  return {
    kind: "key-value-list",
    items: items.map(([key, value]): KVItem => ({
      key,
      value: dash(value),
      ...(copyable.includes(key) && value ? { copyable: true } : {}),
    })),
  };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

const refresh: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.destructive ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function dot(status: ResourceStatus, label?: string): StatusDotNode {
  return { kind: "status-dot", status, ...(label ? { label } : {}) };
}

// ------------------------------------------------------------------- statuses

/** Why an account (own or connected) needs attention, or nothing. */
function accountIssue(resource: ResourceInstance): StatusDotNode {
  const disabled = s(resource, "disabledReason");
  const pastDue = Number(resource.fields["requirementsPastDue"] ?? 0);
  const due = Number(resource.fields["requirementsDue"] ?? 0);
  if (disabled) return dot("error", `Disabled: ${disabled.replace(/[._]/g, " ")}`);
  if (pastDue > 0) return dot("error", `${pastDue} verification requirement(s) past due`);
  if (resource.fields["chargesEnabled"] === false)
    return dot("degraded", "Charges are not enabled");
  if (resource.fields["payoutsEnabled"] === false)
    return dot("degraded", "Payouts are not enabled");
  if (due > 0) return dot("degraded", `${due} verification requirement(s) due`);
  return dot("healthy", "Active");
}

export function statusFor(resource: ResourceInstance): StatusDotNode {
  const status = s(resource, "status");
  switch (resource.resourceTypeId) {
    case ACCOUNT:
    case CONNECTED_ACCOUNT:
      return accountIssue(resource);
    case WEBHOOK_ENDPOINT:
      return status === "disabled"
        ? dot("degraded", "Disabled: receives no events")
        : dot("healthy", "Enabled");
    case EVENT_DESTINATION: {
      if (status === "disabled") {
        const reason = s(resource, "disabledReason");
        if (reason && reason !== "user") {
          return dot("error", `Disabled by Stripe: ${reason.replace(/_/g, " ")}`);
        }
        return dot("degraded", "Disabled: receives no events");
      }
      const source = s(resource, "awsEventSourceStatus") || s(resource, "azurePartnerTopicStatus");
      if (source && source !== "active") {
        return dot(
          "degraded",
          `Event source is ${source.replace(/_/g, " ")}; activate it in your cloud console`,
        );
      }
      return dot("healthy", "Enabled");
    }
    case PRODUCT:
    case PRICE:
      return resource.fields["active"] === false
        ? dot("info", "Archived")
        : dot("healthy", "Active");
    case METER:
      return status === "inactive" ? dot("info", "Deactivated") : dot("healthy", "Active");
    case PAYOUT:
      switch (status) {
        case "paid":
          return dot("healthy", "Paid");
        case "failed": {
          const why = s(resource, "failureMessage") || s(resource, "failureCode");
          return dot("error", why ? `Failed: ${why}` : "Payout failed");
        }
        case "canceled":
          return dot("info", "Canceled");
        default:
          return dot("provisioning", status.replace(/_/g, " ") || "Pending");
      }
    case REPORT_RUN:
    case SIGMA_RUN:
      if (status === "succeeded" || status === "completed") return dot("healthy", "Succeeded");
      if (status === "failed") {
        const why = s(resource, "error");
        return dot("error", why ? `Failed: ${why}` : "Run failed");
      }
      if (status === "timed_out") return dot("error", "Timed out");
      if (status === "canceled") return dot("info", "Canceled");
      return dot("provisioning", status || "Pending");
    default:
      return dot("unknown");
  }
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return { id: resource.id, label: resource.displayName, status: statusFor(resource) };
}

// --------------------------------------------------------------------- details

export function renderDetail(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const base = (() => {
    switch (resource.resourceTypeId) {
      case ACCOUNT:
        return renderAccount(resource, dashboard);
      case CONNECTED_ACCOUNT:
        return renderConnectedAccount(resource);
      case WEBHOOK_ENDPOINT:
        return renderWebhookEndpoint(resource, dashboard);
      case EVENT_DESTINATION:
        return renderEventDestination(resource, dashboard);
      case PRODUCT:
        return renderProduct(resource);
      case PRICE:
        return renderPrice(resource, dashboard);
      case METER:
        return renderMeter(resource, dashboard);
      case PAYOUT:
        return renderPayout(resource, dashboard);
      case REPORT_RUN:
        return renderReportRun(resource, dashboard);
      case SIGMA_RUN:
        return renderSigmaRun(resource, dashboard);
      default:
        return {
          title: resource.displayName,
          subtitle: "Stripe",
          sections: [section("Details", [kv([["ID", resource.externalId ?? ""]])])],
        };
    }
  })();
  return withMetricsCapability(
    base,
    RESOURCE_TYPES,
    resource.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

function money(list: Array<{ amount: number; currency: string }> | undefined): string {
  return (list ?? []).map((a) => formatMoney(a.amount, a.currency)).join(", ");
}

function renderAccount(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const balance = parseStash<BalanceStash>(resource, STASH.balance);
  const subs = parseStash<SubscriptionOverview>(resource, STASH.subscriptions);
  const failed = parseStash<FailedEventSummary[]>(resource, STASH.failedEvents);
  const enrichError = resource.resolvedOutputs[STASH.enrichError];
  const mode = s(resource, "mode");

  const sections: SectionNode[] = [
    section("Account", [
      kv(
        [
          ["Account ID", s(resource, "accountId")],
          ["Name", s(resource, "name")],
          ["Email", s(resource, "email")],
          ["Country", s(resource, "country")],
          ["Default Currency", s(resource, "defaultCurrency")],
          ["Business Type", s(resource, "businessType")],
          ["Mode", mode === "live" ? "Live" : "Test / sandbox"],
          ["Statement Descriptor", s(resource, "statementDescriptor")],
          ["Pinned API Version", STRIPE_API_VERSION],
        ],
        ["Account ID"],
      ),
    ]),
    section("Capabilities", [
      kv([
        ["Charges Enabled", yesNo(resource.fields["chargesEnabled"])],
        ["Payouts Enabled", yesNo(resource.fields["payoutsEnabled"])],
        ["Details Submitted", yesNo(resource.fields["detailsSubmitted"])],
        ["Requirements Due", s(resource, "requirementsDue")],
        ["Requirements Past Due", s(resource, "requirementsPastDue")],
        ["Deadline", s(resource, "requirementsDeadline")],
        ["Disabled Reason", s(resource, "disabledReason")],
        ["Payout Schedule", s(resource, "payoutSchedule")],
      ]),
    ]),
    section("Balance", [
      kv([
        ["Available", balance ? money(balance.available) : s(resource, "availableBalance")],
        ["Pending", balance ? money(balance.pending) : s(resource, "pendingBalance")],
        ["Instant Payout Available", balance ? money(balance.instantAvailable) : ""],
        ["Connect Reserved", balance ? money(balance.connectReserved) : ""],
      ]),
    ]),
  ];

  if (subs) {
    const statusRows: TableRow[] = Object.entries(subs.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({
        cells: { status: status.replace(/_/g, " "), count: String(count) },
      }));
    const mrr = Object.entries(subs.mrrMinor)
      .map(([currency, minor]) => formatMoney(Math.round(minor), currency))
      .join(", ");
    sections.push(
      section("Subscriptions", [
        kv([
          ["Monthly Recurring Revenue", mrr || "None"],
          ["Subscriptions Read", `${subs.total}${subs.truncated ? " (most recent only)" : ""}`],
          ["Canceling at Period End", String(subs.cancelingAtPeriodEnd)],
        ]),
        ...(statusRows.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "status", label: "Status" },
                  { key: "count", label: "Subscriptions" },
                ],
                rows: statusRows,
              },
            ]
          : []),
        {
          kind: "text",
          variant: "muted",
          content:
            "Monthly recurring revenue normalises each active, trialing or past-due subscription's licensed items to a month at list price, before discounts and tax. Metered items are excluded because their amount depends on usage.",
        },
      ]),
    );
  }

  if (failed) {
    sections.push(
      section("Failing Webhook Deliveries", [
        failed.length === 0
          ? {
              kind: "text",
              variant: "muted",
              content: "No events failed to deliver in the last 30 days.",
            }
          : {
              kind: "table",
              columns: [
                { key: "type", label: "Event" },
                { key: "created", label: "Created" },
                { key: "pending", label: "Endpoints Still Retrying" },
                { key: "id", label: "Event ID", mono: true },
              ],
              rows: failed.map((e) => ({
                cells: {
                  type: e.type,
                  created: e.created,
                  pending: String(e.pendingWebhooks),
                  id: e.id,
                },
              })),
            },
        {
          kind: "text",
          variant: "muted",
          content:
            "Events at least one webhook endpoint failed to acknowledge. Stripe retries for up to three days; it does not say which endpoint failed, so check each endpoint's delivery log in the Dashboard.",
        },
      ]),
    );
  }

  if (enrichError) {
    sections.push(
      section("Partial Data", [{ kind: "text", variant: "muted", content: enrichError }]),
    );
  }

  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Account", mode === "live" ? "Live" : "Test"),
    status: accountIssue(resource),
    sections,
    headerActions: [
      refresh,
      {
        kind: "action",
        label: "Open Dashboard",
        action: { type: "open-url", url: `${dashboard}/dashboard` },
      },
      {
        kind: "action",
        label: "API keys",
        action: { type: "open-url", url: `${dashboard}/apikeys` },
      },
    ],
    logs: { defaultTailLines: 100 },
  };
}

function renderConnectedAccount(resource: ResourceInstance): DetailViewSchema {
  const url = resource.resolvedOutputs["dashboardUrl"] ?? "";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Connected Account", s(resource, "country")),
    status: accountIssue(resource),
    sections: [
      section("Account", [
        kv(
          [
            ["Account ID", s(resource, "accountId")],
            ["Email", s(resource, "email")],
            ["Country", s(resource, "country")],
            ["Default Currency", s(resource, "defaultCurrency")],
            ["Type", s(resource, "type")],
            ["Created", s(resource, "created")],
          ],
          ["Account ID"],
        ),
      ]),
      section("Controller", [
        kv([
          ["Dashboard Access", s(resource, "dashboard")],
          ["Requirement Collection", s(resource, "requirementCollection")],
          ["Negative Balance Liability", s(resource, "lossesPayer")],
          ["Stripe Fees Paid By", s(resource, "feesPayer")],
        ]),
      ]),
      section("Capabilities", [
        kv([
          ["Charges Enabled", yesNo(resource.fields["chargesEnabled"])],
          ["Payouts Enabled", yesNo(resource.fields["payoutsEnabled"])],
          ["Details Submitted", yesNo(resource.fields["detailsSubmitted"])],
          ["Requirements Due", s(resource, "requirementsDue")],
          ["Requirements Past Due", s(resource, "requirementsPastDue")],
          ["Deadline", s(resource, "requirementsDeadline")],
          ["Disabled Reason", s(resource, "disabledReason")],
        ]),
      ]),
    ],
    headerActions: [
      refresh,
      ...(url
        ? [
            {
              kind: "action" as const,
              label: "Open in Dashboard",
              action: { type: "open-url" as const, url },
            },
          ]
        : []),
      s(resource, "disabledReason").startsWith("rejected")
        ? pluginAction("Unreject account", "unreject", {
            confirm: "Restore this rejected connected account?",
            success: "Account restored.",
          })
        : pluginAction("Reject account", "reject", {
            confirm:
              "Reject this connected account? It can no longer take charges or receive payouts. Stripe only allows it for accounts where your platform is liable for losses.",
            success: "Account rejected.",
            destructive: true,
          }),
    ],
  };
}

function eventsTable(events: string): SchemaNode {
  const list = events
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (list.length === 0) return { kind: "text", variant: "muted", content: "No events selected." };
  if (list.includes("*")) {
    return {
      kind: "text",
      content: "All events (`*`), except those Stripe requires you to select explicitly.",
    };
  }
  return {
    kind: "table",
    columns: [{ key: "event", label: `Event (${list.length})`, mono: true }],
    rows: list.map((event) => ({ cells: { event } })),
  };
}

function renderWebhookEndpoint(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const disabled = s(resource, "status") === "disabled";
  const failed = parseStash<FailedEventSummary[]>(resource, STASH.failedEvents);
  const id = resource.externalId ?? "";
  const sections: SectionNode[] = [
    section("Endpoint", [
      kv(
        [
          ["URL", s(resource, "url")],
          ["Description", s(resource, "description")],
          ["Status", s(resource, "status")],
          ["API Version", s(resource, "apiVersion") || "Account default"],
          [
            "Events From",
            resource.fields["connect"] === true ? "Connected accounts" : "This account",
          ],
          ["Connect Application", s(resource, "application")],
          ["Endpoint ID", s(resource, "endpointId")],
          ["Created", s(resource, "created")],
        ],
        ["URL", "Endpoint ID"],
      ),
    ]),
    section("Enabled Events", [eventsTable(s(resource, "enabledEvents"))]),
    section("Signing Secret", [
      {
        kind: "text",
        variant: "muted",
        content:
          "Stripe returns the whsec_… signing secret only when the endpoint is created. Endpoints created from Infrawrench keep it as the Signing Secret output; for others, reveal or roll it in the Dashboard.",
      },
    ]),
  ];
  if (failed && failed.length > 0) {
    sections.push(
      section("Recent Failed Deliveries", [
        {
          kind: "table",
          columns: [
            { key: "type", label: "Event" },
            { key: "created", label: "Created" },
            { key: "pending", label: "Endpoints Still Retrying" },
          ],
          rows: failed.map((e) => ({
            cells: { type: e.type, created: e.created, pending: String(e.pendingWebhooks) },
          })),
        },
        {
          kind: "text",
          variant: "muted",
          content:
            "Events of a type this endpoint subscribes to that at least one endpoint failed to acknowledge in the last 30 days. Stripe does not say which endpoint failed: the Dashboard's delivery log does.",
        },
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Webhook Endpoint", s(resource, "status")),
    status: statusFor(resource),
    sections,
    headerActions: [
      refresh,
      disabled
        ? pluginAction("Enable", "enable", { success: "Endpoint enabled." })
        : pluginAction("Disable", "disable", {
            confirm:
              "Disable this endpoint? Stripe stops sending it events until you enable it again.",
            success: "Endpoint disabled.",
          }),
      {
        kind: "action",
        label: "Delivery log",
        action: { type: "open-url", url: `${dashboard}/workbench/webhooks/${id}` },
      },
    ],
  };
}

function renderEventDestination(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const type = s(resource, "type");
  const disabled = s(resource, "status") === "disabled";
  const target: Array<[string, string]> =
    type === "webhook_endpoint"
      ? [["Webhook URL", s(resource, "url")]]
      : type === "amazon_eventbridge"
        ? [
            ["AWS Account", s(resource, "awsAccountId")],
            ["AWS Region", s(resource, "awsRegion")],
            ["Event Source ARN", s(resource, "awsEventSourceArn")],
            ["Event Source Status", s(resource, "awsEventSourceStatus")],
          ]
        : [
            ["Azure Subscription", s(resource, "azureSubscriptionId")],
            ["Resource Group", s(resource, "azureResourceGroup")],
            ["Region", s(resource, "azureRegion")],
            ["Partner Topic", s(resource, "azurePartnerTopicName")],
            ["Partner Topic Status", s(resource, "azurePartnerTopicStatus")],
          ];
  const pending =
    s(resource, "awsEventSourceStatus") === "pending" ||
    s(resource, "azurePartnerTopicStatus") === "pending";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Event Destination", type.replace(/_/g, " ")),
    status: statusFor(resource),
    sections: [
      section("Destination", [
        kv(
          [
            ["Name", s(resource, "name")],
            ["Description", s(resource, "description")],
            ["Type", type.replace(/_/g, " ")],
            ["Payload", s(resource, "eventPayload")],
            ["Snapshot API Version", s(resource, "snapshotApiVersion")],
            ["Events From", s(resource, "eventsFrom")],
            ["Status", s(resource, "status")],
            ["Disabled Reason", s(resource, "disabledReason")],
            ["Destination ID", s(resource, "destinationId")],
            ["Created", s(resource, "created")],
            ["Updated", s(resource, "updated")],
          ],
          ["Destination ID"],
        ),
      ]),
      section("Target", [
        kv(target, ["Webhook URL", "Event Source ARN"]),
        ...(pending
          ? [
              {
                kind: "text" as const,
                variant: "muted" as const,
                content:
                  type === "amazon_eventbridge"
                    ? "Stripe created a partner event source in your AWS account. Associate it with an event bus in the EventBridge console to start receiving events."
                    : "Stripe created a partner topic in your Azure subscription. Activate it in the Event Grid console to start receiving events.",
              },
            ]
          : []),
      ]),
      section("Enabled Events", [eventsTable(s(resource, "enabledEvents"))]),
    ],
    headerActions: [
      refresh,
      disabled
        ? pluginAction("Enable", "enable", { success: "Destination enabled." })
        : pluginAction("Disable", "disable", {
            confirm:
              "Disable this destination? Stripe stops sending it events until you enable it again.",
            success: "Destination disabled.",
          }),
      pluginAction("Send ping", "ping", { success: "Ping event sent." }),
      {
        kind: "action",
        label: "Open in Workbench",
        action: {
          type: "open-url",
          url: `${dashboard}/workbench/event-destinations/${resource.externalId ?? ""}`,
        },
      },
    ],
  };
}

function renderProduct(resource: ResourceInstance): DetailViewSchema {
  const active = resource.fields["active"] !== false;
  const url = resource.resolvedOutputs["dashboardUrl"] ?? "";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Product", active ? "Active" : "Archived"),
    status: statusFor(resource),
    sections: [
      section("Product", [
        kv(
          [
            ["Name", s(resource, "name")],
            ["Description", s(resource, "description")],
            ["Product ID", s(resource, "productId")],
            ["Default Price", s(resource, "defaultPrice")],
            ["Unit Label", s(resource, "unitLabel")],
            ["Statement Descriptor", s(resource, "statementDescriptor")],
            ["Tax Code", s(resource, "taxCode")],
            ["URL", s(resource, "url")],
            ["Created", s(resource, "created")],
            ["Updated", s(resource, "updated")],
          ],
          ["Product ID"],
        ),
      ]),
    ],
    headerActions: [
      refresh,
      active
        ? pluginAction("Archive", "archive", {
            confirm:
              "Archive this product? It can no longer be added to new checkouts or subscriptions; existing subscriptions keep billing.",
            success: "Product archived.",
          })
        : pluginAction("Unarchive", "unarchive", { success: "Product restored." }),
      ...(url
        ? [
            {
              kind: "action" as const,
              label: "Open in Dashboard",
              action: { type: "open-url" as const, url },
            },
          ]
        : []),
    ],
  };
}

function renderPrice(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const active = resource.fields["active"] !== false;
  const interval = s(resource, "interval");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Price", s(resource, "amount")),
    status: statusFor(resource),
    sections: [
      section("Price", [
        kv(
          [
            ["Price ID", s(resource, "priceId")],
            ["Nickname", s(resource, "nickname")],
            ["Amount", s(resource, "amount")],
            ["Currency", s(resource, "currency")],
            ["Type", s(resource, "type").replace(/_/g, " ")],
            ["Billing Scheme", s(resource, "billingScheme").replace(/_/g, " ")],
            ["Lookup Key", s(resource, "lookupKey")],
            ["Tax Behavior", s(resource, "taxBehavior")],
            ["Product", s(resource, "productId")],
            ["Created", s(resource, "created")],
          ],
          ["Price ID", "Lookup Key"],
        ),
      ]),
      ...(interval
        ? [
            section("Recurring", [
              kv([
                ["Interval", interval],
                ["Interval Count", s(resource, "intervalCount")],
                ["Usage Type", s(resource, "usageType")],
                ["Meter", s(resource, "meterId")],
              ]),
            ]),
          ]
        : []),
    ],
    headerActions: [
      refresh,
      active
        ? pluginAction("Archive", "archive", {
            confirm:
              "Archive this price? New purchases can no longer use it; existing subscriptions keep billing at it.",
            success: "Price archived.",
          })
        : pluginAction("Unarchive", "unarchive", { success: "Price restored." }),
      {
        kind: "action",
        label: "Open in Dashboard",
        action: { type: "open-url", url: `${dashboard}/prices/${resource.externalId ?? ""}` },
      },
    ],
  };
}

function renderMeter(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const active = s(resource, "status") !== "inactive";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Billing Meter", s(resource, "eventName")),
    status: statusFor(resource),
    sections: [
      section("Meter", [
        kv(
          [
            ["Meter ID", s(resource, "meterId")],
            ["Display Name", s(resource, "displayName")],
            ["Event Name", s(resource, "eventName")],
            ["Aggregation", s(resource, "aggregation")],
            ["Customer Payload Key", s(resource, "customerPayloadKey")],
            ["Value Payload Key", s(resource, "valuePayloadKey")],
            ["Pre-aggregation Window", s(resource, "eventTimeWindow") || "None"],
            ["Status", s(resource, "status")],
            ["Deactivated", s(resource, "deactivatedAt")],
            ["Created", s(resource, "created")],
          ],
          ["Meter ID", "Event Name"],
        ),
      ]),
      section("Recording Usage", [
        {
          kind: "text",
          variant: "muted",
          content: `Send meter events named "${s(resource, "eventName")}" with the customer id under "${s(resource, "customerPayloadKey") || "stripe_customer_id"}" and the quantity under "${s(resource, "valuePayloadKey") || "value"}" in the payload. The Metrics tab charts daily usage for the customers subscribed to prices on this meter.`,
        },
      ]),
    ],
    headerActions: [
      refresh,
      active
        ? pluginAction("Deactivate", "deactivate", {
            confirm:
              "Deactivate this meter? Stripe rejects new meter events for it, and prices on it stop accruing usage.",
            success: "Meter deactivated.",
          })
        : pluginAction("Reactivate", "reactivate", { success: "Meter reactivated." }),
      {
        kind: "action",
        label: "Open in Dashboard",
        action: { type: "open-url", url: `${dashboard}/meters/${resource.externalId ?? ""}` },
      },
    ],
  };
}

function renderPayout(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  const cancellable = s(resource, "status") === "pending" && resource.fields["automatic"] === false;
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Payout", s(resource, "status").replace(/_/g, " ")),
    status: statusFor(resource),
    sections: [
      section("Payout", [
        kv(
          [
            ["Payout ID", s(resource, "payoutId")],
            ["Amount", s(resource, "amount")],
            ["Status", s(resource, "status").replace(/_/g, " ")],
            ["Arrival Date", s(resource, "arrivalDate")],
            ["Method", s(resource, "method")],
            ["Destination Type", s(resource, "type").replace(/_/g, " ")],
            ["Destination", s(resource, "destination")],
            ["Automatic", yesNo(resource.fields["automatic"])],
            ["Reconciliation", s(resource, "reconciliationStatus").replace(/_/g, " ")],
            ["Statement Descriptor", s(resource, "statementDescriptor")],
            ["Description", s(resource, "description")],
            ["Created", s(resource, "created")],
          ],
          ["Payout ID"],
        ),
      ]),
      ...(s(resource, "failureCode") || s(resource, "failureMessage")
        ? [
            section("Failure", [
              kv([
                ["Code", s(resource, "failureCode")],
                ["Message", s(resource, "failureMessage")],
              ]),
            ]),
          ]
        : []),
    ],
    headerActions: [
      refresh,
      ...(cancellable
        ? [
            pluginAction("Cancel payout", "cancel", {
              confirm: "Cancel this payout? The funds return to your available balance.",
              success: "Payout canceled.",
              destructive: true,
            }),
          ]
        : []),
      {
        kind: "action",
        label: "Open in Dashboard",
        action: { type: "open-url", url: `${dashboard}/payouts/${resource.externalId ?? ""}` },
      },
    ],
  };
}

function renderReportRun(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Report Run", s(resource, "status")),
    status: statusFor(resource),
    sections: [
      section("Report", [
        kv(
          [
            ["Report Type", s(resource, "reportType")],
            ["Status", s(resource, "status")],
            ["From", s(resource, "intervalStart")],
            ["To", s(resource, "intervalEnd")],
            ["Currency", s(resource, "currency")],
            ["Result File", s(resource, "fileId")],
            ["Result Size (bytes)", s(resource, "fileSize")],
            ["Succeeded", s(resource, "succeededAt")],
            ["Error", s(resource, "error")],
            ["Report Run ID", s(resource, "reportRunId")],
            ["Created", s(resource, "created")],
          ],
          ["Report Run ID", "Result File"],
        ),
        {
          kind: "text",
          variant: "muted",
          content:
            "Report files need your API key to download. Open the run in the Dashboard's Reports section to download the CSV.",
        },
      ]),
    ],
    headerActions: [
      refresh,
      {
        kind: "action",
        label: "Reports in Dashboard",
        action: { type: "open-url", url: `${dashboard}/reports/hub` },
      },
    ],
  };
}

function renderSigmaRun(resource: ResourceInstance, dashboard: string): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Stripe Sigma Query Run", s(resource, "status")),
    status: statusFor(resource),
    sections: [
      section("Run", [
        kv(
          [
            ["Title", s(resource, "title")],
            ["Status", s(resource, "status")],
            ["Data As Of", s(resource, "dataLoadTime")],
            ["Result File", s(resource, "fileId")],
            ["Result Size (bytes)", s(resource, "fileSize")],
            ["Result Available Until", s(resource, "resultAvailableUntil")],
            ["Error", s(resource, "error")],
            ["Run ID", s(resource, "runId")],
            ["Created", s(resource, "created")],
          ],
          ["Run ID", "Result File"],
        ),
      ]),
      section("SQL", [
        { kind: "text", variant: "mono", copyable: true, content: dash(s(resource, "sql")) },
      ]),
    ],
    headerActions: [
      refresh,
      {
        kind: "action",
        label: "Open Sigma",
        action: { type: "open-url", url: `${dashboard}/sigma/queries` },
      },
    ],
  };
}
