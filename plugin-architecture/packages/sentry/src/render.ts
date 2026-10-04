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
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import type { UsageSummary } from "./cost-data.js";
import { DEFAULT_METRICS_WINDOW_MS, USAGE_METRICS_WINDOW_MS } from "./metrics.js";
import type { SentryRates } from "./rates.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes the organization's usage summary. */
export const USAGE_SUMMARY_KEY = "__usageSummary__";
/** Key under which `getResource` stashes a project's top unresolved issues. */
export const TOP_ISSUES_KEY = "__topIssues__";

export interface TopIssue {
  id: string;
  shortId: string;
  title: string;
  level: string;
  count: number;
  userCount: number;
  lastSeen: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown, digits = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const fmt = (n: number | undefined, digits = 0): string =>
  n === undefined ? "" : n.toLocaleString("en-US", { maximumFractionDigits: digits });

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

function openInSentry(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Sentry", action: { type: "open-url", url } }]
    : [];
}

function action(
  label: string,
  actionId: string,
  successMessage: string,
  confirmMessage?: string,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(confirmMessage ? { confirmMessage } : {}),
    },
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const humanise = (v: unknown): string => str(v).replace(/_/g, " ").toLowerCase();

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

function renderOrganization(r: ResourceInstance, rates: SentryRates): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<UsageSummary>(r.resolvedOutputs[USAGE_SUMMARY_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"]],
        ["Slug", f["slug"], true],
        ["Region", f["region"]],
        ["Status", f["status"]],
        ["Created", f["dateCreated"]],
      ]),
    ]),
  ];
  if (summary) {
    sections.push(
      section(`Usage this month (${summary.month})`, [
        {
          kind: "table",
          columns: [
            { key: "category", label: "Category", width: "wide" },
            { key: "accepted", label: "Accepted" },
            { key: "filtered", label: "Filtered" },
            { key: "rateLimited", label: "Rate limited" },
            { key: "billable", label: "Billable" },
            { key: "cost", label: "Estimated cost" },
          ],
          rows: summary.categories.map<TableRow>((c) => ({
            cells: {
              category: c.label,
              accepted: `${fmt(c.accepted, 2)} ${c.unit}`,
              filtered: fmt(c.filtered, 2),
              rateLimited: fmt(c.rateLimited, 2),
              billable: fmt(c.billable, 2),
              cost: c.cost !== undefined ? usd(c.cost) : "Enter a rate to estimate",
            },
          })),
        },
        kv([
          ["Plan fee", rates.planFee > 0 ? usd(rates.planFee) : ""],
          ["Estimated total", usd(summary.totalCost)],
        ]),
        {
          kind: "text",
          variant: "muted",
          content:
            "Estimated: Sentry's API reports usage but not prices or your contract. Each category's accepted volume beyond its included amount is priced at the rate in this connection's credentials (pay-as-you-go list prices by default), plus the monthly plan fee. Change the rates and included amounts to your plan's under Edit credentials.",
        },
      ]),
    );
    if (summary.byProject.length > 0) {
      sections.push(
        section("Accepted errors by project this month", [
          {
            kind: "table",
            columns: [
              { key: "project", label: "Project", width: "wide" },
              { key: "errors", label: "Errors" },
              { key: "spans", label: "Spans" },
              { key: "replays", label: "Replays" },
            ],
            rows: summary.byProject.map<TableRow>((p) => ({
              cells: {
                project: p.project,
                errors: fmt(p.errors),
                spans: fmt(p.spans),
                replays: fmt(p.replays),
              },
            })),
          },
        ]),
      );
    }
  } else if (r.resolvedOutputs[USAGE_SUMMARY_KEY] === undefined) {
    sections.push(
      section("Usage", [
        {
          kind: "text",
          variant: "muted",
          content:
            "Month-to-date usage and estimated cost load when this page is opened. If nothing appears, the token may lack the org:read scope needed for usage stats.",
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Organization", str(f["region"])),
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: openInSentry(r.resolvedOutputs["url"]),
  };
}

// ---------------------------------------------------------------------------
// Projects, teams, releases
// ---------------------------------------------------------------------------

function renderProject(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const issues = parseJson<TopIssue[]>(r.resolvedOutputs[TOP_ISSUES_KEY]) ?? [];
  const unresolved = typeof f["unresolvedIssues"] === "number" ? f["unresolvedIssues"] : undefined;
  const sections: SectionNode[] = [
    section("Last 24 hours", [
      kv([
        ["Events accepted", f["events24h"]],
        ["Events dropped (filtered or rate limited)", f["dropped24h"]],
        ["Unresolved issues", unresolved],
      ]),
    ]),
    section("Project", [
      kv([
        ["Platform", f["platform"]],
        ["Slug", f["slug"], true],
        ["Teams", f["teams"]],
        ["Status", f["status"]],
        ["First event", f["firstEvent"]],
        ["Created", f["dateCreated"]],
        ["Project ID", f["projectId"], true],
      ]),
    ]),
  ];
  if (issues.length > 0) {
    sections.push(
      section("Top unresolved issues (14 days)", [
        {
          kind: "table",
          columns: [
            { key: "issue", label: "Issue", width: "wide" },
            { key: "level", label: "Level" },
            { key: "events", label: "Events" },
            { key: "users", label: "Users" },
            { key: "lastSeen", label: "Last seen" },
            { key: "resolve", label: "" },
            { key: "archive", label: "" },
          ],
          rows: issues.map<TableRow>((i) => ({
            cells: {
              issue: `${i.shortId} ${i.title}`,
              level: i.level,
              events: fmt(i.count),
              users: fmt(i.userCount),
              lastSeen: i.lastSeen,
              resolve: action("Resolve", `resolve-issue:${i.id}`, "Issue resolved."),
              archive: action(
                "Archive",
                `archive-issue:${i.id}`,
                "Issue archived until it escalates.",
              ),
            },
          })),
        },
      ]),
    );
  } else if (unresolved === 0) {
    sections.push(
      section("Issues", [{ kind: "text", variant: "muted", content: "No unresolved issues." }]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Project", f["platform"]),
    status: {
      kind: "status-dot",
      status: unresolved && unresolved > 0 ? "degraded" : "healthy",
      label:
        unresolved !== undefined
          ? unresolved === 0
            ? "No unresolved issues"
            : `${fmt(unresolved)} unresolved`
          : "Project",
    },
    sections,
    headerActions: openInSentry(r.resolvedOutputs["url"]),
  };
}

function renderTeam(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Team",
    status: { kind: "status-dot", status: "info", label: "Team" },
    sections: [
      section("Team", [
        kv([
          ["Slug", f["slug"], true],
          ["Members", f["memberCount"]],
          ["Projects", f["projects"]],
          ["Created", f["dateCreated"]],
          ["Team ID", f["teamId"], true],
        ]),
      ]),
    ],
  };
}

function renderRelease(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const released = !!f["dateReleased"];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Release", f["projects"]),
    status: {
      kind: "status-dot",
      status: released ? "healthy" : "info",
      label: released ? "Released" : "Created",
    },
    sections: [
      section("Release", [
        kv([
          ["Version", f["version"], true],
          ["Projects", f["projects"]],
          ["Created", f["dateCreated"]],
          ["Released", f["dateReleased"]],
          ["New issues", f["newGroups"]],
          ["Commits", f["commitCount"]],
          ["Deploys", f["deployCount"]],
          ["Last deploy", joinSubtitle(f["lastDeployEnvironment"], f["lastDeployAt"])],
          ["Ref", f["ref"], true],
          ["URL", f["url"], true],
        ]),
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Issues and keys
// ---------------------------------------------------------------------------

export function levelStatus(level: string): ResourceStatus {
  switch (level) {
    case "fatal":
    case "error":
      return "error";
    case "warning":
      return "degraded";
    default:
      return "info";
  }
}

function renderIssue(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const actions: ActionNode[] =
    status === "unresolved" || status === ""
      ? [
          action("Resolve", "resolve", "Issue resolved."),
          action("Archive until escalating", "archive", "Issue archived until it escalates."),
          action(
            "Archive forever",
            "archive-forever",
            "Issue archived.",
            "Archive this issue for good? Sentry will not alert on it again even if it escalates.",
          ),
        ]
      : [action("Reopen", "unresolve", "Issue reopened.")];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Issue", f["shortId"], f["projectSlug"]),
    status: {
      kind: "status-dot",
      status:
        status === "resolved"
          ? "healthy"
          : status === "ignored"
            ? "unknown"
            : levelStatus(str(f["level"])),
      label: status === "ignored" ? "archived" : status || str(f["level"]) || "Issue",
    },
    sections: [
      section("Issue", [
        kv([
          ["Short ID", f["shortId"], true],
          ["Culprit", f["culprit"]],
          ["Level", f["level"]],
          [
            "Status",
            joinSubtitle(status === "ignored" ? "archived" : status, humanise(f["substatus"])),
          ],
          ["Priority", f["priority"]],
          ["Type", humanise(f["issueType"])],
          ["Events", f["count"]],
          ["Users affected", f["userCount"]],
          ["First seen", f["firstSeen"]],
          ["Last seen", f["lastSeen"]],
          ["Assignee", f["assignedTo"]],
          ["Project", f["projectSlug"]],
        ]),
      ]),
    ],
    headerActions: [...actions, ...openInSentry(r.resolvedOutputs["url"])],
  };
}

function renderClientKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const active = f["isActive"] !== false;
  const count = f["rateLimitCount"];
  const window = f["rateLimitWindow"];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Client key", f["projectSlug"]),
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "unknown",
      label: active ? "Enabled" : "Disabled",
    },
    sections: [
      section("Key", [
        kv([
          ["DSN", f["dsn"], true],
          ["Public key", f["publicKey"], true],
          [
            "Rate limit",
            count !== undefined && window !== undefined
              ? `${str(count)} events per ${str(window)} seconds`
              : "None",
          ],
          ["Project", f["projectSlug"]],
          ["Created", f["dateCreated"]],
          ["Key ID", f["keyId"], true],
        ]),
      ]),
    ],
    headerActions: [
      active
        ? action(
            "Disable",
            "disable",
            "Key disabled.",
            "Disable this key? SDKs using its DSN will have their events rejected until you enable it again.",
          )
        : action("Enable", "enable", "Key enabled."),
    ],
  };
}

// ---------------------------------------------------------------------------
// Alerts and monitors
// ---------------------------------------------------------------------------

function enableToggle(enabled: boolean, noun: string, disableConfirm: string): ActionNode {
  return enabled
    ? action("Disable", "disable", `${noun} disabled.`, disableConfirm)
    : action("Enable", "enable", `${noun} enabled.`);
}

function renderAlert(r: ResourceInstance, alertsUrl: string): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] !== false;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Alert", f["environment"]),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Alert", [
        kv([
          ["Triggers", f["triggers"]],
          ["Filters", f["filters"]],
          ["Actions", f["actions"]],
          ["Action interval", f["frequency"] !== undefined ? `${str(f["frequency"])} minutes` : ""],
          ["Environment", f["environment"]],
          ["Connected monitors", f["monitorCount"]],
          ["Last triggered", f["lastTriggered"] || "Never"],
          ["Owner", f["owner"]],
          ["Created", f["dateCreated"]],
          ["Alert ID", f["alertId"], true],
        ]),
      ]),
    ],
    headerActions: [
      enableToggle(
        enabled,
        "Alert",
        "Disable this alert? Its actions stop running until you enable it again.",
      ),
      ...openInSentry(alertsUrl),
    ],
  };
}

