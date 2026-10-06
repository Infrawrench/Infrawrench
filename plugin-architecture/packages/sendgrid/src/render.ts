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
import type { SgMetrics } from "./metrics.js";
import { METRICS_WINDOW_MS } from "./metrics.js";
import { EVENT_KEYS, RESOURCE_TYPES, eventFieldKey } from "./resource-types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const STATS_KEY = "__stats30d__";
export const SUPPRESSIONS_KEY = "__suppressions__";
export const DNS_KEY = "__dnsRecords__";
export const VERSIONS_KEY = "__versions__";
export const AVAILABLE_IPS_KEY = "__availableIps__";

export const COMMANDS = {
  removeSuppressions: "remove-suppressions",
  addGlobalUnsubscribes: "add-global-unsubscribes",
  addPoolIp: "add-pool-ip",
  removePoolIp: "remove-pool-ip",
  addGroupSuppressions: "add-group-suppressions",
  removeGroupSuppressions: "remove-group-suppressions",
} as const;

/** The account-level suppression lists and the path each lives at. */
export const SUPPRESSION_LISTS = [
  { id: "bounces", label: "Bounces", path: "/v3/suppression/bounces" },
  { id: "blocks", label: "Blocks", path: "/v3/suppression/blocks" },
  { id: "spam_reports", label: "Spam reports", path: "/v3/suppression/spam_reports" },
  { id: "invalid_emails", label: "Invalid emails", path: "/v3/suppression/invalid_emails" },
  { id: "unsubscribes", label: "Global unsubscribes", path: "/v3/suppression/unsubscribes" },
] as const;

export interface SuppressionRow {
  email?: string;
  created?: number;
  reason?: string;
  status?: string;
}

export interface DnsRow {
  type: string;
  name: string;
  content: string;
  purpose: string;
  valid?: boolean;
}

export interface VersionRow {
  name?: string;
  subject?: string;
  active?: number;
  updated_at?: string;
  editor?: string;
}

const APP = "https://app.sendgrid.com";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const count = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : str(v));

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
  opts: { confirm?: string; success?: string; danger?: boolean } = {},
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
    },
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
  description?: string,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      fields,
      submitLabel,
      ...(description ? { description } : {}),
    },
  };
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

export const emailsField: CreateFieldConfig = {
  key: "emails",
  label: "Addresses",
  kind: "text",
  multiline: true,
  required: true,
  placeholder: "one@example.com\ntwo@example.com",
  description: "One address per line.",
};

const pct = (num: number | undefined, den: number | undefined) =>
  num !== undefined && den ? `${((num / den) * 100).toFixed(2)}%` : "";

function statsSection(title: string, m: SgMetrics | undefined): SectionNode {
  if (!m)
    return section(title, [muted("Stats could not be read (the key needs the stats.read scope).")]);
  return section(title, [
    kv([
      ["Requests", count(m.requests ?? 0)],
      ["Delivered", count(m.delivered ?? 0)],
      ["Delivery rate", pct(m.delivered, m.requests)],
      ["Bounces", count(m.bounces ?? 0)],
      ["Bounce rate", pct(m.bounces, m.requests)],
      ["Blocks", count(m.blocks ?? 0)],
      ["Spam reports", count(m.spam_reports ?? 0)],
      ["Unique opens", count(m.unique_opens ?? 0)],
      ["Unique clicks", count(m.unique_clicks ?? 0)],
      ["Unsubscribes", count(m.unsubscribes ?? 0)],
    ]),
  ]);
}

