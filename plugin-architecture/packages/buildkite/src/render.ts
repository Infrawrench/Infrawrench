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
import type { BkAnnotation, BkArtifact, BkBuild, BkCluster, BkJob } from "./mappers.js";
import { PLUGIN_ID, jobLabel, secondsBetween } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes detail-only data in `resolvedOutputs`. */
export const DETAIL_KEYS = {
  builds: "__builds__",
  jobs: "__jobs__",
  annotations: "__annotations__",
  artifacts: "__artifacts__",
  schedules: "__schedules__",
  clusters: "__clusters__",
  busyPipelines: "__busyPipelines__",
  tests: "__tests__",
  queues: "__queues__",
} as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const fmt = (n: unknown, digits = 0): string =>
  typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "";

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
    ? [{ kind: "action", label: "Open in Buildkite", action: { type: "open-url", url } }]
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

/** Build and job states as a status dot. */
export function runStatus(state: string): ResourceStatus {
  switch (state) {
    case "passed":
      return "healthy";
    case "running":
    case "scheduled":
    case "creating":
    case "waiting":
    case "assigned":
    case "accepted":
    case "pending":
    case "canceling":
    case "timing_out":
    case "limiting":
    case "limited":
    case "reserved":
    case "platform_limiting":
    case "platform_limited":
      return "provisioning";
    case "blocked":
    case "unblocked":
    case "canceled":
    case "skipped":
    case "not_run":
    case "waiting_failed":
    case "blocked_failed":
      return "degraded";
    case "failed":
    case "failing":
    case "timed_out":
    case "broken":
    case "expired":
    case "unblocked_failed":
      return "error";
    default:
      return "unknown";
  }
}

const RUNNING_BUILD = new Set([
  "running",
  "scheduled",
  "creating",
  "blocked",
  "failing",
  "canceling",
]);
const RETRYABLE_JOB = new Set(["failed", "timed_out", "canceled", "expired", "broken"]);