function renderMonitor(r: ResourceInstance, monitorsUrl: string): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] !== false;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Monitor", f["monitorType"], f["projectSlug"]),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Monitor", [
        kv([
          ["Type", f["monitorType"]],
          ["Aggregate", f["aggregate"], true],
          ["Filter", f["query"], true],
          ["Time window", f["timeWindow"] !== undefined ? `${str(f["timeWindow"])} minutes` : ""],
          ["Thresholds", f["thresholds"]],
          ["Environment", f["environment"]],
          ["Connected alerts", f["alertCount"]],
          ["Latest issue", f["latestIssue"]],
          ["Owner", f["owner"]],
          ["Project", f["projectSlug"]],
          ["Created", f["dateCreated"]],
          ["Monitor ID", f["monitorId"], true],
        ]),
      ]),
      ...(f["description"]
        ? [section("Description", [{ kind: "text" as const, content: str(f["description"]) }])]
        : []),
    ],
    headerActions: [
      enableToggle(
        enabled,
        "Monitor",
        "Disable this monitor? It stops opening issues until you enable it again.",
      ),
      ...openInSentry(monitorsUrl),
    ],
  };
}

export function cronStatus(f: ResourceInstance["fields"]): {
  status: ResourceStatus;
  label: string;
} {
  if (str(f["status"]) === "disabled") return { status: "unknown", label: "Paused" };
  const health = str(f["health"]);
  switch (health) {
    case "ok":
      return { status: "healthy", label: f["isMuted"] === true ? "OK (muted)" : "OK" };
    case "error":
      return { status: "error", label: "Failing" };
    default:
      return { status: "info", label: "Waiting for check-ins" };
  }
}

