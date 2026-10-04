import type {
  ActionNode,
  CreditBalance,
  DetailViewSchema,
  HostAction,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { WAREHOUSE_SIZES, findSize } from "./catalog.js";
import type { SnowflakeRates } from "./catalog.js";
import type { MonthSummary } from "./cost-data.js";
import type {
  AttributionEntry,
  AttributionReport,
  Recommendation,
  WarehouseActivity,
} from "./insights.js";
import { ACCOUNT_METRICS_WINDOW_MS, WAREHOUSE_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES, TYPE } from "./resource-types.js";

/** resolvedOutputs keys `getResource` stashes reports under for the renderer. */
export const OUT = {
  summary: "__summary__",
  insights: "__insights__",
  monitors: "__monitors__",
  warehouses: "__warehouses__",
} as const;

export interface AccountSummary {
  month?: MonthSummary;
  monthError?: string;
  balances?: CreditBalance[];
  balanceError?: string;
  attribution?: AttributionReport;
  attributionError?: string;
  /** Warehouses whose settings alone earn a recommendation. */
  warehouseFlags: Array<{ warehouse: string; title: string }>;
}

export interface WarehouseInsights {
  activity?: WarehouseActivity;
  activityError?: string;
  recommendations: Recommendation[];
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function money(value: number, currency: string): string {
  try {
    return value.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 2 });
  } catch {
    return `${value.toFixed(2)} ${currency}`;
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

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});

const muted = (content: string): SchemaNode => ({ kind: "text", variant: "muted", content });

function action(label: string, act: HostAction, variant?: ActionNode["variant"]): ActionNode {
  return { kind: "action", label, action: act, ...(variant ? { variant } : {}) };
}

const pluginAction = (
  label: string,
  actionId: string,
  extra: { confirmMessage?: string; successMessage?: string; destructive?: boolean } = {},
  variant?: ActionNode["variant"],
): ActionNode => action(label, { type: "plugin-action", actionId, ...extra }, variant);

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function bytes(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? formatBytes(n) : "";
}

function seconds(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "Never";
  return n % 60 === 0 ? `${n / 60} min` : `${n} s`;
}

function attributionTable(title: string, entries: AttributionEntry[], rates: SnowflakeRates) {
  return section(title, [
    {
      kind: "table",
      columns: [
        { key: "value", label: "Value", width: "wide" },
        { key: "credits", label: "Credits" },
        { key: "cost", label: "At your credit price" },
        { key: "queries", label: "Queries" },
      ],
      rows: entries.map<TableRow>((e) => ({
        cells: {
          value: e.value,
          credits: e.credits.toFixed(3),
          cost: money(e.credits * rates.creditPrice, rates.currency),
          queries: String(e.queries),
        },
      })),
    },
  ]);
}

