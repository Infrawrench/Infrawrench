import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SelectOption,
  SidebarItemSchema,
  TableNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Keys under `resolvedOutputs` that `enrichDetail` fills with JSON for the
 * synchronous renderer. Every renderer copes with their absence (the
 * rendering contract tests and a failed enrichment both take that path).
 */
export const ENRICH = {
  plans: "__plans",
  builds: "__builds",
  deployments: "__deployments",
  envKeys: "__envKeys",
  ports: "__ports",
  runs: "__runs",
  backups: "__backups",
  upgrades: "__upgrades",
  invoices: "__invoices",
  usage: "__usage",
  services: "__services",
  portTargets: "__portTargets",
  releaseRuns: "__releaseRuns",
  nodes: "__nodes",
  pools: "__pools",
  pipelineObjects: "__pipelineObjects",
} as const;

export const CONSOLE = "https://app.northflank.com";

function enriched<V>(resource: ResourceInstance, key: string): V | undefined {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as V;
  } catch {
    return undefined;
  }
}

function str(resource: ResourceInstance, key: string): string {
  const v = resource.fields[key];
  return v === undefined || v === null ? "" : String(v);
}

function bool(resource: ResourceInstance, key: string): boolean | undefined {
  const v = resource.fields[key];
  if (v === undefined || v === "") return undefined;
  return v === true || v === "true";
}

export function nfStatus(raw: string): ResourceStatus {
  const s = raw.toLowerCase();
  if (!s) return "unknown";
  if (["running", "completed", "success", "verified", "active", "healthy", "ready"].includes(s)) {
    return "healthy";
  }
  if (["paused", "build"].includes(s)) return "info";
  if (/fail|error|crash|unschedulable|aborted/.test(s)) return "error";
  if (/delet/.test(s)) return "degraded";
  if (
    /pending|deploy|progress|alloc|scaling|upgrading|resetting|backup|restore|building|queued|starting|creating|provision/.test(
      s,
    )
  ) {
    return "provisioning";
  }
  return "info";
}