function renderCronMonitor(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const paused = str(f["status"]) === "disabled";
  const muted = f["isMuted"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Cron monitor", f["schedule"]),
    status: { kind: "status-dot", ...cronStatus(f) },
    sections: [
      section("Monitor", [
        kv([
          ["Schedule", f["schedule"], true],
          ["Timezone", f["timezone"]],
          [
            "Check-in margin",
            f["checkinMargin"] !== undefined ? `${str(f["checkinMargin"])} minutes` : "",
          ],
          ["Max runtime", f["maxRuntime"] !== undefined ? `${str(f["maxRuntime"])} minutes` : ""],
          ["Environments", f["environments"]],
          ["Last check-in", f["lastCheckIn"]],
          ["Next check-in", f["nextCheckIn"]],
          ["Muted", muted],
          ["Project", f["projectSlug"]],
          ["Slug", f["slug"], true],
        ]),
      ]),
    ],
    headerActions: [
      paused
        ? action("Resume", "resume", "Monitor resumed.")
        : action(
            "Pause",
            "pause",
            "Monitor paused.",
            "Pause this monitor? Sentry stops tracking its check-ins and raising missed or failed check-ins until you resume it.",
          ),
      muted
        ? action("Unmute", "unmute", "Alerts unmuted.")
        : action("Mute", "mute", "Alerts muted."),
    ],
  };
}

