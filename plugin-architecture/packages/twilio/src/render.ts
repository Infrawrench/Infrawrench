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
import type { PeriodSpend } from "./cost-data.js";
import { METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const SPEND_THIS_MONTH_KEY = "__spendThisMonth__";
export const SPEND_LAST_MONTH_KEY = "__spendLastMonth__";
export const VERIFY_SUMMARY_KEY = "__verifySummary__";

const CONSOLE = "https://console.twilio.com";

export interface VerifySummary {
  totalAttempts: number;
  totalConverted: number;
  totalUnconverted: number;
  conversionRate?: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export function money(value: unknown, currency = "USD"): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return "";
  const code = (currency || "USD").toUpperCase();
  try {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${n.toFixed(2)} ${code}`;
  }
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function openInConsole(url: string): ActionNode[] {
  return [{ kind: "action", label: "Open in Twilio Console", action: { type: "open-url", url } }];
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function spendSection(title: string, spend: PeriodSpend | undefined): SectionNode | null {
  if (!spend) return null;
  const children: SchemaNode[] = [kv([["Total billed", money(spend.total, spend.currency)]])];
  if (spend.products.length > 0) {
    children.push({
      kind: "table",
      columns: [
        { key: "product", label: "Product", width: "wide" },
        { key: "price", label: "Billed" },
      ],
      rows: spend.products.map<TableRow>((p) => ({
        cells: { product: p.product, price: money(p.price, spend.currency) },
      })),
    });
  }
  if (spend.categories.length > 0) {
    children.push({
      kind: "table",
      columns: [
        { key: "description", label: "Usage category", width: "wide" },
        { key: "quantity", label: "Usage" },
        { key: "price", label: "Billed" },
      ],
      rows: spend.categories.slice(0, 40).map<TableRow>((c) => ({
        cells: {
          description: c.description,
          quantity:
            c.usage !== undefined
              ? `${c.usage.toLocaleString("en-US")}${c.usageUnit ? ` ${c.usageUnit}` : ""}`
              : "",
          price: money(c.price, spend.currency),
        },
      })),
    });
  }
  if (spend.total === 0) children.push(muted("Nothing billed in this period."));
  return section(title, children);
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const thisMonth = parseJson<PeriodSpend>(r.resolvedOutputs[SPEND_THIS_MONTH_KEY]);
  const lastMonth = parseJson<PeriodSpend>(r.resolvedOutputs[SPEND_LAST_MONTH_KEY]);
  const unit = str(f["priceUnit"]) || "USD";
  const sections: SectionNode[] = [
    section("Account", [
      kv([
        ["Name", f["friendlyName"] ?? r.displayName],
        ["Account SID", f["accountSid"], true],
        ["Type", f["type"]],
        ["Status", f["status"]],
        ["Subaccounts", f["subaccountCount"]],
        ["Signed in with", f["authMode"]],
        ["Created", f["createdAt"]],
      ]),
    ]),
    section("Balance and spend", [
      kv([
        ["Balance", money(f["balance"], str(f["currency"]) || "USD")],
        ["Spend this month", money(f["monthToDate"], unit)],
        ["Spend last month", money(f["lastMonth"], unit)],
      ]),
      muted(
        "Spend is what Twilio billed, from the Usage Records API, including every subaccount. Set a usage trigger on Total spend to have Twilio call a webhook when a month's spend crosses a threshold.",
      ),
    ]),
  ];
  const tm = spendSection("This month by product and category", thisMonth);
  if (tm) sections.push(tm);
  const lm = spendSection("Last month by product and category", lastMonth);
  if (lm) sections.push(lm);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Twilio account", f["type"]),
    status: accountStatus(str(f["status"])),
    sections,
    headerActions: openInConsole(`${CONSOLE}/us1/billing/manage-billing/billing-overview`),
  };
}

function accountStatus(status: string): StatusDotNode {
  const s = status.toLowerCase();
  const dot: ResourceStatus =
    s === "active" ? "healthy" : s === "suspended" ? "degraded" : s === "closed" ? "error" : "info";
  return { kind: "status-dot", status: dot, label: status || "Account" };
}

function renderSubaccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const thisMonth = parseJson<PeriodSpend>(r.resolvedOutputs[SPEND_THIS_MONTH_KEY]);
  const sections: SectionNode[] = [
    section("Subaccount", [
      kv([
        ["Name", f["friendlyName"]],
        ["Account SID", f["accountSid"], true],
        ["Status", status],
        ["Type", f["type"]],
        ["Parent account", f["ownerAccountSid"], true],
        ["Created", f["createdAt"]],
      ]),
      muted(
        "Deleting a subaccount closes it: Twilio releases all of its phone numbers and the subaccount can never be reopened. Suspend it instead to stop calls and messages while keeping its numbers (which are still billed).",
      ),
    ]),
  ];
  const tm = spendSection("This month by product and category", thisMonth);
  if (tm) sections.push(tm);
  else
    sections.push(
      section("Spend", [
        muted(
          "A subaccount's spend can only be read with the parent account's auth token, not an API key.",
        ),
      ]),
    );
  const actions: ActionNode[] =
    status === "suspended"
      ? [
          {
            kind: "action",
            label: "Reactivate",
            action: {
              type: "plugin-action",
              actionId: "reactivate",
              successMessage: "Subaccount reactivated.",
            },
          },
        ]
      : [
          {
            kind: "action",
            label: "Suspend",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "suspend",
              confirmMessage:
                "Suspend this subaccount? Calls and messages stop until you reactivate it; its phone numbers are kept and still billed.",
              successMessage: "Subaccount suspended.",
            },
          },
        ];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Subaccount", status),
    status: accountStatus(status),
    sections,
    headerActions: actions,
  };
}

function renderPhoneNumber(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const handler = str(f["trunkSid"])
    ? "SIP trunk"
    : str(f["messagingServiceSid"]) || str(f["voiceApplicationSid"]) || str(f["smsApplicationSid"])
      ? "Configured"
      : str(f["voiceUrl"]) || str(f["smsUrl"])
        ? "Webhooks"
        : "Unconfigured";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Phone number", f["type"], f["isoCountry"]),
    status: {
      kind: "status-dot",
      status: handler === "Unconfigured" ? "degraded" : "healthy",
      label: handler,
    },
    sections: [
      section("Number", [
        kv([
          ["Phone number", f["phoneNumber"], true],
          ["Friendly name", f["friendlyName"]],
          ["Type", f["type"]],
          ["Country", f["isoCountry"]],
          ["Capabilities", f["capabilities"]],
          ["Monthly price", money(f["monthlyPrice"], str(f["priceUnit"]) || "USD")],
          ["Subaccount", f["subaccountName"] ?? f["subaccountSid"]],
          ["Origin", f["origin"]],
          ["Status", f["status"]],
          ["Emergency calling", f["emergencyStatus"]],
          ["Address requirement", f["addressRequirements"]],
          ["Purchased", f["createdAt"]],
          ["Phone number SID", r.externalId, true],
        ]),
      ]),
      section("Voice", [
        kv([
          ["Webhook", f["voiceUrl"]],
          ["Method", f["voiceMethod"]],
          ["Fallback", f["voiceFallbackUrl"]],
          ["TwiML app", f["voiceApplicationSid"], true],
          ["SIP trunk", f["trunkSid"], true],
        ]),
      ]),
      section("Messaging", [
        kv([
          ["Messaging service", f["messagingServiceName"] ?? f["messagingServiceSid"]],
          ["Webhook", f["smsUrl"]],
          ["Method", f["smsMethod"]],
          ["Fallback", f["smsFallbackUrl"]],
          ["TwiML app", f["smsApplicationSid"], true],
          ["Status callback", f["statusCallback"]],
        ]),
        muted(
          "Deleting a phone number releases it back to Twilio: billing stops, and the number may be given to someone else.",
        ),
      ]),
    ],
    headerActions: openInConsole(`${CONSOLE}/us1/develop/phone-numbers/manage/incoming`),
  };
}

function renderMessagingService(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Messaging service", f["usecase"]),
    status: {
      kind: "status-dot",
      status: "healthy",
      label: `${str(f["senderCount"]) || "0"} senders`,
    },
    sections: [
      section("Service", [
        kv([
          ["Name", f["friendlyName"]],
          ["Service SID", f["serviceSid"], true],
          ["Use case", f["usecase"]],
          ["Phone number senders", f["senderCount"]],
          ["US A2P 10DLC registered", f["usA2pRegistered"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Integration", [
        kv([
          ["Inbound webhook", f["inboundRequestUrl"]],
          ["Inbound fallback", f["fallbackUrl"]],
          ["Use each number's own webhook", f["useInboundWebhookOnNumber"]],
          ["Delivery status callback", f["statusCallback"]],
          ["Validity period (s)", f["validityPeriod"]],
        ]),
      ]),
      section("Sender features", [
        kv([
          ["Sticky sender", f["stickySender"]],
          ["Smart encoding", f["smartEncoding"]],
          ["MMS converter", f["mmsConverter"]],
          ["Fallback to long code", f["fallbackToLongCode"]],
          ["Area code geomatch", f["areaCodeGeomatch"]],
        ]),
      ]),
    ],
    headerActions: openInConsole(`${CONSOLE}/us1/develop/sms/services`),
  };
}

function renderVerifyService(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<VerifySummary>(r.resolvedOutputs[VERIFY_SUMMARY_KEY]);
  const sections: SectionNode[] = [
    section("Service", [
      kv([
        ["Name", f["friendlyName"]],
        ["Service SID", f["serviceSid"], true],
        ["Code length", f["codeLength"]],
        ["Look up numbers first", f["lookupEnabled"]],
        ["Skip SMS to landlines", f["skipSmsToLandlines"]],
        ["Require keypress on voice", f["dtmfInputRequired"]],
        ["Do-not-share warning", f["doNotShareWarningEnabled"]],
        ["Custom codes", f["customCodeEnabled"]],
        ["PSD2", f["psd2Enabled"]],
        ["Default template", f["defaultTemplateSid"]],
        ["Created", f["createdAt"]],
      ]),
    ]),
  ];
  if (summary) {
    sections.push(
      section("Last 30 days", [
        kv([
          ["Verification attempts", summary.totalAttempts.toLocaleString("en-US")],
          ["Converted", summary.totalConverted.toLocaleString("en-US")],
          ["Not converted", summary.totalUnconverted.toLocaleString("en-US")],
          ["Conversion rate", summary.conversionRate ? `${summary.conversionRate}%` : ""],
        ]),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Verify service",
    status: { kind: "status-dot", status: "healthy", label: "Verify" },
    sections,
    headerActions: openInConsole(`${CONSOLE}/us1/develop/verify/services`),
  };
}

function renderTwimlApp(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "TwiML app",
    status: { kind: "status-dot", status: "info", label: "TwiML app" },
    sections: [
      section("Application", [
        kv([
          ["Name", f["friendlyName"]],
          ["Application SID", f["appSid"], true],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Voice", [
        kv([
          ["URL", f["voiceUrl"]],
          ["Method", f["voiceMethod"]],
          ["Fallback", f["voiceFallbackUrl"]],
          ["Status callback", f["statusCallback"]],
        ]),
      ]),
      section("Messaging", [
        kv([
          ["URL", f["smsUrl"]],
          ["Method", f["smsMethod"]],
          ["Fallback", f["smsFallbackUrl"]],
          ["Status callback", f["smsStatusCallback"]],
        ]),
      ]),
    ],
  };
}

export function triggerProgress(f: ResourceInstance["fields"]): number | undefined {
  const current = Number(f["currentValue"]);
  const threshold = Number(f["triggerValue"]);
  if (!Number.isFinite(current) || !Number.isFinite(threshold) || threshold <= 0) return undefined;
  return current / threshold;
}

function renderUsageTrigger(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const progress = triggerProgress(f);
  const fired = str(f["dateFired"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Usage trigger", f["usageCategory"], f["recurring"]),
    status: {
      kind: "status-dot",
      status:
        progress !== undefined && progress >= 1
          ? "error"
          : progress !== undefined && progress >= 0.8
            ? "degraded"
            : "healthy",
      label:
        progress !== undefined ? `${Math.round(progress * 100)}% of threshold` : "Usage trigger",
    },
    sections: [
      section("Trigger", [
        kv([
          ["Name", f["friendlyName"]],
          ["Usage category", f["usageCategory"]],
          ["Measure", f["triggerBy"]],
          ["Threshold", f["triggerValue"]],
          ["Current value", f["currentValue"]],
          ["Repeats", f["recurring"]],
          ["Last fired", fired || "Never"],
          ["Webhook", f["callbackUrl"]],
          ["Webhook method", f["callbackMethod"]],
          ["Trigger SID", f["triggerSid"], true],
          ["Created", f["createdAt"]],
        ]),
        muted(
          "Twilio fires a trigger at most once per period. The category, measure, threshold and period cannot be changed after creation; delete the trigger and create a new one instead.",
        ),
      ]),
    ],
  };
}

function renderApiKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "API key",
    status: {
      kind: "status-dot",
      status: f["inUse"] === true ? "healthy" : "info",
      label: f["inUse"] === true ? "Used by this connection" : "API key",
    },
    sections: [
      section("Key", [
        kv([
          ["Name", f["friendlyName"]],
          ["Key SID", f["keySid"], true],
          ["Used by this connection", f["inUse"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]),
        muted(
          "Twilio shows a key's secret only when it is created. Deleting a key revokes it at once for everything that uses it; the key this connection signs in with cannot be deleted from here.",
        ),
      ]),
    ],
    headerActions: openInConsole(`${CONSOLE}/us1/account/keys-credentials/api-keys`),
  };
}

export function renderTwilioDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "account":
      schema = renderAccount(r);
      break;
    case "subaccount":
      schema = renderSubaccount(r);
      break;
    case "phone-number":
      schema = renderPhoneNumber(r);
      break;
    case "messaging-service":
      schema = renderMessagingService(r);
      break;
    case "verify-service":
      schema = renderVerifyService(r);
      break;
    case "twiml-app":
      schema = renderTwimlApp(r);
      break;
    case "usage-trigger":
      schema = renderUsageTrigger(r);
      break;
    case "api-key":
      schema = renderApiKey(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderTwilioSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "account":
      return item(
        "healthy",
        f["balance"] !== undefined ? money(f["balance"], str(f["currency"])) : "Account",
      );
    case "subaccount": {
      const s = str(f["status"]);
      return item(
        s === "active" ? "healthy" : s === "suspended" ? "degraded" : "info",
        s || "Subaccount",
      );
    }
    case "phone-number": {
      const configured =
        str(f["voiceUrl"]) ||
        str(f["smsUrl"]) ||
        str(f["voiceApplicationSid"]) ||
        str(f["smsApplicationSid"]) ||
        str(f["trunkSid"]) ||
        str(f["messagingServiceSid"]);
      return item(configured ? "healthy" : "degraded", str(f["capabilities"]) || "Number");
    }
    case "usage-trigger": {
      const p = triggerProgress(f);
      return item(
        p !== undefined && p >= 1 ? "error" : p !== undefined && p >= 0.8 ? "degraded" : "healthy",
        p !== undefined ? `${Math.round(p * 100)}%` : str(f["usageCategory"]) || "Trigger",
      );
    }
    case "messaging-service":
      return item("healthy", `${str(f["senderCount"]) || "0"} senders`);
    case "api-key":
      return item(f["inUse"] === true ? "healthy" : "info", f["inUse"] === true ? "In use" : "Key");
    default:
      return item("info", str(r.resourceTypeId));
  }
}