function buildRowsTable(builds: BkBuild[], accountId: string): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "number", label: "#", width: "narrow" },
      { key: "message", label: "Message", width: "wide" },
      { key: "branch", label: "Branch" },
      { key: "state", label: "State" },
      { key: "duration", label: "Duration" },
      { key: "created", label: "Created" },
      { key: "open", label: "" },
    ],
    rows: builds.map<TableRow>((b) => {
      const slug = b.pipeline?.slug ?? "";
      return {
        cells: {
          number: String(b.number),
          message: (b.message ?? "").split("\n")[0] ?? "",
          branch: str(b.branch),
          state: b.state,
          duration: duration(secondsBetween(b.started_at, b.finished_at)),
          created: str(b.created_at),
          open: slug ? navigate("Open", "build", `${accountId}:build:${slug}/${b.number}`) : "",
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

interface BusyPipeline {
  slug: string;
  name: string;
  running: number;
  scheduled: number;
  waiting: number;
}

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const busy = parseJson<BusyPipeline[]>(r.resolvedOutputs[DETAIL_KEYS.busyPipelines]) ?? [];
  const sections: SectionNode[] = [
    section("Right now", [
      kv([
        ["Running builds", fmt(f["runningBuilds"])],
        ["Scheduled builds", fmt(f["scheduledBuilds"])],
        ["Jobs waiting for agents", fmt(f["waitingJobs"])],
        ["Connected agents", fmt(f["agentCount"])],
        ["Busy agents", fmt(f["busyAgents"])],
      ]),
    ]),
    section("Organization", [
      kv([
        ["Name", f["name"]],
        ["Slug", f["slug"], true],
        ["Monthly active users", fmt(f["activeUsers"])],
        ["Pipelines", fmt(f["pipelineCount"])],
        ["Clusters", fmt(f["clusterCount"])],
        [
          "REST API rate limit",
          typeof f["rateLimit"] === "number"
            ? `${fmt(f["rateLimitUsed"])} of ${fmt(f["rateLimit"])} requests this minute`
            : "",
        ],
        ["Organization ID", f["organizationId"], true],
        ["GraphQL ID", f["graphqlId"], true],
      ]),
      muted(
        "Monthly active users is the figure on Buildkite's Usage page, which is what user-based plans bill on. Buildkite has no billing API, so this account has no cost graphs.",
      ),
    ]),
  ];
  if (busy.length > 0) {
    sections.push(
      section("Busiest pipelines", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Pipeline", width: "wide" },
            { key: "running", label: "Running" },
            { key: "scheduled", label: "Scheduled" },
            { key: "waiting", label: "Jobs waiting" },
            { key: "open", label: "" },
          ],
          rows: busy.map<TableRow>((p) => ({
            cells: {
              name: p.name,
              running: fmt(p.running),
              scheduled: fmt(p.scheduled),
              waiting: fmt(p.waiting),
              open: navigate("Open", "pipeline", `${r.accountId}:pipeline:${p.slug}`),
            },
          })),
        },
      ]),
    );
  }
  const waiting = typeof f["waitingJobs"] === "number" ? f["waitingJobs"] : 0;
  return {
    title: r.displayName,
    subtitle: "Organization",
    status: {
      kind: "status-dot",
      status: waiting > 0 ? "degraded" : "healthy",
      label: waiting > 0 ? `${waiting} jobs waiting` : "Organization",
    },
    sections,
    headerActions: openIn(r.resolvedOutputs["url"]),
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function renderPipeline(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const builds = parseJson<BkBuild[]>(r.resolvedOutputs[DETAIL_KEYS.builds]);
  const clusters = parseJson<BkCluster[]>(r.resolvedOutputs[DETAIL_KEYS.clusters]) ?? [];
  const archived = f["archived"] === true;
  const sections: SectionNode[] = [
    section("Right now", [
      kv([
        ["Running builds", fmt(f["runningBuilds"])],
        ["Scheduled builds", fmt(f["scheduledBuilds"])],
        ["Running jobs", fmt(f["runningJobs"])],
        ["Jobs waiting for agents", fmt(f["waitingJobs"])],
      ]),
    ]),
    section("Pipeline", [
      kv([
        ["Repository", f["repository"], true],
        ["Default branch", f["defaultBranch"]],
        ["Branch filter", f["branchConfiguration"]],
        ["Cluster", f["clusterName"] || f["clusterId"]],
        ["Visibility", f["visibility"]],
        ["Skip queued builds", f["skipQueuedBranchBuilds"]],
        ["Cancel running builds", f["cancelRunningBranchBuilds"]],
        ["Allow rebuilds", f["allowRebuilds"]],
        [
          "Default step timeout",
          f["defaultTimeoutMinutes"] ? `${f["defaultTimeoutMinutes"]} min` : "",
        ],
        [
          "Maximum step timeout",
          f["maximumTimeoutMinutes"] ? `${f["maximumTimeoutMinutes"]} min` : "",
        ],
        ["Tags", f["tags"]],
        ["Source", f["provider"]],
        ["Slug", f["slug"], true],
        ["GraphQL ID", f["graphqlId"], true],
      ]),
      ...(f["yamlSteps"] === false
        ? [
            muted(
              "This pipeline still uses visual steps. Its steps can be read but not edited here; convert it to YAML steps in Buildkite to edit them in the Steps tab.",
            ),
          ]
        : []),
    ]),
  ];
  if (builds && builds.length > 0) {
    sections.push(section("Recent builds", [buildRowsTable(builds, r.accountId)]));
  }
  const headerActions: ActionNode[] = [...openIn(r.resolvedOutputs["url"])];
  if (clusters.length > 0) {
    headerActions.push({
      kind: "action",
      label: "Move to cluster",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "moveToCluster",
        title: "Move to cluster",
        description:
          "Builds of this pipeline then run on the chosen cluster's queues. Steps that target a queue the new cluster does not have will wait for an agent.",
        fields: [
          {
            key: "clusterId",
            label: "Cluster",
            kind: "select",
            required: true,
            defaultValue: str(f["clusterId"]) || clusters[0]!.id,
            options: clusters.map((c) => ({ id: c.id, label: c.name })),
          },
        ],
        submitLabel: "Move",
      },
    });
  }
  headerActions.push(
    action(
      "Add GitHub webhook",
      "add-webhook",
      "Webhook created.",
      "Create a webhook on the GitHub repository so pushes start builds? This needs the Buildkite GitHub App.",
      { variant: "ghost" },
    ),
    archived
      ? action("Unarchive", "unarchive", "Pipeline unarchived.")
      : action(
          "Archive",
          "archive",
          "Pipeline archived.",
          "Archive this pipeline? It becomes read-only and runs no builds; history is kept.",
          { variant: "danger" },
        ),
  );
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Pipeline", str(f["clusterName"])),
    status: archived
      ? { kind: "status-dot", status: "info", label: "Archived" }
      : builds && builds[0]
        ? {
            kind: "status-dot",
            status: runStatus(builds[0].state),
            label: `Last build ${builds[0].state}`,
          }
        : { kind: "status-dot", status: "unknown", label: "Pipeline" },
    sections,
    headerActions,
    manifestEditor: { language: "yaml", resourceKind: "Steps", readOnly: f["yamlSteps"] === false },
  };
}

