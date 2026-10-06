import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import type { OutboundOverview } from "./metrics.js";
import { METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const OVERVIEW_KEY = "__overview__";
export const DELIVERY_KEY = "__deliveryStats__";
export const BOUNCES_KEY = "__bounces__";
export const MESSAGES_KEY = "__messages__";
export const SUPPRESSIONS_KEY = "__suppressions__";
export const WEBHOOK_STATS_KEY = "__webhookStats__";

export const COMMANDS = {
  addSuppressions: "add-suppressions",
  removeSuppressions: "remove-suppressions",
  reactivateBounce: "reactivate-bounce",
} as const;

const APP = "https://account.postmarkapp.com";

export interface DeliveryStats {
  InactiveMails?: number;
  Bounces?: Array<{ Name?: string; Count?: number; Type?: string }>;
}

export interface BounceRow {
  ID?: number;
  Type?: string;
  Name?: string;
  Email?: string;
  BouncedAt?: string;
  Description?: string;
  MessageStream?: string;
  Inactive?: boolean;
  CanActivate?: boolean;
  Subject?: string;
}

export interface MessageRow {
  MessageID?: string;
  Recipients?: string[];
  Subject?: string;
  Status?: string;
  ReceivedAt?: string;
  MessageStream?: string;
  Tag?: string;
  From?: string;
}

export interface SuppressionRow {
  EmailAddress?: string;
  SuppressionReason?: string;
  Origin?: string;
  CreatedAt?: string;
}

export interface WebhookStats {
  TimeRange?: { Hours?: number };
  Statuses?: Record<string, string>;
  Metrics?: {
    TotalRequests?: number;
    SuccessCount?: number;
    FailureCount?: number;
    RetryCount?: number;
    SuccessRate?: number;
    AverageTerminalResponseTimeMs?: number;
  };
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

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

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

const count = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : str(v));
const pct = (v: unknown) => (typeof v === "number" ? `${v.toFixed(2)}%` : "");

function overviewSection(o: OutboundOverview | undefined): SectionNode {
  if (!o) {
    return section("Last 30 days", [muted("Sending stats could not be read for this server.")]);
  }
  return section("Last 30 days", [
    kv([
      ["Sent", count(o.Sent)],
      ["Bounced", count(o.Bounced)],
      ["Bounce rate", pct(o.BounceRate)],
      ["Spam complaints", count(o.SpamComplaints)],
      ["Spam complaint rate", pct(o.SpamComplaintsRate)],
      ["SMTP API errors", count(o.SMTPApiErrors)],
      ["Unique opens", count(o.UniqueOpens)],
      ["Unique link clicks", count(o.UniqueLinksClicked)],
    ]),
    muted(
      "Postmark recommends keeping the bounce rate under 10% and spam complaints under 0.1%; above that it may pause sending.",
    ),
  ]);
}

function healthOf(o: OutboundOverview | undefined): ResourceStatus {
  if (!o) return "info";
  if ((o.SpamComplaintsRate ?? 0) >= 0.1 || (o.BounceRate ?? 0) >= 10) return "error";
  if ((o.SpamComplaintsRate ?? 0) >= 0.05 || (o.BounceRate ?? 0) >= 5) return "degraded";
  return "healthy";
}

function renderServer(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const overview = parseJson<OutboundOverview>(r.resolvedOutputs[OVERVIEW_KEY]);
  const delivery = parseJson<DeliveryStats>(r.resolvedOutputs[DELIVERY_KEY]);
  const bounces = parseJson<BounceRow[]>(r.resolvedOutputs[BOUNCES_KEY]) ?? [];
  const messages = parseJson<MessageRow[]>(r.resolvedOutputs[MESSAGES_KEY]) ?? [];
  const sections: SectionNode[] = [
    section("Server", [
      kv([
        ["Name", f["name"]],
        ["Server ID", f["serverId"], true],
        ["Delivery", f["deliveryType"]],
        ["Color", f["color"]],
        ["SMTP", f["smtpApiActivated"]],
        ["Track opens", f["trackOpens"]],
        ["Track links", f["trackLinks"]],
      ]),
    ]),
    overviewSection(overview),
    section("Inbound", [
      kv([
        ["Inbound address", f["inboundAddress"], true],
        ["Inbound domain", f["inboundDomain"]],
        ["Inbound webhook", f["inboundHookUrl"]],
        ["Spam threshold", f["inboundSpamThreshold"]],
        ["Raw email in webhook", f["rawEmailEnabled"]],
      ]),
    ]),
  ];
  if (delivery) {
    const rows = (delivery.Bounces ?? [])
      .filter((b) => (b.Count ?? 0) > 0)
      .map<TableRow>((b) => ({ cells: { name: str(b.Name), count: count(b.Count) } }));
    sections.push(
      section("Bounces by type", [
        kv([["Inactive recipients", count(delivery.InactiveMails)]]),
        rows.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "name", label: "Type", width: "wide" },
                { key: "count", label: "Count" },
              ],
              rows,
            }
          : muted("No bounces recorded."),
      ]),
    );
  }
  if (bounces.length > 0) {
    sections.push(
      section("Recent bounces", [
        {
          kind: "table",
          columns: [
            { key: "email", label: "Recipient", width: "wide" },
            { key: "type", label: "Type" },
            { key: "stream", label: "Stream" },
            { key: "at", label: "Bounced" },
            { key: "inactive", label: "Deactivated" },
          ],
          rows: bounces.map<TableRow>((b) => ({
            cells: {
              email: str(b.Email),
              type: str(b.Name || b.Type),
              stream: str(b.MessageStream),
              at: str(b.BouncedAt),
              inactive: b.Inactive ? "Yes" : "No",
            },
          })),
        },
        muted(
          "A hard bounce deactivates the address: Postmark stops sending to it until it is reactivated.",
        ),
      ]),
    );
  }
  if (messages.length > 0) {
    sections.push(
      section("Recent outbound messages", [
        {
          kind: "table",
          columns: [
            { key: "at", label: "Received" },
            { key: "to", label: "To", width: "wide" },
            { key: "subject", label: "Subject", width: "wide" },
            { key: "status", label: "Status" },
            { key: "stream", label: "Stream" },
          ],
          rows: messages.map<TableRow>((m) => ({
            cells: {
              at: str(m.ReceivedAt),
              to: (m.Recipients ?? []).join(", "),
              subject: str(m.Subject),
              status: str(m.Status),
              stream: str(m.MessageStream),
            },
          })),
        },
      ]),
    );
  }
  const reactivatable = bounces.filter((b) => b.CanActivate && b.ID !== undefined);
  const headerActions: ActionNode[] = [];
  if (reactivatable.length > 0) {
    const field: CreateFieldConfig = {
      key: "bounceId",
      label: "Bounce",
      kind: "select",
      required: true,
      options: reactivatable.map((b) => ({
        id: String(b.ID),
        label: str(b.Email),
        description: joinSubtitle(b.Name, b.BouncedAt),
      })),
    };
    headerActions.push({
      kind: "action",
      label: "Reactivate address",
      action: {
        type: "prompt-nosql-command",
        command: COMMANDS.reactivateBounce,
        title: "Reactivate a bounced address",
        description:
          "Postmark sends to the address again. If it still bounces it is deactivated again, which counts against your bounce rate.",
        fields: [field],
        submitLabel: "Reactivate",
      },
    });
  }
  const link = str(f["serverLink"]);
  if (link) headerActions.push(openUrl("Open in Postmark", link));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Postmark server", f["deliveryType"]),
    status: {
      kind: "status-dot",
      status: str(f["deliveryType"]) === "Sandbox" ? "info" : healthOf(overview),
      label: str(f["deliveryType"]) === "Sandbox" ? "Sandbox" : overview ? "Sending" : "Server",
    },
    sections,
    headerActions,
    customTabs: [
      {
        id: "streams",
        label: "Message streams",
        childResourceTypeIds: ["postmark-message-stream"],
      },
      {
        id: "integrations",
        label: "Webhooks and rules",
        childResourceTypeIds: ["postmark-webhook", "postmark-inbound-rule"],
      },
      { id: "templates", label: "Templates", childResourceTypeIds: ["postmark-template"] },
    ],
  };
}

