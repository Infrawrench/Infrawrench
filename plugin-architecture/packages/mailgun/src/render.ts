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
import { METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES, WEBHOOK_EVENTS, eventFieldKey } from "./resource-types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const STATS_KEY = "__stats30d__";
export const SUPPRESSIONS_KEY = "__suppressions__";
export const MEMBERS_KEY = "__members__";
export const AVAILABLE_IPS_KEY = "__availableIps__";
export const DOMAINS_KEY = "__domains__";
export const QUEUES_KEY = "__queues__";

export const COMMANDS = {
  addSuppressions: "add-suppressions",
  removeSuppressions: "remove-suppressions",
  addMembers: "add-members",
  removeMembers: "remove-members",
  addPoolIp: "add-pool-ip",
  removePoolIp: "remove-pool-ip",
  linkPoolDomain: "link-pool-domain",
} as const;

export const SUPPRESSION_LISTS = [
  { id: "bounces", label: "Bounces" },
  { id: "unsubscribes", label: "Unsubscribes" },
  { id: "complaints", label: "Complaints" },
  { id: "whitelists", label: "Allowlist" },
] as const;

export interface SuppressionRow {
  address?: string;
  value?: string;
  code?: string;
  error?: string;
  tags?: string[];
  created_at?: unknown;
  createdAt?: unknown;
}

export interface MemberRow {
  address?: string;
  name?: string;
  subscribed?: boolean;
}

export interface QueueStatus {
  regular?: { is_disabled?: boolean; disabled?: { until?: string; reason?: string } };
  scheduled?: { is_disabled?: boolean; disabled?: { until?: string; reason?: string } };
}

const APP = "https://app.mailgun.com";

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

function statsSection(stats: Record<string, number> | undefined): SectionNode {
  if (!stats) return section("Last 30 days", [muted("Metrics could not be read for this key.")]);
  const accepted = stats["accepted_outgoing_count"];
  return section("Last 30 days", [
    kv([
      ["Accepted", count(accepted ?? 0)],
      ["Delivered", count(stats["delivered_count"] ?? 0)],
      ["Delivery rate", pct(stats["delivered_count"], accepted)],
      ["Permanent failures", count(stats["permanent_failed_count"] ?? 0)],
      ["Temporary failures", count(stats["temporary_failed_count"] ?? 0)],
      ["Complaints", count(stats["complained_count"] ?? 0)],
      ["Complaint rate", pct(stats["complained_count"], stats["delivered_count"])],
      ["Unique opens", count(stats["unique_opened_count"] ?? 0)],
      ["Unique clicks", count(stats["unique_clicked_count"] ?? 0)],
      ["Unsubscribes", count(stats["unsubscribed_count"] ?? 0)],
    ]),
  ]);
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stats = parseJson<Record<string, number>>(r.resolvedOutputs[STATS_KEY]);
  const limit = Number(f["monthlyLimit"] ?? 0);
  const sent = Number(f["monthlySent"] ?? 0);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Mailgun account", f["regions"]),
    status: limitStatus(limit, sent),
    sections: [
      section("Account", [
        kv([
          ["Regions", f["regions"]],
          ["Domains", f["domainCount"]],
        ]),
      ]),
      section("Custom monthly limit", [
        kv([
          ["Limit", limit > 0 ? count(limit) : "None"],
          ["Sent this month", limit > 0 ? count(sent) : ""],
          ["Used", limit > 0 ? `${((sent / limit) * 100).toFixed(1)}%` : ""],
        ]),
        muted(
          "Edit the account to set or change the limit. Mailgun disables sending for the rest of the month once it is reached; the limit also feeds the Quotas page.",
        ),
      ]),
      statsSection(stats),
    ],
    headerActions: [
      { kind: "action", label: "Open in Mailgun", action: { type: "open-url", url: `${APP}/` } },
    ],
  };
}

