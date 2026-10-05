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
import type { UsageBreakdownLine } from "./cost-data.js";
import { consoleUrl } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, SPEND_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `enrichDetail` stashes data the synchronous renderer needs. */
export const BREAKDOWN_KEY = "__usageBreakdown__";
export const CREDITS_KEY = "__credits__";
export const SPEND_KEY = "__spend__";

export interface OrgBreakdown {
  fromDate: string;
  toDate: string;
  byType: UsageBreakdownLine[];
  byProject: UsageBreakdownLine[];
  byUser: UsageBreakdownLine[];
}

export interface CreditLine {
  name: string;
  kind: "Credit" | "Commit";
  status: "In use" | "Pending" | "Expired";
  balance: number;
  granted: number;
  start: string;
  end: string;
}

export interface CreditSummary {
  balance: number;
  spent: number;
  granted: number;
  lines: CreditLine[];
}

export interface WorkloadSpend {
  fromDate: string;
  dollars: number;
  credits: number;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
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

function openInConsole(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Anyscale", action: { type: "open-url", url } }]
    : [];
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function workspaceStatus(state: string): ResourceStatus {
  if (state === "Running") return "healthy";
  if (/Errored$/.test(state)) return "error";
  if (["StartingUp", "AwaitingStartup", "AwaitingFileMounts", "Updating"].includes(state)) {
    return "provisioning";
  }
  if (["Stopping", "Terminating"].includes(state)) return "info";
  return "unknown";
}

export function jobStatus(state: string): ResourceStatus {
  switch (state) {
    case "RUNNING":
      return "healthy";
    case "SUCCESS":
      return "info";
    case "ERRORED":
    case "BROKEN":
    case "OUT_OF_RETRIES":
      return "error";
    case "RESTARTING":
      return "degraded";
    case "PENDING":
    case "AWAITING_CLUSTER_START":
    case "UPDATING":
      return "provisioning";
    default:
      return "unknown";
  }
}

export function serviceStatus(state: string): ResourceStatus {
  switch (state) {
    case "RUNNING":
      return "healthy";
    case "UNHEALTHY":
      return "degraded";
    case "SYSTEM_FAILURE":
    case "USER_ERROR_FAILURE":
      return "error";
    case "STARTING":
    case "UPDATING":
    case "ROLLING_OUT":
    case "ROLLING_BACK":
      return "provisioning";
    default:
      return "unknown";
  }
}

function breakdownTable(title: string, lines: UsageBreakdownLine[]): SchemaNode[] {
  if (lines.length === 0) return [];
  return [
    { kind: "text", variant: "muted", content: title },
    {
      kind: "table",
      columns: [
        { key: "label", label: "Name", width: "wide" },
        { key: "usd", label: "Spend" },
        { key: "credits", label: "Credits" },
      ],
      rows: lines.slice(0, 25).map<TableRow>((l) => ({
        cells: { label: l.label, usd: usd(l.dollars), credits: num(l.credits) },
      })),
    },
  ];
}

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const breakdown = parseJson<OrgBreakdown>(r.resolvedOutputs[BREAKDOWN_KEY]);
  const credits = parseJson<CreditSummary>(r.resolvedOutputs[CREDITS_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"] ?? r.displayName],
        ["Organization ID", f["organizationId"], true],
        ["Your role", f["permissionLevel"]],
        ["SSO", f["ssoMode"]],
      ]),
    ]),
    section("Spend this month", [
      kv([["Month to date", usd(f["monthToDate"])]]),
      muted(
        "Anyscale's own charges at your contracted rate, as estimated by its usage dashboard. On a customer-hosted cloud this is the platform fee only; the machines are billed under your cloud provider account.",
      ),
      ...(breakdown
        ? [
            ...breakdownTable("By workload type", breakdown.byType),
            ...breakdownTable("By project", breakdown.byProject),
            ...breakdownTable("By user", breakdown.byUser),
          ]
        : f["monthToDate"] === undefined
          ? [muted("Usage and cost are visible to organization owners only.")]
          : []),
    ]),
  ];
  if (credits) {
    sections.push(
      section("Credits", [
        kv([
          ["Current balance", usd(credits.balance)],
          ["Spent", usd(credits.spent)],
          ["Granted", usd(credits.granted)],
        ]),
        ...(credits.lines.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "name", label: "Grant", width: "wide" as const },
                  { key: "kind", label: "Type" },
                  { key: "status", label: "Status" },
                  { key: "balance", label: "Balance" },
                  { key: "granted", label: "Granted" },
                  { key: "period", label: "Valid" },
                ],
                rows: credits.lines.map<TableRow>((l) => ({
                  cells: {
                    name: l.name,
                    kind: l.kind,
                    status: l.status,
                    balance: usd(l.balance),
                    granted: usd(l.granted),
                    period: [l.start, l.end].filter(Boolean).join(" to "),
                  },
                })),
              },
            ]
          : [muted("No credit grants or prepaid commits: this organization pays as it goes.")]),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Organization",
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: openInConsole(consoleUrl.home()),
  };
}

