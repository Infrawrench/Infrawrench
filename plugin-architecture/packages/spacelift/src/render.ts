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
import { PLUGIN_ID } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

export const DETAIL_KEYS = {
  runs: "__runs__",
  contexts: "__contexts__",
  drift: "__drift__",
  scheduled: "__scheduled__",
  stacks: "__stacks__",
  workers: "__workers__",
  attachments: "__attachments__",
} as const;

export interface RunRow {
  id: string;
  state?: string;
  type?: string;
  title?: string;
  createdAt?: string;
  delta?: string;
}

export interface Option {
  id: string;
  name: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const fmt = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "";

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

function openIn(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Spacelift", action: { type: "open-url", url } }]
    : [];
}

export function action(
  label: string,
  actionId: string,
  successMessage: string,
  confirmMessage?: string,
  opts: { destructive?: boolean; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(confirmMessage ? { confirmMessage } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  description: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
  variant: ActionNode["variant"] = "ghost",
): ActionNode {
  return {
    kind: "action",
    label,
    variant,
    action: { type: "prompt-nosql-command", command, title, description, fields, submitLabel },
  };
}

function navigate(label: string, typeId: string, resourceId: string): ActionNode {
  return {
    kind: "action",
    label,
    variant: "ghost",
    action: {
      type: "navigate-to-resource",
      pluginId: PLUGIN_ID,
      resourceTypeId: typeId,
      resourceId,
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

/** Spacelift stack and run states as a status dot. */
export function runStatus(state: string): ResourceStatus {
  switch (state) {
    case "FINISHED":
      return "healthy";
    case "FAILED":
      return "error";
    case "UNCONFIRMED":
    case "PENDING_REVIEW":
    case "REPLAN_REQUESTED":
      return "degraded";
    case "DISCARDED":
    case "CANCELED":
    case "STOPPED":
    case "SKIPPED":
    case "NONE":
      return "info";
    case "":
      return "unknown";
    default:
      return "provisioning";
  }
}

export const TRIGGER_FIELDS: CreateFieldConfig[] = [
  {
    key: "runType",
    label: "Run type",
    kind: "select",
    required: true,
    defaultValue: "TRACKED",
    options: [
      {
        id: "TRACKED",
        label: "Tracked",
        description: "Plan, then apply (after confirmation unless autodeploy is on).",
      },
      { id: "PROPOSED", label: "Proposed", description: "Plan only: shows what would change." },
    ],
  },
  {
    key: "commitSha",
    label: "Commit",
    kind: "text",
    required: false,
    placeholder: "Leave empty for the branch head",
  },
];

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const allowed = typeof f["allowedMinutes"] === "number" ? f["allowedMinutes"] : 0;
  const used = Number(f["publicMinutes"] ?? 0) + Number(f["privateMinutes"] ?? 0);
  return {
    title: r.displayName,
    subtitle: "Spacelift account",
    status: {
      kind: "status-dot",
      status: allowed > 0 && used > allowed ? "degraded" : "healthy",
      label: allowed > 0 ? `${fmt(used)} of ${fmt(allowed)} run minutes` : "Account",
    },
    sections: [
      section("Plan and usage", [
        kv([
          [
            "Billing period",
            f["billingPeriodStart"]
              ? `${str(f["billingPeriodStart"])} to ${str(f["billingPeriodEnd"])}`
              : "",
          ],
          ["Seats in plan", fmt(f["allowedSeats"])],
          ["Run minutes in plan", allowed ? fmt(allowed) : ""],
          ["Public worker minutes this period", fmt(f["publicMinutes"])],
          ["Private worker minutes this period", fmt(f["privateMinutes"])],
          ["Price per seat", typeof f["pricePerSeat"] === "number" ? `$${f["pricePerSeat"]}` : ""],
          [
            "Price per worker",
            typeof f["pricePerWorker"] === "number" ? `$${f["pricePerWorker"]}` : "",
          ],
        ]),
        muted(
          "API keys count as seats while they are in use: every key exchanged for a token in a billing period is billed like a user.",
        ),
      ]),
      section("Public workers", [
        kv([
          ["Parallelism", fmt(f["publicParallelism"])],
          ["Busy", fmt(f["publicBusyWorkers"])],
          ["Runs waiting", fmt(f["publicPendingRuns"])],
        ]),
      ]),
      section("Account", [
        kv([
          ["Stacks", fmt(f["stackCount"])],
          ["Spaces", fmt(f["spaceCount"])],
          ["Private worker pools", fmt(f["workerPoolCount"])],
        ]),
      ]),
    ],
    headerActions: openIn(r.resolvedOutputs["url"]),
  };
}

function renderStack(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const runs = parseJson<RunRow[]>(r.resolvedOutputs[DETAIL_KEYS.runs]) ?? [];
  const contexts = parseJson<
    Array<{ id: string; name: string; priority?: number; auto?: boolean }>
  >(r.resolvedOutputs[DETAIL_KEYS.contexts]);
  const drift = parseJson<{
    schedule?: string[];
    timezone?: string;
    reconcile?: boolean;
    ignoreState?: boolean;
  }>(r.resolvedOutputs[DETAIL_KEYS.drift]);
  const scheduled = parseJson<Array<{ id: string; name: string; cron?: string; next?: string }>>(
    r.resolvedOutputs[DETAIL_KEYS.scheduled],
  );
  const state = str(f["state"]);
  const locked = f["locked"] === true;
  const disabled = f["disabled"] === true;
  const sections: SectionNode[] = [
    section("Stack", [
      kv([
        ["State", state],
        ["Since", f["stateSetAt"]],
        ["Tool", [f["vendor"], f["toolVersion"]].filter(Boolean).join(" ")],
        [
          "Repository",
          f["namespace"] ? `${str(f["namespace"])}/${str(f["repository"])}` : f["repository"],
        ],
        ["Branch", f["branch"]],
        ["Project root", f["projectRoot"]],
        ["Tracked commit", f["commit"] ? `${str(f["commit"])} ${str(f["commitMessage"])}` : ""],
        ["Space", f["spaceName"] || f["space"]],
        ["Worker pool", f["workerPool"] || "Public"],
        ["Autodeploy", f["autodeploy"]],
        ["Autoretry", f["autoretry"]],
        ["Protected from deletion", f["protectFromDeletion"]],
        ["Spacelift manages state", f["managesState"]],
        [
          "Locked by",
          locked ? `${str(f["lockedBy"])}${f["lockNote"] ? `: ${str(f["lockNote"])}` : ""}` : "",
        ],
        ["Blocked by a dependency", f["blocked"]],
        ["Labels", f["labels"]],
        ["Stack ID", f["stackId"], true],
      ]),
    ]),
    section("Drift detection", [
      drift
        ? kv([
            ["Schedule", (drift.schedule ?? []).join(", ")],
            ["Time zone", drift.timezone],
            ["Reconcile automatically", drift.reconcile],
            ["Check in any final state", drift.ignoreState],
          ])
        : muted(
            "Drift detection is off. Set it up to run proposed runs on a schedule and flag drift.",
          ),
    ]),
  ];
  if (contexts && contexts.length > 0) {
    sections.push(
      section("Attached contexts", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Context", width: "wide" },
            { key: "priority", label: "Priority" },
            { key: "auto", label: "Auto-attached" },
          ],
          rows: contexts.map<TableRow>((c) => ({
            cells: { name: c.name, priority: str(c.priority), auto: c.auto ? "Yes" : "No" },
          })),
        },
      ]),
    );
  }
  if (scheduled && scheduled.length > 0) {
    sections.push(
      section("Scheduled runs", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Name", width: "wide" },
            { key: "cron", label: "Schedule", mono: true },
            { key: "next", label: "Next run" },
            { key: "delete", label: "" },
          ],
          rows: scheduled.map<TableRow>((s) => ({
            cells: {
              name: s.name,
              cron: str(s.cron),
              next: str(s.next),
              delete: action(
                "Delete",
                `scheduled-delete:${s.id}`,
                "Scheduled run deleted.",
                "Delete this scheduled run?",
                { variant: "danger" },
              ),
            },
          })),
        },
      ]),
    );
  }
  if (runs.length > 0) {
    sections.push(
      section("Recent runs", [
        {
          kind: "table",
          columns: [
            { key: "title", label: "Run", width: "wide" },
            { key: "type", label: "Type" },
            { key: "state", label: "State" },
            { key: "delta", label: "+ / ~ / -" },
            { key: "created", label: "Created" },
            { key: "open", label: "" },
          ],
          rows: runs.map<TableRow>((x) => ({
            cells: {
              title: str(x.title) || x.id,
              type: str(x.type),
              state: str(x.state),
              delta: str(x.delta),
              created: str(x.createdAt),
              open: navigate("Open", "run", `${r.accountId}:run:${str(f["stackId"])}/${x.id}`),
            },
          })),
        },
      ]),
    );
  }
  const actions: ActionNode[] = [
    ...openIn(r.resolvedOutputs["url"]),
    prompt(
      "Trigger run",
      "trigger",
      "Trigger a run",
      "Runs the stack on its tracked branch.",
      TRIGGER_FIELDS,
      "Trigger",
      "default",
    ),
    locked
      ? action("Unlock", "unlock", "Stack unlocked.")
      : prompt(
          "Lock",
          "lock",
          "Lock stack",
          "Only you can trigger runs while it is locked.",
          [
            {
              key: "note",
              label: "Note",
              kind: "text",
              required: false,
              placeholder: "Maintenance",
            },
          ],
          "Lock",
        ),
    disabled
      ? action("Enable", "enable", "Stack enabled.")
      : action(
          "Disable",
          "disable",
          "Stack disabled.",
          "Disable this stack? No runs start until it is enabled.",
        ),
    prompt(
      "Drift detection",
      "drift",
      "Drift detection",
      "Runs a proposed run on each schedule and flags drift. Reconcile also triggers a tracked run to fix it.",
      [
        {
          key: "schedule",
          label: "Schedule (cron)",
          kind: "text",
          required: true,
          defaultValue: (drift?.schedule ?? ["0 */6 * * *"]).join(", "),
          description: "One or more cron expressions, comma-separated.",
        },
        {
          key: "timezone",
          label: "Time zone",
          kind: "text",
          required: false,
          defaultValue: drift?.timezone ?? "UTC",
        },
        {
          key: "reconcile",
          label: "When drift is found",
          kind: "select",
          required: true,
          defaultValue: drift?.reconcile ? "true" : "false",
          options: [
            { id: "false", label: "Report it" },
            { id: "true", label: "Trigger a tracked run to reconcile" },
          ],
        },
        {
          key: "ignoreState",
          label: "Run when the stack is",
          kind: "select",
          required: true,
          defaultValue: drift?.ignoreState ? "true" : "false",
          options: [
            { id: "false", label: "Finished only" },
            { id: "true", label: "In any final state" },
          ],
        },
      ],
      "Save",
    ),
    prompt(
      "Schedule run",
      "scheduleRun",
      "Schedule a tracked run",
      "Triggers a tracked run on a cron schedule.",
      [
        { key: "name", label: "Name", kind: "text", required: true, placeholder: "Nightly apply" },
        {
          key: "cron",
          label: "Schedule (cron)",
          kind: "text",
          required: true,
          placeholder: "0 2 * * *",
        },
        { key: "timezone", label: "Time zone", kind: "text", required: false, defaultValue: "UTC" },
      ],
      "Schedule",
    ),
  ];
  if (drift)
    actions.push(
      action(
        "Turn off drift detection",
        "drift-off",
        "Drift detection turned off.",
        "Stop drift detection on this stack?",
      ),
    );
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Stack", str(f["vendor"])),
      status: disabled
        ? { kind: "status-dot", status: "info", label: "Disabled" }
        : locked
          ? { kind: "status-dot", status: "info", label: "Locked" }
          : { kind: "status-dot", status: runStatus(state), label: state || "Stack" },
      sections,
      headerActions: actions,
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