const emailsField = (key: string, label: string): CreateFieldConfig => ({
  key,
  label,
  kind: "text",
  multiline: true,
  required: true,
  placeholder: "one@example.com\ntwo@example.com",
  description: "One address per line, up to 50 at a time.",
});

function renderStream(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const overview = parseJson<OutboundOverview>(r.resolvedOutputs[OVERVIEW_KEY]);
  const suppressions = parseJson<SuppressionRow[]>(r.resolvedOutputs[SUPPRESSIONS_KEY]);
  const archived = f["archived"] === true;
  const inbound = str(f["messageStreamType"]) === "Inbound";
  const sections: SectionNode[] = [
    section("Stream", [
      kv([
        ["Name", f["name"]],
        ["Stream ID", f["streamId"], true],
        ["Type", f["messageStreamType"]],
        ["Server", f["serverName"]],
        ["Description", f["description"]],
        ["Unsubscribe handling", f["unsubscribeHandlingType"]],
        ["Archived", f["archivedAt"]],
        ["Purged on", f["expectedPurgeDate"]],
        ["Created", f["createdAt"]],
      ]),
      ...(archived
        ? [
            muted(
              "Archived streams stop sending. Postmark deletes the stream and its data 45 days after archiving unless it is restored.",
            ),
          ]
        : []),
    ]),
  ];
  if (!inbound) sections.push(overviewSection(overview));
  if (suppressions) {
    sections.push(
      section("Suppressions", [
        suppressions.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "email", label: "Address", width: "wide" },
                { key: "reason", label: "Reason" },
                { key: "origin", label: "Origin" },
                { key: "at", label: "Since" },
              ],
              rows: suppressions.slice(0, 200).map<TableRow>((s) => ({
                cells: {
                  email: str(s.EmailAddress),
                  reason: str(s.SuppressionReason),
                  origin: str(s.Origin),
                  at: str(s.CreatedAt),
                },
              })),
            }
          : muted("No suppressed addresses on this stream."),
        muted(
          "Postmark never sends to a suppressed address on this stream. Spam-complaint suppressions cannot be removed.",
        ),
      ]),
    );
  }
  const headerActions: ActionNode[] = [];
  if (!inbound) {
    headerActions.push(
      {
        kind: "action",
        label: "Suppress addresses",
        action: {
          type: "prompt-nosql-command",
          command: COMMANDS.addSuppressions,
          title: "Suppress addresses on this stream",
          fields: [emailsField("emails", "Addresses")],
          submitLabel: "Suppress",
        },
      },
      {
        kind: "action",
        label: "Remove suppressions",
        action: {
          type: "prompt-nosql-command",
          command: COMMANDS.removeSuppressions,
          title: "Remove addresses from the suppression list",
          description: "Postmark may send to these addresses again.",
          fields: [emailsField("emails", "Addresses")],
          submitLabel: "Remove",
        },
      },
    );
  }
  headerActions.push(
    archived
      ? pluginAction("Restore", "unarchive", { success: "Stream restored." })
      : pluginAction("Archive", "archive", {
          danger: true,
          confirm:
            "Archive this stream? Sending through it stops, and Postmark deletes it 45 days from now unless you restore it.",
          success: "Stream archived.",
        }),
  );
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Message stream", f["messageStreamType"], f["serverName"]),
    status: {
      kind: "status-dot",
      status: archived ? "degraded" : inbound ? "info" : healthOf(overview),
      label: archived ? "Archived" : str(f["messageStreamType"]) || "Stream",
    },
    sections,
    headerActions,
  };
}

