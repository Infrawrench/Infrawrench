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

/** Keys under which `getResource` stashes detail-only data in `resolvedOutputs`. */
export const DETAIL_KEYS = {
  runs: "__runs__",
  stateVersions: "__stateVersions__",
  assessment: "__assessment__",
  agentPools: "__agentPools__",
  workspaces: "__workspaces__",
  projects: "__projects__",
  nextInvoice: "__nextInvoice__",
  entitlements: "__entitlements__",
} as const;

export interface RunRow {
  id: string;
  status: string;
  message: string;
  createdAt: string;
  source: string;
  add?: number;
  change?: number;
  destroy?: number;
}

export interface StateVersionRow {
  id: string;
  serial?: number;
  createdAt: string;
  resources?: number;
  terraformVersion?: string;
  runId?: string;
  vcsCommit?: string;
}

export interface Option {
  id: string;
  name: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const fmt = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "";

export function duration(secs: unknown): string {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rest}s`;
  return `${rest}s`;
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

function openIn(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in HCP Terraform", action: { type: "open-url", url } }]
    : [];
}

function action(
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
  opts: { danger?: boolean; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    variant: opts.variant ?? "ghost",
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      description,
      fields,
      submitLabel,
      ...(opts.danger ? { danger: true } : {}),
    },
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

/** Run statuses as a status dot. */
export function runStatus(status: string): ResourceStatus {
  switch (status) {
    case "applied":
    case "planned_and_finished":
      return "healthy";
    case "errored":
    case "policy_soft_failed":
      return "error";
    case "planned":
    case "policy_override":
    case "cost_estimated":
    case "policy_checked":
    case "post_plan_completed":
    case "planned_and_saved":
      return "degraded";
    case "discarded":
    case "canceled":
    case "force_canceled":
      return "info";
    case "":
      return "unknown";
    default:
      return "provisioning";
  }
}

const select = (
  key: string,
  label: string,
  options: Option[],
  required = true,
  def?: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "select",
  required,
  ...((def ?? options[0]?.id) ? { defaultValue: def ?? options[0]!.id } : {}),
  options: options.map((o) => ({ id: o.id, label: o.name })),
});

const commentField: CreateFieldConfig = {
  key: "comment",
  label: "Comment",
  kind: "text",
  required: false,
  placeholder: "Reviewed the plan",
};

/** The "Queue run" form, shared by the workspace and the run create form. */
export const RUN_KIND_FIELD: CreateFieldConfig = {
  key: "kind",
  label: "Run type",
  kind: "select",
  required: true,
  defaultValue: "plan-and-apply",
  options: [
    {
      id: "plan-and-apply",
      label: "Plan and apply",
      description: "Applies after confirmation, or automatically with auto-apply.",
    },
    {
      id: "plan-only",
      label: "Plan only",
      description: "A speculative plan; nothing can be applied.",
    },
    {
      id: "refresh-only",
      label: "Refresh state",
      description: "Update state to match real infrastructure, changing nothing.",
    },
    {
      id: "destroy",
      label: "Destroy",
      description: "Plan to destroy every resource in the workspace.",
    },
  ],
};

export const RUN_EXTRA_FIELDS: CreateFieldConfig[] = [
  {
    key: "message",
    label: "Message",
    kind: "text",
    required: false,
    placeholder: "Queued from Infrawrench",
  },
  {
    key: "targets",
    label: "Target resources",
    kind: "text",
    required: false,
    placeholder: "module.vpc, aws_instance.web",
    description: "Comma-separated resource addresses (-target). Empty plans everything.",
  },
  {
    key: "replace",
    label: "Replace resources",
    kind: "text",
    required: false,
    placeholder: "aws_instance.web",
    description: "Comma-separated addresses to force replacement of (-replace).",
  },
];

// ---------------------------------------------------------------------------

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const next = parseJson<{ total?: number; createdAt?: string }>(
    r.resolvedOutputs[DETAIL_KEYS.nextInvoice],
  );
  const ent = parseJson<Record<string, unknown>>(r.resolvedOutputs[DETAIL_KEYS.entitlements]);
  const sections: SectionNode[] = [
    section("Estate", [
      kv([
        ["Workspaces", fmt(f["workspaceCount"])],
        ["Projects", fmt(f["projectCount"])],
        ["Resources under management", fmt(f["rumCount"])],
        ["Drifted workspaces", fmt(f["driftedWorkspaces"])],
        ["Workspaces failing checks", fmt(f["checksFailing"])],
        ["Active runs", fmt(f["runningRuns"])],
      ]),
    ]),
    section("Organization", [
      kv([
        ["Name", f["name"], true],
        ["Notification email", f["email"]],
        ["Plan", f["plan"]],
        ["Plan expires", f["planExpiresAt"]],
        [
          "Users",
          typeof f["userLimit"] === "number"
            ? `${fmt(f["userCount"])} of ${fmt(f["userLimit"])}`
            : fmt(f["userCount"]),
        ],
        ["Default execution mode", f["defaultExecutionMode"]],
        ["Cost estimation", f["costEstimationEnabled"]],
        ["Health assessments enforced", f["assessmentsEnforced"]],
        [
          "Next invoice",
          typeof next?.total === "number" ? `$${(next.total / 100).toFixed(2)}` : "",
        ],
        ["Organization ID", f["externalId"], true],
      ]),
    ]),
  ];
  if (ent) {
    const on = Object.entries(ent)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort();
    if (on.length > 0)
      sections.push(section("Features in this plan", [{ kind: "text", content: on.join(", ") }]));
  }
  const drifted = Number(f["driftedWorkspaces"] ?? 0);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Organization", str(f["plan"])),
    status: {
      kind: "status-dot",
      status: f["planExpired"] === true ? "error" : drifted > 0 ? "degraded" : "healthy",
      label:
        f["planExpired"] === true
          ? "Plan expired"
          : drifted > 0
            ? `${drifted} drifted`
            : "Organization",
    },
    sections,
    headerActions: openIn(r.resolvedOutputs["url"]),
  };
}

function runTable(runs: RunRow[], accountId: string): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "message", label: "Run", width: "wide" },
      { key: "status", label: "Status" },
      { key: "changes", label: "+ / ~ / -" },
      { key: "source", label: "Source" },
      { key: "created", label: "Created" },
      { key: "open", label: "" },
    ],
    rows: runs.map<TableRow>((x) => ({
      cells: {
        message: (x.message || x.id).split("\n")[0] ?? "",
        status: x.status,
        changes: x.add === undefined ? "" : `${x.add} / ${x.change ?? 0} / ${x.destroy ?? 0}`,
        source: x.source,
        created: x.createdAt,
        open: navigate("Open", "run", `${accountId}:run:${x.id}`),
      },
    })),
  };
}

function renderWorkspace(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const runs = parseJson<RunRow[]>(r.resolvedOutputs[DETAIL_KEYS.runs]) ?? [];
  const versions = parseJson<StateVersionRow[]>(r.resolvedOutputs[DETAIL_KEYS.stateVersions]) ?? [];
  const assessment = parseJson<{
    drifted?: boolean;
    succeeded?: boolean;
    createdAt?: string;
    error?: string;
  }>(r.resolvedOutputs[DETAIL_KEYS.assessment]);
  const pools = parseJson<Option[]>(r.resolvedOutputs[DETAIL_KEYS.agentPools]) ?? [];
  const projects = parseJson<Option[]>(r.resolvedOutputs[DETAIL_KEYS.projects]) ?? [];
  const locked = f["locked"] === true;
  const sections: SectionNode[] = [
    section("Workspace", [
      kv([
        ["Project", f["projectName"]],
        ["Terraform version", f["terraformVersion"]],
        ["Execution mode", f["executionMode"]],
        ["VCS repository", f["vcsRepo"]],
        ["Branch", f["vcsBranch"]],
        ["Working directory", f["workingDirectory"]],
        ["Resources", fmt(f["resourceCount"])],
        ["Resources under management", fmt(f["rumCount"])],
        ["Current run", f["currentRunStatus"]],
        ["Auto apply", f["autoApply"]],
        ["Locked", locked],
        ["Average plan", duration(Number(f["planDurationAverageMs"]) / 1000)],
        ["Average apply", duration(Number(f["applyDurationAverageMs"]) / 1000)],
        ["Run failures", fmt(f["runFailures"])],
        ["Providers", f["providers"]],
        ["Tags", f["tags"]],
        ["Workspace ID", f["workspaceId"], true],
      ]),
    ]),
    section("Health", [
      kv([
        ["Health assessments", f["assessmentsEnabled"]],
        ["Drifted", f["drifted"]],
        ["Drifted resources", fmt(f["resourcesDrifted"])],
        ["Failing checks", fmt(f["checksFailed"])],
        ["Passing checks", fmt(f["checksPassed"])],
        ["Last assessment", assessment?.createdAt],
        ["Assessment error", assessment?.error],
      ]),
      ...(f["assessmentsEnabled"] === true
        ? []
        : [
            muted(
              "Turn on Health assessments under Edit to detect drift and run continuous checks.",
            ),
          ]),
    ]),
  ];
  if (runs.length > 0) sections.push(section("Recent runs", [runTable(runs, r.accountId)]));
  if (versions.length > 0) {
    sections.push(
      section("State versions", [
        {
          kind: "table",
          columns: [
            { key: "serial", label: "Serial", width: "narrow" },
            { key: "created", label: "Created", width: "wide" },
            { key: "resources", label: "Resources" },
            { key: "version", label: "Terraform" },
            { key: "commit", label: "Commit", mono: true },
          ],
          rows: versions.map<TableRow>((v) => ({
            cells: {
              serial: str(v.serial),
              created: v.createdAt,
              resources: fmt(v.resources),
              version: str(v.terraformVersion),
              commit: str(v.vcsCommit).slice(0, 10),
            },
          })),
        },
        muted(
          "Use Get credentials to download the current state; upload it under IaC to see what it manages.",
        ),
      ]),
    );
  }
  const headerActions: ActionNode[] = [
    ...openIn(r.resolvedOutputs["url"]),
    prompt(
      "Queue run",
      "queueRun",
      "Queue a run",
      "Starts a run from the workspace's current configuration.",
      [RUN_KIND_FIELD, ...RUN_EXTRA_FIELDS],
      "Queue",
      { variant: "default" },
    ),
    locked
      ? action("Unlock", "unlock", "Workspace unlocked.")
      : prompt(
          "Lock",
          "lock",
          "Lock workspace",
          "Runs queue but do not start until it is unlocked.",
          [
            {
              key: "reason",
              label: "Reason",
              kind: "text",
              required: false,
              placeholder: "Maintenance",
            },
          ],
          "Lock",
        ),
  ];
  if (locked) {
    headerActions.push(
      action(
        "Force unlock",
        "force-unlock",
        "Workspace force-unlocked.",
        "Force-unlock this workspace? Whoever locked it loses the lock.",
        {
          variant: "danger",
        },
      ),
    );
  }
  if (projects.length > 1) {
    headerActions.push(
      prompt(
        "Move to project",
        "moveProject",
        "Move to project",
        "Team access follows the new project.",
        [select("projectId", "Project", projects, true, str(f["projectId"]))],
        "Move",
      ),
    );
  }
  headerActions.push(
    prompt(
      "Execution",
      "setExecution",
      "Execution mode",
      "Remote runs on HCP Terraform, agent runs on an agent pool you host, local only stores state.",
      [
        {
          key: "mode",
          label: "Execution mode",
          kind: "select",
          required: true,
          defaultValue: str(f["executionMode"]) || "remote",
          options: [
            { id: "remote", label: "Remote" },
            { id: "agent", label: "Agent" },
            { id: "local", label: "Local" },
          ],
        },
        ...(pools.length > 0
          ? [
              {
                ...select("agentPoolId", "Agent pool", pools, false, str(f["agentPoolId"])),
                showWhen: { fieldKey: "mode", fieldValue: "agent" },
              },
            ]
          : []),
      ],
      "Save",
    ),
  );
  const drifted = f["drifted"] === true;
  const failing = Number(f["checksFailed"] ?? 0) > 0;
  const run = str(f["currentRunStatus"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Workspace", str(f["projectName"])),
    status: locked
      ? { kind: "status-dot", status: "info", label: "Locked" }
      : drifted
        ? { kind: "status-dot", status: "degraded", label: "Drifted" }
        : failing
          ? { kind: "status-dot", status: "degraded", label: "Checks failing" }
          : { kind: "status-dot", status: runStatus(run), label: run || "No runs" },
    sections,
    headerActions,
  };
}

function renderRun(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const actions: ActionNode[] = [...openIn(r.resolvedOutputs["url"])];
  if (f["canApply"] === true) {
    actions.push(
      prompt(
        "Apply",
        "applyRun",
        "Apply this run",
        "Applies the planned changes.",
        [commentField],
        "Apply",
        { variant: "default" },
      ),
    );
  }
  if (f["canDiscard"] === true) {
    actions.push(
      prompt(
        "Discard",
        "discardRun",
        "Discard this run",
        "Skips applying the plan.",
        [commentField],
        "Discard",
      ),
    );
  }
  if (f["canCancel"] === true) {
    actions.push(
      prompt(
        "Cancel",
        "cancelRun",
        "Cancel this run",
        "Interrupts the plan or apply in progress.",
        [commentField],
        "Cancel run",
        {
          danger: true,
        },
      ),
    );
  }
  if (f["canForceCancel"] === true) {
    actions.push(
      action(
        "Force cancel",
        "force-cancel",
        "Run force-cancelled.",
        "Force-cancel this run? Terraform is stopped without cleanup and the workspace unlocks.",
        {
          variant: "danger",
          destructive: true,
        },
      ),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Run", str(f["workspaceName"])),
    status: { kind: "status-dot", status: runStatus(status), label: status || "Run" },
    sections: [
      section("Run", [
        kv([
          ["Status", status],
          ["Message", f["message"]],
          ["Workspace", f["workspaceName"]],
          ["Trigger", f["triggerReason"]],
          ["Source", f["source"]],
          ["Destroy", f["isDestroy"]],
          ["Plan only", f["planOnly"]],
          ["Refresh only", f["refreshOnly"]],
          ["Targets", f["targetAddrs"]],
          ["To add", fmt(f["resourceAdditions"])],
          ["To change", fmt(f["resourceChanges"])],
          ["To destroy", fmt(f["resourceDestructions"])],
          ["To import", fmt(f["resourceImports"])],
          ["Terraform version", f["terraformVersion"]],
          ["Duration", duration(f["durationSecs"])],
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
  const actions = [...openIn(r.resolvedOutputs["url"]), ...headerActions];
  return {
    title: r.displayName,
    subtitle,
    status: { kind: "status-dot", status, label: statusLabel },
    sections: [section(subtitle, [kv(items), ...extra])],
    ...(actions.length > 0 ? { headerActions: actions } : {}),
  };
}

function attachActions(r: ResourceInstance, what: string): ActionNode[] {
  const workspaces = parseJson<Option[]>(r.resolvedOutputs[DETAIL_KEYS.workspaces]) ?? [];
  const projects = parseJson<Option[]>(r.resolvedOutputs[DETAIL_KEYS.projects]) ?? [];
  const out: ActionNode[] = [];
  if (workspaces.length > 0) {
    out.push(
      prompt(
        "Workspaces",
        "attach",
        `Apply ${what} to workspaces`,
        `Choose a workspace to add or remove.`,
        [
          select("workspaceId", "Workspace", workspaces),
          {
            key: "op",
            label: "Change",
            kind: "select",
            required: true,
            defaultValue: "add",
            options: [
              { id: "add", label: "Add" },
              { id: "remove", label: "Remove" },
            ],
          },
        ],
        "Save",
      ),
    );
  }
  if (projects.length > 0) {
    out.push(
      prompt(
        "Projects",
        "attachProject",
        `Apply ${what} to projects`,
        `Choose a project to add or remove.`,
        [
          select("projectId", "Project", projects),
          {
            key: "op",
            label: "Change",
            kind: "select",
            required: true,
            defaultValue: "add",
            options: [
              { id: "add", label: "Add" },
              { id: "remove", label: "Remove" },
            ],
          },
        ],
        "Save",
      ),
    );
  }
  return out;
}

export function renderTfDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      break;
    case "project":
      schema = simple(r, "Project", [
        ["Description", f["description"]],
        ["Workspaces", fmt(f["workspaceCount"])],
        ["Default execution mode", f["defaultExecutionMode"]],
        ["Auto-destroy after inactivity", f["autoDestroyActivityDuration"]],
        ["Project ID", f["projectId"], true],
      ]);
      break;
    case "workspace":
      schema = renderWorkspace(r);
      break;
    case "run":
      schema = renderRun(r);
      break;
    case "variable":
    case "varset-variable":
      schema = simple(
        r,
        r.resourceTypeId === "variable" ? "Variable" : "Variable Set Variable",
        [
          ["Key", f["key"], true],
          ["Value", f["sensitive"] === true ? "(sensitive)" : f["value"], true],
          ["Category", f["category"] === "env" ? "Environment" : "Terraform"],
          ["HCL", f["hcl"]],
          ["Description", f["description"]],
          ["Workspace", f["workspaceName"]],
          ["Variable set", f["varsetName"]],
        ],
        f["sensitive"] === true
          ? [muted("Sensitive values are write-only. Type a new value under Edit to replace it.")]
          : [],
      );
      break;
    case "state-output":
      schema = simple(
        r,
        "State Output",
        [
          ["Name", f["name"], true],
          ["Type", f["type"]],
          ["Value", f["sensitive"] === true ? "(sensitive)" : f["preview"], true],
          ["Workspace", f["workspaceName"]],
        ],
        [
          muted(
            "Reference the value output from other resources so they follow what Terraform last applied.",
          ),
        ],
      );
      break;
    case "variable-set":
      schema = simple(
        r,
        "Variable Set",
        [
          ["Description", f["description"]],
          ["Global", f["global"]],
          ["Priority", f["priority"]],
          ["Variables", fmt(f["varCount"])],
          ["Workspaces", fmt(f["workspaceCount"])],
          ["Projects", fmt(f["projectCount"])],
          ["ID", f["varsetId"], true],
        ],
        [],
        "healthy",
        f["global"] === true ? "Global" : "Variable Set",
        f["global"] === true ? [] : attachActions(r, "this variable set"),
      );
      break;
    case "agent-pool": {
      const agents = Number(f["agentCount"] ?? 0);
      schema = simple(
        r,
        "Agent Pool",
        [
          ["Agents", fmt(f["agentCount"])],
          ["Available to all workspaces", f["organizationScoped"]],
          ["Workspaces using it", fmt(f["workspaceCount"])],
          ["Pool ID", f["agentPoolId"], true],
        ],
        [muted("Use Get credentials to mint a token for a new agent (TFC_AGENT_TOKEN).")],
        agents > 0 ? "healthy" : "info",
        agents > 0 ? `${agents} agents` : "No agents",
      );
      break;
    }
    case "agent": {
      const st = str(f["status"]);
      schema = simple(
        r,
        "Agent",
        [
          ["Status", st],
          ["IP address", f["ipAddress"], true],
          ["Last check-in", f["lastPingAt"]],
          ["Pool", f["poolName"]],
        ],
        [],
        st === "idle"
          ? "healthy"
          : st === "busy"
            ? "provisioning"
            : st === "errored"
              ? "error"
              : "degraded",
        st || "Agent",
      );
      break;
    }
    case "agent-token":
      schema = simple(
        r,
        "Agent Token",
        [
          ["Description", f["description"]],
          ["Pool", f["poolName"]],
          ["Created", f["createdAt"]],
          ["Last used", f["lastUsedAt"] || "Never"],
        ],
        [
          muted(
            "The value is only shown at creation. Tokens created from Infrawrench keep it as the token output.",
          ),
        ],
      );
      break;
    case "policy-set":
      schema = simple(
        r,
        "Policy Set",
        [
          ["Framework", str(f["kind"]).toUpperCase()],
          ["Description", f["description"]],
          ["Global", f["global"]],
          ["Overridable", f["overridable"]],
          ["Policies", fmt(f["policyCount"])],
          ["Workspaces", fmt(f["workspaceCount"])],
          ["Projects", fmt(f["projectCount"])],
          ["VCS repository", f["vcsRepo"]],
          ["Policies path", f["policiesPath"]],
          ["Tool version", f["policyToolVersion"]],
        ],
        [],
        "healthy",
        f["global"] === true ? "Global" : "Policy Set",
        f["global"] === true ? [] : attachActions(r, "this policy set"),
      );
      break;
    case "team":
      schema = simple(r, "Team", [
        ["Members", fmt(f["usersCount"])],
        ["Visibility", f["visibility"]],
        ["Manage workspaces", f["manageWorkspaces"]],
        ["Manage projects", f["manageProjects"]],
        ["Manage policies", f["managePolicies"]],
        ["Manage VCS settings", f["manageVcsSettings"]],
        ["Manage teams", f["manageTeams"]],
        ["SSO team ID", f["ssoTeamId"]],
        ["Team ID", f["teamId"], true],
      ]);
      break;
    case "run-task":
      schema = simple(
        r,
        "Run Task",
        [
          ["URL", f["url"], true],
          ["Description", f["description"]],
          ["Enabled", f["enabled"]],
          ["Workspaces", fmt(f["workspaceCount"])],
        ],
        [],
        f["enabled"] === false ? "info" : "healthy",
        f["enabled"] === false ? "Disabled" : "Enabled",
      );
      break;
    case "registry-module":
      schema = simple(r, "Registry Module", [
        ["Source", f["source"], true],
        ["Latest version", f["latestVersion"]],
        ["Versions", fmt(f["versionCount"])],
        ["Status", f["status"]],
        ["Registry", f["registryName"]],
        ["VCS repository", f["vcsRepo"]],
        ["No-code ready", f["noCode"]],
        ["Tests", f["testsEnabled"]],
        ["Updated", f["updatedAt"]],
      ]);
      break;
    case "registry-provider":
      schema = simple(r, "Registry Provider", [
        ["Namespace", f["namespace"]],
        ["Registry", f["registryName"]],
        ["Updated", f["updatedAt"]],
      ]);
      break;
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderTfSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  switch (r.resourceTypeId) {
    case "run":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["status"]))) };
    case "workspace":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(
          f["locked"] === true
            ? "info"
            : f["drifted"] === true || Number(f["checksFailed"] ?? 0) > 0
              ? "degraded"
              : runStatus(str(f["currentRunStatus"])),
        ),
      };
    case "agent":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["status"] === "errored" ? "error" : "healthy"),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