function renderAccount(r: ResourceInstance, rates: SnowflakeRates): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<AccountSummary>(r.resolvedOutputs[OUT.summary]);
  const sections: SectionNode[] = [
    section("Account", [
      kv([
        ["Account", f["name"]],
        ["Organization", f["organization"]],
        ["Account locator", f["accountLocator"], true],
        ["Region", f["region"]],
        ["Role", f["currentRole"]],
        ["Warehouse", f["currentWarehouse"]],
      ]),
    ]),
  ];
  const month = summary?.month;
  if (month) {
    sections.push(
      section(`Spend this month (${month.month})`, [
        kv([
          ["Total", money(month.total, month.currency)],
          [
            "Basis",
            month.basis === "billed"
              ? "Billed amounts from organization usage"
              : `Estimated at ${money(rates.creditPrice, rates.currency)} per credit and ${money(rates.storagePerTbMonth, rates.currency)} per TB-month`,
          ],
        ]),
        {
          kind: "table",
          columns: [
            { key: "service", label: "Service", width: "wide" },
            { key: "amount", label: "Amount" },
          ],
          rows: month.byService.map<TableRow>((s) => ({
            cells: { service: s.service, amount: money(s.amount, month.currency) },
          })),
        },
        ...(month.basis === "estimated"
          ? [
              muted(
                "The connection's role cannot read SNOWFLAKE.ORGANIZATION_USAGE, so spend is estimated from credits, storage and transfer at the prices under Edit credentials. Pick a role with the organization usage views to see billed amounts in your contract currency.",
              ),
            ]
          : []),
      ]),
    );
    if (month.byWarehouse.length > 0) {
      sections.push(
        section("Warehouse compute this month", [
          {
            kind: "table",
            columns: [
              { key: "warehouse", label: "Warehouse", width: "wide" },
              { key: "credits", label: "Credits" },
              { key: "amount", label: "Amount" },
            ],
            rows: month.byWarehouse.map<TableRow>((w) => ({
              cells: {
                warehouse: w.warehouse,
                credits: w.credits ? w.credits.toFixed(2) : "",
                amount: money(w.amount, month.currency),
              },
            })),
          },
        ]),
      );
    }
  } else if (summary?.monthError) {
    sections.push(section("Spend this month", [muted(summary.monthError)]));
  }

  if (summary?.balances && summary.balances.length > 0) {
    sections.push(
      section("Remaining balance", [
        kv(summary.balances.map((b) => [b.label, money(b.remaining, b.currency)])),
        muted(
          "End-of-day balances from organization usage, up to 72 hours behind. The Credits page charts the burn rate and runway.",
        ),
      ]),
    );
  } else if (summary?.balanceError) {
    sections.push(section("Remaining balance", [muted(summary.balanceError)]));
  }

  if (summary?.warehouseFlags && summary.warehouseFlags.length > 0) {
    sections.push(
      section("Warehouse recommendations", [
        {
          kind: "table",
          columns: [
            { key: "warehouse", label: "Warehouse", width: "wide" },
            { key: "finding", label: "Finding", width: "wide" },
          ],
          rows: summary.warehouseFlags.map<TableRow>((w) => ({
            cells: { warehouse: w.warehouse, finding: w.title },
          })),
        },
        muted("Open a warehouse for its load-based sizing advice and one-click fixes."),
      ]),
    );
  }

  const attribution = summary?.attribution;
  if (attribution) {
    sections.push(
      section(`Query cost attribution, last ${attribution.days} days`, [
        muted(
          `${attribution.totalCredits.toFixed(2)} credits attributed to queries. Attribution covers query execution on warehouses only: idle time, queries of about 100 ms or less, cloud services and serverless features are not included, so it adds up to less than the warehouse bill. Set QUERY_TAG in your sessions to group cost by workload.`,
        ),
      ]),
      attributionTable("By query tag", attribution.byQueryTag, rates),
      attributionTable("By user", attribution.byUser, rates),
      attributionTable("By role", attribution.byRole, rates),
      attributionTable("By warehouse", attribution.byWarehouse, rates),
    );
  } else if (summary?.attributionError) {
    sections.push(section("Query cost attribution", [muted(summary.attributionError)]));
  }

  return {
    title: r.displayName,
    subtitle: joinSubtitle("Snowflake account", f["region"]),
    status: { kind: "status-dot", status: "healthy", label: "Connected" },
    sections,
    headerActions: r.resolvedOutputs["accountUrl"]
      ? [action("Open in Snowsight", { type: "open-url", url: r.resolvedOutputs["accountUrl"] })]
      : [],
  };
}

export function warehouseStatus(state: string): { status: ResourceStatus; label: string } {
  switch (state.toUpperCase()) {
    case "STARTED":
      return { status: "healthy", label: "Running" };
    case "RESIZING":
    case "RESUMING":
      return { status: "provisioning", label: state.charAt(0) + state.slice(1).toLowerCase() };
    case "SUSPENDED":
      return { status: "unknown", label: "Suspended" };
    case "SUSPENDING":
      return { status: "provisioning", label: "Suspending" };
    default:
      return { status: "info", label: state || "Unknown" };
  }
}

function sizeOptions(current: string) {
  return WAREHOUSE_SIZES.map((s) => ({
    id: s.sql,
    label: s.show,
    description: `${s.credits} credit${s.credits === 1 ? "" : "s"} per hour${s.show === current ? " (current)" : ""}`,
  }));
}

export const AUTO_SUSPEND_CHOICES = [60, 120, 300, 600, 900, 1800, 3600, 0];