function renderRun(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const actions: ActionNode[] = [...openIn(r.resolvedOutputs["url"])];
  if (f["canConfirm"] === true) {
    actions.push(
      action("Confirm", "confirm", "Run confirmed: applying.", undefined, { variant: "default" }),
    );
    actions.push(action("Discard", "discard", "Run discarded.", "Discard this run's plan?"));
  }
  if (["QUEUED", "READY"].includes(state))
    actions.push(
      action("Cancel", "cancel", "Run cancelled.", "Cancel this run?", { variant: "danger" }),
    );
  if (
    ["PREPARING", "INITIALIZING", "PLANNING", "APPLYING", "PERFORMING", "DESTROYING"].includes(
      state,
    )
  ) {
    actions.push(
      action(
        "Stop",
        "stop",
        "Run stopping.",
        "Stop this run? Spacelift ends it gracefully at the next safe point.",
        { variant: "danger" },
      ),
    );
  }
  if (f["canRetry"] === true) actions.push(action("Retry", "retry", "Run retried."));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Run", str(f["stackName"])),
    status: { kind: "status-dot", status: runStatus(state), label: state || "Run" },
    sections: [
      section("Run", [
        kv([
          ["State", state],
          ["Type", f["type"]],
          ["Title", f["title"]],
          ["Stack", f["stackName"]],
          ["Branch", f["branch"]],
          ["Commit", f["commit"], true],
          ["Author", f["author"]],
          ["Triggered by", f["triggeredBy"]],
          ["Drift detection", f["drift"]],
          ["Needs approval", f["needsApproval"]],
          ["To add", fmt(f["toAdd"])],
          ["To change", fmt(f["toChange"])],
          ["To delete", fmt(f["toDelete"])],
          ["Created", f["createdAt"]],
          ["Run ID", f["runId"], true],
        ]),
      ]),
    ],
    headerActions: actions,
    logs: { defaultTailLines: 500 },
  };
}

