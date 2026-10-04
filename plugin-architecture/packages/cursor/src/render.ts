import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { ANALYTICS_API_DOCS, DASHBOARD_URL } from "./api.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) ? v : 0;
}

function usd(value: unknown): string {
  return `$${num(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function count(value: unknown): string {
  return num(value).toLocaleString("en-US");
}

function limit(value: unknown): string {
  return value === "" || value === undefined || value === null ? "None" : usd(value);
}

function refreshAction(): ActionNode {
  return { kind: "action", label: "Refresh", action: { type: "refresh-resource" } };
}

function dashboardAction(): ActionNode {
  return {
    kind: "action",
    label: "Open Cursor dashboard",
    action: { type: "open-url", url: DASHBOARD_URL },
    variant: "ghost",
  };
}

function kv(title: string, items: KVItem[], extra: SchemaNode[] = []): SectionNode {
  return { kind: "section", title, children: [{ kind: "key-value-list", items }, ...extra] };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function seatStatusDot(status: string): { status: ResourceStatus; label: string } {
  switch (status) {
    case "active":
      return { status: "healthy", label: "active" };
    case "idle":
      return { status: "degraded", label: "idle seat" };
    case "removed":
      return { status: "unknown", label: "removed" };
    default:
      return { status: "info", label: "unpaid admin" };
  }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface MemberRow {
  userId: string;
  name: string;
  email: string;
  joinedAt: string;
  spendUsd?: number;
}

function memberTable(rows: MemberRow[], withSpend: boolean): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "name", label: "Name" },
      { key: "email", label: "Email", mono: true },
      { key: "joined", label: "Joined", width: "narrow" },
      ...(withSpend ? [{ key: "spend", label: "Spend this cycle", width: "narrow" as const }] : []),
      { key: "remove", label: "", width: "narrow" },
    ],
    rows: rows.map((m): TableRow => ({
      cells: {
        name: m.name || "—",
        email: m.email,
        joined: m.joinedAt.slice(0, 10) || "—",
        ...(withSpend ? { spend: usd(m.spendUsd) } : {}),
        remove: {
          kind: "action",
          label: "Remove",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: `remove-from-group:${m.userId}`,
            confirmMessage: `Remove ${m.email || m.name} from this group?`,
            successMessage: "Member removed from the group",
            destructive: true,
          },
        },
      },
    })),
  };
}

function renderTeam(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const idle = num(f["idleSeats"]);
  return {
    title: "Cursor team",
    subtitle: `${count(f["members"])} members · ${count(f["paidSeats"])} paid seats`,
    status: {
      kind: "status-dot",
      status: idle > 0 ? "degraded" : "healthy",
      label: idle > 0 ? `${idle} idle seats` : "all seats active",
    },
    sections: [
      kv("Seats", [
        { key: "Members", value: count(f["members"]) },
        { key: "Paid seats", value: count(f["paidSeats"]) },
        { key: "Unpaid admins", value: count(f["unpaidAdmins"]) },
        { key: "Idle seats (no activity in 30 days)", value: count(f["idleSeats"]) },
        { key: "Active users (30 days)", value: count(f["activeUsers30d"]) },
      ]),
      kv(
        "Billing",
        [
          { key: "Billing cycle start", value: str(f["cycleStart"]) || "—" },
          { key: "Usage-based spend this cycle", value: usd(f["cycleSpendUsd"]) },
          { key: "Estimated seat cost per month", value: usd(f["estimatedSeatCostUsd"]) },
        ],
        [
          muted(
            "Seat cost is an estimate: Cursor's API does not report seat prices, so it uses the seat prices set on this account. Change them in the account settings.",
          ),
        ],
      ),
      kv(
        "Analytics",
        [
          {
            key: "Analytics and AI Code Tracking API",
            value: f["analyticsApi"] ? "Available" : "Not available",
          },
        ],
        f["analyticsApi"]
          ? []
          : [
              muted(
                "Agent edit and Tab acceptance, active users by surface and AI-attributed commit lines come from Cursor's Enterprise-only Analytics API. The metrics here use the daily usage data every team plan has.",
              ),
              { kind: "link", label: "About the Analytics API", url: ANALYTICS_API_DOCS },
            ],
      ),
    ],
    headerActions: [refreshAction(), dashboardAction()],
    logs: { defaultTailLines: 200 },
  };
}

function renderMember(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const dot = seatStatusDot(str(f["seatStatus"]));
  return {
    title: r.displayName,
    subtitle: str(f["email"]),
    status: { kind: "status-dot", ...dot },
    sections: [
      kv("Member", [
        { key: "User ID", value: r.externalId ?? "", copyable: true },
        { key: "Email", value: str(f["email"]), copyable: true },
        { key: "Role", value: str(f["role"]) || "—" },
        { key: "Seat", value: str(f["seat"]) },
        { key: "Last active", value: str(f["lastActiveAt"]) || "Not in the last 30 days" },
        { key: "Client version", value: str(f["clientVersion"]) || "—" },
      ]),
      kv("Last 30 days", [
        { key: "Active days", value: count(f["activeDays30d"]) },
        { key: "Requests", value: count(f["requests30d"]) },
        { key: "Accepted lines", value: count(f["acceptedLines30d"]) },
        { key: "Most used model", value: str(f["mostUsedModel"]) || "—" },
      ]),
      kv(
        "Spend",
        [
          { key: "Spend this cycle", value: usd(f["spendThisCycleUsd"]) },
          { key: "Premium requests this cycle", value: count(f["premiumRequests"]) },
          { key: "Member spend limit", value: limit(f["spendLimitDollars"]) },
          { key: "Team default limit", value: limit(f["teamLimitDollars"]) },
          { key: "Effective limit", value: limit(f["effectiveLimitDollars"]) },
        ],
        [
          muted(
            "Edit this member to set or clear their spend limit. Removing a member frees the seat at the end of the billing cycle.",
          ),
        ],
      ),
    ],
    headerActions: [refreshAction()],
  };
}

function renderModel(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Model · last 30 days",
    status: { kind: "status-dot", status: "healthy", label: `${count(f["requests30d"])} requests` },
    sections: [
      kv("Requests", [
        { key: "Requests", value: count(f["requests30d"]) },
        { key: "Included in plan", value: count(f["includedRequests30d"]) },
        { key: "Usage-based", value: count(f["usageBasedRequests30d"]) },
        { key: "Max Mode", value: count(f["maxModeRequests30d"]) },
        { key: "Members using it", value: count(f["users30d"]) },
        { key: "Last used", value: str(f["lastUsedAt"]) || "—" },
      ]),
      kv(
        "Tokens and spend",
        [
          { key: "Input tokens", value: count(f["inputTokens30d"]) },
          { key: "Output tokens", value: count(f["outputTokens30d"]) },
          { key: "Cache read tokens", value: count(f["cacheReadTokens30d"]) },
          { key: "Cache write tokens", value: count(f["cacheWriteTokens30d"]) },
          { key: "Token cost", value: usd(f["tokenCostUsd30d"]) },
          { key: "Usage-based spend", value: usd(f["usageBasedSpendUsd30d"]) },
        ],
        [
          muted(
            f["sampled"]
              ? "Token cost is what the requests would cost at the model's token prices; only usage-based requests are billed on top of the plan. This team has more than 20,000 events in 30 days, so these totals cover the most recent 20,000. The Costs page reads every event."
              : "Token cost is what the requests would cost at the model's token prices; only usage-based requests are billed on top of the plan.",
          ),
        ],
      ),
    ],
    headerActions: [refreshAction()],
  };
}

function renderBillingGroup(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const members = parseJson<MemberRow[]>(f["memberTable"], []);
  return {
    title: r.displayName,
    subtitle: "Billing group",
    status: { kind: "status-dot", status: "info", label: `${count(f["memberCount"])} members` },
    sections: [
      kv("Group", [
        { key: "Group ID", value: r.externalId ?? "", copyable: true },
        { key: "Spend this cycle", value: usd(f["spendThisCycleUsd"]) },
        { key: "Members", value: count(f["memberCount"]) },
        ...(str(f["directoryGroup"])
          ? [{ key: "Synced from directory group", value: str(f["directoryGroup"]) }]
          : []),
        { key: "Created", value: str(f["createdAt"]) || "—" },
      ]),
      {
        kind: "section",
        title: "Members",
        children: [
          members.length > 0
            ? memberTable(members, true)
            : muted("No members yet. Edit the group to add members by email."),
        ],
      },
    ],
    headerActions: [refreshAction()],
  };
}

function renderDirectoryGroup(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const members = parseJson<MemberRow[]>(f["memberTable"], []);
  return {
    title: r.displayName,
    subtitle: "Member group",
    status: {
      kind: "status-dot",
      status: "info",
      label: `limit ${limit(f["monthlySpendingLimitDollars"])}`,
    },
    sections: [
      kv("Group", [
        { key: "Group ID", value: r.externalId ?? "", copyable: true },
        { key: "Members", value: count(f["memberCount"]) },
        { key: "Monthly spending limit", value: limit(f["monthlySpendingLimitDollars"]) },
        { key: "Created", value: str(f["createdAt"]) || "—" },
        { key: "Updated", value: str(f["updatedAt"]) || "—" },
      ]),
      {
        kind: "section",
        title: "Members",
        children: [
          members.length > 0
            ? memberTable(members, false)
            : muted("No members yet. Edit the group to add members by email."),
        ],
      },
    ],
    headerActions: [refreshAction()],
  };
}

function renderBlocklist(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const patterns = str(f["patterns"])
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    title: r.displayName,
    subtitle: "Repository blocklist",
    status: { kind: "status-dot", status: "healthy", label: `${patterns.length} patterns` },
    sections: [
      kv("Repository", [
        { key: "URL", value: str(f["url"]), copyable: true },
        { key: "Blocklist ID", value: r.externalId ?? "", copyable: true },
      ]),
      {
        kind: "section",
        title: "Blocked patterns",
        children: [
          {
            kind: "table",
            columns: [{ key: "pattern", label: "Pattern", mono: true }],
            rows: patterns.map((pattern) => ({ cells: { pattern } })),
          },
          muted("Cursor will not index these files or send them to a model."),
        ],
      },
    ],
    headerActions: [refreshAction()],
  };
}

export function renderCursorDetail(r: ResourceInstance): DetailViewSchema {
  switch (r.resourceTypeId) {
    case "team":
      return renderTeam(r);
    case "team-member":
      return renderMember(r);
    case "model":
      return renderModel(r);
    case "billing-group":
      return renderBillingGroup(r);
    case "directory-group":
      return renderDirectoryGroup(r);
    case "repo-blocklist":
      return renderBlocklist(r);
    default:
      return {
        title: r.displayName,
        subtitle: r.resourceTypeId,
        status: { kind: "status-dot", status: "info" },
        sections: [{ kind: "section", title: "Details", children: [] }],
        headerActions: [refreshAction()],
      };
  }
}

export function renderCursorSidebarItem(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "team-member":
      return {
        id: r.id,
        label: r.displayName,
        status: { kind: "status-dot", ...seatStatusDot(str(f["seatStatus"])) },
      };
    case "model":
      return {
        id: r.id,
        label: r.displayName,
        status: { kind: "status-dot", status: "healthy", label: `${count(f["requests30d"])} req` },
      };
    case "team":
      return {
        id: r.id,
        label: r.displayName,
        status: {
          kind: "status-dot",
          status: num(f["idleSeats"]) > 0 ? "degraded" : "healthy",
          label: `${count(f["paidSeats"])} seats`,
        },
      };
    default:
      return { id: r.id, label: r.displayName, status: { kind: "status-dot", status: "info" } };
  }
}