function warehouseActions(r: ResourceInstance): ActionNode[] {
  const f = r.fields;
  const state = str(f["state"]).toUpperCase();
  const size = str(f["size"]);
  const monitors = parseJson<string[]>(r.resolvedOutputs[OUT.monitors]) ?? [];
  const actions: ActionNode[] = [];
  if (state === "SUSPENDED") {
    actions.push(
      pluginAction("Resume", "resume", {
        successMessage: "Warehouse resuming",
        confirmMessage: "Resume this warehouse? It bills credits while it runs.",
      }),
    );
  } else {
    actions.push(
      pluginAction("Suspend", "suspend", {
        successMessage: "Warehouse suspending",
        confirmMessage:
          "Suspend this warehouse? Running queries finish first; new queries resume it if auto-resume is on.",
      }),
    );
  }
  actions.push(
    action("Resize", {
      type: "prompt-nosql-command",
      command: "resize",
      title: "Resize warehouse",
      description:
        "A larger size runs queries faster and bills more credits per hour. Running queries finish on the current size; queued and new queries use the new one.",
      fields: [
        {
          key: "size",
          label: "Size",
          kind: "select",
          required: true,
          options: sizeOptions(size),
          ...(findSize(size) ? { defaultValue: findSize(size)!.sql } : {}),
        },
      ],
      submitLabel: "Resize",
    }),
    action("Auto-suspend", {
      type: "prompt-nosql-command",
      command: "set-auto-suspend",
      title: "Auto-suspend",
      description:
        "How long the warehouse waits with no queries before suspending. Every resume bills at least 60 seconds.",
      fields: [
        {
          key: "seconds",
          label: "Suspend after",
          kind: "select",
          required: true,
          options: AUTO_SUSPEND_CHOICES.map((s) => ({
            id: String(s),
            label: s === 0 ? "Never (not recommended)" : seconds(s),
          })),
          defaultValue: String(f["autoSuspend"] ?? 300),
        },
      ],
      submitLabel: "Save",
    }),
    action("Resource monitor", {
      type: "prompt-nosql-command",
      command: "assign-monitor",
      title: "Resource monitor",
      description:
        "Cap this warehouse's credits with a resource monitor. Assigning one needs the ACCOUNTADMIN role.",
      fields: [
        {
          key: "monitor",
          label: "Monitor",
          kind: "select",
          required: false,
          options: [{ id: "", label: "None" }, ...monitors.map((m) => ({ id: m, label: m }))],
          defaultValue: str(f["resourceMonitor"]),
        },
      ],
      submitLabel: "Save",
    }),
  );
  return actions;
}

function recommendationNodes(recs: Recommendation[]): SchemaNode[] {
  const nodes: SchemaNode[] = [];
  for (const rec of recs) {
    nodes.push({
      kind: "badge",
      label: rec.title,
      color: rec.severity === "warning" ? "yellow" : "blue",
    });
    nodes.push({ kind: "text", variant: "body", content: rec.detail });
    if (rec.size) {
      const target = findSize(rec.size);
      if (target) {
        nodes.push(
          pluginAction(`Resize to ${target.show}`, `resize:${target.sql}`, {
            confirmMessage: `Resize this warehouse to ${target.show}?`,
            successMessage: `Resized to ${target.show}`,
          }),
        );
      }
    }
    if (rec.autoSuspend !== undefined) {
      nodes.push(
        pluginAction(
          `Set auto-suspend to ${seconds(rec.autoSuspend)}`,
          `auto-suspend:${rec.autoSuspend}`,
          {
            successMessage: "Auto-suspend updated",
          },
        ),
      );
    }
  }
  return nodes;
}

