import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { WEB_BASE } from "./api.js";
import { RESTRICTION_KINDS, bare, deploymentStatus, stateWord } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import type { BbDeployment, BbPipeline, BbStep } from "./types.js";

export const DETAIL_KEYS = {
  pipelines: "__pipelines__",
  steps: "__steps__",
  deployments: "__deployments__",
} as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

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

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});
const muted = (content: string): SchemaNode => ({ kind: "text", variant: "muted", content });

function action(
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

function openIn(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Bitbucket", action: { type: "open-url", url } }]
    : [];
}

/** Pipeline, step, deployment and runner words as a status dot. */
export function runStatus(word: string): ResourceStatus {
  switch (word.toUpperCase()) {
    case "SUCCESSFUL":
    case "ONLINE":
    case "ENABLED":
    case "COMPLETED":
      return "healthy";
    case "PENDING":
    case "IN_PROGRESS":
    case "RUNNING":
    case "READY":
      return "provisioning";
    case "PAUSED":
    case "STOPPED":
    case "NOT_RUN":
    case "EXPIRED":
    case "UNDEPLOYED":
    case "DISABLED":
    case "UNREGISTERED":
      return "info";
    case "OFFLINE":
    case "UNHEALTHY":
      return "degraded";
    case "FAILED":
    case "ERROR":
      return "error";
    default:
      return "unknown";
  }
}

function simple(
  r: ResourceInstance,
  subtitle: string,
  items: Array<[string, unknown, boolean?]>,
  opts: {
    extra?: SchemaNode[];
    status?: ResourceStatus;
    statusLabel?: string;
    headerActions?: ActionNode[];
    sections?: SectionNode[];
  } = {},
): DetailViewSchema {
  return {
    title: r.displayName,
    subtitle,
    status: {
      kind: "status-dot",
      status: opts.status ?? "healthy",
      label: opts.statusLabel ?? subtitle,
    },
    sections: [section(subtitle, [kv(items), ...(opts.extra ?? [])]), ...(opts.sections ?? [])],
    ...(opts.headerActions && opts.headerActions.length > 0
      ? { headerActions: opts.headerActions }
      : {}),
  };
}

function pipelineTable(pipelines: BbPipeline[]): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "n", label: "#" },
      { key: "ref", label: "Ref", width: "wide" },
      { key: "result", label: "Result" },
      { key: "trigger", label: "Trigger" },
      { key: "minutes", label: "Build time" },
      { key: "created", label: "Started" },
    ],
    rows: pipelines.map((p) => ({
      cells: {
        n: str(p.build_number),
        ref: str(p.target?.ref_name ?? p.target?.source),
        result: str(stateWord(p.state)),
        trigger: str(p.trigger?.name),
        minutes: duration(p.build_seconds_used),
        created: str(p.created_on),
      },
    })),
  };
}

