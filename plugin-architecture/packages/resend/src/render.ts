import type {
  ActionNode,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { DASHBOARD_BASE } from "./api.js";
import {
  ACCOUNT,
  API_KEY,
  AUTOMATION,
  BROADCAST,
  CONTACT,
  CONTACT_PROPERTY,
  DNS_RECORD,
  DOMAIN,
  EMAIL,
  OAUTH_GRANT,
  RESOURCE_TYPES,
  SEGMENT,
  SUPPRESSION,
  TEMPLATE,
  TOPIC,
  WEBHOOK,
} from "./resource-types.js";

export const DEFAULT_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Keys `enrichDetail` stashes JSON under in `resolvedOutputs`. */
export const STASH = {
  records: "__records__",
  deliveries: "__deliveries__",
  steps: "__steps__",
  runs: "__runs__",
  contacts: "__contacts__",
} as const;

export interface DeliveryStash {
  id: string;
  type: string;
  status: string;
  createdAt: string;
}

export interface RecordStash {
  purpose: string;
  name: string;
  type: string;
  value: string;
  priority: string;
  status: string;
}

function parseStash<T>(resource: ResourceInstance, key: string): T | undefined {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const s = (r: ResourceInstance, key: string): string => {
  const v = r.fields[key];
  return v === undefined || v === null ? "" : String(v);
};
const dash = (v: string) => v || "—";
const yesNo = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : "—");

function kv(items: Array<[string, string]>, copyable: string[] = []): SchemaNode {
  return {
    kind: "key-value-list",
    items: items.map(([key, value]) => ({
      key,
      value: dash(value),
      ...(copyable.includes(key) && value ? { copyable: true } : {}),
    })),
  };
}

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});

const refresh: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function act(
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

const open = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function dot(status: ResourceStatus, label?: string): StatusDotNode {
  return { kind: "status-dot", status, ...(label ? { label } : {}) };
}

const human = (v: string) => v.replace(/_/g, " ");

export function statusFor(r: ResourceInstance): StatusDotNode {
  const status = s(r, "status");
  switch (r.resourceTypeId) {
    case ACCOUNT: {
      const used = Number(r.fields["emailsThisPeriod"] ?? 0);
      const limit = Number(r.fields["monthlyLimit"] ?? 0);
      if (limit > 0 && used >= limit)
        return dot("error", "Monthly email quota reached: sending is blocked");
      if (limit > 0 && used >= limit * 0.9)
        return dot(
          "degraded",
          `${Math.round((100 * used) / limit)}% of the monthly email quota used`,
        );
      return dot("healthy", "Active");
    }
    case DOMAIN:
      if (status === "verified") return dot("healthy", "Verified");
      if (status === "failed" || status === "partially_failed") {
        return dot("error", `Verification ${human(status)}: check the required DNS records`);
      }
      if (status === "not_started")
        return dot("degraded", "Verification not started: add the DNS records, then Verify");
      return dot("provisioning", `Verification ${human(status) || "pending"}`);
    case DNS_RECORD:
      if (status === "verified") return dot("healthy", "Verified");
      if (status === "failed") return dot("error", "Resend could not find this record");
      if (status === "temporary_failure")
        return dot("degraded", "Temporary lookup failure; Resend will retry");
      return dot("provisioning", human(status) || "Pending");
    case WEBHOOK:
      return status === "disabled"
        ? dot("degraded", "Disabled: receives no events")
        : dot("healthy", "Enabled");
    case EMAIL: {
      const ev = s(r, "lastEvent");
      if (["bounced", "failed", "complained"].includes(ev))
        return dot("error", `Last event: ${human(ev)}`);
      if (["suppressed", "delivery_delayed", "canceled"].includes(ev))
        return dot("degraded", `Last event: ${human(ev)}`);
      if (["queued", "scheduled", "sent"].includes(ev)) return dot("provisioning", human(ev));
      return dot("healthy", human(ev) || "Sent");
    }
    case BROADCAST:
      if (status === "sent") return dot("healthy", "Sent");
      if (status === "queued" || status === "scheduled" || status === "sending")
        return dot("provisioning", human(status));
      if (status === "failed") return dot("error", "Broadcast failed");
      return dot("info", human(status) || "Draft");
    case TEMPLATE:
      return status === "published"
        ? r.fields["hasUnpublishedVersions"] === true
          ? dot("info", "Published, with unpublished changes")
          : dot("healthy", "Published")
        : dot("info", "Draft");
    case AUTOMATION:
      return status === "enabled" ? dot("healthy", "Enabled") : dot("info", "Disabled");
    case CONTACT:
      return r.fields["unsubscribed"] === true
        ? dot("info", "Unsubscribed")
        : dot("healthy", "Subscribed");
    case SUPPRESSION:
      return dot("info", human(s(r, "origin")) || "Suppressed");
    case OAUTH_GRANT:
      return s(r, "revokedAt") ? dot("info", "Revoked") : dot("healthy", "Active");
    default:
      return dot("healthy");
  }
}

export function renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
  return { id: r.id, label: r.displayName, status: statusFor(r) };
}