function dnsTable(rows: DnsRow[] | undefined): SchemaNode {
  if (!rows || rows.length === 0) return muted("SendGrid returned no DNS records.");
  return {
    kind: "table",
    columns: [
      { key: "type", label: "Type", width: "narrow" },
      { key: "name", label: "Host", mono: true },
      { key: "content", label: "Value", width: "wide", mono: true },
      { key: "purpose", label: "Purpose" },
      { key: "valid", label: "Valid", width: "narrow" },
    ],
    rows: rows.map<TableRow>((r) => ({
      cells: {
        type: r.type,
        name: r.name,
        content: r.content,
        purpose: r.purpose,
        valid: r.valid === undefined ? "" : r.valid ? "Yes" : "No",
      },
    })),
  };
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stats = parseJson<SgMetrics>(r.resolvedOutputs[STATS_KEY]);
  const supp = parseJson<Record<string, SuppressionRow[]>>(r.resolvedOutputs[SUPPRESSIONS_KEY]);
  const total = Number(f["creditsTotal"] ?? 0);
  const used = Number(f["creditsUsed"] ?? 0);
  const sections: SectionNode[] = [
    section("Account", [
      kv([
        ["Username", f["username"], true],
        ["Plan", f["type"]],
        ["Sender reputation", f["reputation"] !== undefined ? `${f["reputation"]}%` : ""],
        ["Company", f["company"]],
        ["API region", f["region"]],
        ["Acting as subuser", f["onBehalfOf"]],
      ]),
    ]),
    section("Email credits", [
      kv([
        ["Credits this period", count(f["creditsTotal"])],
        ["Used", count(f["creditsUsed"])],
        ["Remaining", count(f["creditsRemain"])],
        ["Used so far", total > 0 ? `${((used / total) * 100).toFixed(1)}%` : ""],
        ["Overage", count(f["creditsOverage"])],
        ["Resets", f["creditsResetFrequency"]],
        ["Next reset", f["creditsNextReset"]],
      ]),
      muted(
        "Credits also feed the Quotas page. A usage alert (under Alerts) makes SendGrid email you when a percentage is used.",
      ),
    ]),
    statsSection("Last 30 days", stats),
  ];
  const tabs = [];
  if (supp) {
    const listSections = SUPPRESSION_LISTS.map((l) => {
      const rows = supp[l.id] ?? [];
      return section(l.label, [
        rows.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "email", label: "Address", width: "wide" },
                { key: "reason", label: "Reason", width: "wide" },
                { key: "at", label: "Since" },
              ],
              rows: rows.slice(0, 50).map<TableRow>((s) => ({
                cells: {
                  email: str(s.email),
                  reason: str(s.reason || s.status),
                  at: typeof s.created === "number" ? new Date(s.created * 1000).toISOString() : "",
                },
              })),
            }
          : muted("None."),
      ]);
    });
    tabs.push({
      id: "suppressions",
      label: "Suppressions",
      sections: [
        section("", [
          muted("The most recent 50 addresses on each list. SendGrid drops mail to any of them."),
        ]),
        ...listSections,
      ],
      headerActions: [
        prompt(
          "Remove from a list",
          COMMANDS.removeSuppressions,
          "Remove addresses from a suppression list",
          [
            {
              key: "list",
              label: "List",
              kind: "select",
              required: true,
              defaultValue: "bounces",
              options: SUPPRESSION_LISTS.map((l) => ({ id: l.id, label: l.label })),
            },
            emailsField,
          ],
          "Remove",
          "SendGrid may send to these addresses again. Removing a spam report re-enables mail to someone who complained.",
        ),
        prompt(
          "Add global unsubscribes",
          COMMANDS.addGlobalUnsubscribes,
          "Unsubscribe addresses from all mail",
          [emailsField],
          "Unsubscribe",
        ),
      ],
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("SendGrid account", f["type"]),
    status: creditStatus(f),
    sections,
    ...(tabs.length > 0 ? { customTabs: tabs } : {}),
    headerActions: [openUrl("Open in SendGrid", `${APP}/`)],
  };
}

function creditStatus(f: ResourceInstance["fields"]) {
  const total = Number(f["creditsTotal"] ?? 0);
  const used = Number(f["creditsUsed"] ?? 0);
  const p = total > 0 ? used / total : undefined;
  const status: ResourceStatus =
    p === undefined ? "healthy" : p >= 1 ? "error" : p >= 0.8 ? "degraded" : "healthy";
  return {
    kind: "status-dot" as const,
    status,
    label:
      p === undefined ? str(f["type"]) || "Account" : `${Math.round(p * 100)}% of credits used`,
  };
}