function renderCloud(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const hosted = f["hosting"] === "Anyscale-hosted";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Cloud", f["provider"], f["region"]),
    status: {
      kind: "status-dot",
      status: f["state"] === "ACTIVE" ? "healthy" : f["state"] ? "degraded" : "unknown",
      label: str(f["state"]) || "Cloud",
    },
    sections: [
      section("Cloud", [
        kv([
          ["Name", f["name"]],
          ["Cloud ID", f["cloudId"], true],
          ["Hosting", f["hosting"]],
          ["Provider", f["provider"]],
          ["Compute stack", f["computeStack"]],
          ["Region", f["region"]],
          ["State", f["state"]],
          ["Default cloud", f["isDefault"]],
          ["Running clusters", f["runningClusters"]],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
        ]),
        muted(
          hosted
            ? "Anyscale-hosted: Anyscale runs the machines, and its charges include the compute."
            : "Customer cloud: the machines run in your own account and are billed by that provider. Anyscale's charges for this cloud are its platform fee only.",
        ),
      ]),
    ],
    headerActions: openInConsole(r.resolvedOutputs["url"]),
  };
}

function renderProject(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Project", f["cloudName"]),
    status: { kind: "status-dot", status: "healthy", label: "Project" },
    sections: [
      section("Project", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Cloud", f["cloudName"] ?? f["cloudId"]],
          ["Default project", f["isDefault"]],
          ["Owners", f["owners"]],
          ["Project ID", f["projectId"], true],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    headerActions: openInConsole(r.resolvedOutputs["url"]),
  };
}

function spendSection(r: ResourceInstance): SectionNode[] {
  const spend = parseJson<WorkloadSpend>(r.resolvedOutputs[SPEND_KEY]);
  if (!spend) return [];
  return [
    section(`Anyscale spend since ${spend.fromDate}`, [
      kv([
        ["Spend", usd(spend.dollars)],
        ["Credits", num(spend.credits)],
      ]),
    ]),
  ];
}

function renderWorkspace(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const running = ["Running", "Updating"].includes(state);
  const startable = ["Terminated", "Stopped", "StartupErrored", "TerminatingErrored"].includes(
    state,
  );
  const actions: ActionNode[] = [];
  if (startable) {
    actions.push({
      kind: "action",
      label: "Start",
      action: {
        type: "plugin-action",
        actionId: "start",
        confirmMessage:
          "Start this workspace? Its cluster launches and begins accruing Anyscale and cloud charges.",
        successMessage: "Workspace starting.",
      },
    });
  }
  if (running || ["StartingUp", "AwaitingStartup", "AwaitingFileMounts"].includes(state)) {
    actions.push({
      kind: "action",
      label: "Terminate",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "terminate",
        confirmMessage:
          "Terminate this workspace's cluster? Running processes and anything not saved to persistent storage stop. You can start the workspace again later.",
        successMessage: "Workspace terminating.",
      },
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Workspace", f["projectName"]),
    status: { kind: "status-dot", status: workspaceStatus(state), label: state || "Workspace" },
    sections: [
      section("Workspace", [
        kv([
          ["State", state],
          ["Activity", f["activity"]],
          ["Idle since", f["idleSince"]],
          [
            "Idle termination",
            f["idleTerminationMinutes"] ? `${str(f["idleTerminationMinutes"])} min` : "",
          ],
          ["Project", f["projectName"] ?? f["projectId"]],
          ["Compute config", f["computeConfigId"], true],
          ["Ray version", f["rayVersion"]],
          ["Created by", f["creator"]],
          ["Last started", f["lastStartedAt"]],
          ["Created", f["createdAt"]],
          ["Workspace ID", f["workspaceId"], true],
        ]),
      ]),
      ...spendSection(r),
    ],
    headerActions: [...actions, ...openInConsole(r.resolvedOutputs["url"])],
  };
}

const JOB_ACTIVE = new Set([
  "PENDING",
  "AWAITING_CLUSTER_START",
  "UPDATING",
  "RUNNING",
  "RESTARTING",
]);

function renderJob(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Job", f["projectName"]),
    status: { kind: "status-dot", status: jobStatus(state), label: state || "Job" },
    sections: [
      section("Job", [
        kv([
          ["State", state],
          ["Goal state", f["goalState"]],
          ["Last run", f["lastRunStatus"]],
          ["Error", f["error"]],
          ["Project", f["projectName"] ?? f["projectId"]],
          ["Entrypoint", f["entrypoint"], true],
          ["Image", f["image"], true],
          ["Compute config", f["computeConfigId"], true],
          ["Max retries", f["maxRetries"]],
          ["Timeout", f["timeoutSeconds"] ? `${str(f["timeoutSeconds"])} s` : ""],
          ["Schedule", f["schedule"]],
          ["Job queue", f["jobQueue"]],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
          ["Job ID", f["jobId"], true],
        ]),
      ]),
      ...spendSection(r),
    ],
    headerActions: [
      ...(JOB_ACTIVE.has(state)
        ? [
            {
              kind: "action" as const,
              label: "Terminate",
              variant: "danger" as const,
              action: {
                type: "plugin-action" as const,
                actionId: "terminate",
                confirmMessage: "Terminate this job? The current run stops and is not retried.",
                successMessage: "Job terminating.",
              },
            },
          ]
        : []),
      ...openInConsole(r.resolvedOutputs["url"]),
    ],
  };
}

function renderService(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const actions: ActionNode[] = [];
  if (state === "ROLLING_OUT") {
    actions.push({
      kind: "action",
      label: "Roll back",
      action: {
        type: "plugin-action",
        actionId: "rollback",
        confirmMessage:
          "Roll back this rollout? Traffic moves back to the primary version and the canary is torn down.",
        successMessage: "Rollback started.",
      },
    });
  }
  if (state !== "TERMINATED" && state !== "TERMINATING") {
    actions.push({
      kind: "action",
      label: "Terminate",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "terminate",
        confirmMessage:
          "Terminate this service? Its endpoint stops answering requests and every version's cluster shuts down.",
        successMessage: "Service terminating.",
      },
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Service", f["primaryVersion"]),
    status: { kind: "status-dot", status: serviceStatus(state), label: state || "Service" },
    sections: [
      section("Service", [
        kv([
          ["State", state],
          ["Goal state", f["goalState"]],
          ["Error", f["error"]],
          ["Endpoint", f["baseUrl"], true],
          ["Auto rollout", f["autoRollout"]],
          ["Compute config", f["computeConfigId"], true],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
          ["Service ID", f["serviceId"], true],
        ]),
      ]),
      section("Rollout", [
        kv([
          ["Status", f["rollout"]],
          ["Primary version", f["primaryVersion"]],
          [
            "Primary traffic",
            f["primaryWeight"] !== undefined ? `${str(f["primaryWeight"])}%` : "",
          ],
          ["Canary version", f["canaryVersion"]],
          ["Canary traffic", f["canaryWeight"] !== undefined ? `${str(f["canaryWeight"])}%` : ""],
        ]),
      ]),
      ...spendSection(r),
    ],
    headerActions: [...actions, ...openInConsole(r.resolvedOutputs["url"])],
  };
}

function renderComputeConfig(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Compute config", f["version"] ? `v${str(f["version"])}` : ""),
    status: { kind: "status-dot", status: "info", label: "Compute config" },
    sections: [
      section("Nodes", [
        kv([
          ["Head node", f["headNodeType"]],
          ["Worker nodes", f["workerNodeTypes"]],
          ["Max workers", f["maxWorkers"]],
          ["Uses spot", f["usesSpot"]],
          ["Region", f["region"]],
        ]),
      ]),
      section("Termination", [
        kv([
          [
            "Idle termination",
            f["idleTerminationMinutes"] ? `${str(f["idleTerminationMinutes"])} min` : "Off",
          ],
          [
            "Maximum uptime",
            f["maximumUptimeMinutes"] ? `${str(f["maximumUptimeMinutes"])} min` : "Unlimited",
          ],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
          ["Compute config ID", f["computeConfigId"], true],
        ]),
      ]),
    ],
    headerActions: openInConsole(r.resolvedOutputs["url"]),
  };
}

function renderBudget(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] !== false;
  const pct = typeof f["percentUsed"] === "number" ? f["percentUsed"] : undefined;
  const unit = f["budgetUnit"] === "DOLLARS" ? "USD" : "credits";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Budget", f["scope"]),
    status: {
      kind: "status-dot",
      status: !enabled ? "unknown" : pct !== undefined && pct >= 100 ? "error" : "healthy",
      label: !enabled ? "Disabled" : pct !== undefined ? `${pct}% used` : "Enabled",
    },
    sections: [
      section("Budget", [
        kv([
          ["Scope", f["scope"]],
          ["Period", f["evaluationPeriod"]],
          ["Amount", f["budgetAmount"] !== undefined ? `${str(f["budgetAmount"])} ${unit}` : ""],
          [
            "Current usage",
            f["currentUsage"] !== undefined ? `${str(f["currentUsage"])} ${unit}` : "",
          ],
          ["Used", pct !== undefined ? `${pct}%` : ""],
          ["Enabled", enabled],
          ["Last alerted", f["lastNotifiedAt"]],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
        ]),
        muted(
          "A soft limit: Anyscale alerts when spend crosses it but never stops clusters. Only the amount, unit and period can be changed; to change the scope, create a new budget.",
        ),
      ]),
    ],
    headerActions: [
      {
        kind: "action",
        label: enabled ? "Disable" : "Enable",
        action: {
          type: "plugin-action",
          actionId: enabled ? "disable" : "enable",
          successMessage: enabled ? "Budget disabled." : "Budget enabled.",
        },
      },
    ],
  };
}