function limitStatus(limit: number, sent: number) {
  const p = limit > 0 ? sent / limit : undefined;
  const status: ResourceStatus =
    p === undefined ? "healthy" : p >= 1 ? "error" : p >= 0.75 ? "degraded" : "healthy";
  return {
    kind: "status-dot" as const,
    status,
    label: p === undefined ? "No sending limit" : `${Math.round(p * 100)}% of monthly limit`,
  };
}

function domainStatus(f: ResourceInstance["fields"]) {
  const state = str(f["state"]);
  const status: ResourceStatus =
    f["disabled"] === true
      ? "error"
      : state === "active"
        ? "healthy"
        : state === "unverified"
          ? "degraded"
          : "info";
  return {
    kind: "status-dot" as const,
    status,
    label: f["disabled"] === true ? "Disabled" : state || "Domain",
  };
}

function renderDomain(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stats = parseJson<Record<string, number>>(r.resolvedOutputs[STATS_KEY]);
  const supp = parseJson<Record<string, SuppressionRow[]>>(r.resolvedOutputs[SUPPRESSIONS_KEY]);
  const queues = parseJson<QueueStatus>(r.resolvedOutputs[QUEUES_KEY]);
  const sections: SectionNode[] = [
    section("Domain", [
      kv([
        ["Domain", f["name"], true],
        ["Region", str(f["region"]).toUpperCase()],
        ["State", f["state"]],
        ["Type", f["type"]],
        ["Disabled", f["disabled"] === true ? str(f["disabledReason"]) || "Yes" : ""],
        ["Default SMTP login", f["smtpLogin"], true],
        ["Dedicated IP pool", f["ipPoolId"]],
        ["Subaccount", f["subaccountId"]],
        ["Created", f["createdAt"]],
      ]),
    ]),
    section("Tracking and security", [
      kv([
        ["Track opens", f["trackOpens"]],
        ["Track clicks", f["trackClicks"]],
        ["Unsubscribe links", f["trackUnsubscribes"]],
        ["Tracking scheme", f["webScheme"]],
        ["Tracking host", f["trackingHost"]],
        ["Automatic sender security", f["automaticSenderSecurity"]],
        ["Require TLS", f["requireTls"]],
        ["Skip TLS verification", f["skipVerification"]],
        ["Inbound spam action", f["spamAction"]],
        ["Accept subdomains", f["wildcard"]],
        ["Message retention (s)", f["messageTtl"]],
      ]),
    ]),
  ];
  if (queues && (queues.regular?.is_disabled || queues.scheduled?.is_disabled)) {
    sections.push(
      section("Sending paused", [
        kv([
          [
            "Regular queue",
            queues.regular?.is_disabled
              ? `${str(queues.regular.disabled?.reason)} until ${str(queues.regular.disabled?.until)}`
              : "Sending",
          ],
          [
            "Scheduled queue",
            queues.scheduled?.is_disabled
              ? `${str(queues.scheduled.disabled?.reason)} until ${str(queues.scheduled.disabled?.until)}`
              : "Sending",
          ],
        ]),
      ]),
    );
  }
  sections.push(statsSection(stats));
  const tabs = [];
  if (supp) {
    tabs.push({
      id: "suppressions",
      label: "Suppressions",
      sections: SUPPRESSION_LISTS.map((l) => {
        const rows = supp[l.id] ?? [];
        return section(l.label, [
          rows.length > 0
            ? {
                kind: "table" as const,
                columns: [
                  { key: "address", label: "Address", width: "wide" as const },
                  { key: "detail", label: "Detail", width: "wide" as const },
                  { key: "at", label: "Since" },
                ],
                rows: rows.slice(0, 50).map<TableRow>((s) => ({
                  cells: {
                    address: str(s.address ?? s.value),
                    detail: [s.code, s.error, (s.tags ?? []).join(", ")]
                      .map(str)
                      .filter(Boolean)
                      .join(" "),
                    at: str(s.created_at ?? s.createdAt),
                  },
                })),
              }
            : muted("None."),
        ]);
      }),
      headerActions: [
        prompt(
          "Add addresses",
          COMMANDS.addSuppressions,
          "Add addresses to a suppression list",
          [listField, emailsField],
          "Add",
          "Mailgun stops sending to bounced, unsubscribed and complained addresses. Allowlisted addresses are never added to the bounce list.",
        ),
        prompt(
          "Remove addresses",
          COMMANDS.removeSuppressions,
          "Remove addresses from a suppression list",
          [listField, emailsField],
          "Remove",
          "Mailgun may send to these addresses again.",
        ),
      ],
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Mailgun domain", str(f["region"]).toUpperCase()),
    status: domainStatus(f),
    sections,
    childTables: [
      {
        title: "DNS records",
        typeId: "mailgun-dns-record",
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
            key: "valid",
            label: "Valid",
            width: "narrow",
            source: { kind: "field", fieldKey: "valid" },
          },
        ],
        emptyText: "Mailgun returned no DNS records for this domain.",
        onRowClick: "navigate",
      },
    ],
    ...(tabs.length > 0 ? { customTabs: tabs } : {}),
    headerActions: [
      pluginAction("Verify DNS", "verify", { success: "Mailgun rechecked the DNS records." }),
      {
        kind: "action",
        label: "Open in Mailgun",
        action: {
          type: "open-url",
          url: `${APP}/mg/sending/${encodeURIComponent(str(f["name"]))}/settings`,
        },
      },
    ],
  };
}