function validStatus(valid: unknown) {
  return {
    kind: "status-dot" as const,
    status: (valid === true ? "healthy" : "error") as ResourceStatus,
    label: valid === true ? "Verified" : "Not verified",
  };
}

function renderDomain(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const dns = parseJson<DnsRow[]>(r.resolvedOutputs[DNS_KEY]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Authenticated domain", f["default"] === true ? "default" : undefined),
    status: validStatus(f["valid"]),
    sections: [
      section("Domain", [
        kv([
          ["Domain", f["domain"]],
          ["Return-Path subdomain", f["subdomain"]],
          ["Owner", f["username"]],
          ["Default", f["default"]],
          ["Automated security", f["automaticSecurity"]],
          ["Custom SPF", f["customSpf"]],
          ["Custom SPF IPs", f["ips"]],
          ["Subusers", f["subusers"]],
          ["Last validated", f["lastValidationAt"]],
          ["Domain ID", f["domainId"], true],
        ]),
      ]),
      section("DNS records", [
        dnsTable(dns),
        muted(
          "Create these records at your DNS provider, then Validate. The same records are listed as Required DNS Records and on the Domains page.",
        ),
      ]),
    ],
    headerActions: [
      pluginAction("Validate", "validate", { success: "SendGrid found every record." }),
      ...(f["default"] === true
        ? []
        : [pluginAction("Make default", "make-default", { success: "Default domain set." })]),
    ],
  };
}

function renderLink(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const dns = parseJson<DnsRow[]>(r.resolvedOutputs[DNS_KEY]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Link branding", f["default"] === true ? "default" : undefined),
    status: validStatus(f["valid"]),
    sections: [
      section("Link branding", [
        kv([
          ["Domain", f["domain"]],
          ["Subdomain", f["subdomain"]],
          ["Owner", f["username"]],
          ["Default", f["default"]],
          ["Legacy", f["legacy"]],
          ["Link branding ID", f["linkId"], true],
        ]),
      ]),
      section("DNS records", [dnsTable(dns)]),
    ],
    headerActions: [
      pluginAction("Validate", "validate", { success: "SendGrid found every record." }),
      ...(f["default"] === true
        ? []
        : [
            pluginAction("Make default", "make-default", { success: "Default link branding set." }),
          ]),
    ],
  };
}

function renderReverseDns(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const dns = parseJson<DnsRow[]>(r.resolvedOutputs[DNS_KEY]);
  return {
    title: r.displayName,
    subtitle: "Reverse DNS",
    status: validStatus(f["valid"]),
    sections: [
      section("Reverse DNS", [
        kv([
          ["IP address", f["ip"], true],
          ["Hostname", f["rdns"], true],
          ["Domain", f["domain"]],
          ["Subdomain", f["subdomain"]],
        ]),
      ]),
      section("DNS record", [dnsTable(dns)]),
    ],
    headerActions: [
      pluginAction("Validate", "validate", { success: "SendGrid found the A record." }),
    ],
  };
}

function renderDnsRecord(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const valid = f["valid"];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Required DNS record", f["ownerType"], f["ownerName"]),
    status:
      valid === undefined
        ? { kind: "status-dot", status: "info", label: "Not checked by SendGrid" }
        : validStatus(valid),
    sections: [
      section("Record", [
        kv([
          ["Type", f["type"]],
          ["Host", f["name"], true],
          ["Value", f["content"], true],
          ["Priority", f["priority"]],
          ["Purpose", f["purpose"]],
          ["For", f["ownerType"]],
          ["Owner", f["ownerName"]],
          ["Valid", valid],
        ]),
        muted(
          "Create this record at the DNS provider for the domain. SendGrid does not host your DNS.",
        ),
      ]),
    ],
  };
}

function renderApiKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const scopes = str(f["scopes"]);
  return {
    title: r.displayName,
    subtitle: "API key",
    status: {
      kind: "status-dot",
      status: f["inUse"] === true ? "healthy" : f["canCreateKeys"] === true ? "degraded" : "info",
      label:
        f["inUse"] === true
          ? "Used by this connection"
          : f["canCreateKeys"] === true
            ? "Admin-equivalent"
            : "API key",
    },
    sections: [
      section("Key", [
        kv([
          ["Name", f["name"]],
          ["Key ID", f["apiKeyId"], true],
          ["Scopes", f["scopeCount"]],
          ["Can create API keys", f["canCreateKeys"]],
          ["Used by this connection", f["inUse"]],
        ]),
        muted(
          "SendGrid only shows a key's secret when it is created. Deleting a key revokes it at once; the key this connection signs in with cannot be deleted from here.",
        ),
      ]),
      ...(scopes
        ? [
            section("Scopes", [
              {
                kind: "text" as const,
                variant: "mono" as const,
                content: scopes.split(", ").join("\n"),
              },
            ]),
          ]
        : []),
    ],
    headerActions: [openUrl("Open in SendGrid", `${APP}/settings/api_keys`)],
  };
}

function renderIp(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const warming = f["warmup"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Dedicated IP", f["pools"]),
    status: {
      kind: "status-dot",
      status: warming ? "provisioning" : "healthy",
      label: warming ? "Warming up" : "Active",
    },
    sections: [
      section("IP", [
        kv([
          ["IP address", f["ip"], true],
          ["Pools", f["pools"]],
          ["Warming up", f["warmup"]],
          ["Warmup started", f["warmupStartedAt"]],
          ["Reverse DNS", f["rdns"]],
          ["Subusers", f["subusers"]],
          ["Assigned", f["assignedAt"]],
        ]),
        muted(
          "Automatic warmup limits how much SendGrid sends from a new IP each hour and spills the rest onto shared IPs, so mailbox providers learn to trust it gradually.",
        ),
      ]),
    ],
    headerActions: [
      warming
        ? pluginAction("Stop warmup", "stop-warmup", {
            confirm: "Stop warming this IP? It sends at full volume immediately.",
            success: "Warmup stopped.",
          })
        : pluginAction("Start warmup", "start-warmup", { success: "Warmup started." }),
    ],
  };
}

function renderIpPool(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const ips = str(f["ips"]).split(", ").filter(Boolean);
  const available = parseJson<string[]>(r.resolvedOutputs[AVAILABLE_IPS_KEY]) ?? [];
  const actions: ActionNode[] = [];
  if (available.length > 0) {
    actions.push(
      prompt(
        "Add IP",
        COMMANDS.addPoolIp,
        "Add a dedicated IP to this pool",
        [
          {
            key: "ip",
            label: "IP",
            kind: "select",
            required: true,
            options: available.map((ip) => ({ id: ip, label: ip })),
          },
        ],
        "Add",
      ),
    );
  }
  if (ips.length > 0) {
    actions.push(
      prompt(
        "Remove IP",
        COMMANDS.removePoolIp,
        "Remove a dedicated IP from this pool",
        [
          {
            key: "ip",
            label: "IP",
            kind: "select",
            required: true,
            options: ips.map((ip) => ({ id: ip, label: ip })),
          },
        ],
        "Remove",
      ),
    );
  }
  return {
    title: r.displayName,
    subtitle: "IP pool",
    status: {
      kind: "status-dot",
      status: ips.length > 0 ? "healthy" : "degraded",
      label: `${ips.length} IPs`,
    },
    sections: [
      section("Pool", [
        kv([
          ["Name", f["name"]],
          ["IPs", ips.join(", ") || "None"],
        ]),
        muted('Send through a pool with "ip_pool_name" in the Mail Send request.'),
      ]),
    ],
    headerActions: actions,
  };
}