// ---------------------------------------------------------------------------
// Build and job
// ---------------------------------------------------------------------------

function renderBuild(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const jobs = parseJson<BkJob[]>(r.resolvedOutputs[DETAIL_KEYS.jobs]) ?? [];
  const annotations = parseJson<BkAnnotation[]>(r.resolvedOutputs[DETAIL_KEYS.annotations]) ?? [];
  const artifacts = parseJson<BkArtifact[]>(r.resolvedOutputs[DETAIL_KEYS.artifacts]) ?? [];
  const state = str(f["state"]);
  const slug = str(f["pipelineSlug"]);
  const number = str(f["number"]);
  const sections: SectionNode[] = [
    section("Build", [
      kv([
        ["Pipeline", f["pipelineName"]],
        ["State", state],
        ["Branch", f["branch"]],
        ["Commit", f["commit"], true],
        ["Message", f["message"]],
        ["Source", f["source"]],
        ["Created by", f["creator"]],
        ["Pull request", f["pullRequest"]],
        ["Rebuilt from", f["rebuiltFrom"] ? `#${f["rebuiltFrom"]}` : ""],
        ["Cancel reason", f["cancelReason"]],
        ["Duration", duration(f["durationSecs"])],
        ["Longest wait for an agent", duration(f["waitSecs"])],
        ["Created", f["createdAt"]],
        ["Finished", f["finishedAt"]],
      ]),
    ]),
  ];
  const visibleJobs = jobs.filter((j) => j.type !== "waiter");
  if (visibleJobs.length > 0) {
    sections.push(
      section("Jobs", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Job", width: "wide" },
            { key: "state", label: "State" },
            { key: "exit", label: "Exit" },
            { key: "agent", label: "Agent" },
            { key: "wait", label: "Waited" },
            { key: "duration", label: "Duration" },
            { key: "logs", label: "" },
            { key: "act", label: "" },
          ],
          rows: visibleJobs.map<TableRow>((j) => {
            const jobId = `${r.accountId}:job:${slug}/${number}/${j.id}`;
            let act: ActionNode | string = "";
            if (j.type === "manual" && (j.state === "blocked" || j.unblockable)) {
              act = action(
                "Unblock",
                `unblock-job:${j.id}`,
                "Step unblocked.",
                `Unblock "${jobLabel(j)}" and let the build continue?`,
              );
            } else if (j.type === "script" && RETRYABLE_JOB.has(j.state ?? "") && !j.retried) {
              act = action("Retry", `retry-job:${j.id}`, "Job retry started.");
            }
            return {
              cells: {
                name: jobLabel(j),
                state: str(j.state),
                exit:
                  j.exit_status === undefined || j.exit_status === null
                    ? ""
                    : String(j.exit_status),
                agent: str(j.agent?.name),
                wait: duration(secondsBetween(j.runnable_at, j.started_at)),
                duration: duration(secondsBetween(j.started_at, j.finished_at)),
                logs: j.type === "script" ? navigate("Logs", "job", jobId) : "",
                act,
              },
            };
          }),
        },
      ]),
    );
  }
  if (annotations.length > 0) {
    sections.push(
      section(
        "Annotations",
        annotations.map((a) => ({
          kind: "text",
          variant: "body",
          content: `${a.style ? `[${a.style}] ` : ""}${stripHtml(a.body_html ?? "")}`,
        })),
      ),
    );
  }
  if (artifacts.length > 0) {
    sections.push(
      section("Artifacts", [
        {
          kind: "table",
          columns: [
            { key: "path", label: "Path", width: "wide", mono: true },
            { key: "size", label: "Size" },
            { key: "state", label: "State" },
          ],
          rows: artifacts.slice(0, 100).map<TableRow>((a) => ({
            cells: { path: a.path, size: bytes(a.file_size), state: str(a.state) },
          })),
        },
      ]),
    );
  }
  const headerActions: ActionNode[] = [...openIn(r.resolvedOutputs["url"])];
  if (RUNNING_BUILD.has(state)) {
    headerActions.push(
      action("Cancel", "cancel", "Build cancelled.", "Cancel this build and its running jobs?", {
        variant: "danger",
      }),
    );
  } else {
    headerActions.push(action("Rebuild", "rebuild", "Rebuild started."));
    if (state === "failed" || state === "canceled") {
      headerActions.push(action("Retry failed jobs", "retry-failed", "Failed jobs retried."));
    }
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Build", str(f["branch"])),
    status: { kind: "status-dot", status: runStatus(state), label: state || "Build" },
    sections,
    headerActions,
    hiddenChildTypeIds: ["job"],
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);
}

function bytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderJob(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const headerActions: ActionNode[] = [...openIn(r.resolvedOutputs["url"])];
  if (f["type"] === "manual" && state === "blocked") {
    headerActions.push(action("Unblock", "unblock", "Step unblocked.", "Unblock this step?"));
  }
  if (f["type"] === "script" && RETRYABLE_JOB.has(state) && f["retried"] !== true) {
    headerActions.push(action("Retry", "retry", "Job retry started."));
  }
  if (["scheduled", "waiting", "assigned", "pending"].includes(state)) {
    headerActions.push({
      kind: "action",
      label: "Change priority",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "reprioritize",
        title: "Change job priority",
        description: "Higher numbers are dispatched to agents first.",
        fields: [
          {
            key: "priority",
            label: "Priority",
            kind: "number",
            required: true,
            defaultValue: str(f["priority"] ?? 0),
          },
        ],
        submitLabel: "Save",
      },
    });
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Job", `${str(f["pipelineSlug"])} #${str(f["buildNumber"])}`),
    status: { kind: "status-dot", status: runStatus(state), label: state || "Job" },
    sections: [
      section("Job", [
        kv([
          ["State", state],
          ["Type", f["type"]],
          ["Command", f["command"], true],
          ["Exit status", f["exitStatus"]],
          ["Soft failed", f["softFailed"]],
          ["Agent", f["agentName"]],
          ["Agent targeting", f["agentQueryRules"]],
          ["Priority", f["priority"]],
          ["Waited for an agent", duration(f["waitSecs"])],
          ["Duration", duration(f["durationSecs"])],
          ["Retries", f["retriesCount"]],
          ["Started", f["startedAt"]],
          ["Finished", f["finishedAt"]],
          ["Job ID", f["jobId"], true],
        ]),
      ]),
    ],
    headerActions,
    ...(f["type"] === "script" ? { logs: { defaultTailLines: 500 } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Agents, clusters, queues, tokens, secrets
// ---------------------------------------------------------------------------

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

function renderAgent(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const conn = str(f["connectionState"]);
  const connected = conn === "connected";
  const busy = f["busy"] === true;
  const actions: ActionNode[] = [];
  if (connected) {
    actions.push(
      {
        kind: "action",
        label: "Pause",
        variant: "ghost",
        action: {
          type: "prompt-nosql-command",
          command: "pauseAgent",
          title: "Pause agent",
          description:
            "The agent finishes its current job, then takes no new ones until resumed or the timeout passes.",
          fields: [
            {
              key: "note",
              label: "Note",
              kind: "text",
              required: false,
              placeholder: "Investigating disk space",
            },
            {
              key: "timeoutMinutes",
              label: "Resume automatically after (minutes)",
              kind: "number",
              required: false,
              defaultValue: "60",
              minValue: 1,
              maxValue: 10080,
            },
          ],
          submitLabel: "Pause",
        },
      },
      action("Resume", "resume", "Agent resumed.", undefined, { variant: "ghost" }),
      action(
        "Stop",
        "stop",
        "Agent stopping after its current job.",
        "Stop this agent once its current job finishes? It shuts itself down.",
      ),
    );
    if (busy) {
      actions.push(
        action(
          "Stop now",
          "stop-force",
          "Agent stopped.",
          "Stop this agent now? Its running job and build are cancelled.",
          { variant: "danger", destructive: true },
        ),
      );
    }
  }
  return simple(
    r,
    "Agent",
    [
      ["Connection", conn],
      ["Current job", f["currentJob"]],
      ["Hostname", f["hostname"], true],
      ["IP address", f["ipAddress"], true],
      ["Version", f["version"]],
      ["OS", f["os"]],
      ["Architecture", f["arch"]],
      ["Queue", f["queue"]],
      ["Priority", f["priority"]],
      ["Tags", f["tags"]],
      ["Connected", f["connectedAt"]],
      ["Last job finished", f["lastJobFinishedAt"]],
      ["Agent ID", f["agentId"], true],
    ],
    [],
    !connected ? "degraded" : busy ? "provisioning" : "healthy",
    !connected ? conn || "Disconnected" : busy ? "Busy" : "Idle",
    actions,
  );
}

function renderCluster(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const queues =
    parseJson<Array<{ id: string; key: string }>>(r.resolvedOutputs[DETAIL_KEYS.queues]) ?? [];
  const actions: ActionNode[] = [];
  if (queues.length > 0) {
    actions.push({
      kind: "action",
      label: "Default queue",
      variant: "ghost",
      action: {
        type: "prompt-nosql-command",
        command: "setDefaultQueue",
        title: "Default queue",
        description:
          "Agents that connect to this cluster without naming a queue take jobs from the default queue.",
        fields: [
          {
            key: "queueId",
            label: "Queue",
            kind: "select",
            required: true,
            defaultValue: str(f["defaultQueueId"]) || queues[0]!.id,
            options: queues.map((q) => ({ id: q.id, label: q.key })),
          },
        ],
        submitLabel: "Save",
      },
    });
  }
  return simple(
    r,
    "Cluster",
    [
      ["Description", f["description"]],
      ["Default queue", f["defaultQueue"]],
      ["Queues", fmt(f["queueCount"])],
      ["Connected agents", fmt(f["agentCount"])],
      ["Hosted git mirror", f["hostedGitMirror"]],
      ["Hosted container cache", f["hostedContainerCache"]],
      ["Cluster ID", f["clusterId"], true],
      ["GraphQL ID", f["graphqlId"], true],
    ],
    [muted("Use Get credentials to mint an agent token for registering agents with this cluster.")],
    "healthy",
    "Cluster",
    actions,
  );
}

function renderQueue(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const paused = f["dispatchPaused"] === true;
  const hosted = f["hosted"] === true;
  const agents = typeof f["agentCount"] === "number" ? f["agentCount"] : undefined;
  const actions: ActionNode[] = paused
    ? [action("Resume dispatch", "resume-dispatch", "Dispatch resumed.")]
    : [
        {
          kind: "action",
          label: "Pause dispatch",
          variant: "ghost",
          action: {
            type: "prompt-nosql-command",
            command: "pauseQueue",
            title: "Pause dispatch",
            description:
              "Jobs for this queue wait instead of going to agents. Running jobs carry on. The note shows on the queue and on affected builds.",
            fields: [
              {
                key: "note",
                label: "Note",
                kind: "text",
                required: false,
                placeholder: "Paused while we investigate a security issue",
              },
            ],
            submitLabel: "Pause",
            danger: true,
          },
        },
      ];
  actions.push(
    action("Make default", "make-default", "Default queue changed.", undefined, {
      variant: "ghost",
    }),
  );
  return simple(
    r,
    hosted ? "Hosted Queue" : "Queue",
    [
      ["Key", f["key"], true],
      ["Description", f["description"]],
      ["Cluster", f["clusterName"]],
      ["Instance shape", f["instanceShape"]],
      ["vCPUs", f["vcpus"]],
      ["Memory", f["memoryGb"] ? `${f["memoryGb"]} GB` : ""],
      ["Connected agents", fmt(agents)],
      ["Retry affinity", f["retryAgentAffinity"]],
      ["Dispatch paused", paused],
      ["Pause note", f["pausedNote"]],
      ["Paused at", f["pausedAt"]],
      ["Queue ID", f["queueId"], true],
    ],
    hosted
      ? [
          muted(
            "Hosted agents are billed by the minute for the instance shape; change it with Edit.",
          ),
        ]
      : [],
    paused ? "degraded" : agents === 0 && !hosted ? "info" : "healthy",
    paused ? "Paused" : agents === 0 && !hosted ? "No agents" : "Dispatching",
    actions,
  );
}

function renderSchedule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] !== false;
  const failed = Boolean(f["failedMessage"]);
  return simple(
    r,
    "Schedule",
    [
      ["Schedule", f["cronline"], true],
      ["Branch", f["branch"]],
      ["Commit", f["commit"]],
      ["Build message", f["message"]],
      ["Environment", f["env"]],
      ["Next build", f["nextBuildAt"]],
      ["Last failure", f["failedMessage"]],
      ["Failed at", f["failedAt"]],
      ["Pipeline", f["pipelineSlug"]],
    ],
    [],
    !enabled ? "info" : failed ? "error" : "healthy",
    !enabled ? "Disabled" : failed ? "Failing" : "Enabled",
    [
      enabled
        ? action(
            "Disable",
            "disable",
            "Schedule disabled.",
            "Stop this schedule from starting builds?",
          )
        : action("Enable", "enable", "Schedule enabled."),
    ],
  );
}

function renderSuite(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const flaky = typeof f["flakyTests"] === "number" ? f["flakyTests"] : undefined;
  return simple(
    r,
    "Test Suite",
    [
      ["Default branch", f["defaultBranch"]],
      ["Application", f["applicationName"]],
      ["Flaky tests", fmt(flaky)],
      ["Slug", f["slug"], true],
      ["Suite ID", f["suiteId"], true],
    ],
    [
      muted(
        "The suite API token (BUILDKITE_ANALYTICS_TOKEN) is an output: reference it from a secret export instead of copying it.",
      ),
    ],
    flaky && flaky > 0 ? "degraded" : "healthy",
    flaky && flaky > 0 ? `${flaky} flaky` : "Test Suite",
  );
}

function renderTest(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]) || "enabled";
  const actions: ActionNode[] = [];
  if (state !== "muted")
    actions.push(
      action("Mute", "mute", "Test muted.", "Mute this test? Its failures stop failing builds."),
    );
  if (state !== "skipped")
    actions.push(action("Skip", "skip", "Test skipped.", "Skip this test? It stops running."));
  if (state !== "enabled") actions.push(action("Enable", "enable", "Test enabled."));
  return simple(
    r,
    "Flaky Test",
    [
      ["Name", f["name"]],
      ["Scope", f["scope"]],
      ["Location", f["location"], true],
      ["State", state],
      ["Labels", f["labels"]],
      ["Reliability", f["reliability"] === undefined ? "" : `${f["reliability"]}%`],
      ["Executions", fmt(f["executions"])],
      ["Failed", fmt(f["failed"])],
      ["Passed", fmt(f["passed"])],
      ["Average duration", duration(f["durationAvgSecs"])],
      ["Longest", duration(f["durationMaxSecs"])],
    ],
    [
      muted(
        "Muting and skipping need test state management enabled on the suite (Pro and Enterprise plans).",
      ),
    ],
    state === "enabled" ? "degraded" : "info",
    state === "enabled" ? "Flaky" : state,
    actions,
  );
}