function renderRepository(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const pipelines = parseJson<BbPipeline[]>(r.resolvedOutputs[DETAIL_KEYS.pipelines]);
  const latest = pipelines?.[0];
  const enabled = f["pipelinesEnabled"];
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Repository", str(f["language"])),
      status: latest
        ? {
            kind: "status-dot",
            status: runStatus(stateWord(latest.state) ?? ""),
            label: `Latest pipeline ${str(stateWord(latest.state)).toLowerCase()}`,
          }
        : {
            kind: "status-dot",
            status: "healthy",
            label: f["private"] === false ? "Public" : "Private",
          },
      sections: [
        section("Repository", [
          kv([
            ["Full name", f["fullName"], true],
            ["Project", f["project"]],
            ["Main branch", f["mainBranch"]],
            ["Language", f["language"]],
            ["Size", typeof f["sizeBytes"] === "number" ? formatBytes(f["sizeBytes"]) : ""],
            ["Private", f["private"]],
            ["Fork policy", f["forkPolicy"]],
            ["Pipelines enabled", f["pipelinesEnabled"]],
            ["Description", f["description"]],
            ["Updated", f["updatedAt"]],
          ]),
        ]),
        section("Clone", [
          kv([
            ["HTTPS", r.resolvedOutputs["httpsCloneUrl"], true],
            ["SSH", r.resolvedOutputs["sshCloneUrl"], true],
          ]),
        ]),
        ...(pipelines && pipelines.length > 0
          ? [section("Recent pipelines", [pipelineTable(pipelines)])]
          : []),
      ],
      headerActions: [
        ...openIn(r.resolvedOutputs["webUrl"]),
        ...(enabled === true
          ? [
              action("Disable Pipelines", "disable-pipelines", "Pipelines disabled.", {
                confirm: "Turn Pipelines off for this repository? Pushes stop starting builds.",
                variant: "ghost",
              }),
            ]
          : enabled === false
            ? [action("Enable Pipelines", "enable-pipelines", "Pipelines enabled.")]
            : []),
        action("Clear caches", "clear-caches", "Pipeline caches deleted.", {
          confirm: "Delete every Pipelines cache in this repository? The next builds rebuild them.",
          destructive: true,
          variant: "ghost",
        }),
      ],
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

function renderPipeline(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const steps = parseJson<BbStep[]>(r.resolvedOutputs[DETAIL_KEYS.steps]);
  const result = str(f["result"]);
  const running =
    ["PENDING", "IN_PROGRESS", "RUNNING", "PAUSED"].includes(result) ||
    f["state"] === "IN_PROGRESS";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Pipeline", str(f["refName"])),
    status: {
      kind: "status-dot",
      status: runStatus(result),
      label: result.toLowerCase() || "Pipeline",
    },
    sections: [
      section("Pipeline", [
        kv([
          ["Repository", f["repository"], true],
          ["Result", result],
          ["Ref", f["refName"]],
          ["Ref type", f["refType"]],
          ["Commit", f["commit"], true],
          ["Pipeline", f["selector"]],
          ["Trigger", f["trigger"]],
          ["Started by", f["creator"]],
          ["Build time", duration(f["buildSeconds"])],
          ["Duration", duration(f["durationSecs"])],
          ["Created", f["createdAt"]],
          ["Completed", f["completedAt"]],
        ]),
        muted("Build time is what counts against the workspace's build minutes."),
      ]),
      ...(steps && steps.length > 0
        ? [
            section("Steps", [
              {
                kind: "table",
                columns: [
                  { key: "name", label: "Step", width: "wide" },
                  { key: "result", label: "Result" },
                  { key: "image", label: "Image" },
                  { key: "duration", label: "Duration" },
                ],
                rows: steps.map((s) => ({
                  cells: {
                    name: str(s.name),
                    result: str(stateWord(s.state)),
                    image: str(s.image?.name),
                    duration: duration(
                      s.duration_in_seconds ??
                        (s.started_on && s.completed_on
                          ? (Date.parse(s.completed_on) - Date.parse(s.started_on)) / 1000
                          : undefined),
                    ),
                  },
                })),
              },
            ]),
          ]
        : []),
    ],
    logs: { defaultTailLines: 500 },
    headerActions: [
      ...openIn(r.resolvedOutputs["webUrl"]),
      ...(running
        ? [action("Stop", "stop", "Pipeline stopping.", { confirm: "Stop this pipeline?" })]
        : []),
    ],
  };
}

