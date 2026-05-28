/**
 * Detail renderer for Cloud Tasks queues.
 */
import type { DetailViewSchema, DetailViewTab, ResourceInstance } from "@infrawrench/plugin-base";
import { gcpStatus } from "./utils.js";
import { formatRelativeTime } from "./shared-renderers.js";

/** Apply the Cloud Tasks queue renderer to `base`. */
export function renderCloudTasksQueue(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const state = String(fields["state"] ?? "");
  base.subtitle = "Cloud Tasks Queue";
  base.status = {
    kind: "status-dot",
    status: state === "RUNNING" ? "healthy" : state === "PAUSED" ? "info" : gcpStatus(state),
    ...(state ? { label: state } : {}),
  };

  const formatRate = (n: unknown): string => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? `${v}/s` : "—";
  };
  const formatCount = (n: unknown): string => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v.toLocaleString() : "—";
  };
  // Cloud Tasks API returns durations like "0.100s", "3600s", "0s" (Unlimited).
  const formatDuration = (raw: unknown): string => {
    const s = String(raw ?? "");
    if (!s) return "—";
    if (s === "0s") return "Unlimited";
    return s;
  };
  const formatMaxAttempts = (n: unknown): string => {
    const v = Number(n);
    // -1 (and the API's "unlimited" form) maps to Unlimited.
    if (!Number.isFinite(v) || v < 0) return "Unlimited";
    if (v === 0) return "—";
    return v.toLocaleString();
  };

  base.sections = [
    {
      kind: "section",
      title: "Configuration",
      children: [
        {
          kind: "key-value-list",
          items: [{ key: "Location", value: String(fields["region"] ?? "—") }],
        },
      ],
    },
    {
      kind: "section",
      title: "Rate limits",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Max rate", value: formatRate(fields["maxDispatchesPerSecond"]) },
            { key: "Max concurrent", value: formatCount(fields["maxConcurrentDispatches"]) },
            { key: "Max burst size", value: formatCount(fields["maxBurstSize"]) },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Retry parameters",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Max attempts", value: formatMaxAttempts(fields["maxAttempts"]) },
            { key: "Min interval", value: formatDuration(fields["minBackoff"]) },
            { key: "Max interval", value: formatDuration(fields["maxBackoff"]) },
            { key: "Max doublings", value: formatCount(fields["maxDoublings"]) },
            { key: "Max retry duration", value: formatDuration(fields["maxRetryDuration"]) },
          ],
        },
      ],
    },
  ];

  base.metricsCapability = { defaultTimeRangeMs: 3_600_000 };
  base.logs = { defaultTailLines: 200 };

  interface CloudTasksTaskRow {
    name: string;
    shortName: string;
    scheduleTime: string;
    createTime: string;
    dispatchCount: number;
    responseCount: number;
    url: string;
    method: string;
  }
  const tasksRaw = String(resource.resolvedOutputs["cloudTasksQueueTasks"] ?? "");
  let tasksData: { items: CloudTasksTaskRow[]; error?: string } = { items: [] };
  if (tasksRaw) {
    try {
      tasksData = JSON.parse(tasksRaw) as typeof tasksData;
    } catch {
      tasksData = { items: [] };
    }
  }
  const taskRows = tasksData.items.map((t) => ({
    cells: {
      name: t.shortName,
      method: t.method || "—",
      url: t.url || "—",
      scheduleTime: t.scheduleTime ? formatRelativeTime(t.scheduleTime) : "—",
      dispatchCount: String(t.dispatchCount ?? 0),
    },
  }));
  const tasksTab: DetailViewTab = {
    id: "tasks",
    label: "Tasks",
    sections: [
      {
        kind: "section",
        title: tasksData.error
          ? "Tasks (failed to load)"
          : taskRows.length === 0
            ? "Tasks (queue is empty)"
            : `Tasks (showing ${taskRows.length})`,
        children: tasksData.error
          ? [{ kind: "text", content: tasksData.error }]
          : taskRows.length === 0
            ? [
                {
                  kind: "text",
                  content:
                    "No pending tasks in this queue. Tasks appear here while they wait to be dispatched.",
                },
              ]
            : [
                {
                  kind: "table",
                  columns: [
                    { key: "name", label: "Task ID", mono: true, width: "wide" },
                    { key: "method", label: "Method", width: "narrow" },
                    { key: "url", label: "Target URL", mono: true, width: "wide" },
                    { key: "scheduleTime", label: "Scheduled" },
                    { key: "dispatchCount", label: "Dispatches", width: "narrow" },
                  ],
                  rows: taskRows,
                },
              ],
      },
    ],
  };
  base.customTabs = [...(base.customTabs ?? []), tasksTab];

  base.publishPanel = {
    tabLabel: "Create task",
    subtitle: `Enqueue an HTTP task on ${resource.displayName}`,
    bodyFormat: "text",
    defaultBody: '{"hello":"world"}',
    helpText:
      "Creates a task whose target is the URL below. The body is sent as the HTTP request payload (Cloud Tasks base64-encodes it on the wire).",
    submitLabel: "Create task",
    extraFields: [
      {
        key: "url",
        label: "Target URL",
        kind: "text",
        placeholder: "https://example.com/handler",
        helpText: "Required. Cloud Tasks will POST/PUT the body to this URL.",
      },
      {
        key: "method",
        label: "HTTP method",
        kind: "select",
        defaultValue: "POST",
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "DELETE", label: "DELETE" },
          { value: "GET", label: "GET" },
          { value: "HEAD", label: "HEAD" },
        ],
      },
      {
        key: "headers",
        label: "Headers",
        kind: "key-value-list",
        helpText: "HTTP headers Cloud Tasks should set on the dispatch.",
      },
    ],
  };
}