function kv(items: Array<[string, string | number | boolean | undefined]>): SchemaNode {
  const out: KVItem[] = [];
  for (const [key, value] of items) {
    if (value === undefined || value === "") continue;
    out.push({
      key,
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  return { kind: "key-value-list", items: out };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function text(content: string, variant: "body" | "muted" | "mono" = "body"): SchemaNode {
  return { kind: "text", content, variant };
}

function table(
  columns: Array<[string, string]>,
  rows: Array<Record<string, string | ActionNode>>,
): TableNode {
  return {
    kind: "table",
    columns: columns.map(([key, label]) => ({ key, label })),
    rows: rows.map((cells) => ({ cells })),
  };
}

export function action(
  label: string,
  a: ActionNode["action"],
  variant?: ActionNode["variant"],
): ActionNode {
  return { kind: "action", label, action: a, ...(variant ? { variant } : {}) };
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; destructive?: boolean; danger?: boolean } = {},
): ActionNode {
  return action(
    label,
    {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
    opts.danger ? "danger" : undefined,
  );
}

function prompt(
  label: string,
  command: string,
  title: string,
  description: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
  opts: { danger?: boolean; blocked?: boolean } = {},
): ActionNode {
  return action(
    label,
    {
      type: "prompt-nosql-command",
      command,
      title,
      description,
      fields,
      submitLabel,
      ...(opts.danger ? { danger: true } : {}),
      ...(opts.blocked ? { blocked: true, descriptionVariant: "error" as const } : {}),
    },
    opts.danger ? "danger" : undefined,
  );
}

const refresh = (): ActionNode => action("Refresh", { type: "refresh-resource" });
const openConsole = (): ActionNode =>
  action("Open in Northflank", { type: "open-url", url: CONSOLE });

function date(raw: string | number | undefined): string {
  if (raw === undefined || raw === "") return "";
  const d = typeof raw === "number" ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function mb(raw: number | string | undefined): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === undefined || raw === "") return "";
  return n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} GB` : `${n} MB`;
}

// ---------------------------------------------------------------------------
// Shared prompts
// ---------------------------------------------------------------------------

function planField(resource: ResourceInstance, key = "deploymentPlan"): CreateFieldConfig {
  const plans = enriched<SelectOption[]>(resource, ENRICH.plans) ?? [];
  const current = str(resource, key);
  return plans.length
    ? {
        key: "deploymentPlan",
        label: "Compute plan",
        kind: "select",
        required: false,
        options: plans,
        ...(current ? { defaultValue: current } : {}),
      }
    : {
        key: "deploymentPlan",
        label: "Compute plan",
        kind: "text",
        required: false,
        placeholder: "nf-compute-20",
        ...(current ? { defaultValue: current } : {}),
      };
}

function envActions(kind: "service" | "job"): ActionNode[] {
  return [
    prompt(
      "Set variables",
      "set-env",
      "Set runtime variables",
      `Adds or overwrites runtime environment variables on this ${kind}, one KEY=value per line. Variables not listed are left as they are. The ${kind} restarts to pick them up.`,
      [
        {
          key: "variables",
          label: "Variables",
          kind: "text",
          multiline: true,
          required: true,
          placeholder: "LOG_LEVEL=info\nFEATURE_FLAG=on",
        },
      ],
      "Save variables",
    ),
    prompt(
      "Remove variables",
      "unset-env",
      "Remove runtime variables",
      `Deletes the named runtime variables from this ${kind}. Variables inherited from secret groups are not affected.`,
      [{ key: "keys", label: "Variable names", kind: "string-list", required: true }],
      "Remove",
      { danger: true },
    ),
  ];
}

function envSection(resource: ResourceInstance): SectionNode | null {
  const keys = enriched<string[]>(resource, ENRICH.envKeys);
  if (!keys) return null;
  return section("Runtime variables", [
    keys.length
      ? text(keys.join(", "), "mono")
      : text("No runtime variables are set on the resource itself.", "muted"),
  ]);
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function renderAccount(resource: ResourceInstance): DetailViewSchema {
  const sections: SectionNode[] = [
    section("API token", [
      kv([
        ["Scope", str(resource, "entityType")],
        ["Team / organisation", str(resource, "entityId")],
        ["Acting for team", str(resource, "teamId")],
        ["Token", str(resource, "tokenName")],
        ["API role", str(resource, "roleName")],
        ["Created by", str(resource, "creatorEmail")],
        ["Created", date(str(resource, "tokenCreatedAt"))],
        ["Expires", date(str(resource, "tokenExpiresAt")) || "Never"],
      ]),
    ]),
  ];
  const usage = enriched<{ total?: number; currency?: string; parts?: Array<[string, number]> }>(
    resource,
    ENRICH.usage,
  );
  if (usage) {
    const cur = (usage.currency ?? "USD").toUpperCase();
    sections.push(
      section("This month so far", [
        kv([
          ["Total", usage.total !== undefined ? `${usage.total.toFixed(2)} ${cur}` : ""],
          ...(usage.parts ?? []).map(([k, v]): [string, string] => [k, `${v.toFixed(2)} ${cur}`]),
        ]),
      ]),
    );
  }
  const invoices = enriched<
    Array<{
      id?: string;
      start?: number;
      end?: number;
      status?: string;
      total?: number;
      currency?: string;
    }>
  >(resource, ENRICH.invoices);
  if (invoices?.length) {
    sections.push(
      section("Invoices", [
        table(
          [
            ["period", "Period"],
            ["status", "Status"],
            ["total", "Total"],
          ],
          invoices.map((i) => ({
            period: `${date(i.start).slice(0, 10)} to ${date(i.end).slice(0, 10)}`,
            status: i.status ?? "",
            total:
              i.total !== undefined
                ? `${i.total.toFixed(2)} ${(i.currency ?? "USD").toUpperCase()}`
                : "",
          })),
        ),
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Northflank", str(resource, "entityType")),
    sections,
    headerActions: [refresh(), openConsole()],
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function renderProject(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      "Project",
      str(resource, "region") ||
        (str(resource, "clusterName") ? `BYOC ${str(resource, "clusterName")}` : ""),
    ),
    sections: [
      section("Project", [
        kv([
          ["ID", resource.externalId],
          ["Description", str(resource, "description")],
          ["Region", str(resource, "region")],
          ["Cluster", str(resource, "clusterName") || str(resource, "clusterId")],
          ["Services", str(resource, "serviceCount")],
          ["Jobs", str(resource, "jobCount")],
          ["Addons", str(resource, "addonCount")],
          ["Created", date(str(resource, "createdAt"))],
        ]),
      ]),
    ],
    headerActions: [refresh(), openConsole()],
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function renderService(resource: ResourceInstance): DetailViewSchema {
  const type = str(resource, "serviceType");
  const state = str(resource, "state");
  const sections: SectionNode[] = [
    section("Service", [
      kv([
        ["Type", type],
        ["State", state],
        ["Deployment", str(resource, "deploymentStatus")],
        ["Last build", str(resource, "buildStatus")],
        ["Instances", str(resource, "instances")],
        ["Compute plan", str(resource, "deploymentPlan")],
        ["Build plan", str(resource, "buildPlan")],
        ["Image", str(resource, "image")],
        ["Repository", str(resource, "repository")],
        ["Branch", str(resource, "branch")],
        ["Deploys from", str(resource, "buildServiceId")],
        ["CI disabled", bool(resource, "disabledCI")],
        ["CD disabled", bool(resource, "disabledCD")],
        ["Tags", str(resource, "tags")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
  ];
  const ports = enriched<
    Array<{
      name?: string;
      internalPort?: number;
      protocol?: string;
      public?: boolean;
      dns?: string;
      domains?: string;
    }>
  >(resource, ENRICH.ports);
  if (ports?.length) {
    sections.push(
      section("Ports", [
        table(
          [
            ["name", "Name"],
            ["port", "Port"],
            ["protocol", "Protocol"],
            ["exposure", "Exposure"],
            ["address", "Address"],
          ],
          ports.map((p) => ({
            name: p.name ?? "",
            port: String(p.internalPort ?? ""),
            protocol: p.protocol ?? "",
            exposure: p.public ? "Public" : "Private",
            address: [p.dns, p.domains].filter(Boolean).join(", "),
          })),
        ),
      ]),
    );
  } else if (str(resource, "publicUrls")) {
    sections.push(section("Public URLs", [text(str(resource, "publicUrls"), "mono")]));
  }
  const builds = enriched<Array<Record<string, string>>>(resource, ENRICH.builds);
  if (builds?.length) {
    sections.push(
      section("Recent builds", [
        table(
          [
            ["created", "Started"],
            ["status", "Status"],
            ["branch", "Branch"],
            ["sha", "Commit"],
          ],
          builds,
        ),
      ]),
    );
  }
  const deployments = enriched<Array<Record<string, string>>>(resource, ENRICH.deployments);
  if (deployments?.length) {
    sections.push(
      section("Recent deployments", [
        table(
          [
            ["created", "Created"],
            ["active", "Serving"],
            ["image", "Image"],
            ["commit", "Commit"],
          ],
          deployments,
        ),
      ]),
    );
  }
  const env = envSection(resource);
  if (env) sections.push(env);

  const headerActions: ActionNode[] = [refresh()];
  if (type !== "build") {
    headerActions.push(
      pluginAction("Restart", "restart", { confirm: "Restart every instance of this service?" }),
    );
    headerActions.push(
      state === "paused"
        ? pluginAction("Resume", "resume", { success: "Resuming." })
        : pluginAction("Pause", "pause", {
            confirm: "Pause this service? It scales to zero instances and stops serving traffic.",
          }),
    );
    headerActions.push(
      prompt(
        "Scale",
        "scale",
        "Scale service",
        "Changes the instance count and compute plan. 0 instances pauses the service.",
        [
          {
            key: "instances",
            label: "Instances",
            kind: "number",
            required: false,
            minValue: 0,
            ...(str(resource, "instances") ? { defaultValue: str(resource, "instances") } : {}),
          },
          planField(resource),
        ],
        "Scale",
      ),
    );
  }
  if (type === "combined" || type === "build") {
    headerActions.push(
      prompt(
        "Start build",
        "build",
        "Start a build",
        type === "build"
          ? "Builds the latest commit of a branch, or a specific commit."
          : "Builds the latest commit of the service's branch, or a specific commit, and deploys it.",
        [
          ...(type === "build"
            ? [
                {
                  key: "branch",
                  label: "Branch",
                  kind: "text" as const,
                  required: false,
                  placeholder: "main",
                  ...(str(resource, "branch") ? { defaultValue: str(resource, "branch") } : {}),
                },
              ]
            : []),
          { key: "sha", label: "Commit SHA (optional)", kind: "text", required: false },
        ],
        "Build",
      ),
    );
    headerActions.push(
      pluginAction("Clear build cache", "clear-build-cache", {
        confirm: "Clear the build cache? The next build starts from scratch.",
      }),
    );
  }
  if (type === "deployment") {
    headerActions.push(
      prompt(
        "Deploy image",
        "deploy-image",
        "Deploy an image",
        "Points the service at a container image and rolls it out. Leave the credentials empty for public images.",
        [
          {
            key: "imagePath",
            label: "Image",
            kind: "text",
            required: true,
            placeholder: "nginx:1.27 or ghcr.io/org/app:tag",
            ...(str(resource, "image") ? { defaultValue: str(resource, "image") } : {}),
          },
        ],
        "Deploy",
      ),
    );
    if (str(resource, "buildServiceId")) {
      headerActions.push(
        pluginAction("Deploy latest build", "deploy-latest", {
          confirm: "Deploy the latest build of the linked build service and branch?",
        }),
      );
    }
  }
  if (type !== "build") headerActions.push(...envActions("service"));
  headerActions.push(openConsole());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(`${type || "service"} service`, str(resource, "projectId")),
    status: {
      kind: "status-dot",
      status: nfStatus(state || str(resource, "buildStatus")),
      label: state,
    },
    sections,
    headerActions,
    logs: { defaultTailLines: 200 },
  };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

function renderJob(resource: ResourceInstance): DetailViewSchema {
  const cron = str(resource, "jobType") === "cron";
  const suspended = bool(resource, "suspended") === true;
  const sections: SectionNode[] = [
    section("Job", [
      kv([
        ["Type", str(resource, "jobType")],
        ["Schedule", str(resource, "schedule")],
        ["Schedule suspended", cron ? suspended : undefined],
        ["Concurrency", str(resource, "concurrencyPolicy")],
        ["Retries", str(resource, "backoffLimit")],
        [
          "Timeout",
          str(resource, "activeDeadlineSeconds")
            ? `${str(resource, "activeDeadlineSeconds")} s`
            : "",
        ],
        ["Compute plan", str(resource, "deploymentPlan")],
        ["Image", str(resource, "image")],
        ["Repository", str(resource, "repository")],
        ["Branch", str(resource, "branch")],
        ["Tags", str(resource, "tags")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
  ];
  const runs = enriched<Array<Record<string, string>>>(resource, ENRICH.runs);
  if (runs?.length) {
    sections.push(
      section("Recent runs", [
        table(
          [
            ["name", "Run"],
            ["status", "Status"],
            ["started", "Started"],
            ["concluded", "Finished"],
          ],
          runs,
        ),
      ]),
    );
  }
  const env = envSection(resource);
  if (env) sections.push(env);
  const lastStatus = runs?.[0]?.["status"] ?? "";
  const headerActions: ActionNode[] = [
    refresh(),
    pluginAction("Run now", "run", { success: "Run started." }),
  ];
  if (cron) {
    headerActions.push(
      suspended
        ? pluginAction("Resume schedule", "unsuspend", { success: "Schedule resumed." })
        : pluginAction("Suspend schedule", "suspend", {
            confirm: "Stop scheduling new runs? Runs already going finish normally.",
          }),
    );
  }
  if (str(resource, "repository")) {
    headerActions.push(
      prompt(
        "Start build",
        "build",
        "Start a build",
        "Builds the latest commit of the job's branch, or a specific commit.",
        [{ key: "sha", label: "Commit SHA (optional)", kind: "text", required: false }],
        "Build",
      ),
    );
  }
  headerActions.push(
    prompt(
      "Change plan",
      "scale",
      "Change compute plan",
      "The plan each run of this job gets.",
      [planField(resource)],
      "Save",
    ),
  );
  headerActions.push(...envActions("job"), openConsole());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(`${str(resource, "jobType") || ""} job`, str(resource, "schedule")),
    status: {
      kind: "status-dot",
      status: suspended ? "info" : lastStatus ? nfStatus(lastStatus) : "unknown",
      label: suspended ? "suspended" : lastStatus.toLowerCase(),
    },
    sections,
    headerActions,
    logs: { defaultTailLines: 200 },
  };
}

// ---------------------------------------------------------------------------
// Addon
// ---------------------------------------------------------------------------

function renderAddon(resource: ResourceInstance): DetailViewSchema {
  const status = str(resource, "status");
  const sections: SectionNode[] = [
    section("Addon", [
      kv([
        ["Type", str(resource, "addonType")],
        ["Version", str(resource, "version")],
        ["Version support", str(resource, "lifecycleStatus")],
        ["Status", status],
        ["Compute plan", str(resource, "deploymentPlan")],
        ["Replicas", str(resource, "replicas")],
        ["Storage", mb(str(resource, "storageMb"))],
        ["Storage class", str(resource, "storageClass")],
        ["Region", str(resource, "region")],
        ["Tags", str(resource, "tags")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
    section("Networking", [
      kv([
        ["TLS", bool(resource, "tlsEnabled")],
        ["Public access", bool(resource, "externalAccessEnabled")],
      ]),
      ...(bool(resource, "externalAccessEnabled")
        ? []
        : [
            text(
              "Only workloads inside Northflank can connect. Turn on TLS and public access with Edit to open the database consoles here.",
              "muted",
            ),
          ]),
    ]),
  ];
  if (str(resource, "lifecycleStatus") && str(resource, "lifecycleStatus") !== "active") {
    sections.unshift(
      section("Version support", [
        text(
          `Version ${str(resource, "version")} is ${str(resource, "lifecycleStatus")}. Upgrade it with Upgrade version.`,
        ),
      ]),
    );
  }
  const backups = enriched<Array<Record<string, string>>>(resource, ENRICH.backups);
  if (backups?.length) {
    sections.push(
      section("Backups", [
        table(
          [
            ["name", "Backup"],
            ["type", "Type"],
            ["status", "Status"],
            ["created", "Created"],
            ["size", "Size"],
          ],
          backups,
        ),
      ]),
    );
  }
  const upgrades = enriched<Array<{ version: string; type?: string }>>(resource, ENRICH.upgrades);
  const headerActions: ActionNode[] = [
    refresh(),
    status === "paused"
      ? pluginAction("Resume", "resume", { success: "Resuming." })
      : pluginAction("Pause", "pause", {
          confirm:
            "Pause this addon? It stops accepting connections; storage is kept and still billed.",
        }),
    pluginAction("Restart", "restart", { confirm: "Restart the addon? Connections drop briefly." }),
    prompt(
      "Scale",
      "scale",
      "Scale addon",
      "Changes the compute plan, storage or replica count. Storage can grow but not shrink.",
      [
        planField(resource),
        {
          key: "storage",
          label: "Storage (MB)",
          kind: "number",
          required: false,
          ...(str(resource, "storageMb")
            ? {
                minValue: Number(str(resource, "storageMb")),
                defaultValue: str(resource, "storageMb"),
              }
            : {}),
        },
        {
          key: "replicas",
          label: "Replicas",
          kind: "number",
          required: false,
          minValue: 1,
          ...(str(resource, "replicas") ? { defaultValue: str(resource, "replicas") } : {}),
        },
      ],
      "Scale",
    ),
    prompt(
      "Back up now",
      "backup",
      "Back up now",
      "Takes a backup that is kept until you delete it.",
      [
        { key: "name", label: "Name (optional)", kind: "text", required: false },
        {
          key: "backupType",
          label: "Type",
          kind: "select",
          required: false,
          defaultValue: "snapshot",
          options: [
            { id: "snapshot", label: "Snapshot (disk)" },
            { id: "dump", label: "Native dump" },
          ],
        },
      ],
      "Back up",
    ),
  ];
  if (upgrades?.length) {
    headerActions.push(
      prompt(
        "Upgrade version",
        "upgrade",
        "Upgrade version",
        `Currently ${str(resource, "version") || "unknown"}. Major upgrades cannot be rolled back; take a backup first.`,
        [
          {
            key: "version",
            label: "Target version",
            kind: "select",
            required: true,
            options: upgrades.map((u) => ({
              id: u.version,
              label: u.version,
              ...(u.type ? { description: `${u.type} upgrade` } : {}),
            })),
          },
        ],
        "Upgrade",
      ),
    );
  }
  headerActions.push(
    pluginAction("Rotate credentials", "rotate-secrets", {
      confirm:
        "Start a credential rotation? New credentials are created alongside the old ones; finish it once every workload uses the new ones.",
      success: "Rotation started. Finish it once workloads have picked up the new credentials.",
    }),
    pluginAction("Finish rotation", "finalise-rotation", {
      confirm: "Revoke the old credentials now? Anything still using them loses access.",
      destructive: true,
    }),
    openConsole(),
  );
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      str(resource, "addonType"),
      str(resource, "version"),
      str(resource, "region"),
    ),
    status: { kind: "status-dot", status: nfStatus(status), label: status },
    sections,
    headerActions,
    logs: { defaultTailLines: 200 },
  };
}

// ---------------------------------------------------------------------------
// Secret group, volume, pipeline
// ---------------------------------------------------------------------------

function renderSecretGroup(resource: ResourceInstance): DetailViewSchema {
  const keys = str(resource, "keys");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Secret group", str(resource, "secretType")),
    sections: [
      section("Secret group", [
        kv([
          ["Description", str(resource, "description")],
          ["Injected into", str(resource, "secretType")],
          ["Kind", str(resource, "type")],
          ["Priority", str(resource, "priority")],
          ["Restricted", bool(resource, "restricted")],
          ["Updated", date(str(resource, "updatedAt"))],
        ]),
      ]),
      section("Variables", [
        keys
          ? text(keys, "mono")
          : text(
              "Values are shown only in Northflank; names appear here after a refresh.",
              "muted",
            ),
      ]),
    ],
    headerActions: [
      refresh(),
      prompt(
        "Set variables",
        "set-vars",
        "Set variables",
        "Adds or overwrites variables in this group, one KEY=value per line. Other variables are left as they are. Services and jobs using the group restart to pick them up.",
        [
          {
            key: "variables",
            label: "Variables",
            kind: "text",
            multiline: true,
            required: true,
            placeholder: "API_URL=https://example.com\nAPI_KEY=…",
          },
        ],
        "Save",
      ),
      prompt(
        "Remove variables",
        "unset-vars",
        "Remove variables",
        "Deletes the named variables from this group.",
        [{ key: "keys", label: "Variable names", kind: "string-list", required: true }],
        "Remove",
        { danger: true },
      ),
      openConsole(),
    ],
  };
}

function renderVolume(resource: ResourceInstance): DetailViewSchema {
  const attached = str(resource, "attachedTo");
  const services = enriched<SelectOption[]>(resource, ENRICH.services) ?? [];
  const backups = enriched<Array<Record<string, string>>>(resource, ENRICH.backups);
  const sections: SectionNode[] = [
    section("Volume", [
      kv([
        ["Size", mb(str(resource, "storageSizeMb"))],
        ["Storage class", str(resource, "storageClass")],
        ["Access mode", str(resource, "accessMode")],
        ["Status", str(resource, "status")],
        ["Attached to", attached || "Nothing"],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
  ];
  if (backups?.length) {
    sections.push(
      section("Backups", [
        table(
          [
            ["name", "Backup"],
            ["status", "Status"],
            ["created", "Created"],
          ],
          backups,
        ),
      ]),
    );
  }
  const headerActions: ActionNode[] = [
    refresh(),
    prompt(
      "Back up now",
      "backup",
      "Back up now",
      "Snapshots the volume.",
      [{ key: "name", label: "Name (optional)", kind: "text", required: false }],
      "Back up",
    ),
  ];
  if (attached) {
    headerActions.push(
      pluginAction("Detach", "detach", {
        confirm: `Detach the volume from ${attached}? The service restarts without it.`,
      }),
    );
  } else {
    headerActions.push(
      prompt(
        "Attach",
        "attach",
        "Attach to a service",
        services.length
          ? "Mounts the volume into one service in this project. A volume serves one service with a single instance."
          : "There is no service in this project to attach to.",
        [
          {
            key: "serviceId",
            label: "Service",
            kind: "select",
            required: true,
            options: services,
          },
          {
            key: "containerMountPath",
            label: "Mount path",
            kind: "text",
            required: true,
            placeholder: "/data",
          },
        ],
        "Attach",
        { blocked: services.length === 0 },
      ),
    );
  }
  headerActions.push(openConsole());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Volume", mb(str(resource, "storageSizeMb"))),
    status: {
      kind: "status-dot",
      status: nfStatus(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections,
    headerActions,
  };
}

function renderPipeline(resource: ResourceInstance): DetailViewSchema {
  const objects = enriched<Array<Record<string, string>>>(resource, ENRICH.pipelineObjects);
  const runs = enriched<Array<Record<string, string>>>(resource, ENRICH.releaseRuns);
  const sections: SectionNode[] = [
    section("Pipeline", [
      kv([
        ["Description", str(resource, "description")],
        ["Stages", str(resource, "stages")],
        ["Resources", str(resource, "resourceCount")],
        ["Updated", date(str(resource, "updatedAt"))],
      ]),
    ]),
  ];
  if (objects?.length) {
    sections.push(
      section("Resources by stage", [
        table(
          [
            ["stage", "Stage"],
            ["type", "Type"],
            ["id", "Resource"],
          ],
          objects,
        ),
      ]),
    );
  }
  if (runs?.length) {
    sections.push(
      section("Recent release flow runs", [
        table(
          [
            ["stage", "Stage"],
            ["name", "Run"],
            ["status", "Status"],
            ["created", "Started"],
          ],
          runs,
        ),
      ]),
    );
  }
  const stages = (str(resource, "stages") || "Development, Staging, Production")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    title: resource.displayName,
    subtitle: "Pipeline",
    sections,
    headerActions: [
      refresh(),
      prompt(
        "Run release flow",
        "run-release",
        "Run release flow",
        "Runs the release flow configured for a stage (promotions, builds, migrations, whatever the flow defines).",
        [
          {
            key: "stage",
            label: "Stage",
            kind: "select",
            required: true,
            options: stages.map((s) => ({ id: s, label: s })),
            defaultValue: stages[0] ?? "Development",
          },
          { key: "name", label: "Run name (optional)", kind: "text", required: false },
        ],
        "Run",
      ),
      openConsole(),
    ],
  };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

function renderDomain(resource: ResourceInstance): DetailViewSchema {
  const verified = str(resource, "status") === "verified";
  const sections: SectionNode[] = [
    section("Domain", [
      kv([
        ["Verification", str(resource, "status")],
        ["Redirect mode", str(resource, "redirectMode")],
        ["Subdomains", str(resource, "subdomainCount")],
        ["Wildcard certificate expires", date(str(resource, "certificateExpiry"))],
      ]),
    ]),
  ];
  if (!verified) {
    sections.unshift(
      section("Verify ownership", [
        text("Add this TXT record at your DNS provider, then press Verify."),
        {
          kind: "key-value-list",
          items: [
            { key: "Type", value: "TXT" },
            { key: "Name", value: str(resource, "verifyHostname"), copyable: true },
            { key: "Value", value: str(resource, "verifyToken"), copyable: true },
          ],
        },
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: "Domain",
    status: {
      kind: "status-dot",
      status: verified ? "healthy" : "provisioning",
      label: str(resource, "status"),
    },
    sections,
    headerActions: [
      refresh(),
      ...(verified
        ? []
        : [pluginAction("Verify", "verify", { success: "Verification requested." })]),
      openConsole(),
    ],
  };
}

function renderSubdomain(resource: ResourceInstance): DetailViewSchema {
  const verified = bool(resource, "verified") === true;
  const targets = enriched<SelectOption[]>(resource, ENRICH.portTargets) ?? [];
  const cdn = bool(resource, "cdnEnabled") === true;
  const sections: SectionNode[] = [
    section("Subdomain", [
      kv([
        ["Hostname", str(resource, "fullName")],
        ["Verified", verified],
        ["Routing", str(resource, "routingMode")],
        ["CDN", cdn],
        ["Certificate expires", date(str(resource, "certificateExpiry"))],
      ]),
    ]),
    section("DNS record", [
      text(
        verified
          ? "Keep this record in place:"
          : "Create this record at your DNS provider, then press Verify.",
      ),
      {
        kind: "key-value-list",
        items: [
          { key: "Type", value: str(resource, "recordType") || "CNAME" },
          { key: "Name", value: str(resource, "fullName"), copyable: true },
          { key: "Value", value: str(resource, "content"), copyable: true },
        ],
      },
    ]),
  ];
  const headerActions: ActionNode[] = [refresh()];
  if (!verified)
    headerActions.push(pluginAction("Verify", "verify", { success: "Verification requested." }));
  headerActions.push(
    prompt(
      "Assign to service",
      "assign",
      "Assign to a service port",
      targets.length
        ? "Routes this hostname to a public HTTP port of a service. Any current assignment is replaced."
        : "No service has a public port to route to.",
      [{ key: "target", label: "Service port", kind: "select", required: true, options: targets }],
      "Assign",
      { blocked: targets.length === 0 },
    ),
    pluginAction("Unassign", "unassign", { confirm: "Stop routing this hostname to its service?" }),
    cdn
      ? pluginAction("Disable CDN", "cdn-disable", {
          confirm: "Remove the CDN from this subdomain?",
        })
      : pluginAction("Enable CDN", "cdn-enable", { success: "CDN enabled." }),
  );
  if (cdn)
    headerActions.push(
      pluginAction("Purge CDN cache", "cdn-purge", { success: "Purge requested." }),
    );
  headerActions.push(openConsole());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Subdomain", str(resource, "domain")),
    status: {
      kind: "status-dot",
      status: verified ? "healthy" : "provisioning",
      label: verified ? "verified" : "pending",
    },
    sections,
    headerActions,
  };
}

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

function renderCluster(resource: ResourceInstance): DetailViewSchema {
  const sections: SectionNode[] = [
    section("Cluster", [
      kv([
        ["Cloud", str(resource, "provider")],
        ["Region", str(resource, "region")],
        ["State", str(resource, "state")],
        ["Reason", str(resource, "stateReason")],
        ["Node pools", str(resource, "nodePools")],
        ["Node types", str(resource, "nodeTypes")],
        ["Configured nodes", str(resource, "configuredNodes")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
  ];
  const pools = enriched<Array<Record<string, string>>>(resource, ENRICH.pools);
  if (pools?.length) {
    sections.push(
      section("Node pools", [
        table(
          [
            ["id", "Pool"],
            ["nodeType", "Node type"],
            ["nodes", "Nodes"],
            ["autoscaling", "Autoscaling"],
          ],
          pools,
        ),
      ]),
    );
  }
  const nodes = enriched<
    Array<{ id: string; name: string; pool: string; status: string; zone: string; type: string }>
  >(resource, ENRICH.nodes);
  if (nodes?.length) {
    sections.push(
      section("Nodes", [
        table(
          [
            ["name", "Node"],
            ["pool", "Pool"],
            ["type", "Type"],
            ["zone", "Zone"],
            ["status", "Status"],
            ["cordon", ""],
            ["drain", ""],
          ],
          nodes.map((n) => ({
            name: n.name,
            pool: n.pool,
            type: n.type,
            zone: n.zone,
            status: n.status,
            cordon: /cordon|unschedulable/i.test(n.status)
              ? pluginAction("Uncordon", `node-uncordon:${n.id}`, { success: "Node uncordoned." })
              : pluginAction("Cordon", `node-cordon:${n.id}`, {
                  confirm: `Stop scheduling new workloads onto ${n.name}?`,
                }),
            drain: pluginAction("Drain", `node-drain:${n.id}`, {
              confirm: `Evict every workload from ${n.name}? They reschedule onto other nodes.`,
            }),
          })),
        ),
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("BYOC cluster", str(resource, "provider"), str(resource, "region")),
    status: {
      kind: "status-dot",
      status: nfStatus(str(resource, "state")),
      label: str(resource, "state"),
    },
    sections,
    headerActions: [refresh(), openConsole()],
  };
}

export function renderNorthflankDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.account:
      return renderAccount(resource);
    case T.project:
      return renderProject(resource);
    case T.service:
      return renderService(resource);
    case T.job:
      return renderJob(resource);
    case T.addon:
      return renderAddon(resource);
    case T.secretGroup:
      return renderSecretGroup(resource);
    case T.volume:
      return renderVolume(resource);
    case T.pipeline:
      return renderPipeline(resource);
    case T.domain:
      return renderDomain(resource);
    case T.subdomain:
      return renderSubdomain(resource);
    case T.cluster:
      return renderCluster(resource);
    default:
      return {
        title: resource.displayName,
        sections: [section("Resource", [kv([["ID", resource.externalId]])])],
      };
  }
}

export function renderNorthflankSidebar(resource: ResourceInstance): SidebarItemSchema {
  const statusField: Record<string, string> = {
    [T.service]: "state",
    [T.addon]: "status",
    [T.volume]: "status",
    [T.cluster]: "state",
    [T.domain]: "status",
  };
  const key = statusField[resource.resourceTypeId];
  let raw = key ? str(resource, key) : "";
  if (resource.resourceTypeId === T.subdomain)
    raw = bool(resource, "verified") ? "verified" : "pending";
  if (resource.resourceTypeId === T.job && bool(resource, "suspended")) raw = "paused";
  return {
    id: resource.id,
    label: resource.displayName,
    ...(raw ? { status: { kind: "status-dot" as const, status: nfStatus(raw), label: raw } } : {}),
  };
}