export function uptimeStatus(f: ResourceInstance["fields"]): {
  status: ResourceStatus;
  label: string;
} {
  if (str(f["status"]) === "disabled") return { status: "unknown", label: "Paused" };
  const up = str(f["uptimeStatus"]);
  if (up === "up") return { status: "healthy", label: "Up" };
  if (up === "down") return { status: "error", label: "Down" };
  return { status: "info", label: up || "Active" };
}

function renderUptimeMonitor(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const paused = str(f["status"]) === "disabled";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Uptime monitor", f["checkUrl"]),
    status: { kind: "status-dot", ...uptimeStatus(f) },
    sections: [
      section("Monitor", [
        kv([
          ["URL", f["checkUrl"], true],
          ["Method", f["method"]],
          [
            "Interval",
            f["intervalSeconds"] !== undefined ? `${str(f["intervalSeconds"])} seconds` : "",
          ],
          ["Timeout", f["timeoutMs"] !== undefined ? `${str(f["timeoutMs"])} ms` : ""],
          ["Environment", f["environment"]],
          ["Owner", f["owner"]],
          ["Project", f["projectSlug"]],
          ["Monitor ID", f["monitorId"], true],
        ]),
      ]),
    ],
    headerActions: [
      paused
        ? action("Resume", "resume", "Monitor resumed.")
        : action(
            "Pause",
            "pause",
            "Monitor paused.",
            "Pause this monitor? Sentry stops checking the URL until you resume it.",
          ),
    ],
  };
}

export interface RenderLinks {
  alerts: string;
  monitors: string;
}

export function renderSentryDetail(
  r: ResourceInstance,
  rates: SentryRates,
  links: RenderLinks,
): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs = DEFAULT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r, rates);
      windowMs = USAGE_METRICS_WINDOW_MS;
      break;
    case "project":
      schema = renderProject(r);
      break;
    case "team":
      schema = renderTeam(r);
      break;
    case "release":
      schema = renderRelease(r);
      break;
    case "issue":
      schema = renderIssue(r);
      break;
    case "client-key":
      schema = renderClientKey(r);
      break;
    case "alert":
      schema = renderAlert(r, links.alerts);
      break;
    case "monitor":
      schema = renderMonitor(r, links.monitors);
      break;
    case "cron-monitor":
      schema = renderCronMonitor(r);
      break;
    case "uptime-monitor":
      schema = renderUptimeMonitor(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderSentrySidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "project": {
      const n = f["unresolvedIssues"];
      if (typeof n !== "number") return item("info", "Project");
      return n > 0 ? item("degraded", `${fmt(n)} unresolved`) : item("healthy", "No issues");
    }
    case "issue":
      return item(levelStatus(str(f["level"])), str(f["level"]) || "Issue");
    case "client-key":
      return f["isActive"] === false ? item("unknown", "Disabled") : item("healthy", "Enabled");
    case "alert":
    case "monitor":
      return f["enabled"] === false ? item("unknown", "Disabled") : item("healthy", "Enabled");
    case "cron-monitor": {
      const s = cronStatus(f);
      return item(s.status, s.label);
    }
    case "uptime-monitor": {
      const s = uptimeStatus(f);
      return item(s.status, s.label);
    }
    case "release":
      return item(
        f["dateReleased"] ? "healthy" : "info",
        f["dateReleased"] ? "Released" : "Created",
      );
    case "organization":
      return item("healthy", "Organization");
    default:
      return item("info", "Team");
  }
}
