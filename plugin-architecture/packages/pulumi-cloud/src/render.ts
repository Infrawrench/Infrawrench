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
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

export const DETAIL_KEYS = {
  updates: "__updates__",
  schedules: "__schedules__",
  settings: "__settings__",
  revisions: "__revisions__",
  aggregations: "__aggregations__",
  stacks: "__stacks__",
} as const;

export interface UpdateRow {
  version?: number;
  kind?: string;
  result?: string;
  start?: string;
  durationSecs?: number;
  message?: string;
  changes?: string;
}

export interface ScheduleRow {
  id: string;
  cron?: string;
  once?: string;
  operation?: string;
  paused?: boolean;
  next?: string;
  last?: string;
}

export interface RevisionRow {
  number: number;
  created: string;
  by?: string;
  tags?: string[];
  retracted?: boolean;
}

export const OPERATIONS = [
  { id: "update", label: "Update", description: "pulumi up" },
  { id: "preview", label: "Preview", description: "pulumi preview: changes nothing" },
  { id: "refresh", label: "Refresh", description: "Sync state with real infrastructure" },
  { id: "detect-drift", label: "Detect drift", description: "Refresh preview that reports drift" },
  {
    id: "remediate-drift",
    label: "Remediate drift",
    description: "Update to bring resources back in line",
  },
  { id: "destroy", label: "Destroy", description: "Delete every resource in the stack" },
];

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const fmt = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "";

