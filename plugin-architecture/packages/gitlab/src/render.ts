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
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import type { GlDeployment, GlPackageFile, GlPipeline } from "./types.js";

/** Keys under which `getResource` stashes detail-only data in `resolvedOutputs`. */
export const DETAIL_KEYS = {
  storage: "__storage__",
  subgroups: "__subgroups__",
  pipelines: "__pipelines__",
  statistics: "__statistics__",
  jobs: "__jobs__",
  deployments: "__deployments__",
  files: "__files__",
  hookEvents: "__hookEvents__",
} as const;

interface StashedJob {
  id: number;
  name: string;
  stage?: string;
  status: string;
  duration?: number | null;
  queued?: number | null;
  allowFailure?: boolean;
  failureReason?: string;
  url?: string;
  ref?: string;
  createdAt?: string;
  project?: string;
  pipelineId?: number;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Seconds as `1h 2m`, `3m 4s` or `5s`. */
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

const bytes = (v: unknown) => (typeof v === "number" ? formatBytes(v) : "");
const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "");

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
    ? [{ kind: "action", label: "Open in GitLab", action: { type: "open-url", url } }]
    : [];
}

/** Pipeline and job statuses as a status dot. */
export function runStatus(status: string): ResourceStatus {
  switch (status) {
    case "success":
    case "online":
    case "available":
      return "healthy";
    case "created":
    case "pending":
    case "running":
    case "preparing":
    case "waiting_for_resource":
    case "waiting_for_callback":
    case "scheduled":
    case "canceling":
    case "stopping":
      return "provisioning";
    case "manual":
    case "skipped":
    case "canceled":
    case "blocked":
    case "stopped":
    case "offline":
    case "never_contacted":
      return "info";
    case "failed":
    case "stale":
      return "error";
    default:
      return "unknown";
  }
}

const RETRYABLE = new Set(["failed", "canceled", "success", "skipped"]);
const CANCELLABLE = new Set([
  "created",
  "pending",
  "running",
  "preparing",
  "waiting_for_resource",
  "scheduled",
  "manual",
]);

/** `<instance>/<path>/-/<suffix>` for children that only know their project's path. */
function projectLink(baseUrl: string, path: unknown, suffix: string): string | undefined {
  const p = str(path);
  return p ? `${baseUrl}/${p}/-/${suffix}` : undefined;
}