function renderDomain(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const dkim = f["dkimVerified"] === true;
  const rp = str(f["returnPathDomain"]);
  return {
    title: r.displayName,
    subtitle: "Sending domain",
    status: {
      kind: "status-dot",
      status: dkim
        ? rp && f["returnPathDomainVerified"] !== true
          ? "degraded"
          : "healthy"
        : "error",
      label: dkim ? "DKIM verified" : "DKIM not verified",
    },
    sections: [
      section("Domain", [
        kv([
          ["Domain", f["name"]],
          ["Domain ID", f["domainId"], true],
          ["DKIM verified", f["dkimVerified"]],
          ["Weak DKIM key", f["weakDkim"]],
          ["DKIM host", f["dkimHost"], true],
          ["DKIM rotation", f["dkimUpdateStatus"]],
          ["Pending DKIM host", f["dkimPendingHost"], true],
          ["Revoked key safe to remove", f["safeToRemoveRevokedKey"]],
          ["Return-Path domain", rp || "Default (pm.mtasv.net)"],
          ["Return-Path verified", rp ? f["returnPathDomainVerified"] : undefined],
        ]),
        muted(
          "The DNS records below must exist at your DNS provider. After adding them, use Verify DKIM and Verify Return-Path; DNS changes can take a while to propagate.",
        ),
      ]),
    ],
    childTables: [
      {
        title: "Required DNS records",
        typeId: "postmark-dns-record",
        columns: [
          {
            key: "type",
            label: "Type",
            width: "narrow",
            source: { kind: "field", fieldKey: "type" },
            format: "type-badge",
          },
          {
            key: "name",
            label: "Host",
            source: { kind: "field", fieldKey: "name" },
            format: "mono",
          },
          {
            key: "content",
            label: "Value",
            width: "wide",
            source: { kind: "field", fieldKey: "content" },
            format: "mono",
          },
          { key: "purpose", label: "Purpose", source: { kind: "field", fieldKey: "purpose" } },
          {
            key: "verified",
            label: "Verified",
            width: "narrow",
            source: { kind: "field", fieldKey: "verified" },
            format: "boolean-yesno",
          },
        ],
        emptyText: "Postmark has not issued DNS records for this domain yet.",
        onRowClick: "navigate",
      },
    ],
    headerActions: [
      pluginAction("Verify DKIM", "verify-dkim", { success: "DKIM checked." }),
      ...(rp
        ? [
            pluginAction("Verify Return-Path", "verify-return-path", {
              success: "Return-Path checked.",
            }),
          ]
        : []),
      pluginAction("Rotate DKIM key", "rotate-dkim", {
        confirm:
          "Rotate the DKIM key? Postmark issues a new key to publish in DNS; it keeps signing with the current key until the new one verifies.",
        success: "New DKIM key issued. Publish the pending record.",
      }),
      openUrl("Open in Postmark", `${APP}/signature_domains`),
    ],
  };
}