function renderWarehouse(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const st = warehouseStatus(str(f["state"]));
  const insights = parseJson<WarehouseInsights>(r.resolvedOutputs[OUT.insights]);
  const size = findSize(str(f["size"]));
  const sections: SectionNode[] = [
    section("Warehouse", [
      kv([
        ["Size", size ? `${size.show} (${size.credits} credits/hour)` : f["size"]],
        ["Type", f["type"]],
        ["Generation", f["generation"]],
        ["Auto-suspend", seconds(f["autoSuspend"])],
        ["Auto-resume", f["autoResume"]],
        [
          "Clusters",
          f["maxClusterCount"] !== undefined && Number(f["maxClusterCount"]) > 1
            ? `${str(f["minClusterCount"])} to ${str(f["maxClusterCount"])} (${str(f["scalingPolicy"]).toLowerCase()})`
            : "",
        ],
        ["Query acceleration", f["queryAcceleration"]],
        ["Resource monitor", f["resourceMonitor"] || "None"],
        ["Owner", f["owner"]],
        ["Comment", f["comment"]],
      ]),
    ]),
    section("Right now", [
      kv([
        ["Running queries", f["running"]],
        ["Queued queries", f["queued"]],
        ["Started clusters", f["startedClusters"]],
        ["Last resumed", f["resumedOn"]],
      ]),
    ]),
  ];
  if (insights?.activity) {
    const a = insights.activity;
    sections.push(
      section(`Last ${a.days} days`, [
        kv([
          ["Credits", a.credits.toFixed(2)],
          ["Hours with queries", a.activeHours],
          ["Average running load", `${Math.round(a.avgRunning * 100)}%`],
          ["Average queued load", a.avgQueued.toFixed(2)],
        ]),
      ]),
    );
  } else if (insights?.activityError) {
    sections.push(section("Recent activity", [muted(insights.activityError)]));
  }
  if (insights && insights.recommendations.length > 0) {
    sections.push(section("Recommendations", recommendationNodes(insights.recommendations)));
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Warehouse", size?.show),
    status: { kind: "status-dot", ...st },
    sections,
    headerActions: warehouseActions(r),
  };
}

function renderDatabase(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Database", f["kind"]),
    status: { kind: "status-dot", status: "healthy", label: str(f["kind"]) || "Database" },
    sections: [
      section("Database", [
        kv([
          ["Storage", bytes(f["storageBytes"])],
          ["Fail-safe", bytes(f["failsafeBytes"])],
          [
            "Time Travel retention",
            f["retentionTime"] !== undefined ? `${str(f["retentionTime"])} days` : "",
          ],
          ["Origin", f["origin"]],
          ["Owner", f["owner"]],
          ["Created", f["createdOn"]],
          ["Comment", f["comment"]],
        ]),
      ]),
    ],
  };
}

function renderSchema(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Schema", f["database"]),
    status: { kind: "status-dot", status: "healthy", label: "Schema" },
    sections: [
      section("Schema", [
        kv([
          ["Qualified name", r.resolvedOutputs["qualifiedName"], true],
          ["Managed access", f["managedAccess"]],
          ["Transient", f["transient"]],
          [
            "Time Travel retention",
            f["retentionTime"] !== undefined ? `${str(f["retentionTime"])} days` : "",
          ],
          ["Owner", f["owner"]],
          ["Created", f["createdOn"]],
          ["Comment", f["comment"]],
        ]),
      ]),
    ],
  };
}

function renderMonitor(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const quota = Number(f["creditQuota"]);
  const used = Number(f["usedCredits"] ?? 0);
  const pct = Number.isFinite(quota) && quota > 0 ? Math.round((used / quota) * 100) : undefined;
  const suspendAt = Number(f["suspendAt"] ?? f["suspendImmediatelyAt"]);
  const status: ResourceStatus =
    pct === undefined
      ? "info"
      : Number.isFinite(suspendAt) && pct >= suspendAt
        ? "error"
        : pct >= 80
          ? "degraded"
          : "healthy";
  const warehouses = parseJson<string[]>(r.resolvedOutputs[OUT.warehouses]) ?? [];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Resource monitor", str(f["frequency"]).toLowerCase()),
    status: {
      kind: "status-dot",
      status,
      label: pct !== undefined ? `${pct}% of quota used` : "No quota",
    },
    sections: [
      section("Quota", [
        kv([
          ["Credit quota", f["creditQuota"]],
          ["Used", f["usedCredits"]],
          ["Remaining", f["remainingCredits"]],
          ["Resets", str(f["frequency"]).toLowerCase()],
          ["Notify at", str(f["notifyAt"]) ? `${str(f["notifyAt"]).split(",").join("%, ")}%` : ""],
          ["Suspend at", f["suspendAt"] !== undefined ? `${str(f["suspendAt"])}%` : ""],
          [
            "Suspend immediately at",
            f["suspendImmediatelyAt"] !== undefined ? `${str(f["suspendImmediatelyAt"])}%` : "",
          ],
        ]),
      ]),
      section("Applies to", [
        kv([
          ["Level", str(f["level"]) || "Not assigned"],
          ["Warehouses", f["warehouses"]],
          ["Starts", f["startTime"]],
          ["Ends", f["endTime"]],
          ["Owner", f["owner"]],
        ]),
      ]),
    ],
    headerActions: [
      action("Assign to warehouse", {
        type: "prompt-nosql-command",
        command: "assign-warehouse",
        title: "Assign to warehouse",
        description:
          "The warehouse's credits count against this monitor from now on. A warehouse has at most one monitor, so this replaces any it had. Needs the ACCOUNTADMIN role.",
        fields: [
          {
            key: "warehouse",
            label: "Warehouse",
            kind: "select",
            required: true,
            options: warehouses.map((w) => ({ id: w, label: w })),
          },
        ],
        submitLabel: "Assign",
        ...(warehouses.length === 0
          ? {
              blocked: true,
              descriptionVariant: "error" as const,
              description: "The connection's role cannot see any warehouses.",
            }
          : {}),
      }),
      pluginAction("Set as account monitor", "set-account-monitor", {
        confirmMessage:
          "Make this the account-level monitor? It then caps the credits of every warehouse in the account. Needs the ACCOUNTADMIN role.",
        successMessage: "Account monitor set",
      }),
    ],
  };
}