export function renderBuildkiteDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      break;
    case "pipeline":
      schema = renderPipeline(r);
      break;
    case "build":
      schema = renderBuild(r);
      break;
    case "job":
      schema = renderJob(r);
      break;
    case "agent":
      schema = renderAgent(r);
      break;
    case "cluster":
      schema = renderCluster(r);
      break;
    case "queue":
      schema = renderQueue(r);
      break;
    case "agent-token": {
      const expires = str(f["expiresAt"]);
      const expired = expires !== "" && Date.parse(expires) < Date.now();
      schema = simple(
        r,
        "Agent Token",
        [
          ["Description", f["description"]],
          ["Cluster", f["clusterName"]],
          ["Allowed IP ranges", f["allowedIpAddresses"] || "Any"],
          ["Expires", expires || "Never"],
          ["Created by", f["createdBy"]],
          ["Created", f["createdAt"]],
          ["Token ID", f["tokenId"], true],
        ],
        [
          muted(
            "Buildkite only shows a token's value when it is created. Tokens created from Infrawrench keep it as the token output; for any other token, mint a new one with Get credentials on the cluster.",
          ),
        ],
        expired ? "error" : "healthy",
        expired ? "Expired" : "Active",
      );
      break;
    }
    case "cluster-secret":
      schema = simple(
        r,
        "Cluster Secret",
        [
          ["Key", f["key"], true],
          ["Description", f["description"]],
          ["Access policy", f["policy"]],
          ["Cluster", f["clusterName"]],
          ["Last read by a build", f["lastReadAt"] || "Never"],
          ["Updated", f["updatedAt"]],
          ["Created", f["createdAt"]],
        ],
        [muted("Buildkite never returns the value. Type a new one under Edit to replace it.")],
      );
      break;
    case "schedule":
      schema = renderSchedule(r);
      break;
    case "pipeline-template":
      schema = {
        ...simple(r, "Pipeline Template", [
          ["Description", f["description"]],
          ["Available to non-admins", f["available"]],
          ["Steps", fmt(f["stepCount"])],
          ["Updated", f["updatedAt"]],
          ["UUID", f["templateUuid"], true],
        ]),
        manifestEditor: { language: "yaml", resourceKind: "Steps" },
      };
      break;
    case "test-suite":
      schema = renderSuite(r);
      break;
    case "test":
      schema = renderTest(r);
      break;
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderBuildkiteSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  switch (r.resourceTypeId) {
    case "build":
    case "job":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["state"]))) };
    case "agent":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(
          f["connectionState"] !== "connected"
            ? "degraded"
            : f["busy"] === true
              ? "provisioning"
              : "healthy",
        ),
      };
    case "queue":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["dispatchPaused"] === true ? "degraded" : "healthy"),
      };
    case "pipeline":
      return {
        id: r.id,
        label: r.displayName,
        ...(f["archived"] === true ? { status: dot("info") } : {}),
      };
    case "schedule":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["enabled"] === false ? "info" : f["failedMessage"] ? "error" : "healthy"),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