function renderDnsRecord(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const verified = f["verified"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Required DNS record", f["domainName"]),
    status: {
      kind: "status-dot",
      status: verified ? "healthy" : "degraded",
      label: verified ? "Verified" : "Not verified",
    },
    sections: [
      section("Record", [
        kv([
          ["Type", f["type"]],
          ["Host", f["name"], true],
          ["Value", f["content"], true],
          ["Purpose", f["purpose"]],
          ["Verified", f["verified"]],
          ["Domain", f["domainName"]],
        ]),
        muted(
          "Create this record at the DNS provider for the domain. Postmark reads it when you verify the domain; it does not host your DNS.",
        ),
      ]),
    ],
  };
}

function renderSignature(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const confirmed = f["confirmed"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Sender signature", f["domain"]),
    status: {
      kind: "status-dot",
      status: confirmed ? "healthy" : "degraded",
      label: confirmed ? "Confirmed" : "Awaiting confirmation",
    },
    sections: [
      section("Signature", [
        kv([
          ["From address", f["emailAddress"], true],
          ["From name", f["name"]],
          ["Reply-To", f["replyToEmailAddress"]],
          ["Return-Path domain", f["returnPathDomain"]],
          ["Domain", f["domain"]],
          ["Confirmed", f["confirmed"]],
          ["Signature ID", f["signatureId"], true],
        ]),
      ]),
    ],
    headerActions: confirmed
      ? []
      : [
          pluginAction("Resend confirmation", "resend-confirmation", {
            success: "Confirmation email sent.",
          }),
        ],
  };
}

function renderWebhook(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stats = parseJson<WebhookStats>(r.resolvedOutputs[WEBHOOK_STATS_KEY]);
  const events = [
    ["Delivery", f["delivery"]],
    ["Bounce", f["bounce"]],
    ["Spam complaint", f["spamComplaint"]],
    ["Open", f["open"]],
    ["Click", f["click"]],
    ["Subscription change", f["subscriptionChange"]],
  ]
    .filter(([, on]) => on === true)
    .map(([name]) => name as string);
  const sections: SectionNode[] = [
    section("Webhook", [
      kv([
        ["URL", f["url"], true],
        ["Message stream", f["messageStream"]],
        ["Server", f["serverName"]],
        ["Events", events.join(", ") || "None"],
        ["Bounce content included", f["bounceIncludeContent"]],
        ["Spam complaint content included", f["spamIncludeContent"]],
        ["Only the first open", f["postFirstOpenOnly"]],
        ["Basic auth user", f["httpAuthUsername"]],
        ["Custom headers", f["headerCount"]],
      ]),
    ]),
  ];
  const m = stats?.Metrics;
  if (m) {
    sections.push(
      section(`Last ${stats?.TimeRange?.Hours ?? 24} hours`, [
        kv([
          ["Requests", count(m.TotalRequests)],
          ["Succeeded", count(m.SuccessCount)],
          ["Failed", count(m.FailureCount)],
          ["Retried", count(m.RetryCount)],
          ["Success rate", typeof m.SuccessRate === "number" ? `${m.SuccessRate}%` : ""],
          [
            "Average response",
            typeof m.AverageTerminalResponseTimeMs === "number"
              ? `${m.AverageTerminalResponseTimeMs} ms`
              : "",
          ],
        ]),
      ]),
    );
  }
  const failing = (m?.FailureCount ?? 0) > 0;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Webhook", f["messageStream"], f["serverName"]),
    status: {
      kind: "status-dot",
      status: events.length === 0 ? "degraded" : failing ? "degraded" : "healthy",
      label:
        events.length === 0
          ? "No events"
          : failing
            ? "Failing deliveries"
            : `${events.length} events`,
    },
    sections,
    headerActions: [
      pluginAction("Send test events", "verify", {
        success: "Postmark reached the endpoint for every enabled event.",
      }),
    ],
  };
}