const listField: CreateFieldConfig = {
  key: "list",
  label: "List",
  kind: "select",
  required: true,
  defaultValue: "bounces",
  options: SUPPRESSION_LISTS.map((l) => ({ id: l.id, label: l.label })),
};

function renderDnsRecord(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const valid = str(f["valid"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Required DNS record", f["domainName"]),
    status: {
      kind: "status-dot",
      status: valid === "valid" ? "healthy" : valid === "invalid" ? "error" : "degraded",
      label: valid || "Unknown",
    },
    sections: [
      section("Record", [
        kv([
          ["Type", f["type"]],
          ["Host", f["name"], true],
          ["Value", f["content"], true],
          ["Priority", f["priority"]],
          ["Purpose", f["purpose"]],
          ["Valid", valid],
          ["Currently published", f["cached"]],
          ["Domain", f["domainName"]],
        ]),
        muted(
          "Create this record at the DNS provider for the domain, then Verify DNS on the domain.",
        ),
      ]),
    ],
  };
}

function renderKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = f["disabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("API key", f["kind"], f["role"]),
    status: {
      kind: "status-dot",
      status: disabled ? "error" : "healthy",
      label: disabled ? "Disabled" : str(f["role"]) || "Active",
    },
    sections: [
      section("Key", [
        kv([
          ["Description", f["description"]],
          ["Kind", f["kind"]],
          ["Role", f["role"]],
          ["Domain", f["domainName"]],
          ["User", f["userName"]],
          ["Disabled", disabled ? str(f["disabledReason"]) || "Yes" : ""],
          ["Expires", f["expiresAt"]],
          ["Created", f["createdAt"]],
          ["Key ID", f["keyId"], true],
        ]),
        muted(
          "Mailgun shows a key's secret only when it is created, and a key's role cannot change. Deleting a key revokes it at once; make sure it is not the key this connection uses.",
        ),
      ]),
    ],
  };
}

function eventsOf(f: ResourceInstance["fields"]): string[] {
  return WEBHOOK_EVENTS.filter(([e]) => f[eventFieldKey(e)] === true).map(([, label]) => label);
}

function renderWebhook(r: ResourceInstance, account: boolean): DetailViewSchema {
  const f = r.fields;
  const events = eventsOf(f);
  return {
    title: r.displayName,
    subtitle: account ? "Account webhook" : joinSubtitle("Domain webhook", f["domainName"]),
    status: {
      kind: "status-dot",
      status: events.length > 0 ? "healthy" : "degraded",
      label: `${events.length} events`,
    },
    sections: [
      section("Webhook", [
        kv([
          ["URL", f["url"], true],
          ["Description", f["description"]],
          ["Domain", f["domainName"]],
          ["Events", events.join(", ") || "None"],
          ["Webhook ID", f["webhookId"], true],
          ["Created", f["createdAt"]],
        ]),
        muted("Verify requests with the account's webhook signing key (an output of the account)."),
      ]),
    ],
  };
}