function simple(
  r: ResourceInstance,
  subtitle: string,
  items: Array<[string, unknown, boolean?]>,
  extra: SchemaNode[] = [],
  status: ResourceStatus = "healthy",
  statusLabel = subtitle,
  headerActions: ActionNode[] = [],
): DetailViewSchema {
  return {
    title: r.displayName,
    subtitle,
    status: { kind: "status-dot", status, label: statusLabel },
    sections: [section(subtitle, [kv(items), ...extra])],
    ...(headerActions.length > 0 ? { headerActions } : {}),
  };
}

function attachTable(
  r: ResourceInstance,
  what: "context" | "policy",
): { nodes: SchemaNode[]; actions: ActionNode[] } {
  const stacks = parseJson<Option[]>(r.resolvedOutputs[DETAIL_KEYS.stacks]) ?? [];
  const attached = parseJson<
    Array<{ id: string; stackId: string; stackName?: string; isModule?: boolean }>
  >(r.resolvedOutputs[DETAIL_KEYS.attachments]);
  const nodes: SchemaNode[] = [];
  if (attached && attached.length > 0) {
    nodes.push({
      kind: "table",
      columns: [
        { key: "name", label: "Attached to", width: "wide" },
        { key: "kind", label: "Kind" },
        { key: "detach", label: "" },
      ],
      rows: attached.map<TableRow>((a) => ({
        cells: {
          name: str(a.stackName || a.stackId),
          kind: a.isModule ? "Module" : "Stack",
          detach: action("Detach", `detach:${a.id}`, "Detached.", `Detach this ${what}?`),
        },
      })),
    });
  }
  const actions: ActionNode[] = [];
  if (stacks.length > 0) {
    actions.push(
      prompt(
        "Attach to stack",
        "attach",
        `Attach ${what} to a stack`,
        what === "context"
          ? "The stack's runs get this context's variables and files."
          : "The policy evaluates for this stack.",
        [
          {
            key: "stack",
            label: "Stack",
            kind: "select",
            required: true,
            defaultValue: stacks[0]!.id,
            options: stacks.map((s) => ({ id: s.id, label: s.name })),
          },
          ...(what === "context"
            ? [
                {
                  key: "priority",
                  label: "Priority",
                  kind: "number" as const,
                  required: false,
                  defaultValue: "0",
                  description: "Lower numbers win when contexts set the same variable.",
                },
              ]
            : []),
        ],
        "Attach",
      ),
    );
  }
  return { nodes, actions };
}