function renderEnvironment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const deployments = parseJson<BbDeployment[]>(r.resolvedOutputs[DETAIL_KEYS.deployments]);
  const last = str(f["lastDeploymentStatus"]);
  return withMetricsCapability(
    simple(
      r,
      "Deployment Environment",
      [
        ["Type", f["environmentType"]],
        ["Admins only", f["adminOnly"]],
        ["Locked", f["locked"]],
        ["Hidden", f["hidden"]],
        ["Last deployment", last],
        ["Last deployed", f["lastDeployedAt"]],
        ["Last deployed by", f["lastDeployedBy"]],
        ["Last release", f["lastRelease"]],
        ["Repository", f["repository"], true],
      ],
      {
        status: last ? runStatus(last) : "info",
        statusLabel: f["locked"] === true ? "Deploying" : last.toLowerCase() || "No deployments",
        ...(deployments && deployments.length > 0
          ? {
              sections: [
                section("Recent deployments", [
                  {
                    kind: "table",
                    columns: [
                      { key: "release", label: "Release", width: "wide" },
                      { key: "status", label: "Status" },
                      { key: "by", label: "By" },
                      { key: "at", label: "When" },
                    ],
                    rows: deployments.map((d) => ({
                      cells: {
                        release: str(d.release?.name),
                        status: str(deploymentStatus(d)),
                        by: str(d.state?.deployer?.display_name),
                        at: str(d.state?.completion_date ?? d.state?.start_date),
                      },
                    })),
                  },
                ]),
              ],
            }
          : {}),
      },
    ),
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

export function renderBitbucketDetail(r: ResourceInstance, workspace: string): DetailViewSchema {
  const f = r.fields;
  const repoUrl = (suffix = "") =>
    f["repository"] ? `${WEB_BASE}/${workspace}/${str(f["repository"])}${suffix}` : undefined;
  switch (r.resourceTypeId) {
    case "workspace":
      return simple(
        r,
        "Workspace",
        [
          ["Slug", f["slug"], true],
          ["Private", f["private"]],
          ["Forking", f["forkingMode"]],
          ["Members", typeof f["members"] === "number" ? f["members"].toLocaleString("en-US") : ""],
          ["UUID", r.resolvedOutputs["uuid"], true],
          ["Created", f["createdAt"]],
        ],
        {
          extra: [
            muted(
              "Bitbucket has no billing API: check build minutes and plan under Workspace settings, Plan details.",
            ),
          ],
          headerActions: openIn(r.resolvedOutputs["webUrl"]),
        },
      );
    case "project":
      return simple(
        r,
        "Project",
        [
          ["Key", f["key"], true],
          ["Description", f["description"]],
          ["Private", f["private"]],
          ["Has public repositories", f["publicRepos"]],
          ["Updated", f["updatedAt"]],
        ],
        { headerActions: openIn(r.resolvedOutputs["webUrl"]) },
      );
    case "repository":
      return renderRepository(r);
    case "pipeline":
      return renderPipeline(r);
    case "environment":
      return renderEnvironment(r);
    case "repository-variable":
    case "workspace-variable":
    case "deployment-variable":
      return simple(
        r,
        r.resourceTypeId === "workspace-variable"
          ? "Workspace Variable"
          : r.resourceTypeId === "deployment-variable"
            ? "Deployment Variable"
            : "Repository Variable",
        [
          ["Name", f["key"], true],
          ["Secured", f["secured"]],
          ["Environment", f["environment"]],
          ["Repository", f["repository"], true],
        ],
        {
          extra: [
            muted(
              f["secured"] === true
                ? "Secured: Bitbucket never returns the value. Type a new value under Edit to change it."
                : "The value is never stored in Infrawrench. Edit replaces it, or keeps it when left empty.",
            ),
          ],
          status: f["secured"] === true ? "healthy" : "degraded",
          statusLabel: f["secured"] === true ? "Secured" : "Visible",
        },
      );
    case "branch-restriction":
      return simple(
        r,
        "Branch Restriction",
        [
          ["Rule", RESTRICTION_KINDS[str(f["kind"])]?.label ?? f["kind"]],
          ["Applies to", f["pattern"]],
          ["Required count", f["value"]],
          ["Exempt users", f["users"]],
          ["Exempt groups", f["groups"]],
          ["Repository", f["repository"], true],
        ],
        {
          extra: [
            muted(
              "Exempt users and groups are kept when you edit; manage them in Bitbucket's branch permissions.",
            ),
          ],
          headerActions: openIn(repoUrl("/admin/branch-restrictions")),
        },
      );
    case "repository-webhook":
    case "workspace-webhook": {
      const active = f["active"] !== false;
      return simple(
        r,
        r.resourceTypeId === "workspace-webhook" ? "Workspace Webhook" : "Repository Webhook",
        [
          ["URL", f["url"], true],
          ["Description", f["description"]],
          ["Events", f["events"]],
          ["Active", f["active"]],
          ["Secret set", f["secretSet"]],
          ["Created", f["createdAt"]],
        ],
        {
          status: active ? "healthy" : "info",
          statusLabel: active ? "Active" : "Inactive",
          headerActions: [
            active
              ? action("Deactivate", "deactivate", "Webhook deactivated.", { variant: "ghost" })
              : action("Activate", "activate", "Webhook activated."),
          ],
        },
      );
    }
    case "deploy-key":
    case "project-deploy-key":
      return simple(
        r,
        r.resourceTypeId === "project-deploy-key" ? "Project Deploy Key" : "Deploy Key",
        [
          ["Label", f["label"]],
          ["Key type", f["keyType"]],
          ["Comment", f["comment"]],
          ["Last used", f["lastUsedAt"] ?? "Never"],
          ["Added", f["createdAt"]],
          ["Repository", f["repository"], true],
          ["Project", f["project"], true],
        ],
        { statusLabel: "Read-only" },
      );
    case "runner": {
      const status = str(f["status"]);
      const outdated = f["version"] && f["latestVersion"] && f["version"] !== f["latestVersion"];
      return simple(
        r,
        "Runner",
        [
          ["Status", status],
          ["Registered to", f["scope"]],
          ["Labels", f["labels"]],
          ["Version", f["version"]],
          ["Latest version", f["latestVersion"]],
          ["Cordoned", f["cordoned"]],
          ["Last seen", f["stateUpdatedAt"]],
          ["UUID", r.resolvedOutputs["runnerUuid"], true],
        ],
        {
          extra: [
            muted(
              `Start a runner with the OAuth client ID and secret outputs (kept only for runners created from Infrawrench), the workspace UUID and this runner's UUID ${bare(r.resolvedOutputs["runnerUuid"])}.${outdated ? " A newer runner version is available." : ""}`,
            ),
          ],
          status: runStatus(status),
          statusLabel: status.toLowerCase() || "Runner",
          headerActions: [
            status === "DISABLED"
              ? action("Enable", "enable", "Runner enabled.")
              : action("Disable", "disable", "Runner disabled.", {
                  confirm: "Disable this runner? It stops taking steps.",
                  variant: "ghost",
                }),
          ],
        },
      );
    }
    case "pipeline-schedule": {
      const runs = parseJson<BbPipeline[]>(r.resolvedOutputs[DETAIL_KEYS.pipelines]);
      const enabled = f["enabled"] !== false;
      return simple(
        r,
        "Pipeline Schedule",
        [
          ["Cron (UTC)", f["cron"], true],
          ["Branch", f["refName"]],
          ["Pipeline", f["selector"]],
          ["Enabled", f["enabled"]],
          ["Repository", f["repository"], true],
          ["Updated", f["updatedAt"]],
        ],
        {
          status: enabled ? "healthy" : "info",
          statusLabel: enabled ? "Enabled" : "Disabled",
          headerActions: [
            enabled
              ? action("Disable", "disable", "Schedule disabled.", { variant: "ghost" })
              : action("Enable", "enable", "Schedule enabled."),
          ],
          ...(runs && runs.length > 0
            ? { sections: [section("Recent runs", [pipelineTable(runs)])] }
            : {}),
        },
      );
    }
    case "pipeline-cache":
      return simple(r, "Pipeline Cache", [
        ["Name", f["name"]],
        ["Path", f["path"], true],
        ["Size", typeof f["sizeBytes"] === "number" ? formatBytes(f["sizeBytes"]) : ""],
        ["Repository", f["repository"], true],
        ["Created", f["createdAt"]],
      ]);
    default:
      return { title: r.displayName, sections: [section("Details", [muted("No details.")])] };
  }
}

export function renderBitbucketSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  switch (r.resourceTypeId) {
    case "pipeline":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["result"]))) };
    case "runner":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["status"]))) };
    case "environment":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["lastDeploymentStatus"] ? runStatus(str(f["lastDeploymentStatus"])) : "info"),
      };
    case "pipeline-schedule":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["enabled"] === false ? "info" : "healthy"),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