export function duration(secs: unknown): string {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
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

function openIn(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Pulumi Cloud", action: { type: "open-url", url } }]
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
  variant: ActionNode["variant"] = "ghost",
): ActionNode {
  return {
    kind: "action",
    label,
    variant,
    action: { type: "prompt-nosql-command", command, title, description, fields, submitLabel },
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

export const operationField = (def = "update"): CreateFieldConfig => ({
  key: "operation",
  label: "Operation",
  kind: "select",
  required: true,
  defaultValue: def,
  options: OPERATIONS,
});

export function deploymentStatus(status: string): ResourceStatus {
  switch (status) {
    case "succeeded":
      return "healthy";
    case "failed":
      return "error";
    case "skipped":
      return "info";
    case "not-started":
    case "accepted":
    case "running":
      return "provisioning";
    default:
      return "unknown";
  }
}

function updateStatus(result: string | undefined): ResourceStatus {
  if (result === "succeeded") return "healthy";
  if (result === "failed") return "error";
  if (result === "in-progress" || result === "not-started") return "provisioning";
  return "unknown";
}

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const aggs =
    parseJson<Record<string, Array<{ name: string; count: number }>>>(
      r.resolvedOutputs[DETAIL_KEYS.aggregations],
    ) ?? {};
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"], true],
        ["Your role", f["role"]],
        ["Members", fmt(f["memberCount"])],
        ["Projects", fmt(f["projectCount"])],
        ["Stacks", fmt(f["stackCount"])],
        ["ESC environments", fmt(f["environmentCount"])],
      ]),
    ]),
    section("Usage", [
      kv([
        ["Resources under management", fmt(f["resourcesUnderManagement"])],
        ["Resource-hours (30 days)", fmt(f["resourceHours30d"])],
        ["Deployment minutes (30 days)", fmt(f["deploymentMinutes30d"])],
        ["ESC secret-hours (30 days)", fmt(f["secretHours30d"])],
      ]),
      muted(
        "Pulumi has no billing API: cost graphs price this usage at your plan's published rates, set under Edit credentials.",
      ),
    ]),
  ];
  for (const [facet, buckets] of Object.entries(aggs)) {
    if (buckets.length === 0) continue;
    sections.push(
      section(`Resources by ${facet}`, [
        {
          kind: "table",
          columns: [
            { key: "name", label: facet, width: "wide", mono: true },
            { key: "count", label: "Resources" },
          ],
          rows: buckets.map<TableRow>((b) => ({ cells: { name: b.name, count: fmt(b.count) } })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Organization",
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: openIn(r.resolvedOutputs["url"]),
  };
}

function renderStack(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const updates = parseJson<UpdateRow[]>(r.resolvedOutputs[DETAIL_KEYS.updates]) ?? [];
  const schedules = parseJson<ScheduleRow[]>(r.resolvedOutputs[DETAIL_KEYS.schedules]) ?? [];
  const settings = parseJson<{ repo?: string; branch?: string; dir?: string; operation?: string }>(
    r.resolvedOutputs[DETAIL_KEYS.settings],
  );
  const sections: SectionNode[] = [
    section("Stack", [
      kv([
        ["Resources", fmt(f["resourceCount"])],
        ["Last update", f["lastUpdate"]],
        [
          "Running now",
          f["currentOperation"] ? `${f["currentOperation"]} by ${str(f["operationAuthor"])}` : "",
        ],
        ["Drift detected", f["driftDetected"]],
        ["Description", f["description"]],
        ["Runtime", f["runtime"]],
        ["Repository", f["repository"]],
        ["Tags", f["tags"]],
        ["Secrets provider", f["secretsProvider"]],
        ["ESC environment", f["environment"]],
        ["Full name", f["fullyQualifiedName"], true],
      ]),
    ]),
    section("Deployment settings", [
      settings
        ? kv([
            ["Repository", settings.repo],
            ["Branch", settings.branch],
            ["Directory", settings.dir],
            ["Default operation", settings.operation],
          ])
        : muted(
            "No Pulumi Deployments settings yet. Add them in the Settings tab to run deployments from here.",
          ),
    ]),
  ];
  if (updates.length > 0) {
    sections.push(
      section("Update history", [
        {
          kind: "table",
          columns: [
            { key: "version", label: "#", width: "narrow" },
            { key: "kind", label: "Kind" },
            { key: "result", label: "Result" },
            { key: "changes", label: "Changes" },
            { key: "message", label: "Message", width: "wide" },
            { key: "start", label: "Started" },
            { key: "duration", label: "Duration" },
          ],
          rows: updates.map<TableRow>((u) => ({
            cells: {
              version: str(u.version),
              kind: str(u.kind),
              result: str(u.result),
              changes: str(u.changes),
              message: str(u.message).split("\n")[0] ?? "",
              start: str(u.start),
              duration: duration(u.durationSecs),
            },
          })),
        },
      ]),
    );
  }
  if (schedules.length > 0) {
    sections.push(
      section("Deployment schedules", [
        {
          kind: "table",
          columns: [
            { key: "when", label: "When", mono: true },
            { key: "operation", label: "Operation" },
            { key: "next", label: "Next run" },
            { key: "last", label: "Last run" },
            { key: "toggle", label: "" },
            { key: "delete", label: "" },
          ],
          rows: schedules.map<TableRow>((s) => ({
            cells: {
              when: str(s.cron || s.once),
              operation: str(s.operation),
              next: s.paused ? "Paused" : str(s.next),
              last: str(s.last),
              toggle: s.paused
                ? action("Resume", `schedule-resume:${s.id}`, "Schedule resumed.")
                : action("Pause", `schedule-pause:${s.id}`, "Schedule paused."),
              delete: action(
                "Delete",
                `schedule-delete:${s.id}`,
                "Schedule deleted.",
                "Delete this schedule?",
                {
                  variant: "danger",
                },
              ),
            },
          })),
        },
      ]),
    );
  }
  const busy = Boolean(f["currentOperation"]);
  const last = updates[0];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Stack", str(f["organization"])),
    status: busy
      ? { kind: "status-dot", status: "provisioning", label: str(f["currentOperation"]) }
      : f["driftDetected"] === true
        ? { kind: "status-dot", status: "degraded", label: "Drifted" }
        : {
            kind: "status-dot",
            status: updateStatus(last?.result),
            label: last?.result ? `Last update ${last.result}` : "Stack",
          },
    sections,
    headerActions: [
      ...openIn(r.resolvedOutputs["url"]),
      prompt(
        "Deploy",
        "deploy",
        "Run a deployment",
        "Runs on Pulumi Deployments with this stack's deployment settings.",
        [operationField()],
        "Run",
        "default",
      ),
      prompt(
        "Schedule",
        "schedule",
        "Schedule a deployment",
        "Runs on Pulumi Deployments on a cron schedule (UTC), or once at a time.",
        [
          operationField("detect-drift"),
          {
            key: "cron",
            label: "Cron schedule",
            kind: "text",
            required: false,
            placeholder: "0 3 * * 1-5",
            description: "Five fields, UTC.",
          },
          { key: "once", label: "Or once at", kind: "datetime", required: false },
        ],
        "Schedule",
      ),
      prompt(
        "Rename",
        "rename",
        "Rename stack",
        "Renames the stack (and can move it to another project). Code referencing it must be updated.",
        [
          {
            key: "newName",
            label: "Stack name",
            kind: "text",
            required: true,
            defaultValue: str(f["name"]),
          },
          {
            key: "newProject",
            label: "Project",
            kind: "text",
            required: true,
            defaultValue: str(f["project"]),
          },
        ],
        "Rename",
      ),
    ],
    manifestEditor: { language: "json", resourceKind: "Deployment settings" },
  };
}

function renderEnvironment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const revisions = parseJson<RevisionRow[]>(r.resolvedOutputs[DETAIL_KEYS.revisions]) ?? [];
  const latest = revisions[0]?.number;
  const sections: SectionNode[] = [
    section("Environment", [
      kv([
        ["Project", f["project"]],
        ["Owner", f["owner"]],
        ["Stacks using it", fmt(f["stackReferrers"])],
        ["Environments importing it", fmt(f["environmentReferrers"])],
        ["Deletion protected", f["deletionProtected"]],
        ["Tags", f["tags"]],
        ["Modified", f["modified"]],
      ]),
      muted("Edit the YAML in the Definition tab; every save makes a new revision."),
    ]),
  ];
  if (revisions.length > 0) {
    sections.push(
      section("Revisions", [
        {
          kind: "table",
          columns: [
            { key: "number", label: "Revision", width: "narrow" },
            { key: "created", label: "Created", width: "wide" },
            { key: "by", label: "By" },
            { key: "tags", label: "Tags" },
            { key: "rollback", label: "" },
          ],
          rows: revisions.map<TableRow>((v) => ({
            cells: {
              number: String(v.number),
              created: v.created,
              by: str(v.by),
              tags: (v.tags ?? []).join(", ") + (v.retracted ? " (retracted)" : ""),
              rollback:
                v.number !== latest && !v.retracted
                  ? action(
                      "Roll back",
                      `rollback:${v.number}`,
                      "Rolled back: a new revision now holds this definition.",
                      `Make revision ${v.number}'s definition current again? This adds a new revision.`,
                    )
                  : "",
            },
          })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "ESC Environment",
    status: {
      kind: "status-dot",
      status: "healthy",
      label: latest ? `Revision ${latest}` : "Environment",
    },
    sections,
    headerActions: [
      ...openIn(r.resolvedOutputs["url"]),
      prompt(
        "Tag revision",
        "tagRevision",
        "Tag a revision",
        "Pins a name (such as stable or prod) to a revision; consumers can open it as env@tag.",
        [
          { key: "tag", label: "Tag", kind: "text", required: true, placeholder: "stable" },
          {
            key: "revision",
            label: "Revision",
            kind: "select",
            required: true,
            ...(latest ? { defaultValue: String(latest) } : {}),
            options: revisions.map((v) => ({
              id: String(v.number),
              label: `Revision ${v.number}`,
              description: v.created,
            })),
          },
        ],
        "Tag",
      ),
    ],
    manifestEditor: { language: "yaml", resourceKind: "Definition" },
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

export function renderPulumiDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      break;
    case "project":
      schema = simple(r, "Project", [
        ["Stacks", fmt(f["stackCount"])],
        ["Resources", fmt(f["resourceCount"])],
        ["Last update", f["lastUpdate"]],
      ]);
      break;
    case "stack":
      schema = renderStack(r);
      break;
    case "stack-output":
      schema = simple(
        r,
        "Stack Output",
        [
          ["Name", f["name"], true],
          ["Type", f["type"]],
          ["Value", f["secret"] === true ? "(secret)" : f["preview"], true],
          ["Stack", `${str(f["project"])}/${str(f["stack"])}`],
        ],
        [
          muted(
            "Reference the value output from other resources so they follow what Pulumi last deployed.",
          ),
        ],
      );
      break;
    case "deployment": {
      const status = str(f["status"]);
      schema = {
        ...simple(
          r,
          "Deployment",
          [
            ["Status", status],
            ["Operation", f["operation"]],
            ["Stack", `${str(f["project"])}/${str(f["stack"])}`],
            ["Requested by", f["requestedBy"]],
            ["Initiator", f["initiator"]],
            ["Update result", f["updateResult"]],
            ["Steps", f["steps"]],
            ["Duration", duration(f["durationSecs"])],
            ["Created", f["created"]],
            ["Deployment ID", f["deploymentId"], true],
          ],
          [],
          deploymentStatus(status),
          status || "Deployment",
          ["not-started", "accepted", "running"].includes(status)
            ? [
                action("Cancel", "cancel", "Deployment cancelled.", "Cancel this deployment?", {
                  variant: "danger",
                }),
              ]
            : [],
        ),
        logs: { defaultTailLines: 500 },
      };
      break;
    }
    case "environment":
      schema = renderEnvironment(r);
      break;
    case "access-token":
      schema = simple(
        r,
        "Organization Token",
        [
          ["Description", f["description"]],
          ["Admin", f["admin"]],
          ["Created by", f["createdBy"]],
          ["Created", f["created"]],
          ["Last used", f["lastUsed"] || "Never"],
          ["Expires", f["expires"] || "Never"],
        ],
        [
          muted(
            "Pulumi shows a token once. Tokens created from Infrawrench keep it as the token output.",
          ),
        ],
      );
      break;
    case "team":
      schema = simple(r, "Team", [
        ["Display name", f["displayName"]],
        ["Description", f["description"]],
        ["Kind", f["kind"]],
        ["Members", fmt(f["memberCount"])],
        ["Stacks", fmt(f["stackCount"])],
        ["Environments", fmt(f["environmentCount"])],
      ]);
      break;
    case "webhook": {
      const active = f["active"] !== false;
      schema = simple(
        r,
        "Webhook",
        [
          ["Payload URL", f["payloadUrl"], true],
          ["Format", f["format"]],
          ["Event groups", f["groups"] || "All"],
          ["Event filters", f["filters"]],
          ["Signed", f["hasSecret"]],
        ],
        [],
        active ? "healthy" : "info",
        active ? "Active" : "Disabled",
        [
          action("Send test", "ping", "Test event sent."),
          active
            ? action("Disable", "disable", "Webhook disabled.")
            : action("Enable", "enable", "Webhook enabled."),
        ],
      );
      break;
    }
    case "policy-pack":
      schema = simple(r, "Policy Pack", [
        ["Display name", f["displayName"]],
        ["Latest version", f["latestVersion"]],
        ["Versions", fmt(f["versionCount"])],
        ["Version tags", f["versionTags"]],
      ]);
      break;
    case "policy-group": {
      const stacks =
        parseJson<Array<{ id: string; name: string }>>(r.resolvedOutputs[DETAIL_KEYS.stacks]) ?? [];
      schema = simple(
        r,
        "Policy Group",
        [
          ["Mode", f["mode"]],
          ["Applies to", f["entityType"]],
          ["Organization default", f["isOrgDefault"]],
          ["Stacks", fmt(f["stackCount"])],
          ["Policy packs", fmt(f["policyPackCount"])],
        ],
        [],
        "healthy",
        "Policy Group",
        stacks.length > 0
          ? [
              prompt(
                "Stacks",
                "groupStack",
                "Add or remove a stack",
                "Policies in this group run on the stacks it contains.",
                [
                  {
                    key: "stack",
                    label: "Stack",
                    kind: "select",
                    required: true,
                    defaultValue: stacks[0]!.id,
                    options: stacks.map((s) => ({ id: s.id, label: s.name })),
                  },
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
            ]
          : [],
      );
      break;
    }
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderPulumiSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  switch (r.resourceTypeId) {
    case "deployment":
      return { id: r.id, label: r.displayName, status: dot(deploymentStatus(str(f["status"]))) };
    case "stack":
      return {
        id: r.id,
        label: r.displayName,
        ...(f["currentOperation"]
          ? { status: dot("provisioning") }
          : f["driftDetected"] === true
            ? { status: dot("degraded") }
            : {}),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