export function renderSpaceliftDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "account":
      return renderAccount(r);
    case "stack":
      return renderStack(r);
    case "run":
      return renderRun(r);
    case "space":
      return simple(r, "Space", [
        ["Description", f["description"]],
        ["Parent space", f["parentSpace"]],
        ["Inherit entities", f["inheritEntities"]],
        ["Labels", f["labels"]],
        ["Space ID", f["spaceId"], true],
      ]);
    case "stack-output":
      return simple(
        r,
        "Stack Output",
        [
          ["Name", f["name"], true],
          ["Value", f["sensitive"] === true ? "(sensitive)" : f["preview"], true],
          ["Description", f["description"]],
          ["Stack", f["stackName"]],
        ],
        [
          muted(
            "Reference the value output from other resources so they follow what the stack last applied.",
          ),
        ],
      );
    case "context": {
      const { nodes, actions } = attachTable(r, "context");
      return simple(
        r,
        "Context",
        [
          ["Description", f["description"]],
          ["Labels", f["labels"]],
          ["Space", f["space"]],
          ["Variables and files", fmt(f["variableCount"])],
          ["Context ID", f["contextId"], true],
        ],
        nodes,
        "healthy",
        "Context",
        actions,
      );
    }
    case "context-variable":
      return simple(
        r,
        "Context Variable",
        [
          ["Name", f["name"], true],
          ["Type", f["type"] === "file" ? "Mounted file" : "Environment variable"],
          ["Value", f["writeOnly"] === true ? "(secret)" : f["value"], true],
          ["Description", f["description"]],
          ["Context", f["contextName"]],
        ],
        f["writeOnly"] === true
          ? [muted("Secret values are write-only. Type a new value under Edit to replace it.")]
          : [],
      );
    case "policy": {
      const { nodes, actions } = attachTable(r, "policy");
      return {
        ...simple(
          r,
          "Policy",
          [
            ["Type", f["type"]],
            ["Description", f["description"]],
            ["Labels", f["labels"]],
            ["Space", f["space"]],
            ["Lines", fmt(f["lines"])],
            ["Updated", f["updatedAt"]],
          ],
          nodes,
          "healthy",
          str(f["type"]) || "Policy",
          actions,
        ),
        manifestEditor: { language: "yaml", resourceKind: "Policy" },
      };
    }
    case "module":
      return simple(
        r,
        "Module",
        [
          ["Provider", f["terraformProvider"]],
          [
            "Repository",
            f["namespace"] ? `${str(f["namespace"])}/${str(f["repository"])}` : f["repository"],
          ],
          ["Branch", f["branch"]],
          ["Labels", f["labels"]],
          ["Space", f["space"]],
        ],
        [],
        "healthy",
        "Module",
        [
          action("Enable", "enable", "Module enabled.", undefined, { variant: "ghost" }),
          action(
            "Disable",
            "disable",
            "Module disabled.",
            "Disable this module? No new versions are published while it is disabled.",
            { variant: "ghost" },
          ),
        ],
      );
    case "worker-pool": {
      const workers =
        parseJson<Array<{ id: string; busy?: boolean; drained?: boolean; status?: string }>>(
          r.resolvedOutputs[DETAIL_KEYS.workers],
        ) ?? [];
      return simple(
        r,
        "Worker Pool",
        [
          ["Description", f["description"]],
          ["Workers", fmt(f["workers"])],
          ["Busy", fmt(f["busyWorkers"])],
          ["Labels", f["labels"]],
          ["Space", f["space"]],
          ["Pool ID", f["workerPoolId"], true],
        ],
        workers.length > 0
          ? [
              {
                kind: "table",
                columns: [
                  { key: "id", label: "Worker", width: "wide", mono: true },
                  { key: "status", label: "Status" },
                  { key: "busy", label: "Busy" },
                  { key: "drain", label: "" },
                ],
                rows: workers.map<TableRow>((w) => ({
                  cells: {
                    id: w.id,
                    status: str(w.status),
                    busy: w.busy ? "Yes" : "No",
                    drain: w.drained
                      ? action("Undrain", `undrain:${w.id}`, "Worker accepts runs again.")
                      : action(
                          "Drain",
                          `drain:${w.id}`,
                          "Worker drained.",
                          "Drain this worker? It finishes its current run and takes no new ones.",
                        ),
                  },
                })),
              },
            ]
          : [],
        workers.length > 0 ? "healthy" : "info",
        workers.length > 0 ? `${workers.length} workers` : "No workers",
        [
          action(
            "Cycle workers",
            "cycle",
            "Workers cycling.",
            "Drain and replace every worker in this pool?",
          ),
        ],
      );
    }
    default:
      return withMetricsCapability(
        { title: r.displayName, sections: [] },
        RESOURCE_TYPES,
        r.resourceTypeId,
        DEFAULT_METRICS_WINDOW_MS,
      );
  }
}

export function renderSpaceliftSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  if (r.resourceTypeId === "stack" || r.resourceTypeId === "run") {
    return {
      id: r.id,
      label: r.displayName,
      status: dot(f["disabled"] === true ? "info" : runStatus(str(f["state"]))),
    };
  }
  return { id: r.id, label: r.displayName };
}
