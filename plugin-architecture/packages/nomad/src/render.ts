import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableNode,
} from "@infrawrench/plugin-base";
import { camelToTitle, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

export const COMMANDS = {
  scale: "scale",
  dispatch: "dispatch",
  revert: "revert",
  drain: "drain",
  editRules: "edit-rules",
  signal: "signal",
} as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function fieldsNode(r: ResourceInstance): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (value === "") continue;
    items.push({
      key: labels.get(key) ?? camelToTitle(key),
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  return { kind: "key-value-list", items };
}

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});
const openUrl = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function act(
  label: string,
  actionId: string,
  successMessage: string,
  opts: { confirm?: string; destructive?: boolean; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function stashed<T>(r: ResourceInstance, key: string): T[] {
  try {
    const v = JSON.parse(r.resolvedOutputs[key] ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function table(rows: Array<Record<string, string>>, cols: Array<[string, string]>): TableNode {
  return {
    kind: "table",
    columns: cols.map(([key, label]) => ({ key, label })),
    rows: rows.map((row) => ({ cells: Object.fromEntries(cols.map(([k]) => [k, str(row[k])])) })),
  };
}

function jobStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  if (f["stopped"] === true) return { status: "info", label: "Stopped" };
  const s = str(f["status"]);
  if (Number(f["failed"] ?? 0) > 0 && s !== "dead")
    return { status: "degraded", label: `${str(f["failed"])} failed` };
  if (s === "running") return { status: "healthy", label: "Running" };
  if (s === "pending") return { status: "provisioning", label: "Pending" };
  return { status: s === "dead" ? "info" : "unknown", label: s || "unknown" };
}

function allocStatus(s: string): ResourceStatus {
  return s === "running" || s === "complete"
    ? "healthy"
    : s === "pending"
      ? "provisioning"
      : s === "failed" || s === "lost"
        ? "error"
        : "unknown";
}

function nodeStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  if (f["status"] === "down") return { status: "error", label: "Down" };
  if (f["drain"] === true) return { status: "degraded", label: "Draining" };
  if (f["eligibility"] === "ineligible") return { status: "info", label: "Ineligible" };
  return f["status"] === "ready"
    ? { status: "healthy", label: "Ready" }
    : { status: "unknown", label: str(f["status"]) };
}

export function renderNomadDetail(r: ResourceInstance, address: string): DetailViewSchema {
  const f = r.fields;
  const ui = `${address}/ui`;
  const base = (subtitle: string, extra: Partial<DetailViewSchema> = {}): DetailViewSchema =>
    withMetricsCapability(
      {
        title: r.displayName || "Nomad",
        subtitle,
        sections: [section("Details", [fieldsNode(r)])],
        ...extra,
      },
      RESOURCE_TYPES,
      r.resourceTypeId,
    );
  switch (r.resourceTypeId) {
    case "nomad-cluster":
      return base(joinSubtitle("Nomad", f["version"] ? `v${str(f["version"])}` : "", f["region"]), {
        status: {
          kind: "status-dot",
          status: f["leader"] ? "healthy" : "error",
          label: f["leader"] ? "Leader elected" : "No leader",
        },
        headerActions: [openUrl("Open Nomad UI", `${ui}/`)],
      });
    case "nomad-job": {
      const ns = str(f["namespace"]);
      const groups = stashed<{ name: string; count: number }>(r, "__groups__");
      const versions = stashed<{ version: number; stable: boolean }>(r, "__versions__");
      const stopped = f["stopped"] === true;
      const actions: ActionNode[] = [
        openUrl("Open in Nomad UI", `${ui}/jobs/${encodeURIComponent(`${str(f["id"])}@${ns}`)}`),
      ];
      if (stopped) actions.push(act("Start", "start", "Job started"));
      else
        actions.push(
          act("Stop", "stop", "Job stopped", {
            confirm: `Stop ${str(f["id"])}? Its allocations are shut down; the job stays registered and can be started again.`,
            variant: "danger",
          }),
        );
      if (groups.length && !stopped && f["type"] !== "system" && f["type"] !== "sysbatch")
        actions.push({
          kind: "action",
          label: "Scale",
          action: {
            type: "prompt-nosql-command",
            command: COMMANDS.scale,
            title: `Scale ${str(f["id"])}`,
            submitLabel: "Scale",
            fields: [
              {
                key: "group",
                label: "Task group",
                kind: "select",
                required: true,
                defaultValue: groups[0]!.name,
                options: groups.map((g) => ({ id: g.name, label: `${g.name} (now ${g.count})` })),
              },
              {
                key: "count",
                label: "Count",
                kind: "number",
                required: true,
                minValue: 0,
                defaultValue: String(groups[0]!.count),
              },
              { key: "message", label: "Reason", kind: "text", required: false },
            ],
          },
        });
      if (f["parameterized"] === true)
        actions.push({
          kind: "action",
          label: "Dispatch",
          action: {
            type: "prompt-nosql-command",
            command: COMMANDS.dispatch,
            title: `Dispatch ${str(f["id"])}`,
            description: "Starts a new child job from this parameterized job.",
            submitLabel: "Dispatch",
            fields: [
              { key: "payload", label: "Payload", kind: "text", multiline: true, required: false },
              {
                key: "meta",
                label: "Metadata",
                kind: "text",
                required: false,
                placeholder: "key=value, other=value",
              },
            ],
          },
        });
      if (f["periodic"] === true)
        actions.push(act("Run now", "force-periodic", "Periodic run launched"));
      if (versions.length > 1)
        actions.push({
          kind: "action",
          label: "Revert",
          action: {
            type: "prompt-nosql-command",
            command: COMMANDS.revert,
            title: `Revert ${str(f["id"])}`,
            description: "Registers an earlier version again as a new version.",
            submitLabel: "Revert",
            fields: [
              {
                key: "version",
                label: "Version",
                kind: "select",
                required: true,
                options: versions
                  .filter((v) => v.version !== Number(f["version"]))
                  .map((v) => ({
                    id: String(v.version),
                    label: `v${v.version}${v.stable ? " (stable)" : ""}`,
                  })),
              },
            ],
          },
        });
      if (!stopped) actions.push(act("Reschedule failed", "evaluate", "Evaluation created"));
      return base(
        joinSubtitle(
          `${str(f["type"])} job`,
          ns,
          f["version"] !== undefined ? `v${str(f["version"])}` : "",
        ),
        {
          status: { kind: "status-dot", ...jobStatus(f) },
          manifestEditor: { language: "json", resourceKind: "Specification" },
          describe: { language: "text" },
          headerActions: actions,
        },
      );
    }
    case "nomad-allocation":
      return base(joinSubtitle("Allocation", f["taskGroup"], f["node"]), {
        status: {
          kind: "status-dot",
          status: allocStatus(str(f["clientStatus"])),
          label: str(f["clientStatus"]) || "unknown",
        },
        logs: { defaultTailLines: 200 },
        describe: { language: "text" },
        headerActions: [
          openUrl("Open in Nomad UI", `${ui}/allocations/${encodeURIComponent(str(f["id"]))}`),
          act("Restart", "restart", "Tasks restarting", {
            confirm: "Restart every task in this allocation in place?",
          }),
          {
            kind: "action",
            label: "Send signal",
            action: {
              type: "prompt-nosql-command",
              command: COMMANDS.signal,
              title: "Send a signal",
              submitLabel: "Send",
              fields: [
                {
                  key: "signal",
                  label: "Signal",
                  kind: "select",
                  required: true,
                  defaultValue: "SIGHUP",
                  options: ["SIGHUP", "SIGUSR1", "SIGUSR2", "SIGINT", "SIGTERM", "SIGKILL"].map(
                    (s) => ({ id: s, label: s }),
                  ),
                },
                {
                  key: "task",
                  label: "Task",
                  kind: "text",
                  required: false,
                  placeholder: "Empty: every task",
                },
              ],
            },
          },
          act("Stop", "stop", "Allocation stopped; the scheduler places a replacement", {
            confirm: "Stop this allocation? The scheduler replaces it, possibly on another node.",
            variant: "danger",
          }),
        ],
      });
    case "nomad-deployment": {
      const s = str(f["status"]);
      const live = s === "running" || s === "paused" || s === "pending" || s === "blocked";
      return base(joinSubtitle("Deployment", f["jobId"]), {
        status: {
          kind: "status-dot",
          status:
            s === "successful"
              ? "healthy"
              : s === "failed"
                ? "error"
                : s === "cancelled"
                  ? "info"
                  : "provisioning",
          label: s || "unknown",
        },
        headerActions: live
          ? [
              ...(Number(f["canariesPending"] ?? 0) > 0
                ? [act("Promote", "promote", "Canaries promoted")]
                : []),
              s === "paused"
                ? act("Resume", "resume", "Deployment resumed")
                : act("Pause", "pause", "Deployment paused"),
              act("Fail", "fail", "Deployment failed", {
                confirm:
                  "Mark this deployment failed? With auto-revert the job rolls back to the last stable version.",
                variant: "danger",
              }),
            ]
          : [],
      });
    }
    case "nomad-node":
      return base(joinSubtitle("Client node", f["datacenter"], f["nodePool"]), {
        status: { kind: "status-dot", ...nodeStatus(f) },
        headerActions: [
          openUrl("Open in Nomad UI", `${ui}/clients/${encodeURIComponent(r.externalId ?? "")}`),
          f["drain"] === true
            ? act("Cancel drain", "cancel-drain", "Drain cancelled")
            : {
                kind: "action",
                label: "Drain",
                action: {
                  type: "prompt-nosql-command",
                  command: COMMANDS.drain,
                  title: `Drain ${r.displayName}`,
                  description:
                    "Migrates allocations off the node and stops new ones being placed on it.",
                  submitLabel: "Drain",
                  fields: [
                    {
                      key: "deadline",
                      label: "Deadline",
                      kind: "select",
                      required: true,
                      defaultValue: "1h",
                      options: [
                        { id: "10m", label: "10 minutes" },
                        { id: "1h", label: "1 hour" },
                        { id: "4h", label: "4 hours" },
                        { id: "force", label: "Force now (no waiting)" },
                      ],
                    },
                    {
                      key: "ignoreSystemJobs",
                      label: "Leave system jobs running",
                      kind: "select",
                      required: false,
                      defaultValue: "false",
                      options: [
                        { id: "false", label: "No" },
                        { id: "true", label: "Yes" },
                      ],
                    },
                    { key: "message", label: "Reason", kind: "text", required: false },
                  ],
                },
              },
          f["eligibility"] === "ineligible"
            ? act("Mark eligible", "eligible", "Node is eligible for placements")
            : act("Mark ineligible", "ineligible", "No new placements on this node"),
        ],
      });
    case "nomad-variable":
      return base(joinSubtitle("Variable", f["namespace"]), {
        manifestEditor: { language: "json", resourceKind: "Items" },
        headerActions: [
          openUrl(
            "Open in Nomad UI",
            `${ui}/variables/var/${str(f["path"])}@${encodeURIComponent(str(f["namespace"]))}`,
          ),
        ],
      });
    case "nomad-acl-policy": {
      const rules = r.resolvedOutputs["rules"] ?? "";
      return base("ACL policy", {
        sections: [
          section("Details", [fieldsNode(r)]),
          ...(rules
            ? [
                section("Rules", [
                  {
                    kind: "text" as const,
                    content: rules,
                    variant: "mono" as const,
                    copyable: true,
                  },
                ]),
              ]
            : []),
        ],
        headerActions: [
          {
            kind: "action",
            label: "Edit rules",
            action: {
              type: "prompt-nosql-command",
              command: COMMANDS.editRules,
              title: `Edit ${r.displayName}`,
              description:
                "Saving replaces the rules. Tokens carrying the policy pick up the change immediately.",
              submitLabel: "Save rules",
              fields: [
                {
                  key: "rules",
                  label: "Rules (HCL)",
                  kind: "code",
                  codeLanguage: "hcl",
                  required: true,
                  defaultValue: rules,
                },
              ],
            },
          },
        ],
      });
    }
    case "nomad-service": {
      const regs = stashed<Record<string, string>>(r, "__registrations__");
      return base(joinSubtitle("Service", f["namespace"]), {
        sections: [
          section("Details", [fieldsNode(r)]),
          ...(regs.length
            ? [
                section("Instances", [
                  table(regs, [
                    ["address", "Address"],
                    ["job", "Job"],
                    ["alloc", "Allocation"],
                    ["node", "Node"],
                    ["dc", "Datacenter"],
                  ]),
                ]),
              ]
            : []),
        ],
      });
    }
    case "nomad-volume":
      return base(
        joinSubtitle(`${str(f["type"]) === "host" ? "Host" : "CSI"} volume`, f["namespace"]),
        {
          status: {
            kind: "status-dot",
            status: f["schedulable"] === false ? "degraded" : "healthy",
            label:
              f["schedulable"] === false ? "Not schedulable" : str(f["state"]) || "Schedulable",
          },
        },
      );
    default:
      return base(camelToTitle(r.resourceTypeId.replace(/^nomad-/, "")));
  }
}

export function renderNomadSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "nomad-job") status = jobStatus(f).status;
  if (r.resourceTypeId === "nomad-allocation") status = allocStatus(str(f["clientStatus"]));
  if (r.resourceTypeId === "nomad-node") status = nodeStatus(f).status;
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
