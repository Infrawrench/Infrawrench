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
import { DEFAULT_METRICS_WINDOW_MS } from "./constants.js";
import { SLEEP_OPTIONS, flavorOptions } from "./create-config.js";
import { ROUTER_BASE } from "./http.js";
import { computeDescription, computeLabel, repoUrl } from "./mappers.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import type {
  Compute,
  HardwareFlavor,
  RouterModel,
  ServiceAccount,
  SpaceKeyEntry,
} from "./wire.js";

const CHAT_TASKS = new Set(["text-generation", "image-text-to-text", "any-to-any"]);

function s(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function dash(value: unknown): string {
  return s(value) || "—";
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function kv(items: Array<[string, unknown]>, copyable: string[] = []): SchemaNode {
  const out: KVItem[] = items.map(([key, value]) => ({
    key,
    value: dash(value),
    ...(copyable.includes(key) && s(value) ? { copyable: true } : {}),
  }));
  return { kind: "key-value-list", items: out };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function refresh(): ActionNode {
  return { kind: "action", label: "Refresh", action: { type: "refresh-resource" } };
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, variant: "ghost", action: { type: "open-url", url } };
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; destructive?: boolean; danger?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

export function endpointStatus(state: string): ResourceStatus {
  switch (state) {
    case "running":
      return "healthy";
    case "scaledToZero":
      return "info";
    case "paused":
      return "degraded";
    case "failed":
    case "updateFailed":
      return "error";
    case "pending":
    case "initializing":
    case "updating":
      return "provisioning";
    default:
      return "unknown";
  }
}

export function spaceStatus(stage: string): ResourceStatus {
  switch (stage) {
    case "RUNNING":
      return "healthy";
    case "BUILDING":
    case "RUNNING_BUILDING":
    case "APP_STARTING":
    case "RUNNING_APP_STARTING":
      return "provisioning";
    case "BUILD_ERROR":
    case "RUNTIME_ERROR":
    case "CONFIG_ERROR":
    case "NO_APP_FILE":
      return "error";
    case "PAUSED":
    case "STOPPED":
    case "SLEEPING":
      return "degraded";
    default:
      return "unknown";
  }
}

export function jobStatus(stage: string): ResourceStatus {
  switch (stage) {
    case "COMPLETED":
      return "healthy";
    case "RUNNING":
    case "SCHEDULING":
      return "provisioning";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "DELETED":
      return "degraded";
    default:
      return "unknown";
  }
}

function statusFor(resource: ResourceInstance): { status: ResourceStatus; label?: string } {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "hf-inference-endpoint":
      return { status: endpointStatus(s(f["state"])), label: s(f["state"]) || "unknown" };
    case "hf-space":
      return { status: spaceStatus(s(f["stage"])), label: s(f["stage"]) || "unknown" };
    case "hf-job":
      return { status: jobStatus(s(f["stage"])), label: s(f["stage"]) || "unknown" };
    case "hf-scheduled-job":
      return f["suspended"] === true || f["suspended"] === "true"
        ? { status: "degraded", label: "Suspended" }
        : { status: "healthy", label: "Active" };
    case "hf-member-token": {
      const st = s(f["status"]);
      if (st === "revoked" || st === "denied") return { status: "error", label: st };
      if (st === "pending") return { status: "provisioning", label: st };
      return { status: "healthy", label: st || "active" };
    }
    case "hf-webhook":
      return s(f["disabled"])
        ? { status: "degraded", label: "Disabled" }
        : { status: "healthy", label: "Enabled" };
    case "hf-model":
    case "hf-dataset":
      return f["disabled"] === true
        ? { status: "error", label: "Disabled" }
        : { status: "info", label: s(f["visibility"]) || "public" };
    default:
      return { status: "info" };
  }
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  const st = statusFor(resource);
  return {
    id: resource.id,
    label: resource.displayName || resource.externalId || resource.id,
    status: { kind: "status-dot", status: st.status },
  };
}

export function renderDetail(resource: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (resource.resourceTypeId) {
    case "hf-inference-endpoint":
      schema = renderEndpoint(resource);
      break;
    case "hf-model":
    case "hf-dataset":
      schema = renderRepo(resource);
      break;
    case "hf-space":
      schema = renderSpace(resource);
      break;
    case "hf-job":
      schema = renderJob(resource);
      break;
    case "hf-scheduled-job":
      schema = renderScheduledJob(resource);
      break;
    case "hf-provider-model":
      schema = renderProviderModel(resource);
      break;
    case "hf-service-account":
      schema = renderServiceAccount(resource);
      break;
    case "hf-member-token":
      schema = renderMemberToken(resource);
      break;
    case "hf-webhook":
      schema = renderWebhook(resource);
      break;
    default:
      schema = { title: resource.displayName, subtitle: "Hugging Face", sections: [] };
  }
  return withMetricsCapability(
    schema,
    RESOURCE_TYPES,
    resource.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

// ------------------------------------------------------------ endpoints

function renderEndpoint(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = s(f["state"]);
  const url = s(f["url"]);
  const price = Number(f["pricePerHour"]);
  const target = Number(f["targetReplica"] ?? 0);
  const computes = parseJson<Compute[]>(r.resolvedOutputs["__computes__"], []);
  const replicas = parseJson<Array<{ id?: string; status?: { stage?: string; live?: boolean } }>>(
    r.resolvedOutputs["__replicas__"],
    [],
  );
  const name = s(f["name"]) || (r.externalId ?? "");

  const actions: ActionNode[] = [refresh()];
  if (state === "paused") {
    actions.push(pluginAction("Resume", "resume", { success: "Resuming the endpoint." }));
  } else if (state && state !== "failed") {
    actions.push(
      pluginAction("Pause", "pause", {
        confirm: "Pause this endpoint? It stops serving and stops billing until you resume it.",
        success: "Pausing the endpoint.",
      }),
    );
    if (state === "running") {
      actions.push(
        pluginAction("Scale to zero", "scale-to-zero", {
          confirm:
            "Scale this endpoint to zero now? The next request wakes it, which takes a cold start.",
          success: "Scaling to zero.",
        }),
      );
    }
  } else if (state === "failed") {
    actions.push(pluginAction("Resume", "resume", { success: "Restarting the endpoint." }));
  }
  if (computes.length > 0) {
    const current = computes.find(
      (c) => c.instanceType === s(f["instanceType"]) && c.instanceSize === s(f["instanceSize"]),
    );
    actions.push({
      kind: "action",
      label: "Change hardware",
      action: {
        type: "prompt-nosql-command",
        command: "changeHardware",
        title: "Change hardware",
        description: `Moves ${name} to different hardware in ${s(f["vendor"]).toUpperCase()} ${s(f["region"])}. Replicas restart on the new instance.`,
        fields: [
          {
            key: "compute",
            label: "Hardware",
            kind: "select",
            required: true,
            ...(current?.id ? { defaultValue: current.id } : {}),
            options: computes.map((c) => ({
              id: String(c.id),
              label: computeLabel(c),
              description: computeDescription(c),
            })),
          },
        ],
        submitLabel: "Change hardware",
      },
    });
  }
  actions.push(
    openUrl(
      "Open in console",
      `https://endpoints.huggingface.co/${encodeURIComponent(s(f["namespace"]) || "")}${s(f["namespace"]) ? "/" : ""}endpoints/${encodeURIComponent(name)}`,
    ),
  );

  const sections: SectionNode[] = [
    section("Endpoint", [
      kv(
        [
          ["Name", name],
          ["State", state],
          ["Message", f["message"]],
          ["Security Level", f["type"]],
          ["URL", url],
          ["Tags", f["tags"]],
        ],
        ["URL"],
      ),
    ]),
    section("Model", [
      kv([
        ["Repository", f["repository"]],
        ["Revision", f["revision"] || "latest"],
        ["Task", f["task"]],
        ["Container", f["container"]],
        ["Framework", f["framework"]],
      ]),
    ]),
    section("Compute", [
      kv([
        ["Cloud", s(f["vendor"]).toUpperCase()],
        ["Region", f["region"]],
        ["Accelerator", s(f["accelerator"]).toUpperCase()],
        ["Instance", [f["instanceType"], f["instanceSize"]].filter(Boolean).join(" ")],
        [
          "Price",
          Number.isFinite(price) && price > 0 ? `$${price.toFixed(3)} per replica-hour` : "",
        ],
        [
          "Current Burn",
          Number.isFinite(price) && price > 0
            ? `$${(price * target).toFixed(3)}/h (${target} replica${target === 1 ? "" : "s"})`
            : "",
        ],
      ]),
    ]),
    section("Autoscaling", [
      kv([
        ["Min Replicas", f["minReplica"]],
        ["Max Replicas", f["maxReplica"]],
        ["Scale to Zero After", s(f["scaleToZeroTimeout"]) ? `${f["scaleToZeroTimeout"]} min` : ""],
        ["Ready / Target", `${f["readyReplica"] ?? 0} / ${f["targetReplica"] ?? 0}`],
        ["Last Used", f["lastUsedAt"]],
      ]),
    ]),
  ];
  if (replicas.length > 0) {
    sections.push(
      section("Replicas", [
        {
          kind: "table",
          columns: [
            { key: "id", label: "Replica", mono: true },
            { key: "stage", label: "Stage" },
            { key: "live", label: "Live" },
          ],
          rows: replicas.map((rep) => ({
            cells: {
              id: s(rep.id),
              stage: s(rep.status?.stage),
              live: rep.status?.live ? "yes" : "no",
            },
          })),
        },
      ]),
    );
  }
  sections.push(
    section("Timeline", [
      kv([
        ["Created", f["createdAt"]],
        ["Created By", f["createdBy"]],
        ["Updated", f["updatedAt"]],
      ]),
    ]),
  );

  const task = s(f["task"]);
  const chatReady = state === "running" || state === "scaledToZero";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Inference Endpoint", f["repository"]),
    status: { kind: "status-dot", ...statusFor(r) },
    sections,
    headerActions: actions,
    logs: { defaultTailLines: 500 },
    ...(CHAT_TASKS.has(task) || !task
      ? {
          chatPanel: {
            subtitle: `${s(f["repository"])} on ${url || "this endpoint"}`,
            inputPlaceholder: "Send a message to the endpoint…",
            ...(chatReady && url
              ? {}
              : {
                  disabledReason:
                    state === "paused"
                      ? "The endpoint is paused. Resume it to chat."
                      : "The endpoint is not running yet.",
                }),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------- repos

function renderRepo(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const isModel = r.resourceTypeId === "hf-model";
  const repoId = s(f["repoId"]) || (r.externalId ?? "");
  const url = repoUrl(isModel ? "model" : "dataset", repoId);
  const storage = Number(f["usedStorage"] ?? 0);
  return {
    title: repoId,
    subtitle: isModel ? joinSubtitle("Model", s(f["pipelineTag"])) : "Dataset",
    status: { kind: "status-dot", ...statusFor(r) },
    sections: [
      section("Repository", [
        kv(
          [
            ["ID", repoId],
            ["Visibility", f["visibility"]],
            ["Gated Access", f["gated"]],
            ...(isModel
              ? ([
                  ["Task", f["pipelineTag"]],
                  ["Library", f["libraryName"]],
                ] as Array<[string, unknown]>)
              : []),
            ["Storage", storage > 0 ? formatBytes(storage) : ""],
          ],
          ["ID"],
        ),
      ]),
      section("Activity", [
        kv([
          ["Downloads (30 days)", Number(f["downloads"] ?? 0).toLocaleString()],
          ["Likes", Number(f["likes"] ?? 0).toLocaleString()],
          ["Last Modified", f["lastModified"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Use it", [
        { kind: "text", variant: "mono", copyable: true, content: `git clone ${url}` },
      ]),
    ],
    headerActions: [
      refresh(),
      openUrl("Open on the Hub", url),
      openUrl("Settings", `${url}/settings`),
      ...(isModel
        ? [
            openUrl(
              "Deploy",
              `https://endpoints.huggingface.co/new?repository=${encodeURIComponent(repoId)}`,
            ),
          ]
        : []),
    ],
  };
}

// --------------------------------------------------------------- spaces

function renderSpace(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const repoId = s(f["repoId"]) || (r.externalId ?? "");
  const url = repoUrl("space", repoId);
  const appUrl = r.resolvedOutputs["appUrl"] ?? "";
  const secrets = parseJson<SpaceKeyEntry[]>(r.resolvedOutputs["__secrets__"], []);
  const variables = parseJson<SpaceKeyEntry[]>(r.resolvedOutputs["__variables__"], []);
  const hardware = parseJson<HardwareFlavor[]>(r.resolvedOutputs["__hardware__"], []);
  const sdk = s(f["sdk"]);
  const isStatic = sdk === "static";
  const sleep = s(f["sleepTimeSeconds"]);
  const sleepLabel =
    sleep === "-1"
      ? "Never"
      : sleep
        ? (SLEEP_OPTIONS.find((o) => o.id === sleep)?.label ?? `${sleep} s`)
        : "";

  const actions: ActionNode[] = [refresh()];
  if (!isStatic) {
    actions.push(
      pluginAction("Restart", "restart", { success: "Restarting the Space." }),
      pluginAction("Factory rebuild", "factory-reboot", {
        confirm: "Rebuild this Space from scratch, discarding the build cache?",
        success: "Rebuilding the Space.",
      }),
      pluginAction("Pause", "pause", {
        confirm: "Pause this Space? It stops serving and stops billing until you restart it.",
        success: "Pausing the Space.",
      }),
    );
    if (hardware.length > 0) {
      actions.push({
        kind: "action",
        label: "Change hardware",
        action: {
          type: "prompt-nosql-command",
          command: "changeHardware",
          title: "Change hardware",
          description:
            "The Space restarts on the new hardware. Paid hardware is billed per minute while running.",
          fields: [
            {
              key: "flavor",
              label: "Hardware",
              kind: "select",
              required: true,
              defaultValue: s(f["requestedHardware"]) || s(f["hardware"]) || "cpu-basic",
              options: flavorOptions(hardware),
            },
            {
              key: "sleepTimeSeconds",
              label: "Sleep After",
              kind: "select",
              required: false,
              defaultValue: "3600",
              options: SLEEP_OPTIONS,
              showWhen: { fieldKey: "flavor", fieldValuesNot: ["cpu-basic", "zero-a10g"] },
            },
          ],
          submitLabel: "Change hardware",
        },
      });
    }
    actions.push({
      kind: "action",
      label: "Set sleep time",
      action: {
        type: "prompt-nosql-command",
        command: "setSleepTime",
        title: "Sleep time",
        description:
          "How long the Space may sit idle before it sleeps. Only upgraded hardware can change this; free CPU Spaces always sleep after 48 hours.",
        fields: [
          {
            key: "seconds",
            label: "Sleep After",
            kind: "select",
            required: true,
            defaultValue: sleep || "3600",
            options: SLEEP_OPTIONS,
          },
        ],
        submitLabel: "Save",
      },
    });
  }
  actions.push(
    keyPrompt(
      "Add secret",
      "addSecret",
      "Secrets are write-only: the value can be replaced but never read back.",
    ),
    keyPrompt(
      "Add variable",
      "addVariable",
      "Variables are visible to anyone who can see the Space's settings.",
    ),
  );
  if (appUrl) actions.push(openUrl("Open app", appUrl));
  actions.push(openUrl("Open on the Hub", url));

  const secretRows: TableRow[] = secrets.map((e) => ({
    cells: {
      key: s(e.key),
      description: s(e.description),
      updated: s(e.updatedAt),
      remove: pluginAction("Delete", `delete-secret:${s(e.key)}`, {
        confirm: `Delete the secret ${s(e.key)}? The Space restarts without it.`,
        destructive: true,
        danger: true,
      }),
    },
  }));
  const variableRows: TableRow[] = variables.map((e) => ({
    cells: {
      key: s(e.key),
      value: s(e.value),
      description: s(e.description),
      remove: pluginAction("Delete", `delete-variable:${s(e.key)}`, {
        confirm: `Delete the variable ${s(e.key)}?`,
        destructive: true,
        danger: true,
      }),
    },
  }));

  const sections: SectionNode[] = [
    section("Space", [
      kv(
        [
          ["ID", repoId],
          ["SDK", sdk],
          ["Stage", f["stage"]],
          ["Error", f["errorMessage"]],
          ["Visibility", f["visibility"]],
          ["App URL", appUrl],
        ],
        ["ID", "App URL"],
      ),
    ]),
    section("Runtime", [
      kv([
        ["Hardware", f["hardware"]],
        ["Requested Hardware", f["requestedHardware"]],
        ["Sleep After", sleepLabel],
        ["Persistent Storage", f["storage"] || "none"],
      ]),
    ]),
    section("Secrets", [
      secretRows.length
        ? {
            kind: "table",
            columns: [
              { key: "key", label: "Key", mono: true },
              { key: "description", label: "Description" },
              { key: "updated", label: "Updated" },
              { key: "remove", label: "", width: "narrow" },
            ],
            rows: secretRows,
          }
        : { kind: "text", variant: "muted", content: "No secrets." },
    ]),
    section("Variables", [
      variableRows.length
        ? {
            kind: "table",
            columns: [
              { key: "key", label: "Key", mono: true },
              { key: "value", label: "Value", mono: true },
              { key: "description", label: "Description" },
              { key: "remove", label: "", width: "narrow" },
            ],
            rows: variableRows,
          }
        : { kind: "text", variant: "muted", content: "No variables." },
    ]),
    section("Activity", [
      kv([
        ["Likes", Number(f["likes"] ?? 0).toLocaleString()],
        ["Last Modified", f["lastModified"]],
        ["Created", f["createdAt"]],
      ]),
    ]),
  ];

  return {
    title: r.displayName,
    subtitle: joinSubtitle("Space", sdk),
    status: { kind: "status-dot", ...statusFor(r) },
    sections,
    headerActions: actions,
  };
}

function keyPrompt(label: string, command: string, description: string): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title: label,
      description: `${description} Saving restarts the Space.`,
      fields: [
        { key: "key", label: "Key", kind: "text", required: true, placeholder: "HF_TOKEN" },
        {
          key: "value",
          label: "Value",
          kind: command === "addSecret" ? "password" : "text",
          required: true,
        },
        { key: "description", label: "Description", kind: "text", required: false },
      ],
      submitLabel: "Save",
    },
  };
}

// ----------------------------------------------------------------- jobs

function renderJob(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stage = s(f["stage"]);
  const running = stage === "RUNNING" || stage === "SCHEDULING";
  const runningSecs = Number(f["runningSecs"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Job", f["flavor"]),
    status: { kind: "status-dot", ...statusFor(r) },
    sections: [
      section("Job", [
        kv(
          [
            ["Job ID", f["jobId"]],
            ["Stage", stage],
            ["Message", f["message"]],
            ["Image", f["dockerImage"]],
            ["Space", f["spaceId"]],
            ["Hardware", f["flavor"]],
            ["Timeout", s(f["timeoutSeconds"]) ? `${f["timeoutSeconds"]} s` : ""],
          ],
          ["Job ID"],
        ),
      ]),
      ...(s(f["command"])
        ? [
            section("Command", [
              { kind: "text", variant: "mono", copyable: true, content: s(f["command"]) },
            ]),
          ]
        : []),
      section("Timeline", [
        kv([
          ["Created", f["createdAt"]],
          ["Created By", f["createdBy"]],
          ["Started", f["startedAt"]],
          ["Finished", f["finishedAt"]],
          [
            "Running Time",
            Number.isFinite(runningSecs) && runningSecs > 0 ? `${Math.round(runningSecs)} s` : "",
          ],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      ...(running
        ? [
            pluginAction("Cancel", "cancel", {
              confirm: "Cancel this job? Time already used is still billed.",
              success: "Cancelling the job.",
            }),
          ]
        : []),
    ],
  };
}

function renderScheduledJob(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const suspended = f["suspended"] === true || f["suspended"] === "true";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Scheduled Job", f["schedule"]),
    status: { kind: "status-dot", ...statusFor(r) },
    sections: [
      section("Schedule", [
        kv(
          [
            ["Schedule", f["schedule"]],
            ["State", suspended ? "Suspended" : "Active"],
            ["Suspend Reason", f["suspendReason"]],
            ["Overlapping Runs", f["concurrency"] === true ? "allowed" : "skipped"],
            ["Next Run", f["nextRunAt"]],
            ["Last Run", f["lastRunAt"]],
            ["Last Job", f["lastJobId"]],
          ],
          ["Last Job"],
        ),
      ]),
      section("Job", [
        kv([
          ["Image", f["dockerImage"]],
          ["Hardware", f["flavor"]],
          ["Command", f["command"]],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      pluginAction("Run now", "run", { success: "Started a run." }),
      suspended
        ? pluginAction("Resume", "resume", { success: "Schedule resumed." })
        : pluginAction("Suspend", "suspend", {
            confirm: "Suspend this schedule? No runs start until you resume it.",
            success: "Schedule suspended.",
          }),
    ],
  };
}

// ------------------------------------------------------ provider models

function renderProviderModel(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const id = s(f["modelId"]) || (r.externalId ?? "");
  const providers = parseJson<NonNullable<RouterModel["providers"]>>(s(f["providerDetails"]), []);
  const live = providers.filter((p) => p.provider && p.status !== "offline");
  const isChat = s(f["outputModalities"]).includes("text") || !s(f["outputModalities"]);
  const models = [
    id,
    `${id}:cheapest`,
    `${id}:preferred`,
    ...live.map((p) => `${id}:${p.provider}`),
  ];
  return {
    title: id,
    subtitle: joinSubtitle("Inference Providers", s(f["ownedBy"])),
    status: {
      kind: "status-dot",
      status: live.length ? "healthy" : "degraded",
      label: `${live.length} provider${live.length === 1 ? "" : "s"}`,
    },
    sections: [
      section("Model", [
        kv(
          [
            ["Model ID", id],
            ["Input", f["inputModalities"]],
            ["Output", f["outputModalities"]],
            [
              "Max Context",
              Number(f["maxContextLength"]) ? Number(f["maxContextLength"]).toLocaleString() : "",
            ],
          ],
          ["Model ID"],
        ),
      ]),
      section("Providers", [
        {
          kind: "table",
          columns: [
            { key: "provider", label: "Provider" },
            { key: "status", label: "Status" },
            { key: "input", label: "Input $/1M" },
            { key: "output", label: "Output $/1M" },
            { key: "context", label: "Context" },
            { key: "ttft", label: "First Token" },
            { key: "throughput", label: "Tokens/s" },
            { key: "tools", label: "Tools" },
          ],
          rows: providers.map((p) => ({
            cells: {
              provider: s(p.provider),
              status: s(p.status),
              input: typeof p.pricing?.input === "number" ? `$${p.pricing.input}` : "—",
              output: typeof p.pricing?.output === "number" ? `$${p.pricing.output}` : "—",
              context: p.context_length ? p.context_length.toLocaleString() : "—",
              ttft: p.first_token_latency_ms ? `${Math.round(p.first_token_latency_ms)} ms` : "—",
              throughput: p.throughput ? p.throughput.toFixed(0) : "—",
              tools: p.supports_tools ? "yes" : "no",
            },
          })),
          emphasizeFirstColumn: true,
        },
      ]),
      section("Use it", [
        {
          kind: "text",
          variant: "muted",
          content:
            "OpenAI-compatible. Append :cheapest, :preferred or :<provider> to the model id to choose who serves it; the plain id picks the fastest.",
        },
        {
          kind: "text",
          variant: "mono",
          copyable: true,
          content: `${ROUTER_BASE}/chat/completions`,
        },
      ]),
    ],
    headerActions: [
      refresh(),
      openUrl("Model card", `https://huggingface.co/${id}`),
      openUrl("Provider settings", "https://huggingface.co/settings/inference-providers"),
    ],
    ...(isChat
      ? {
          chatPanel: {
            subtitle: `${id} through router.huggingface.co`,
            models,
            defaultModel: id,
            modelLabel: "Provider",
          },
        }
      : {}),
  };
}

// --------------------------------------------------- org identity/tokens

function renderServiceAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const tokens = parseJson<NonNullable<ServiceAccount["accessTokens"]>>(
    r.resolvedOutputs["__tokens__"],
    [],
  );
  return {
    title: r.displayName,
    subtitle: "Service Account",
    status: { kind: "status-dot", status: "info" },
    sections: [
      section("Account", [
        kv(
          [
            ["Name", f["name"]],
            ["Username", f["username"]],
            ["Description", f["description"]],
            ["Email", f["email"]],
            ["Created", f["createdAt"]],
          ],
          ["Username"],
        ),
      ]),
      section("Access Tokens", [
        tokens.length
          ? {
              kind: "table",
              columns: [
                { key: "name", label: "Name" },
                { key: "last4", label: "Ends With", mono: true },
                { key: "permissions", label: "Permissions" },
                { key: "lastUsed", label: "Last Used" },
                { key: "expires", label: "Expires" },
                { key: "remove", label: "", width: "narrow" },
              ],
              rows: tokens.map((t) => ({
                cells: {
                  name: s(t.displayName),
                  last4: t.last4 ? `…${t.last4}` : "",
                  permissions: (t.permissions ?? []).join(", ") || s(t.role),
                  lastUsed: s(t.lastUsedAt) || "never",
                  expires: s(t.expiration) || "never",
                  remove: pluginAction("Delete", `delete-token:${s(t._id)}`, {
                    confirm: `Delete the token ${s(t.displayName)}? Anything using it stops working.`,
                    destructive: true,
                    danger: true,
                  }),
                },
              })),
            }
          : {
              kind: "text",
              variant: "muted",
              content: "No tokens yet. Use Get credentials to mint one.",
            },
      ]),
    ],
    headerActions: [refresh()],
  };
}

function renderMemberToken(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const revoked = s(f["status"]) === "revoked";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Member Access Token", f["role"]),
    status: { kind: "status-dot", ...statusFor(r) },
    sections: [
      section("Token", [
        kv([
          ["Owner", f["owner"]],
          ["Name", f["displayName"]],
          ["Role", f["role"]],
          ["Ends With", s(f["last4"]) ? `…${f["last4"]}` : ""],
          ["Approval", f["status"]],
          ["Created", f["createdAt"]],
          ["Last Used", s(f["lastUsedAt"]) || "never"],
        ]),
      ]),
      section("Revoking", [
        {
          kind: "text",
          variant: "muted",
          content:
            "Revoking withdraws this token's access to the organization only. The token keeps working for its owner's personal repositories.",
        },
      ]),
    ],
    headerActions: [
      refresh(),
      ...(revoked
        ? []
        : [
            pluginAction("Revoke org access", "revoke", {
              confirm: "Revoke this token's access to the organization?",
              success: "Token access revoked.",
              destructive: true,
              danger: true,
            }),
          ]),
    ],
  };
}

function renderWebhook(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = Boolean(s(f["disabled"]));
  return {
    title: r.displayName,
    subtitle: "Webhook",
    status: { kind: "status-dot", ...statusFor(r) },
    sections: [
      section("Webhook", [
        kv(
          [
            ["Target", f["url"]],
            ["Watching", f["watched"]],
            ["Events", f["domains"]],
            ["State", disabled ? `disabled (${s(f["disabled"])})` : "enabled"],
            ["Signed", f["hasSecret"] === true ? "yes" : "no"],
            ["Last Triggered", f["lastTriggerAt"]],
          ],
          ["Target"],
        ),
      ]),
    ],
    headerActions: [
      refresh(),
      disabled
        ? pluginAction("Enable", "enable", { success: "Webhook enabled." })
        : pluginAction("Disable", "disable", { success: "Webhook disabled." }),
      openUrl("Webhook settings", "https://huggingface.co/settings/webhooks"),
    ],
  };
}