function renderUser(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = f["disabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("User", f["type"]),
    status: {
      kind: "status-dot",
      status: disabled ? "unknown" : "healthy",
      label: disabled ? "Disabled" : "Enabled",
    },
    sections: [
      section("Sign-in", [
        kv([
          ["Login name", f["loginName"], true],
          ["Email", f["email"]],
          ["Password", f["hasPassword"]],
          ["Key pair", f["hasRsaPublicKey"]],
          ["MFA", f["hasMfa"]],
          ["Last login", f["lastSuccessLogin"] || "Never"],
        ]),
      ]),
      section("Defaults", [
        kv([
          ["Default role", f["defaultRole"]],
          ["Default warehouse", f["defaultWarehouse"]],
          ["Owner", f["owner"]],
          ["Created", f["createdOn"]],
          ["Comment", f["comment"]],
        ]),
      ]),
    ],
    headerActions: [
      disabled
        ? pluginAction("Enable", "enable", { successMessage: "User enabled" })
        : pluginAction(
            "Disable",
            "disable",
            {
              confirmMessage:
                "Disable this user? Their sessions end and they cannot sign in until re-enabled.",
              successMessage: "User disabled",
            },
            "danger",
          ),
    ],
  };
}

function renderRole(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Role",
    status: { kind: "status-dot", status: "healthy", label: "Role" },
    sections: [
      section("Role", [
        kv([
          ["Granted to users", f["assignedToUsers"]],
          ["Granted to roles", f["grantedToRoles"]],
          ["Inherits roles", f["grantedRoles"]],
          ["Owner", f["owner"]],
          ["Created", f["createdOn"]],
          ["Comment", f["comment"]],
        ]),
      ]),
    ],
  };
}

function objectRows(r: ResourceInstance): Array<[string, unknown, boolean?]> {
  return [
    ["Qualified name", r.resolvedOutputs["qualifiedName"], true],
    ["Owner", r.fields["owner"]],
    ["Created", r.fields["createdOn"]],
    ["Comment", r.fields["comment"]],
  ];
}

function renderTask(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const started = str(f["state"]) === "started";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Task", f["database"], f["schema"]),
    status: {
      kind: "status-dot",
      status: started ? "healthy" : "unknown",
      label: started ? "Started" : "Suspended",
    },
    sections: [
      section("Task", [
        kv([
          ["Schedule", f["schedule"]],
          ["Runs after", f["predecessors"]],
          ["Warehouse", f["warehouse"] || "Serverless"],
          ["Condition", f["condition"]],
          ["Last suspended reason", f["lastSuspendedReason"]],
          ...objectRows(r),
        ]),
      ]),
      ...(str(f["definition"])
        ? [
            section("Definition", [
              {
                kind: "text",
                variant: "mono",
                content: str(f["definition"]),
                copyable: true,
              } as SchemaNode,
            ]),
          ]
        : []),
    ],
    headerActions: [
      started
        ? pluginAction("Suspend", "suspend", { successMessage: "Task suspended" })
        : pluginAction("Resume", "resume", { successMessage: "Task resumed" }),
      pluginAction("Run now", "execute", {
        confirmMessage: "Run this task now, outside its schedule?",
        successMessage: "Task run started",
      }),
    ],
  };
}