export function renderDetail(r: ResourceInstance): DetailViewSchema {
  const base = renderBase(r);
  return withMetricsCapability(base, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

function renderBase(r: ResourceInstance): DetailViewSchema {
  const id = r.externalId ?? "";
  const header = (
    subtitle: string,
    sections: SectionNode[],
    actions: ActionNode[] = [],
  ): DetailViewSchema => ({
    title: r.displayName,
    subtitle,
    status: statusFor(r),
    sections,
    headerActions: [refresh, ...actions],
  });
  switch (r.resourceTypeId) {
    case ACCOUNT:
      return {
        ...header(
          "Resend Account",
          [
            section("Emails", [
              kv([
                ["Today", usage(r, "emailsToday", "dailyLimit")],
                ["This Billing Period", usage(r, "emailsThisPeriod", "monthlyLimit")],
                ["Sent This Period", s(r, "sentThisPeriod")],
                ["Received This Period", s(r, "receivedThisPeriod")],
                ["Period Resets", s(r, "periodResetsAt")],
              ]),
            ]),
            section("Plan Usage", [
              kv([
                ["Contacts", usage(r, "contacts", "contactsLimit")],
                ["Domains", usage(r, "domains", "domainsLimit")],
                ["Segments", usage(r, "segments", "segmentsLimit")],
                ["Broadcasts Sent", s(r, "broadcastsSent")],
                ["Automation Runs", usage(r, "automationRuns", "automationRunsLimit")],
                ["AI Credits", usage(r, "aiCredits", "aiCreditsLimit")],
                ["API Rate Limit", s(r, "rateLimit")],
              ]),
              {
                kind: "text",
                variant: "muted",
                content:
                  "Resend has no billing API, so spend stays in the Resend dashboard. The limits above also feed the Quotas page. The Logs tab shows API requests and sent and received emails.",
              },
            ]),
          ],
          [open("Billing", `${DASHBOARD_BASE}/settings/billing`)],
        ),
        logs: { defaultTailLines: 100 },
      };
    case DOMAIN: {
      const records = parseStash<RecordStash[]>(r, STASH.records);
      return header(
        joinSubtitle("Resend Domain", s(r, "region")),
        [
          section("Domain", [
            kv(
              [
                ["Domain", s(r, "name")],
                ["Status", human(s(r, "status"))],
                ["Region", s(r, "region")],
                ["Sending", s(r, "sending")],
                ["Receiving", s(r, "receiving")],
                ["Open Tracking", yesNo(r.fields["openTracking"])],
                ["Click Tracking", yesNo(r.fields["clickTracking"])],
                ["Tracking Subdomain", s(r, "trackingSubdomain")],
                ["TLS", s(r, "tls")],
                ["Domain ID", s(r, "domainId")],
                ["Created", s(r, "createdAt")],
              ],
              ["Domain ID"],
            ),
          ]),
          section(
            `DNS Records (${s(r, "recordsVerified") || "0"} of ${s(r, "recordsTotal") || "0"} verified)`,
            [
              records && records.length > 0
                ? {
                    kind: "table",
                    columns: [
                      { key: "purpose", label: "Purpose" },
                      { key: "type", label: "Type" },
                      { key: "name", label: "Host", mono: true },
                      { key: "value", label: "Value", mono: true, width: "wide" },
                      { key: "priority", label: "Priority", width: "narrow" },
                      { key: "status", label: "Status" },
                    ],
                    rows: records.map((rec): TableRow => ({
                      cells: {
                        purpose: rec.purpose,
                        type: rec.type,
                        name: rec.name,
                        value: rec.value,
                        priority: rec.priority,
                        status: human(rec.status),
                      },
                    })),
                  }
                : {
                    kind: "text",
                    variant: "muted",
                    content: "Open the domain's Required DNS Records to see each record.",
                  },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Resend does not host DNS. Create these records at your DNS provider, then use Verify. They also appear on the Domains page.",
              },
            ],
          ),
        ],
        [
          act("Verify", "verify", {
            success: "Verification started. Records can take a while to propagate.",
          }),
          open("Open in Resend", `${DASHBOARD_BASE}/domains/${id}`),
        ],
      );
    }
    case DNS_RECORD:
      return header(joinSubtitle("Resend DNS Record", s(r, "purpose")), [
        section("Record", [
          kv(
            [
              ["Purpose", s(r, "purpose")],
              ["Type", s(r, "type")],
              ["Host", s(r, "name")],
              ["Value", s(r, "content")],
              ["Priority", s(r, "priority")],
              ["TTL", s(r, "ttl") || "Auto"],
              ["Status", human(s(r, "status"))],
              ["Domain", s(r, "domainName")],
            ],
            ["Host", "Value"],
          ),
          {
            kind: "text",
            variant: "muted",
            content: "Create this record at your DNS provider, then use Verify on the domain.",
          },
        ]),
      ]);
    case API_KEY:
      return header("Resend API Key", [
        section("API Key", [
          kv(
            [
              ["Name", s(r, "name")],
              ["Last Used", s(r, "lastUsedAt") || "Never"],
              ["Created", s(r, "createdAt")],
              ["API Key ID", s(r, "apiKeyId")],
            ],
            ["API Key ID"],
          ),
          {
            kind: "text",
            variant: "muted",
            content:
              "Resend shows a key's token once, when it is created. Keys created from Infrawrench keep it as the Token output; others cannot be read back.",
          },
        ]),
      ]);
    case WEBHOOK: {
      const deliveries = parseStash<DeliveryStash[]>(r, STASH.deliveries);
      const disabled = s(r, "status") === "disabled";
      const failed = (deliveries ?? []).filter((d) => d.status === "failed").length;
      return {
        ...header(
          joinSubtitle("Resend Webhook", s(r, "status")),
          [
            section("Webhook", [
              kv(
                [
                  ["Endpoint", s(r, "endpoint")],
                  ["Status", s(r, "status")],
                  ["Webhook ID", s(r, "webhookId")],
                  ["Created", s(r, "createdAt")],
                ],
                ["Endpoint", "Webhook ID"],
              ),
            ]),
            section("Events", [
              {
                kind: "table",
                columns: [{ key: "event", label: "Event", mono: true }],
                rows: s(r, "events")
                  .split(",")
                  .map((e) => e.trim())
                  .filter(Boolean)
                  .map((event) => ({ cells: { event } })),
              },
            ]),
            ...(deliveries
              ? [
                  section(`Recent Deliveries${failed ? ` (${failed} failed)` : ""}`, [
                    deliveries.length === 0
                      ? {
                          kind: "text" as const,
                          variant: "muted" as const,
                          content: "No deliveries yet.",
                        }
                      : {
                          kind: "table" as const,
                          columns: [
                            { key: "createdAt", label: "Time" },
                            { key: "type", label: "Event" },
                            { key: "status", label: "Status" },
                            { key: "action", label: "" },
                          ],
                          rows: deliveries.map((d) => ({
                            cells: {
                              createdAt: d.createdAt,
                              type: d.type,
                              status: d.status,
                              action:
                                d.status === "failed"
                                  ? act("Replay", `replay:${d.id}`, { success: "Event replayed." })
                                  : "",
                            },
                          })),
                        },
                  ]),
                ]
              : []),
          ],
          [
            disabled
              ? act("Enable", "enable", { success: "Webhook enabled." })
              : act("Disable", "disable", {
                  confirm:
                    "Disable this webhook? Resend stops sending it events until you enable it again.",
                  success: "Webhook disabled.",
                }),
            act("Rotate signing secret", "rotate-secret", {
              confirm:
                "Rotate the signing secret? Signatures made with the old secret stop verifying, so update your receiver with the new Signing Secret output right away.",
              success: "Signing secret rotated.",
            }),
          ],
        ),
        logs: { defaultTailLines: 100 },
      };
    }
    case EMAIL: {
      const scheduled = s(r, "lastEvent") === "scheduled";
      return header(
        joinSubtitle("Resend Email", s(r, "lastEvent")),
        [
          section("Email", [
            kv(
              [
                ["Subject", s(r, "subject")],
                ["From", s(r, "from")],
                ["To", s(r, "to")],
                ["Cc", s(r, "cc")],
                ["Last Event", human(s(r, "lastEvent"))],
                ["Scheduled For", s(r, "scheduledAt")],
                ["Message-ID", s(r, "messageId")],
                ["Email ID", s(r, "emailId")],
                ["Created", s(r, "createdAt")],
              ],
              ["Email ID", "Message-ID"],
            ),
          ]),
        ],
        [
          ...(scheduled
            ? [
                act("Cancel", "cancel", {
                  confirm: "Cancel this scheduled email?",
                  success: "Email canceled.",
                  destructive: true,
                }),
              ]
            : []),
          open("Open in Resend", `${DASHBOARD_BASE}/emails/${id}`),
        ],
      );
    }
    case BROADCAST: {
      const status = s(r, "status");
      const draft = status === "draft" || status === "";
      return header(
        joinSubtitle("Resend Broadcast", status),
        [
          section("Broadcast", [
            kv(
              [
                ["Name", s(r, "name")],
                ["Subject", s(r, "subject")],
                ["From", s(r, "from")],
                ["Reply-To", s(r, "replyTo")],
                ["Preview Text", s(r, "previewText")],
                ["Segment", s(r, "segmentId")],
                ["Topic", s(r, "topicId")],
                ["Status", status],
                ["Scheduled For", s(r, "scheduledAt")],
                ["Sent", s(r, "sentAt")],
                ["Broadcast ID", s(r, "broadcastId")],
              ],
              ["Broadcast ID"],
            ),
          ]),
        ],
        [
          ...(draft
            ? [
                act("Send now", "send", {
                  confirm:
                    "Send this broadcast to every subscribed contact in its segment now? This cannot be undone.",
                  success: "Broadcast queued.",
                }),
              ]
            : []),
          ...(status === "scheduled"
            ? [
                act("Cancel", "cancel", {
                  confirm: "Cancel this scheduled broadcast? It returns to draft.",
                  success: "Broadcast canceled.",
                }),
              ]
            : []),
          act("Duplicate", "duplicate", { success: "Broadcast duplicated as a draft." }),
          open("Open in Resend", `${DASHBOARD_BASE}/broadcasts/${id}`),
        ],
      );
    }
    case TEMPLATE:
      return header(
        joinSubtitle("Resend Template", s(r, "status")),
        [
          section("Template", [
            kv(
              [
                ["Name", s(r, "name")],
                ["Alias", s(r, "alias")],
                ["From", s(r, "from")],
                ["Subject", s(r, "subject")],
                ["Status", s(r, "status")],
                ["Unpublished Changes", yesNo(r.fields["hasUnpublishedVersions"])],
                ["Published", s(r, "publishedAt")],
                ["Template ID", s(r, "templateId")],
                ["Updated", s(r, "updatedAt")],
              ],
              ["Template ID", "Alias"],
            ),
          ]),
        ],
        [
          act("Publish", "publish", { success: "Template published." }),
          act("Duplicate", "duplicate", { success: "Template duplicated." }),
          open("Open in Resend", `${DASHBOARD_BASE}/templates/${id}`),
        ],
      );
    case SEGMENT: {
      const contacts = parseStash<Array<{ email: string; unsubscribed: boolean }>>(
        r,
        STASH.contacts,
      );
      return header("Resend Segment", [
        section("Segment", [
          kv(
            [
              ["Name", s(r, "name")],
              ["Segment ID", s(r, "segmentId")],
              ["Created", s(r, "createdAt")],
            ],
            ["Segment ID"],
          ),
        ]),
        ...(contacts
          ? [
              section(
                `Contacts${contacts.length >= 100 ? " (first 100)" : ` (${contacts.length})`}`,
                [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "email", label: "Email" },
                      { key: "unsubscribed", label: "Unsubscribed" },
                    ],
                    rows: contacts.map((c) => ({
                      cells: { email: c.email, unsubscribed: yesNo(c.unsubscribed) },
                    })),
                  },
                ],
              ),
            ]
          : []),
      ]);
    }
    case TOPIC:
      return header("Resend Topic", [
        section("Topic", [
          kv(
            [
              ["Name", s(r, "name")],
              ["Description", s(r, "description")],
              ["Default", human(s(r, "defaultSubscription"))],
              ["Visibility", s(r, "visibility")],
              ["Topic ID", s(r, "topicId")],
            ],
            ["Topic ID"],
          ),
        ]),
      ]);
    case CONTACT:
      return header("Resend Contact", [
        section("Contact", [
          kv(
            [
              ["Email", s(r, "email")],
              ["First Name", s(r, "firstName")],
              ["Last Name", s(r, "lastName")],
              ["Unsubscribed", yesNo(r.fields["unsubscribed"])],
              ["Contact ID", s(r, "contactId")],
              ["Created", s(r, "createdAt")],
            ],
            ["Contact ID"],
          ),
        ]),
      ]);
    case CONTACT_PROPERTY:
      return header("Resend Contact Property", [
        section("Property", [
          kv([
            ["Key", s(r, "key")],
            ["Type", s(r, "type")],
            ["Fallback Value", s(r, "fallbackValue")],
            ["Created", s(r, "createdAt")],
          ]),
        ]),
      ]);
    case SUPPRESSION:
      return header("Resend Suppression", [
        section("Suppression", [
          kv([
            ["Email", s(r, "email")],
            ["Origin", s(r, "origin")],
            ["Source", s(r, "sourceId")],
            ["Created", s(r, "createdAt")],
          ]),
          {
            kind: "text",
            variant: "muted",
            content: "Delete the suppression to let Resend send to this address again.",
          },
        ]),
      ]);
    case AUTOMATION: {
      const steps = parseStash<Array<{ key: string; type: string; config: string }>>(
        r,
        STASH.steps,
      );
      const runs = parseStash<Array<{ id: string; status: string; createdAt: string }>>(
        r,
        STASH.runs,
      );
      const enabled = s(r, "status") === "enabled";
      return header(
        "Resend Automation",
        [
          section("Automation", [
            kv(
              [
                ["Name", s(r, "name")],
                ["Status", s(r, "status")],
                ["Automation ID", s(r, "automationId")],
                ["Updated", s(r, "updatedAt")],
              ],
              ["Automation ID"],
            ),
          ]),
          ...(steps && steps.length > 0
            ? [
                section("Steps", [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "key", label: "Step", mono: true },
                      { key: "type", label: "Type" },
                      { key: "config", label: "Configuration", mono: true, width: "wide" as const },
                    ],
                    rows: steps.map((st) => ({
                      cells: { key: st.key, type: human(st.type), config: st.config },
                    })),
                  },
                ]),
              ]
            : []),
          ...(runs && runs.length > 0
            ? [
                section("Recent Runs", [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "createdAt", label: "Started" },
                      { key: "status", label: "Status" },
                      { key: "id", label: "Run ID", mono: true },
                    ],
                    rows: runs.map((run) => ({
                      cells: { createdAt: run.createdAt, status: human(run.status), id: run.id },
                    })),
                  },
                ]),
              ]
            : []),
        ],
        [
          enabled
            ? act("Disable", "disable", { success: "Automation disabled." })
            : act("Enable", "enable", { success: "Automation enabled." }),
          act("Stop runs", "stop", {
            confirm: "Stop every run of this automation that is in progress?",
            success: "Runs stopped.",
            destructive: true,
          }),
          act("Duplicate", "duplicate", { success: "Automation duplicated." }),
        ],
      );
    }
    case OAUTH_GRANT:
      return header("Resend OAuth Grant", [
        section("Grant", [
          kv([
            ["App", s(r, "clientName")],
            ["Client ID", s(r, "clientId")],
            ["Scopes", s(r, "scopes")],
            ["Granted", s(r, "createdAt")],
            ["Revoked", s(r, "revokedAt")],
            ["Revoked Reason", s(r, "revokedReason")],
          ]),
        ]),
      ]);
    default:
      return header("Resend", [section("Details", [kv([["ID", id]])])]);
  }
}

function usage(r: ResourceInstance, usedKey: string, limitKey: string): string {
  const used = Number(r.fields[usedKey] ?? 0);
  const limit = Number(r.fields[limitKey] ?? 0);
  return limit > 0
    ? `${used.toLocaleString()} of ${limit.toLocaleString()}`
    : used.toLocaleString();
}