function renderSubuser(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stats = parseJson<SgMetrics>(r.resolvedOutputs[STATS_KEY]);
  const disabled = f["disabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Subuser", f["region"]),
    status: {
      kind: "status-dot",
      status: disabled ? "degraded" : "healthy",
      label: disabled ? "Disabled" : "Enabled",
    },
    sections: [
      section("Subuser", [
        kv([
          ["Username", f["username"], true],
          ["Email", f["email"]],
          ["Disabled", f["disabled"]],
          ["Region", f["region"]],
          ["Sender reputation", f["reputation"] !== undefined ? `${f["reputation"]}%` : ""],
        ]),
      ]),
      section("Credits", [
        kv([
          ["Allocation", f["creditType"]],
          ["Credits per period", count(f["creditTotal"])],
          ["Resets", f["creditResetFrequency"]],
          ["Used", count(f["creditUsed"])],
          ["Remaining", count(f["creditRemain"])],
        ]),
      ]),
      statsSection("Last 30 days", stats),
    ],
    headerActions: [
      disabled
        ? pluginAction("Enable", "enable", { success: "Subuser enabled." })
        : pluginAction("Disable", "disable", {
            danger: true,
            confirm:
              "Disable this subuser? It stops sending mail and cannot sign in until enabled again.",
            success: "Subuser disabled.",
          }),
    ],
  };
}

function renderEventWebhook(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const events = EVENT_KEYS.filter(([e]) => f[eventFieldKey(e)] === true).map(([, label]) => label);
  const enabled = f["enabled"] === true;
  return {
    title: r.displayName,
    subtitle: "Event Webhook",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "degraded",
      label: enabled ? `${events.length} events` : "Disabled",
    },
    sections: [
      section("Webhook", [
        kv([
          ["Name", f["friendlyName"]],
          ["URL", f["url"], true],
          ["Enabled", f["enabled"]],
          ["Events", events.join(", ") || "None"],
          ["Signature verification", f["signed"]],
          ["OAuth", f["oauth"]],
          ["Webhook ID", f["webhookId"], true],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    headerActions: [
      pluginAction("Send test event", "test", { success: "SendGrid posted a test event." }),
    ],
  };
}

function renderParse(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Inbound Parse",
    status: { kind: "status-dot", status: "info", label: "Receiving" },
    sections: [
      section("Inbound Parse", [
        kv([
          ["Receiving hostname", f["hostname"], true],
          ["Destination URL", f["url"], true],
          ["Spam check", f["spamCheck"]],
          ["Raw MIME", f["sendRaw"]],
        ]),
        muted(
          `Mail only arrives once ${str(f["hostname"]) || "the hostname"} has an MX record pointing at mx.sendgrid.net with priority 10.`,
        ),
      ]),
    ],
  };
}

function renderTemplate(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const versions = parseJson<VersionRow[]>(r.resolvedOutputs[VERSIONS_KEY]) ?? [];
  const sections: SectionNode[] = [
    section("Template", [
      kv([
        ["Name", f["name"]],
        ["Generation", f["generation"]],
        ["Active version", f["activeVersion"]],
        ["Active subject", f["subject"]],
        ["Versions", f["versionCount"]],
        ["Updated", f["updatedAt"]],
        ["Template ID", f["templateId"], true],
      ]),
    ]),
  ];
  if (versions.length > 0) {
    sections.push(
      section("Versions", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Version", width: "wide" },
            { key: "subject", label: "Subject", width: "wide" },
            { key: "active", label: "Active", width: "narrow" },
            { key: "editor", label: "Editor", width: "narrow" },
            { key: "updated", label: "Updated" },
          ],
          rows: versions.map<TableRow>((v) => ({
            cells: {
              name: str(v.name),
              subject: str(v.subject),
              active: v.active === 1 ? "Yes" : "No",
              editor: str(v.editor),
              updated: str(v.updated_at),
            },
          })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Template", f["generation"]),
    status: {
      kind: "status-dot",
      status: f["activeVersion"] ? "healthy" : "degraded",
      label: f["activeVersion"] ? "Active version set" : "No active version",
    },
    sections,
    headerActions: [
      openUrl(
        "Edit in SendGrid",
        `${APP}/dynamic_templates/${encodeURIComponent(str(f["templateId"]))}`,
      ),
    ],
  };
}

function renderGroup(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Unsubscribe group",
    status: {
      kind: "status-dot",
      status: "info",
      label: `${count(f["unsubscribes"] ?? 0)} unsubscribed`,
    },
    sections: [
      section("Group", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Default", f["isDefault"]],
          ["Unsubscribes", count(f["unsubscribes"])],
          ["Group ID", f["groupId"], true],
        ]),
        muted('Send with "asm": { "group_id": … } so recipients can opt out of just this group.'),
      ]),
    ],
    headerActions: [
      prompt(
        "Add addresses",
        COMMANDS.addGroupSuppressions,
        "Unsubscribe addresses from this group",
        [emailsField],
        "Add",
      ),
      prompt(
        "Remove addresses",
        COMMANDS.removeGroupSuppressions,
        "Resubscribe addresses to this group",
        [emailsField],
        "Remove",
      ),
    ],
  };
}

function renderSender(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const verified = f["verified"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Verified sender", f["nickname"]),
    status: {
      kind: "status-dot",
      status: verified ? "healthy" : "degraded",
      label: verified ? "Verified" : "Awaiting verification",
    },
    sections: [
      section("Sender", [
        kv([
          ["Nickname", f["nickname"]],
          ["From", f["fromEmail"], true],
          ["From name", f["fromName"]],
          ["Reply-To", f["replyTo"]],
          ["Reply-To name", f["replyToName"]],
          [
            "Address",
            [f["address"], f["address2"], f["city"], f["state"], f["zip"], f["country"]]
              .map(str)
              .filter(Boolean)
              .join(", "),
          ],
          ["Locked", f["locked"]],
        ]),
      ]),
    ],
    headerActions: verified
      ? []
      : [pluginAction("Resend verification", "resend", { success: "Verification email sent." })],
  };
}

function renderAlert(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Alert",
    status: {
      kind: "status-dot",
      status: "info",
      label: str(f["type"]) === "usage_limit" ? "Usage" : "Stats",
    },
    sections: [
      section("Alert", [
        kv([
          ["Type", str(f["type"]) === "usage_limit" ? "Usage limit" : "Stats summary"],
          ["Send to", f["emailTo"]],
          ["At percent used", f["percentage"]],
          ["Frequency", f["frequency"]],
        ]),
      ]),
    ],
  };
}

