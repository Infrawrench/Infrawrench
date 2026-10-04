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
import type {
  BillingRates,
  BillingSummary,
  ModalAppInfo,
  ModalDeployment,
  ModalFunctionDetail,
  ModalFunctionStats,
} from "./api.js";
import { describeGpus, functionKind } from "./mappers.js";
import { COST_METRICS_WINDOW_MS, FUNCTION_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const SUMMARY_KEY = "__summary__";
export const RATES_KEY = "__rates__";
export const APP_INFO_KEY = "__appInfo__";
export const TAGS_KEY = "__tags__";
export const DEPLOYMENTS_KEY = "__deployments__";
export const FUNCTION_KEY = "__function__";
export const STATS_KEY = "__stats__";
export const BILLING_NOTE_KEY = "__billingNote__";

/** App states in which `AppStop` has something to stop. */
const STOPPABLE = new Set([
  "deployed",
  "ephemeral",
  "detached",
  "detached-disconnected",
  "initializing",
]);

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function openInModal(url: string | undefined): ActionNode[] {
  return url ? [{ kind: "action", label: "Open in Modal", action: { type: "open-url", url } }] : [];
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function titleCase(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function seconds(n: number | undefined): string {
  if (n === undefined) return "";
  if (n >= 3600 && n % 3600 === 0) return `${n / 3600}h`;
  if (n >= 60 && n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}

export function appStatus(state: string): ResourceStatus {
  switch (state) {
    case "deployed":
      return "healthy";
    case "ephemeral":
    case "detached":
    case "initializing":
      return "info";
    case "stopping":
    case "detached-disconnected":
      return "degraded";
    default:
      return "unknown";
  }
}

function moneyTable(label: string, values: Record<string, number>): SchemaNode[] {
  const rows = Object.entries(values)
    .filter(([, v]) => v !== 0)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));
  if (rows.length === 0) return [];
  return [
    {
      kind: "table",
      columns: [
        { key: "item", label, width: "wide" },
        { key: "amount", label: "Amount" },
      ],
      rows: rows.map<TableRow>(([k, v]) => ({ cells: { item: titleCase(k), amount: usd(v) } })),
    },
  ];
}

function renderWorkspace(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<BillingSummary>(r.resolvedOutputs[SUMMARY_KEY]);
  const rates = parseJson<BillingRates>(r.resolvedOutputs[RATES_KEY]);
  const note = r.resolvedOutputs[BILLING_NOTE_KEY];
  const sections: SectionNode[] = [
    section("Workspace", [
      kv([
        ["Name", f["name"], true],
        ["Environments", f["environmentCount"]],
      ]),
    ]),
    section("This billing cycle", [
      kv([
        ["Metered", usd(summary?.metered ?? f["monthMetered"])],
        ["Billed", usd(summary?.billed ?? f["monthBilled"])],
        [
          "Period",
          summary?.startMs !== undefined && summary.endMs !== undefined
            ? `${new Date(summary.startMs).toISOString().slice(0, 10)} to ${new Date(summary.endMs).toISOString().slice(0, 10)}`
            : "",
        ],
      ]),
      ...(summary ? moneyTable("Metered by product", summary.breakdown) : []),
      ...(summary
        ? moneyTable("Adjustments (credits, plan, allowances)", summary.adjustments)
        : []),
      ...(note ? [muted(note)] : []),
      muted(
        "Metered cost is before credits, plan allowances and reservations; billed cost is what Modal invoices.",
      ),
    ]),
  ];
  if (rates && Object.keys(rates.rates).length > 0) {
    sections.push(
      section("Rate card", [
        {
          kind: "table",
          columns: [
            { key: "resource", label: "Resource", width: "wide" },
            { key: "rate", label: "Rate (USD)" },
          ],
          rows: Object.entries(rates.rates)
            .sort(([a], [b]) => a.localeCompare(b))
            .map<TableRow>(([k, v]) => ({ cells: { resource: k, rate: String(v) } })),
        },
        muted("Compute rates are per unit per hour; storage is per GiB per month."),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Workspace",
    status: { kind: "status-dot", status: "healthy", label: "Workspace" },
    sections,
    headerActions: openInModal(r.resolvedOutputs["url"]),
  };
}

function renderEnvironment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<BillingSummary>(r.resolvedOutputs[SUMMARY_KEY]);
  const reached = f["spendLimitReached"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Environment", f["isDefault"] === true ? "default" : ""),
    status: {
      kind: "status-dot",
      status: reached ? "error" : "healthy",
      label: reached ? "Spend limit reached" : "Active",
    },
    sections: [
      section("Environment", [
        kv([
          ["Name", f["name"], true],
          ["Default", f["isDefault"]],
          ["Web endpoint suffix", f["webhookSuffix"]],
          ["Created", f["createdAt"]],
          ["Environment ID", f["environmentId"], true],
        ]),
      ]),
      section("Concurrency", [
        kv([
          ["Running containers", f["currentConcurrentTasks"]],
          ["Max concurrent containers", f["maxConcurrentTasks"] ?? "No cap"],
          ["GPUs in use", f["currentConcurrentGpus"]],
          ["Max concurrent GPUs", f["maxConcurrentGpus"] ?? "No cap"],
        ]),
      ]),
      section("Spend this cycle", [
        kv([
          ["Spend", usd(summary?.metered ?? f["cycleUsage"])],
          ["Budget", usd(f["cycleBudget"])],
          ["Spend limit", usd(f["spendLimit"])],
          ["Spend limit reached", f["spendLimitReached"]],
        ]),
        ...(summary ? moneyTable("Metered by product", summary.breakdown) : []),
        muted(
          "Credits and other adjustments apply to the whole workspace, so an environment shows metered cost only.",
        ),
      ]),
    ],
    headerActions: openInModal(r.resolvedOutputs["url"]),
  };
}

function renderApp(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const info = parseJson<ModalAppInfo>(r.resolvedOutputs[APP_INFO_KEY]);
  const tags = parseJson<Record<string, string>>(r.resolvedOutputs[TAGS_KEY]);
  const history = parseJson<{ deployments: ModalDeployment[]; productionVersion: number }>(
    r.resolvedOutputs[DEPLOYMENTS_KEY],
  );
  const sections: SectionNode[] = [
    section("App", [
      kv([
        ["Name", f["name"], true],
        ["State", state],
        ["Environment", f["environment"]],
        ["Running containers", f["runningTasks"]],
        ["Description", f["description"]],
        ["Version", f["version"]],
        ["Deployed", f["deployedAt"]],
        ["Deployed by", f["deployedBy"]],
        ["Created", f["createdAt"]],
        ["Created by", f["createdBy"]],
        ["Stopped", f["stoppedAt"]],
        ["Stopped by", f["stoppedBy"]],
        ["App ID", f["appId"], true],
      ]),
    ]),
  ];
  if (info && info.functions.length > 0) {
    sections.push(
      section(`Functions and servers (${info.functions.length})`, [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Name", width: "wide" },
            { key: "kind", label: "Kind" },
            { key: "gpu", label: "GPU" },
            { key: "schedule", label: "Schedule" },
          ],
          rows: info.functions.map<TableRow>((fn) => ({
            cells: {
              name: fn.tag.endsWith(".*") ? fn.tag.slice(0, -2) : fn.tag,
              kind: functionKind(fn),
              gpu: describeGpus(fn.gpus) || "None",
              schedule: fn.schedule?.description ?? "",
            },
          })),
        },
      ]),
    );
  }
  if (tags && Object.keys(tags).length > 0) {
    sections.push(
      section("Tags", [
        kv(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)) as Array<[string, string]>),
        muted(
          "Tags ride along on this app's cost rows, so cost can be grouped and filtered by them.",
        ),
      ]),
    );
  }
  if (history && history.deployments.length > 0) {
    sections.push(
      section("Deployment history", [
        {
          kind: "table",
          columns: [
            { key: "version", label: "Version" },
            { key: "at", label: "Deployed", width: "wide" },
            { key: "by", label: "By" },
            { key: "tag", label: "Tag" },
            { key: "client", label: "Client" },
          ],
          rows: history.deployments.slice(0, 25).map<TableRow>((d) => ({
            cells: {
              version: `v${d.version}${d.version === history.productionVersion ? " (live)" : ""}${d.rollbackVersion ? ` (rollback to v${d.rollbackVersion})` : ""}`,
              at: d.deployedAt !== undefined ? new Date(d.deployedAt).toISOString() : "",
              by: d.deployedBy,
              tag: d.tag,
              client: d.clientVersion,
            },
          })),
        },
      ]),
    );
  }
  const actions: ActionNode[] = [...openInModal(r.resolvedOutputs["url"])];
  if (STOPPABLE.has(state)) {
    actions.push({
      kind: "action",
      label: "Stop app",
      action: {
        type: "plugin-action",
        actionId: "stop",
        confirmMessage:
          "Stop this app? Its running containers are terminated, scheduled functions stop firing and web endpoints stop answering. A stopped app cannot be restarted; it has to be deployed again.",
        successMessage: "App stopped.",
        destructive: true,
      },
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("App", f["environment"]),
    status: { kind: "status-dot", status: appStatus(state), label: state || "App" },
    sections,
    headerActions: actions,
  };
}

function renderFunction(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const detail = parseJson<ModalFunctionDetail>(r.resolvedOutputs[FUNCTION_KEY]);
  const stats = parseJson<ModalFunctionStats>(r.resolvedOutputs[STATS_KEY]);
  const sections: SectionNode[] = [
    section(r.resourceTypeId === "scheduled-function" ? "Scheduled function" : "Function", [
      kv([
        ["Name", f["name"], true],
        ["App", f["app"]],
        ["Environment", f["environment"]],
        ["Kind", f["kind"]],
        ["Schedule", f["schedule"] ?? detail?.schedule?.description],
        ["GPU", f["gpu"] || "None"],
        ["Module", detail?.module],
        ["Region", detail?.routingRegion],
        ["Function ID", f["functionId"], true],
      ]),
      ...(detail?.webUrl
        ? [
            {
              kind: "text" as const,
              variant: "mono" as const,
              content: detail.webUrl,
              copyable: true,
            },
          ]
        : []),
    ]),
  ];
  if (stats) {
    sections.push(
      section("Right now", [
        kv([
          ["Queued inputs", stats.backlog],
          ["Running inputs", stats.runningInputs],
          ["Containers", stats.totalTasks],
          ["Spare input capacity", stats.inputHeadroom],
        ]),
      ]),
    );
  }
  if (detail) {
    sections.push(
      section("Scaling", [
        kv([
          ["Min containers", detail.minContainers ?? 0],
          ["Max containers", detail.maxContainers ?? "No cap"],
          ["Buffer containers", detail.bufferContainers],
          ["Scale-up window", seconds(detail.scaleupWindowSecs)],
          ["Scale-down window", seconds(detail.scaledownWindowSecs)],
          ["Target concurrency", detail.targetConcurrency],
          ["Timeout", seconds(detail.timeoutSecs || undefined)],
          ["Startup timeout", seconds(detail.startupTimeoutSecs || undefined)],
        ]),
      ]),
    );
    if (detail.hardware.length > 0) {
      sections.push(
        section(detail.hardware.length > 1 ? "Hardware (in preference order)" : "Hardware", [
          {
            kind: "table",
            columns: [
              { key: "gpu", label: "GPU", width: "wide" },
              { key: "cpu", label: "CPU" },
              { key: "memory", label: "Memory" },
              { key: "disk", label: "Disk" },
              { key: "concurrency", label: "Inputs per container" },
              { key: "cloud", label: "Cloud" },
            ],
            rows: detail.hardware.map<TableRow>((h) => ({
              cells: {
                gpu: describeGpus(h.gpus) || "None",
                cpu: h.milliCpu
                  ? `${h.milliCpu / 1000}${h.milliCpuMax ? ` to ${h.milliCpuMax / 1000}` : ""} cores`
                  : "Default",
                memory: h.memoryMb
                  ? `${h.memoryMb} MiB${h.memoryMbMax ? ` to ${h.memoryMbMax} MiB` : ""}`
                  : "Default",
                disk: h.ephemeralDiskMb ? `${h.ephemeralDiskMb} MiB` : "Default",
                concurrency: h.maxConcurrentInputs
                  ? `${h.targetConcurrentInputs || h.maxConcurrentInputs} target, ${h.maxConcurrentInputs} max`
                  : "1",
                cloud: h.cloud || "Auto",
              },
            })),
          },
          muted(
            "Resources and scaling are set in the app's code (the @app.function decorator) and change on the next deploy.",
          ),
        ]),
      );
    }
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle(
      r.resourceTypeId === "scheduled-function"
        ? "Scheduled function"
        : str(f["kind"]) || "Function",
      f["app"],
    ),
    status: { kind: "status-dot", status: "healthy", label: str(f["gpu"]) || "CPU" },
    sections,
    headerActions: openInModal(r.resolvedOutputs["url"]),
  };
}

function renderNamed(
  r: ResourceInstance,
  typeLabel: string,
  extra: Array<[string, unknown]>,
  note?: string,
): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle(typeLabel, f["environment"]),
    status: { kind: "status-dot", status: "healthy", label: typeLabel },
    sections: [
      section(typeLabel, [
        kv([
          ["Name", f["name"], true],
          ["Environment", f["environment"]],
          ...extra,
          ["Created", f["createdAt"]],
          ["Created by", f["createdBy"]],
        ]),
        ...(note ? [muted(note)] : []),
      ]),
    ],
  };
}

