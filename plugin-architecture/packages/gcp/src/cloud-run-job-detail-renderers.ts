/**
 * Detail renderers for Cloud Run jobs and Memorystore for Valkey instances.
 */
import type {
  ActionNode,
  DetailViewSchema,
  DetailViewTab,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import type { CloudRunJobExecutionSummary } from "./cloud-run-job-handlers.js";
import { formatRelativeTime } from "./shared-renderers.js";

const ACTIVE_EXECUTION = new Set(["EXECUTION_RUNNING", "EXECUTION_PENDING"]);

/** Apply the Cloud Run job renderer to `base`. */
export function renderCloudRunJob(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const lastStatus = String(fields["lastExecutionStatus"] ?? "");
  const actions: ActionNode[] = [
    {
      kind: "action",
      label: "Execute",
      action: {
        type: "plugin-action",
        actionId: "execute",
        confirmMessage: `Start a new execution of ${resource.displayName}?`,
        successMessage: "Execution started.",
      },
    },
  ];
  if (ACTIVE_EXECUTION.has(lastStatus)) {
    actions.push({
      kind: "action",
      label: "Cancel execution",
      action: {
        type: "plugin-action",
        actionId: "cancel-latest",
        confirmMessage: `Cancel execution ${String(fields["lastExecution"] ?? "")}? Running tasks are stopped.`,
        successMessage: "Cancellation requested.",
      },
    });
  }
  base.headerActions = [...actions, ...(base.headerActions ?? [])];
  base.logs = { defaultTailLines: 200 };

  const raw = String(resource.resolvedOutputs["executions"] ?? "");
  let data: { items: CloudRunJobExecutionSummary[]; error?: string } = { items: [] };
  if (raw) {
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      data = { items: [] };
    }
  }
  const rows = data.items.map((e) => ({
    cells: {
      name: e.name,
      status: e.status,
      tasks: e.tasks,
      started: e.createTime ? formatRelativeTime(e.createTime) : "-",
      finished: e.completionTime ? formatRelativeTime(e.completionTime) : "-",
    },
  }));
  const tab: DetailViewTab = {
    id: "executions",
    label: "Executions",
    sections: [
      {
        kind: "section",
        title: data.error
          ? "Executions (failed to load)"
          : rows.length === 0
            ? "Executions"
            : `Executions (latest ${rows.length})`,
        children: data.error
          ? [{ kind: "text", content: data.error }]
          : rows.length === 0
            ? [
                {
                  kind: "text",
                  content: "This job has not been executed yet. Use Execute to start a run.",
                },
              ]
            : [
                {
                  kind: "table",
                  columns: [
                    { key: "name", label: "Execution", mono: true, width: "wide" },
                    { key: "status", label: "Status", width: "narrow" },
                    { key: "tasks", label: "Tasks succeeded", width: "narrow" },
                    { key: "started", label: "Started" },
                    { key: "finished", label: "Finished" },
                  ],
                  rows,
                },
              ],
      },
    ],
  };
  base.customTabs = [...(base.customTabs ?? []), tab];
}

/** Apply the Memorystore for Valkey renderer to `base`. */
export function renderMemorystoreValkey(resource: ResourceInstance, base: DetailViewSchema): void {
  const state = String(resource.fields["state"] ?? "");
  // Reachable only over Private Service Connect inside the VPC, so like
  // Memorystore for Redis it is shown as informational rather than healthy.
  base.status = { kind: "status-dot", status: "info", ...(state ? { label: state } : {}) };

  const out = resource.resolvedOutputs;
  const host = String(out["host"] ?? "");
  if (!host) return;
  const items = [
    { key: "Endpoint", value: `${host}:${String(out["port"] ?? "6379")}`, copyable: true },
  ];
  const reader = String(out["readerHost"] ?? "");
  if (reader) items.push({ key: "Reader endpoint", value: reader, copyable: true });
  base.sections = [
    ...(base.sections ?? []),
    {
      kind: "section",
      title: "Connection",
      children: [
        { kind: "key-value-list", items },
        {
          kind: "text",
          variant: "muted",
          content:
            resource.fields["mode"] === "CLUSTER"
              ? "Cluster mode: connect with a cluster-aware Valkey or Redis client from inside the VPC; it discovers the shards from this endpoint."
              : "Connect from inside the VPC network with any Valkey or Redis client.",
        },
      ],
    },
  ];
}