function renderRoute(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Route", str(f["region"]).toUpperCase()),
    status: { kind: "status-dot", status: "info", label: `Priority ${str(f["priority"]) || "0"}` },
    sections: [
      section("Route", [
        kv([
          ["Description", f["description"]],
          ["Priority", f["priority"]],
          ["Route ID", f["routeId"], true],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Filter", [
        { kind: "text", variant: "mono", content: str(f["expression"]), copyable: true },
      ]),
      section("Actions", [{ kind: "text", variant: "mono", content: str(f["actions"]) || "None" }]),
    ],
  };
}

function renderList(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const members = parseJson<MemberRow[]>(r.resolvedOutputs[MEMBERS_KEY]);
  const sections: SectionNode[] = [
    section("Mailing list", [
      kv([
        ["Address", f["address"], true],
        ["Name", f["name"]],
        ["Description", f["description"]],
        ["Who can post", f["accessLevel"]],
        ["Replies go to", f["replyPreference"]],
        ["Members", count(f["membersCount"])],
        ["Created", f["createdAt"]],
      ]),
    ]),
  ];
  if (members) {
    sections.push(
      section("Members", [
        members.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "address", label: "Address", width: "wide" },
                { key: "name", label: "Name" },
                { key: "subscribed", label: "Subscribed", width: "narrow" },
              ],
              rows: members.map<TableRow>((m) => ({
                cells: {
                  address: str(m.address),
                  name: str(m.name),
                  subscribed: m.subscribed === false ? "No" : "Yes",
                },
              })),
            }
          : muted("No members."),
        muted("The first 100 members."),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Mailing list", str(f["region"]).toUpperCase()),
    status: {
      kind: "status-dot",
      status: "info",
      label: `${count(f["membersCount"] ?? 0)} members`,
    },
    sections,
    headerActions: [
      prompt(
        "Add members",
        COMMANDS.addMembers,
        "Add members",
        [emailsField],
        "Add",
        "Existing members are updated rather than duplicated.",
      ),
      prompt("Remove members", COMMANDS.removeMembers, "Remove members", [emailsField], "Remove"),
    ],
  };
}

function renderCredential(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("SMTP credential", f["domainName"]),
    status: { kind: "status-dot", status: "info", label: "SMTP login" },
    sections: [
      section("Credential", [
        kv([
          ["Login", f["login"], true],
          ["SMTP host", r.resolvedOutputs["smtpHost"], true],
          ["Ports", "587 or 2525 (STARTTLS), 465 (TLS)"],
          ["Domain", f["domainName"]],
          ["Created", f["createdAt"]],
        ]),
        muted("Mailgun never returns a password. Edit the credential to set a new one."),
      ]),
    ],
  };
}

function renderPool(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const ips = str(f["ips"]).split(", ").filter(Boolean);
  const available = parseJson<string[]>(r.resolvedOutputs[AVAILABLE_IPS_KEY]) ?? [];
  const domains = parseJson<string[]>(r.resolvedOutputs[DOMAINS_KEY]) ?? [];
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
  if (domains.length > 0) {
    actions.push(
      prompt(
        "Link domain",
        COMMANDS.linkPoolDomain,
        "Send a domain through this pool",
        [
          {
            key: "domain",
            label: "Domain",
            kind: "select",
            required: true,
            options: domains.map((d) => ({ id: d, label: d })),
          },
        ],
        "Link",
      ),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Dedicated IP pool",
    status: {
      kind: "status-dot",
      status: ips.length > 0 ? "healthy" : "degraded",
      label: `${ips.length} IPs`,
    },
    sections: [
      section("Pool", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["IPs", ips.join(", ") || "None"],
          ["Linked to domains", f["linked"]],
          ["Inherited from parent", f["inherited"]],
          ["Pool ID", f["poolId"], true],
        ]),
      ]),
    ],
    headerActions: actions,
  };
}