export function renderModalDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs = COST_METRICS_WINDOW_MS;
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "workspace":
      schema = renderWorkspace(r);
      break;
    case "environment":
      schema = renderEnvironment(r);
      break;
    case "app":
      schema = renderApp(r);
      break;
    case "function":
    case "scheduled-function":
      schema = renderFunction(r);
      windowMs = FUNCTION_METRICS_WINDOW_MS;
      break;
    case "volume":
      schema = renderNamed(
        r,
        "Volume",
        [
          ["Version", f["version"]],
          ["Volume ID", f["volumeId"]],
        ],
        "Deleting a volume deletes every file in it, for every app that mounts it.",
      );
      break;
    case "secret":
      schema = renderNamed(
        r,
        "Secret",
        [
          ["Keys", f["keys"]],
          ["Last used", f["lastUsedAt"]],
          ["Secret ID", f["secretId"]],
        ],
        "Only key names are shown; Infrawrench never reads secret values.",
      );
      break;
    case "dict":
      schema = renderNamed(r, "Dict", [["Dict ID", f["dictId"]]]);
      break;
    case "queue":
      schema = renderNamed(r, "Queue", [
        ["Partitions", f["partitions"]],
        ["Items", f["totalSize"]],
        ["Queue ID", f["queueId"]],
      ]);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(f).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderModalSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "workspace":
      return item("healthy", f["monthBilled"] !== undefined ? usd(f["monthBilled"]) : "Workspace");
    case "environment":
      return f["spendLimitReached"] === true
        ? item("error", "Spend limit reached")
        : item("healthy", f["isDefault"] === true ? "Default" : "Environment");
    case "app": {
      const state = str(f["state"]);
      return item(appStatus(state), state || "App");
    }
    case "function":
    case "scheduled-function":
      return item("healthy", str(f["schedule"]) || str(f["gpu"]) || str(f["kind"]) || "Function");
    case "queue":
      return item("info", `${str(f["totalSize"] ?? 0)} items`);
    case "secret":
      return item("info", `${str(f["keyCount"] ?? 0)} keys`);
    default:
      return item("info", str(f["environment"]) || r.resourceTypeId);
  }
}