export function renderSendGridDetail(r: ResourceInstance): DetailViewSchema {
  const renderers: Record<string, (r: ResourceInstance) => DetailViewSchema> = {
    "sendgrid-account": renderAccount,
    "sendgrid-api-key": renderApiKey,
    "sendgrid-domain": renderDomain,
    "sendgrid-link-branding": renderLink,
    "sendgrid-reverse-dns": renderReverseDns,
    "sendgrid-dns-record": renderDnsRecord,
    "sendgrid-ip": renderIp,
    "sendgrid-ip-pool": renderIpPool,
    "sendgrid-subuser": renderSubuser,
    "sendgrid-event-webhook": renderEventWebhook,
    "sendgrid-inbound-parse": renderParse,
    "sendgrid-template": renderTemplate,
    "sendgrid-unsubscribe-group": renderGroup,
    "sendgrid-verified-sender": renderSender,
    "sendgrid-alert": renderAlert,
  };
  const render = renderers[r.resourceTypeId];
  const schema: DetailViewSchema = render
    ? render(r)
    : {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderSendGridSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "sendgrid-account":
      return item(creditStatus(f).status, creditStatus(f).label);
    case "sendgrid-domain":
    case "sendgrid-link-branding":
    case "sendgrid-reverse-dns":
      return f["valid"] === true ? item("healthy", "Verified") : item("error", "Not verified");
    case "sendgrid-dns-record":
      return f["valid"] === false
        ? item("degraded", "Not found")
        : item("healthy", str(f["type"]) || "Record");
    case "sendgrid-subuser":
      return f["disabled"] === true ? item("degraded", "Disabled") : item("healthy", "Enabled");
    case "sendgrid-event-webhook":
      return f["enabled"] === true ? item("healthy", "Enabled") : item("degraded", "Disabled");
    case "sendgrid-verified-sender":
      return f["verified"] === true ? item("healthy", "Verified") : item("degraded", "Unverified");
    case "sendgrid-ip":
      return f["warmup"] === true ? item("provisioning", "Warming up") : item("healthy", "Active");
    default:
      return item("info", str(r.resourceTypeId).replace("sendgrid-", ""));
  }
}