function renderTemplate(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const sections: SectionNode[] = [
    section("Template", [
      kv([
        ["Name", f["name"]],
        ["Alias", f["alias"], true],
        ["Type", f["templateType"]],
        ["Layout", f["layoutTemplate"]],
        ["Subject", f["subject"]],
        ["Active", f["active"]],
        ["Server", f["serverName"]],
        ["Template ID", f["templateId"], true],
      ]),
    ]),
  ];
  const html = str(f["htmlBody"]);
  const text = str(f["textBody"]);
  if (html)
    sections.push(
      section("HTML body", [{ kind: "text", variant: "mono", content: html, copyable: true }]),
    );
  if (text)
    sections.push(
      section("Text body", [{ kind: "text", variant: "mono", content: text, copyable: true }]),
    );
  return {
    title: r.displayName,
    subtitle: joinSubtitle(
      str(f["templateType"]) === "Layout" ? "Layout" : "Template",
      f["serverName"],
    ),
    status: {
      kind: "status-dot",
      status: f["active"] === false ? "degraded" : "healthy",
      label: f["active"] === false ? "Inactive" : "Active",
    },
    sections,
  };
}

function renderInboundRule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Inbound block rule", f["serverName"]),
    status: { kind: "status-dot", status: "info", label: "Blocking" },
    sections: [
      section("Rule", [
        kv([
          ["Blocked", f["rule"]],
          ["Server", f["serverName"]],
        ]),
        muted(
          "Inbound mail from this address or domain is dropped. Rules cannot be edited; delete and recreate instead.",
        ),
      ]),
    ],
  };
}

export function renderPostmarkDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "postmark-server":
      schema = renderServer(r);
      break;
    case "postmark-message-stream":
      schema = renderStream(r);
      break;
    case "postmark-domain":
      schema = renderDomain(r);
      break;
    case "postmark-dns-record":
      schema = renderDnsRecord(r);
      break;
    case "postmark-sender-signature":
      schema = renderSignature(r);
      break;
    case "postmark-webhook":
      schema = renderWebhook(r);
      break;
    case "postmark-template":
      schema = renderTemplate(r);
      break;
    case "postmark-inbound-rule":
      schema = renderInboundRule(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderPostmarkSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "postmark-server":
      return item(
        str(f["deliveryType"]) === "Sandbox" ? "info" : "healthy",
        str(f["deliveryType"]) || "Server",
      );
    case "postmark-message-stream":
      return f["archived"] === true
        ? item("degraded", "Archived")
        : item("healthy", str(f["messageStreamType"]) || "Stream");
    case "postmark-domain":
      return f["dkimVerified"] === true
        ? item("healthy", "Verified")
        : item("error", "DKIM not verified");
    case "postmark-dns-record":
      return f["verified"] === true
        ? item("healthy", str(f["type"]) || "Record")
        : item("degraded", "Not verified");
    case "postmark-sender-signature":
      return f["confirmed"] === true
        ? item("healthy", "Confirmed")
        : item("degraded", "Unconfirmed");
    case "postmark-template":
      return item(
        f["active"] === false ? "degraded" : "healthy",
        str(f["templateType"]) || "Template",
      );
    default:
      return item("info", str(r.resourceTypeId).replace("postmark-", ""));
  }
}