function renderPipe(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["executionState"]);
  const paused = /PAUSED/i.test(state);
  const status: ResourceStatus = !state
    ? "info"
    : /RUNNING/i.test(state)
      ? "healthy"
      : paused
        ? "unknown"
        : "degraded";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Pipe", f["database"], f["schema"]),
    status: {
      kind: "status-dot",
      status,
      label: state ? state.toLowerCase().replace(/_/g, " ") : "Pipe",
    },
    sections: [
      section("Pipe", [
        kv([
          ["Pending files", f["pendingFileCount"]],
          ["Last ingested", f["lastIngested"]],
          ["Notification channel", f["notificationChannel"], true],
          ["Integration", f["integration"]],
          ["Pattern", f["pattern"]],
          ["Invalid reason", f["invalidReason"]],
          ...objectRows(r),
        ]),
      ]),
      ...(str(f["definition"])
        ? [
            section("Definition", [
              {
                kind: "text",
                variant: "mono",
                content: str(f["definition"]),
                copyable: true,
              } as SchemaNode,
            ]),
          ]
        : []),
    ],
    headerActions: [
      paused
        ? pluginAction("Resume", "resume", { successMessage: "Pipe resumed" })
        : pluginAction("Pause", "pause", { successMessage: "Pipe paused" }),
      pluginAction("Refresh", "refresh", {
        confirmMessage: "Queue files staged in the last 7 days that the pipe has not loaded yet?",
        successMessage: "Refresh queued",
      }),
    ],
  };
}

function renderDynamicTable(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["schedulingState"]).toUpperCase();
  const running = state === "RUNNING" || state === "ACTIVE";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Dynamic table", f["database"], f["schema"]),
    status: {
      kind: "status-dot",
      status: running ? "healthy" : state === "SUSPENDED" ? "unknown" : "info",
      label: state ? state.charAt(0) + state.slice(1).toLowerCase() : "Dynamic table",
    },
    sections: [
      section("Dynamic table", [
        kv([
          ["Target lag", f["targetLag"]],
          ["Refresh mode", f["refreshMode"]],
          ["Warehouse", f["warehouse"]],
          ["Rows", f["rows"]],
          ["Size", bytes(f["bytes"])],
          ["Data as of", f["dataTimestamp"]],
          ...objectRows(r),
        ]),
      ]),
    ],
    headerActions: [
      state === "SUSPENDED"
        ? pluginAction("Resume", "resume", { successMessage: "Dynamic table resumed" })
        : pluginAction("Suspend", "suspend", { successMessage: "Dynamic table suspended" }),
      pluginAction("Refresh now", "refresh", { successMessage: "Refresh started" }),
    ],
  };
}

export function renderSnowflakeDetail(
  r: ResourceInstance,
  rates: SnowflakeRates,
): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs = ACCOUNT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case TYPE.account:
      schema = renderAccount(r, rates);
      break;
    case TYPE.warehouse:
      schema = renderWarehouse(r);
      windowMs = WAREHOUSE_METRICS_WINDOW_MS;
      break;
    case TYPE.database:
      schema = renderDatabase(r);
      break;
    case TYPE.schema:
      schema = renderSchema(r);
      break;
    case TYPE.resourceMonitor:
      schema = renderMonitor(r);
      break;
    case TYPE.user:
      schema = renderUser(r);
      break;
    case TYPE.role:
      schema = renderRole(r);
      break;
    case TYPE.task:
      schema = renderTask(r);
      break;
    case TYPE.pipe:
      schema = renderPipe(r);
      break;
    case TYPE.dynamicTable:
      schema = renderDynamicTable(r);
      break;
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderSnowflakeSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: { status: ResourceStatus; label: string } | undefined;
  switch (r.resourceTypeId) {
    case TYPE.warehouse:
      status = warehouseStatus(str(f["state"]));
      break;
    case TYPE.user:
      status =
        f["disabled"] === true
          ? { status: "unknown", label: "Disabled" }
          : { status: "healthy", label: "Enabled" };
      break;
    case TYPE.task:
      status =
        str(f["state"]) === "started"
          ? { status: "healthy", label: "Started" }
          : { status: "unknown", label: "Suspended" };
      break;
    default:
      status = undefined;
  }
  return {
    id: r.id,
    label: r.displayName,
    ...(status ? { status: { kind: "status-dot", ...status } } : {}),
  };
}