function jobTable(jobs: StashedJob[], withActions: boolean, showProject = false): SchemaNode {
  return {
    kind: "table",
    columns: [
      ...(showProject ? [{ key: "project", label: "Project" }] : []),
      { key: "stage", label: "Stage" },
      { key: "name", label: "Job", width: "wide" as const },
      { key: "status", label: "Status" },
      { key: "duration", label: "Duration" },
      { key: "queued", label: "Queued" },
      ...(withActions ? [{ key: "action", label: "" }] : []),
    ],
    rows: jobs.map<TableRow>((j) => ({
      cells: {
        ...(showProject ? { project: str(j.project) } : {}),
        stage: str(j.stage),
        name: j.name,
        status: `${j.status}${j.allowFailure && j.status === "failed" ? " (allowed)" : ""}${j.failureReason && j.status === "failed" ? `: ${j.failureReason}` : ""}`,
        duration: duration(j.duration),
        queued: duration(j.queued),
        ...(withActions
          ? {
              action:
                j.status === "manual"
                  ? action("Run", `play-job:${j.id}`, "Job started.")
                  : CANCELLABLE.has(j.status)
                    ? action("Cancel", `cancel-job:${j.id}`, "Job cancelled.")
                    : RETRYABLE.has(j.status)
                      ? action("Retry", `retry-job:${j.id}`, "Job retried.")
                      : "",
            }
          : {}),
      },
    })),
  };
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

// ---------------------------------------------------------------------------
// Per type
// ---------------------------------------------------------------------------

function renderGroup(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const storage = parseJson<{
    storageSizeLimit?: number | null;
    rootStorageStatistics?: Record<string, number> | null;
  }>(r.resolvedOutputs[DETAIL_KEYS.storage]);
  const subgroups = parseJson<Array<{ name: string; path: string }>>(
    r.resolvedOutputs[DETAIL_KEYS.subgroups],
  );
  const used = f["computeMinutesUsed"];
  const limit = f["computeMinutesLimit"];
  const sections: SectionNode[] = [
    section("Plan and usage", [
      kv([
        ["Plan", f["plan"]],
        ["Seats in use", num(f["seatsInUse"])],
        ["Billable members", num(f["billableMembers"])],
        ["Projects", num(f["projectsCount"])],
        [
          "Compute minutes used",
          typeof used === "number"
            ? `${num(used)}${typeof limit === "number" ? ` of ${num(limit)}` : ""}`
            : "",
        ],
        ["Repository storage", bytes(f["repositorySizeBytes"])],
        ["Trial ends", f["trialEndsOn"]],
        ["Subscription ends", f["subscriptionEnds"]],
      ]),
      ...(f["parentId"]
        ? [muted("Plan, seats and compute minutes belong to the top-level group.")]
        : typeof limit !== "number"
          ? [
              muted(
                "GitLab only shows the compute minutes quota to instance administrators; see Usage Quotas in GitLab for yours.",
              ),
            ]
          : []),
    ]),
    section("Group", [
      kv([
        ["Full path", f["fullPath"], true],
        ["Visibility", f["visibility"]],
        ["Description", f["description"]],
        ["Group ID", r.resolvedOutputs["groupId"], true],
        ["Created", f["createdAt"]],
      ]),
    ]),
  ];
  const stats = storage?.rootStorageStatistics;
  if (stats) {
    const rows: Array<[string, string]> = [
      ["Repositories", "repositorySize"],
      ["LFS objects", "lfsObjectsSize"],
      ["Job artifacts", "buildArtifactsSize"],
      ["Pipeline artifacts", "pipelineArtifactsSize"],
      ["Packages", "packagesSize"],
      ["Container registry", "containerRegistrySize"],
      ["Wikis", "wikiSize"],
      ["Snippets", "snippetsSize"],
      ["Uploads", "uploadsSize"],
    ];
    sections.push(
      section("Storage", [
        kv([
          ["Total", bytes(stats["storageSize"])],
          ...(storage?.storageSizeLimit
            ? [["Limit", bytes(storage.storageSizeLimit)] as [string, string]]
            : []),
          ...rows.map(([label, key]) => [label, bytes(stats[key])] as [string, string]),
        ]),
      ]),
    );
  }
  if (subgroups && subgroups.length > 0) {
    sections.push(
      section("Subgroups", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Name" },
            { key: "path", label: "Path", width: "wide", mono: true },
          ],
          rows: subgroups.map((s) => ({ cells: { name: s.name, path: s.path } })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Group", str(f["plan"])),
    status: { kind: "status-dot", status: "healthy", label: str(f["visibility"]) || "Group" },
    sections,
    headerActions: openIn(r.resolvedOutputs["webUrl"]),
  };
}

function renderProject(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const pipelines = parseJson<GlPipeline[]>(r.resolvedOutputs[DETAIL_KEYS.pipelines]);
  const stats = parseJson<Record<string, number>>(r.resolvedOutputs[DETAIL_KEYS.statistics]);
  const latest = pipelines?.[0];
  const sections: SectionNode[] = [
    section("Project", [
      kv([
        ["Path", f["pathWithNamespace"], true],
        ["Default branch", f["defaultBranch"]],
        ["Visibility", f["visibility"]],
        ["Open merge requests", num(f["openMergeRequests"])],
        ["Open issues", num(f["openIssues"])],
        ["Stars", num(f["stars"])],
        ["Forks", num(f["forks"])],
        ["CI/CD config", f["ciConfigPath"]],
        ["Last activity", f["lastActivityAt"]],
        ["Archived", f["archived"]],
        ["Project ID", f["projectId"], true],
      ]),
    ]),
    section("Clone", [
      kv([
        ["HTTPS", r.resolvedOutputs["httpCloneUrl"], true],
        ["SSH", r.resolvedOutputs["sshCloneUrl"], true],
      ]),
    ]),
  ];
  if (stats) {
    sections.push(
      section("Storage", [
        kv([
          ["Total", bytes(stats["storage_size"])],
          ["Repository", bytes(stats["repository_size"])],
          ["Job artifacts", bytes(stats["job_artifacts_size"])],
          ["Packages", bytes(stats["packages_size"])],
          ["Container registry", bytes(stats["container_registry_size"])],
          ["LFS objects", bytes(stats["lfs_objects_size"])],
          ["Commits", num(stats["commit_count"])],
        ]),
      ]),
    );
  }
  if (pipelines && pipelines.length > 0) {
    sections.push(
      section("Recent pipelines", [
        {
          kind: "table",
          columns: [
            { key: "iid", label: "#" },
            { key: "ref", label: "Ref", width: "wide" },
            { key: "status", label: "Status" },
            { key: "source", label: "Source" },
            { key: "created", label: "Created" },
          ],
          rows: pipelines.map((p) => ({
            cells: {
              iid: str(p.iid ?? p.id),
              ref: str(p.ref),
              status: p.status,
              source: str(p.source),
              created: str(p.created_at),
            },
          })),
        },
      ]),
    );
  }
  const archived = f["archived"] === true;
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Project", str(f["visibility"])),
      status: archived
        ? { kind: "status-dot", status: "info", label: "Archived" }
        : latest
          ? {
              kind: "status-dot",
              status: runStatus(latest.status),
              label: `Latest pipeline ${latest.status}`,
            }
          : { kind: "status-dot", status: "healthy", label: "Project" },
      sections,
      headerActions: [
        ...openIn(r.resolvedOutputs["webUrl"]),
        archived
          ? action("Unarchive", "unarchive", "Project unarchived.")
          : action("Archive", "archive", "Project archived.", {
              confirm: "Archive this project? It becomes read-only until unarchived.",
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
  const jobs = parseJson<StashedJob[]>(r.resolvedOutputs[DETAIL_KEYS.jobs]);
  const status = str(f["status"]);
  const sections: SectionNode[] = [
    section("Pipeline", [
      kv([
        ["Project", f["project"], true],
        ["Status", status],
        ["Ref", f["ref"]],
        ["Commit", f["sha"], true],
        ["Source", f["source"]],
        ["Name", f["name"]],
        ["Triggered by", f["user"]],
        ["Duration", duration(f["durationSecs"])],
        ["Queued", duration(f["queuedSecs"])],
        ["Coverage", f["coverage"] === undefined ? "" : `${f["coverage"]}%`],
        ["Created", f["createdAt"]],
        ["Finished", f["finishedAt"]],
      ]),
    ]),
  ];
  if (jobs && jobs.length > 0) {
    sections.push(
      section("Jobs", [
        jobTable(
          [...jobs].sort((a, b) => a.id - b.id),
          true,
        ),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Pipeline", str(f["ref"])),
    status: { kind: "status-dot", status: runStatus(status), label: status || "Pipeline" },
    sections,
    logs: { defaultTailLines: 500 },
    headerActions: [
      ...openIn(r.resolvedOutputs["webUrl"]),
      ...(CANCELLABLE.has(status) || status === "running"
        ? [
            action("Cancel", "cancel", "Pipeline cancelled.", {
              confirm: "Cancel every running job?",
            }),
          ]
        : []),
      ...(status === "failed" || status === "canceled"
        ? [action("Retry failed jobs", "retry", "Failed jobs retried.")]
        : []),
    ],
  };
}

function renderEnvironment(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  const deployments = parseJson<GlDeployment[]>(r.resolvedOutputs[DETAIL_KEYS.deployments]);
  const state = str(f["state"]);
  const sections: SectionNode[] = [
    section("Environment", [
      kv([
        ["External URL", f["externalUrl"], true],
        ["Tier", f["tier"]],
        ["State", state],
        ["Description", f["description"]],
        ["Last deployment", f["lastDeploymentStatus"]],
        ["Last deployed ref", f["lastDeploymentRef"]],
        ["Last deployed", f["lastDeployedAt"]],
        ["Last deployed by", f["lastDeployedBy"]],
        ["Auto-stops", f["autoStopAt"]],
        ["Kubernetes namespace", f["kubernetesNamespace"]],
        ["Project", f["project"], true],
      ]),
    ]),
  ];
  if (deployments && deployments.length > 0) {
    sections.push(
      section("Recent deployments", [
        {
          kind: "table",
          columns: [
            { key: "iid", label: "#" },
            { key: "ref", label: "Ref", width: "wide" },
            { key: "status", label: "Status" },
            { key: "by", label: "By" },
            { key: "at", label: "When" },
            { key: "approve", label: "" },
            { key: "reject", label: "" },
          ],
          rows: deployments.map((d) => {
            const blocked = d.status === "blocked";
            return {
              cells: {
                iid: str(d.iid ?? d.id),
                ref: str(d.ref),
                status: str(d.status),
                by: str(d.user?.username),
                at: str(d.finished_at ?? d.created_at),
                approve: blocked
                  ? action("Approve", `approve-deployment:${d.id}`, "Deployment approved.")
                  : "",
                reject: blocked
                  ? action("Reject", `reject-deployment:${d.id}`, "Deployment rejected.", {
                      variant: "danger",
                    })
                  : "",
              },
            };
          }),
        },
      ]),
    );
  }
  const url = str(f["externalUrl"]);
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Environment", str(f["tier"])),
      status: { kind: "status-dot", status: runStatus(state), label: state || "Environment" },
      sections,
      headerActions: [
        ...(url
          ? [
              {
                kind: "action" as const,
                label: "Open URL",
                action: { type: "open-url" as const, url },
              },
            ]
          : []),
        ...openIn(projectLink(baseUrl, f["project"], "environments")),
        ...(state === "available"
          ? [
              action("Stop", "stop", "Environment stopping.", {
                confirm: "Stop this environment? GitLab runs its on_stop job, if it has one.",
              }),
            ]
          : []),
      ],
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

function renderRunner(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const jobs = parseJson<StashedJob[]>(r.resolvedOutputs[DETAIL_KEYS.jobs]);
  const paused = f["paused"] === true;
  const status = str(f["status"]);
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Runner", str(f["runnerType"])),
      status: paused
        ? { kind: "status-dot", status: "info", label: "Paused" }
        : {
            kind: "status-dot",
            status: runStatus(status),
            label: f["busy"] === true ? "Running jobs" : status || "Runner",
          },
      sections: [
        section("Runner", [
          kv([
            ["Status", status],
            ["Paused", f["paused"]],
            ["Running jobs", f["busy"]],
            ["Tags", f["tagList"]],
            ["Runs untagged jobs", f["runUntagged"]],
            ["Locked", f["locked"]],
            ["Protected refs only", f["accessLevel"] === "ref_protected"],
            ["Maximum timeout", duration(f["maximumTimeout"])],
            ["Version", f["version"]],
            ["Platform", f["platform"]],
            ["Last contact", f["contactedAt"]],
            ["Registered to", f["owner"]],
            ["Maintenance note", f["maintenanceNote"]],
            ["Runner ID", f["runnerId"], true],
          ]),
          muted(
            "Get credentials resets the runner's authentication token; the old token stops working.",
          ),
        ]),
        ...(jobs && jobs.length > 0 ? [section("Recent jobs", [jobTable(jobs, false, true)])] : []),
      ],
      headerActions: [
        paused
          ? action("Resume", "resume", "Runner resumed.")
          : action("Pause", "pause", "Runner paused.", {
              confirm: "Pause this runner? It stops picking up new jobs.",
            }),
      ],
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

function renderHook(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const events = parseJson<
    Array<{ trigger?: string; status?: string | number; executionDuration?: number; at?: string }>
  >(r.resolvedOutputs[DETAIL_KEYS.hookEvents]);
  const alert = str(f["alertStatus"]);
  const failing = alert === "disabled" || alert === "temporarily_disabled";
  return simple(
    r,
    r.resourceTypeId === "group-webhook" ? "Group Webhook" : "Project Webhook",
    [
      ["URL", f["url"], true],
      ["Name", f["name"]],
      ["Description", f["description"]],
      ["Events", f["events"]],
      ["Push branch filter", f["pushEventsBranchFilter"]],
      ["Verify TLS", f["enableSslVerification"]],
      ["Secret token set", f["tokenSet"]],
      ["Delivery status", alert],
      ["Disabled until", f["disabledUntil"]],
      ["Created", f["createdAt"]],
    ],
    {
      status: failing ? "error" : "healthy",
      statusLabel: failing ? "Disabled after failures" : "Active",
      headerActions: [action("Send test push", "test", "Test push event sent.")],
      ...(events && events.length > 0
        ? {
            sections: [
              section("Recent deliveries (7 days)", [
                {
                  kind: "table",
                  columns: [
                    { key: "at", label: "When", width: "wide" },
                    { key: "trigger", label: "Event" },
                    { key: "status", label: "Response" },
                    { key: "time", label: "Took" },
                  ],
                  rows: events.map((e) => ({
                    cells: {
                      at: str(e.at),
                      trigger: str(e.trigger),
                      status: str(e.status),
                      time:
                        typeof e.executionDuration === "number"
                          ? `${Math.round(e.executionDuration * 1000)} ms`
                          : "",
                    },
                  })),
                },
              ]),
            ],
          }
        : {}),
    },
  );
}

export function renderGitLabDetail(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "group":
      return withMetricsCapability(
        renderGroup(r),
        RESOURCE_TYPES,
        r.resourceTypeId,
        365 * 24 * 60 * 60 * 1000,
      );
    case "project":
      return renderProject(r);
    case "pipeline":
      return renderPipeline(r);
    case "environment":
      return renderEnvironment(r, baseUrl);
    case "runner":
      return renderRunner(r);
    case "project-webhook":
    case "group-webhook":
      return renderHook(r);
    case "protected-branch":
      return simple(
        r,
        "Protected Branch",
        [
          ["Branch", f["name"], true],
          ["Allowed to push", f["pushAccess"]],
          ["Allowed to merge", f["mergeAccess"]],
          ["Force push allowed", f["allowForcePush"]],
          ["Code owner approval required", f["codeOwnerApprovalRequired"]],
          ["Inherited from group", f["inherited"]],
          ["Project", f["project"], true],
        ],
        {
          extra: [
            muted(
              "Changing who may push or merge re-protects the branch with the new levels (GitLab only edits levels in place on Premium). Rules for specific users, groups or deploy keys are kept only on Premium and Ultimate.",
            ),
          ],
          status: f["allowForcePush"] === true ? "degraded" : "healthy",
          statusLabel: f["allowForcePush"] === true ? "Force push allowed" : "Protected",
          headerActions: openIn(projectLink(baseUrl, f["project"], "settings/repository")),
        },
      );
    case "project-variable":
    case "group-variable":
      return simple(
        r,
        r.resourceTypeId === "group-variable" ? "Group Variable" : "Project Variable",
        [
          ["Key", f["key"], true],
          ["Environment scope", f["environmentScope"]],
          ["Type", f["variableType"] === "file" ? "File" : "Variable"],
          ["Protected", f["protected"]],
          ["Masked", f["masked"]],
          ["Hidden", f["hidden"]],
          ["Raw", f["raw"]],
          ["Description", f["description"]],
          [
            r.resourceTypeId === "group-variable" ? "Group" : "Project",
            f["group"] ?? f["project"],
            true,
          ],
        ],
        {
          extra: [
            muted(
              f["hidden"] === true
                ? "Hidden: GitLab never returns the value. Type a new value under Edit to change any setting."
                : "The value is never stored in Infrawrench. Edit replaces it, or keeps it when left empty.",
            ),
          ],
          status: f["protected"] === true || f["masked"] === true ? "healthy" : "degraded",
          statusLabel:
            f["masked"] === true ? "Masked" : f["protected"] === true ? "Protected" : "Visible",
        },
      );
    case "pipeline-schedule": {
      const active = f["active"] !== false;
      return simple(
        r,
        "Pipeline Schedule",
        [
          ["Cron", f["cron"], true],
          ["Time zone", f["cronTimezone"]],
          ["Ref", f["ref"]],
          ["Active", f["active"]],
          ["Next run", f["nextRunAt"]],
          ["Owner", f["owner"]],
          ["Last pipeline", f["lastPipelineStatus"]],
          ["Variables", f["variables"]],
          ["Project", f["project"], true],
        ],
        {
          status: !active
            ? "info"
            : f["lastPipelineStatus"]
              ? runStatus(str(f["lastPipelineStatus"]))
              : "healthy",
          statusLabel: active ? "Active" : "Inactive",
          headerActions: [
            action("Run now", "play", "Scheduled pipeline started."),
            active
              ? action("Deactivate", "deactivate", "Schedule deactivated.", { variant: "ghost" })
              : action("Activate", "activate", "Schedule activated."),
            action("Take ownership", "take-ownership", "You now own this schedule.", {
              confirm:
                "Take ownership? Scheduled pipelines then run as you, with your permissions.",
              variant: "ghost",
            }),
          ],
        },
      );
    }
    case "container-repository":
      return {
        ...simple(
          r,
          "Container Repository",
          [
            ["Location", f["location"], true],
            ["Tags", num(f["tagsCount"])],
            ["Size", bytes(f["sizeBytes"])],
            ["Last cleanup", f["cleanupPolicyStartedAt"]],
            ["Status", f["status"]],
            ["Project", f["project"], true],
            ["Created", f["createdAt"]],
          ],
          {
            extra: [muted("Every tag's digest and size are under Artifacts.")],
            headerActions: [
              action("Clean up old tags", "cleanup", "Tag cleanup started.", {
                confirm:
                  "Delete every tag older than 30 days except the newest 10? GitLab runs this in the background.",
                destructive: true,
                variant: "danger",
              }),
            ],
          },
        ),
        artifactRegistry: { format: "docker", supportsTags: true },
      };
    case "package": {
      const files = parseJson<GlPackageFile[]>(r.resolvedOutputs[DETAIL_KEYS.files]);
      const total = files?.reduce((sum, x) => sum + (x.size ?? 0), 0);
      return {
        ...simple(
          r,
          "Package",
          [
            ["Name", f["name"], true],
            ["Version", f["version"]],
            ["Type", f["packageType"]],
            ["Status", f["status"]],
            ["Files", files ? String(files.length) : ""],
            ["Total size", total === undefined ? "" : formatBytes(total)],
            ["Built by pipeline", f["pipelineStatus"]],
            ["Last downloaded", f["lastDownloadedAt"]],
            ["Project", f["project"], true],
            ["Published", f["createdAt"]],
          ],
          { headerActions: openIn(projectLink(baseUrl, f["project"], "packages")) },
        ),
        artifactRegistry: { format: str(f["packageType"]) || "generic", supportsTags: false },
      };
    }
    case "deploy-key":
      return simple(
        r,
        "Deploy Key",
        [
          ["Title", f["title"]],
          ["Fingerprint", f["fingerprint"], true],
          ["Write access", f["canPush"]],
          ["Expires", f["expiresAt"]],
          ["Project", f["project"], true],
          ["Created", f["createdAt"]],
        ],
        {
          status: f["canPush"] === true ? "degraded" : "healthy",
          statusLabel: f["canPush"] === true ? "Read-write" : "Read-only",
        },
      );
    case "deploy-token":
    case "group-deploy-token": {
      const dead = f["revoked"] === true || f["expired"] === true;
      return simple(
        r,
        r.resourceTypeId === "group-deploy-token" ? "Group Deploy Token" : "Deploy Token",
        [
          ["Username", f["username"], true],
          ["Scopes", f["scopes"]],
          ["Expires", f["expiresAt"]],
          ["Revoked", f["revoked"]],
          ["Expired", f["expired"]],
          [
            r.resourceTypeId === "group-deploy-token" ? "Group" : "Project",
            f["group"] ?? f["project"],
            true,
          ],
        ],
        {
          extra: [
            muted(
              "GitLab shows a token once. Tokens created from Infrawrench are kept as the sensitive Token output; others cannot be recovered.",
            ),
          ],
          status: dead ? "error" : "healthy",
          statusLabel:
            f["revoked"] === true ? "Revoked" : f["expired"] === true ? "Expired" : "Active",
        },
      );
    }
    case "release":
      return simple(
        r,
        "Release",
        [
          ["Tag", f["tagName"], true],
          ["Name", f["name"]],
          ["Released", f["releasedAt"]],
          ["Upcoming", f["upcoming"]],
          ["Author", f["author"]],
          ["Commit", f["commit"], true],
          ["Milestones", f["milestones"]],
          ["Assets", num(f["assetCount"])],
          ["Project", f["project"], true],
        ],
        {
          ...(f["description"]
            ? { extra: [{ kind: "text", variant: "body", content: str(f["description"]) }] }
            : {}),
          headerActions: openIn(r.resolvedOutputs["webUrl"]),
        },
      );
    case "project-member":
    case "group-member":
      return simple(
        r,
        r.resourceTypeId === "group-member" ? "Group Member" : "Project Member",
        [
          ["Username", f["username"], true],
          ["Name", f["name"]],
          ["Role", f["accessLevel"]],
          ["Custom role", f["customRole"]],
          ["Access expires", f["expiresAt"]],
          ["State", f["state"]],
          ["Added", f["createdAt"]],
          [
            r.resourceTypeId === "group-member" ? "Group" : "Project",
            f["group"] ?? f["project"],
            true,
          ],
        ],
        { statusLabel: str(f["accessLevel"]) || "Member" },
      );
    default:
      return { title: r.displayName, sections: [section("Details", [muted("No details.")])] };
  }
}

export function renderGitLabSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  switch (r.resourceTypeId) {
    case "pipeline":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["status"]))) };
    case "environment":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["state"]))) };
    case "runner":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["paused"] === true ? "info" : runStatus(str(f["status"]))),
      };
    case "pipeline-schedule":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["active"] === false ? "info" : "healthy"),
      };
    case "project":
      return {
        id: r.id,
        label: r.displayName,
        ...(f["archived"] === true ? { status: dot("info") } : {}),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