export function renderAnyscaleDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs: number | undefined = DEFAULT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      windowMs = SPEND_METRICS_WINDOW_MS;
      break;
    case "cloud":
      schema = renderCloud(r);
      break;
    case "project":
      schema = renderProject(r);
      break;
    case "workspace":
      schema = renderWorkspace(r);
      break;
    case "job":
      schema = renderJob(r);
      break;
    case "service":
      schema = renderService(r);
      break;
    case "compute-config":
      schema = renderComputeConfig(r);
      break;
    case "budget":
      schema = renderBudget(r);
      break;
    default:
      schema = {
        title: r.displayName || r.id,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
      windowMs = undefined;
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderAnyscaleSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  const state = str(f["state"]);
  switch (r.resourceTypeId) {
    case "workspace":
      return item(
        f["idle"] === "yes" ? "degraded" : workspaceStatus(state),
        f["idle"] === "yes" ? "Idle" : state || "Workspace",
      );
    case "job":
      return item(jobStatus(state), state || "Job");
    case "service":
      return item(serviceStatus(state), state || "Service");
    case "budget": {
      const pct = typeof f["percentUsed"] === "number" ? f["percentUsed"] : undefined;
      if (f["enabled"] === false) return item("unknown", "Disabled");
      return item(
        pct !== undefined && pct >= 100 ? "error" : "healthy",
        pct !== undefined ? `${pct}%` : "Enabled",
      );
    }
    case "cloud":
      return item(state === "ACTIVE" ? "healthy" : "unknown", state || "Cloud");
    default:
      return { id: r.id, label: r.displayName || r.id };
  }
}