function renderIp(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: f["dedicated"] === true ? "Dedicated IP" : "Shared IP",
    status: {
      kind: "status-dot",
      status:
        f["enabled"] === false ? "degraded" : f["warmingUp"] === true ? "provisioning" : "healthy",
      label:
        f["enabled"] === false ? "Disabled" : f["warmingUp"] === true ? "Warming up" : "Active",
    },
    sections: [
      section("IP", [
        kv([
          ["IP address", f["ip"], true],
          ["Dedicated", f["dedicated"]],
          ["Enabled", f["enabled"]],
          ["Warming up", f["warmingUp"]],
          ["Pools", f["pools"]],
        ]),
      ]),
    ],
  };
}

function renderTag(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Tag",
    status: { kind: "status-dot", status: "info", label: "Tag" },
    sections: [
      section("Tag", [
        kv([
          ["Tag", f["tag"], true],
          ["Description", f["description"]],
          ["First seen", f["firstSeen"]],
          ["Last seen", f["lastSeen"]],
        ]),
      ]),
    ],
  };
}

function renderSubaccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const limit = Number(f["monthlyLimit"] ?? 0);
  return {
    title: r.displayName,
    subtitle: "Subaccount",
    status: {
      kind: "status-dot",
      status: status === "open" ? "healthy" : status === "disabled" ? "degraded" : "info",
      label: status || "Subaccount",
    },
    sections: [
      section("Subaccount", [
        kv([
          ["Name", f["name"]],
          ["Status", status],
          ["Custom monthly limit", limit > 0 ? count(limit) : "None"],
          ["Sent this month", limit > 0 ? count(f["monthlySent"]) : ""],
          ["Subaccount ID", f["subaccountId"], true],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    headerActions:
      status === "disabled"
        ? [pluginAction("Enable", "enable", { success: "Subaccount enabled." })]
        : status === "open"
          ? [
              pluginAction("Disable", "disable", {
                danger: true,
                confirm: "Disable this subaccount? It stops sending until enabled again.",
                success: "Subaccount disabled.",
              }),
            ]
          : [],
  };
}

export function renderMailgunDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "mailgun-account":
      schema = renderAccount(r);
      break;
    case "mailgun-domain":
      schema = renderDomain(r);
      break;
    case "mailgun-dns-record":
      schema = renderDnsRecord(r);
      break;
    case "mailgun-api-key":
      schema = renderKey(r);
      break;
    case "mailgun-webhook":
      schema = renderWebhook(r, false);
      break;
    case "mailgun-account-webhook":
      schema = renderWebhook(r, true);
      break;
    case "mailgun-route":
      schema = renderRoute(r);
      break;
    case "mailgun-mailing-list":
      schema = renderList(r);
      break;
    case "mailgun-smtp-credential":
      schema = renderCredential(r);
      break;
    case "mailgun-ip-pool":
      schema = renderPool(r);
      break;
    case "mailgun-ip":
      schema = renderIp(r);
      break;
    case "mailgun-tag":
      schema = renderTag(r);
      break;
    case "mailgun-subaccount":
      schema = renderSubaccount(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderMailgunSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "mailgun-account": {
      const s = limitStatus(Number(f["monthlyLimit"] ?? 0), Number(f["monthlySent"] ?? 0));
      return item(s.status, s.label);
    }
    case "mailgun-domain": {
      const s = domainStatus(f);
      return item(s.status, s.label);
    }
    case "mailgun-dns-record":
      return str(f["valid"]) === "valid"
        ? item("healthy", str(f["type"]))
        : item("degraded", str(f["valid"]) || "Unknown");
    case "mailgun-api-key":
      return f["disabled"] === true
        ? item("error", "Disabled")
        : item("healthy", str(f["role"]) || "Key");
    case "mailgun-subaccount":
      return item(
        str(f["status"]) === "open" ? "healthy" : "degraded",
        str(f["status"]) || "Subaccount",
      );
    default:
      return item("info", str(r.resourceTypeId).replace("mailgun-", ""));
  }
}
