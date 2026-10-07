import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  PublishPanelCapability,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";
import { QSTASH_PLANS, REDIS_PLANS, REDIS_REGIONS, T } from "./resource-types.js";

/** JSON blobs `enrichDetail` puts in `resolvedOutputs` for the synchronous renderer. */
export const ENRICH = {
  backups: "__backups",
  teams: "__teams",
  stats: "__stats",
  members: "__members",
  dlq: "__dlq",
  counts: "__counts",
} as const;

export const CONSOLE = "https://console.upstash.com";

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

function flag(resource: ResourceInstance, key: string): boolean | undefined {
  const v = resource.fields[key];
  if (v === undefined || v === "") return undefined;
  return v === true || v === "true";
}

export function upStatus(raw: string): ResourceStatus {
  const s = raw.toLowerCase();
  if (!s) return "unknown";
  if (["active", "running", "completed"].includes(s)) return "healthy";
  if (["paused", "passive"].includes(s)) return "info";
  if (/suspend|fail|error|inactive/.test(s)) return "error";
  if (/pending|creat|modif|upgrad|migrat/.test(s)) return "provisioning";
  return "info";
}

function kv(items: Array<[string, string | number | boolean | undefined]>): SchemaNode {
  const out: KVItem[] = [];
  for (const [key, value] of items) {
    if (value === undefined || value === "") continue;
    out.push({ key, value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value) });
  }
  return { kind: "key-value-list", items: out };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function action(
  label: string,
  a: ActionNode["action"],
  variant?: ActionNode["variant"],
): ActionNode {
  return { kind: "action", label, action: a, ...(variant ? { variant } : {}) };
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; destructive?: boolean } = {},
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
    opts.destructive ? "danger" : undefined,
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
const open = (path = ""): ActionNode =>
  action("Open in Upstash", { type: "open-url", url: `${CONSOLE}${path}` });

function date(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString().replace("T", " ").slice(0, 16);
}

function bytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 100) / 100} GB`;
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function usd(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? "" : `$${n.toFixed(2)}`;
}

function teamAction(resource: ResourceInstance, what: string): ActionNode {
  const teams = enriched<SelectOption[]>(resource, ENRICH.teams) ?? [];
  return prompt(
    "Move to team",
    "move-to-team",
    "Move to a team",
    teams.length
      ? `Moves this ${what} to a team. Moving back to a personal account is not supported.`
      : "You are not a member of any team.",
    [{ key: "teamId", label: "Team", kind: "select", required: true, options: teams }],
    "Move",
    { blocked: teams.length === 0 },
  );
}

function tokenSection(): SectionNode {
  return section("Credentials", [
    {
      kind: "text",
      variant: "muted",
      content:
        "Tokens and passwords are outputs: copy them from the Outputs panel or export them to a secret.",
    },
  ]);
}

// ---------------------------------------------------------------------------

function renderAccount(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: "Upstash account",
    sections: [
      section("Account", [
        kv([
          ["Email", str(resource, "email")],
          ["Redis databases", str(resource, "redisCount")],
          ["Vector indexes", str(resource, "vectorCount")],
          ["Search indexes", str(resource, "searchCount")],
          ["Teams", str(resource, "teamCount")],
        ]),
      ]),
    ],
    headerActions: [refresh(), open("/account/api")],
    logs: { defaultTailLines: 100 },
  };
}

function renderRedis(resource: ResourceInstance): DetailViewSchema {
  const stats = enriched<{
    storage?: number;
    monthlyRequests?: number;
    monthlyBandwidth?: number;
    monthlyCost?: number;
    todayCommands?: number;
  }>(resource, ENRICH.stats);
  const backups = enriched<
    Array<{ id: string; name: string; state: string; created: string; size: string }>
  >(resource, ENRICH.backups);
  const platform = str(resource, "platform") || "aws";
  const primary = str(resource, "region");
  const currentReads = str(resource, "readRegions")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sections: SectionNode[] = [
    section("Database", [
      kv([
        ["State", str(resource, "state")],
        ["Cloud", platform.toUpperCase()],
        ["Primary region", primary],
        ["Read regions", str(resource, "readRegions") || "None"],
        ["Plan", str(resource, "plan")],
        ["Monthly budget", str(resource, "budget") ? `$${str(resource, "budget")}` : ""],
        ["Eviction", flag(resource, "eviction")],
        ["Auto upgrade", flag(resource, "autoUpgrade")],
        ["Daily backup", flag(resource, "dailyBackup")],
        ["TLS", flag(resource, "tls")],
        ["Production pack", flag(resource, "prodPack")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
    section("Connection", [
      kv([
        ["Endpoint", str(resource, "endpoint")],
        ["Port", str(resource, "port")],
      ]),
    ]),
    section("Limits", [
      kv([
        ["Storage limit", str(resource, "diskLimitGb") ? `${str(resource, "diskLimitGb")} GB` : ""],
        ["Commands per second", str(resource, "maxCommandsPerSecond")],
        ["Connections", str(resource, "maxClients")],
      ]),
    ]),
  ];
  if (stats) {
    sections.push(
      section("This month", [
        kv([
          ["Storage used", bytes(stats.storage)],
          ["Commands today", stats.todayCommands],
          ["Requests", stats.monthlyRequests],
          ["Bandwidth", bytes(stats.monthlyBandwidth)],
          ["Cost so far", usd(stats.monthlyCost)],
        ]),
      ]),
    );
  }
  if (backups?.length) {
    sections.push(
      section("Backups", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Backup" },
            { key: "state", label: "State" },
            { key: "created", label: "Created" },
            { key: "size", label: "Size" },
          ],
          rows: backups.map((b) => ({
            cells: { name: b.name, state: b.state, created: b.created, size: b.size },
          })),
        },
      ]),
    );
  }
  sections.push(tokenSection());
  const backupOptions = (backups ?? [])
    .filter((b) => b.state === "completed")
    .map((b) => ({ id: b.id, label: b.name, description: b.created }));
  const readOptions = REDIS_REGIONS.filter((r) => r.platform === platform && r.id !== primary).map(
    (r) => ({
      id: r.id,
      label: r.id,
      description: r.label,
    }),
  );
  const headerActions: ActionNode[] = [
    refresh(),
    prompt(
      "Change plan",
      "change-plan",
      "Change plan",
      `Currently ${str(resource, "plan") || "unknown"}. Fixed plans bill a flat monthly price; pay as you go bills per request.`,
      [
        {
          key: "plan",
          label: "Plan",
          kind: "select",
          required: true,
          options: REDIS_PLANS.map((p) => ({
            id: p,
            label: p.replace("fixed_", "Fixed ").replace("payg", "Pay as you go"),
          })),
        },
      ],
      "Change plan",
    ),
    {
      kind: "action",
      label: "Read regions",
      action: {
        type: "prompt-nosql-command",
        command: "update-regions",
        title: "Read regions",
        description:
          "Replicas in these regions serve reads close to your users. Each one adds to the bill.",
        fields: [
          {
            key: "readRegions",
            label: "Read regions",
            kind: "policy-picker",
            required: false,
            policies: readOptions,
            defaultValue: JSON.stringify(currentReads),
          },
        ],
        submitLabel: "Save regions",
      },
    },
    prompt(
      "Back up now",
      "backup",
      "Back up now",
      "Takes a backup you can restore from later.",
      [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          defaultValue: `backup-${new Date().toISOString().slice(0, 10)}`,
        },
      ],
      "Back up",
    ),
    prompt(
      "Restore backup",
      "restore",
      "Restore a backup",
      backupOptions.length
        ? "Replaces every key in the database with the contents of the backup."
        : "There is no completed backup to restore.",
      [
        {
          key: "backupId",
          label: "Backup",
          kind: "select",
          required: true,
          options: backupOptions,
        },
      ],
      "Restore",
      { danger: true, blocked: backupOptions.length === 0 },
    ),
    prompt(
      "Delete backup",
      "delete-backup",
      "Delete a backup",
      backupOptions.length ? "Deletes the backup permanently." : "There is no backup to delete.",
      [
        {
          key: "backupId",
          label: "Backup",
          kind: "select",
          required: true,
          options: backupOptions,
        },
      ],
      "Delete",
      { danger: true, blocked: backupOptions.length === 0 },
    ),
    pluginAction("Reset password", "reset-password", {
      confirm:
        "Issue a new password and REST tokens? Every client using the old ones loses access.",
      success: "Password reset. Refresh outputs to see the new one.",
    }),
  ];
  if (flag(resource, "tls") === false) {
    headerActions.push(
      pluginAction("Enable TLS", "enable-tls", {
        confirm:
          "Enable TLS? It cannot be turned off again, and clients must connect with rediss://.",
      }),
    );
  }
  headerActions.push(teamAction(resource, "database"), open(`/redis/${resource.externalId ?? ""}`));
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Redis", primary, str(resource, "plan")),
    status: {
      kind: "status-dot",
      status: upStatus(str(resource, "state")),
      label: str(resource, "state"),
    },
    sections,
    headerActions,
  };
}

function indexStatsSection(resource: ResourceInstance, noun: string): SectionNode | null {
  const s = enriched<{
    count?: number;
    pending?: number;
    dailyQueries?: number;
    monthlyQueries?: number;
    monthlyUpdates?: number;
    bandwidth?: number;
    storage?: number;
    monthlyCost?: number;
  }>(resource, ENRICH.stats);
  if (!s) return null;
  return section("Usage", [
    kv([
      [noun, s.count],
      ["Pending", s.pending],
      ["Queries today", s.dailyQueries],
      ["Queries this month", s.monthlyQueries],
      ["Updates this month", s.monthlyUpdates],
      ["Bandwidth this month", bytes(s.bandwidth)],
      ["Storage", bytes(s.storage)],
      ["Cost this month", usd(s.monthlyCost)],
    ]),
  ]);
}

function renderVector(resource: ResourceInstance): DetailViewSchema {
  const sections: SectionNode[] = [
    section("Index", [
      kv([
        ["Region", str(resource, "region")],
        ["Plan", str(resource, "plan")],
        ["Type", str(resource, "indexType")],
        ["Similarity", str(resource, "similarity")],
        ["Dimensions", str(resource, "dimensions")],
        ["Embedding model", str(resource, "embeddingModel")],
        ["Sparse embedding model", str(resource, "sparseEmbeddingModel")],
        ["Endpoint", str(resource, "endpoint")],
        ["Max vectors", str(resource, "maxVectors")],
        ["Max daily queries", str(resource, "maxDailyQueries")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
  ];
  const stats = indexStatsSection(resource, "Vectors");
  if (stats) sections.push(stats);
  sections.push(tokenSection());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Vector index", str(resource, "region"), str(resource, "plan")),
    sections,
    headerActions: [
      refresh(),
      prompt(
        "Change plan",
        "set-plan",
        "Change plan",
        `Currently ${str(resource, "plan") || "unknown"}.`,
        [
          {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            options: [
              { id: "free", label: "Free" },
              { id: "payg", label: "Pay as you go" },
              { id: "fixed", label: "Fixed" },
            ],
          },
        ],
        "Change plan",
      ),
      pluginAction("Reset tokens", "reset-password", {
        confirm:
          "Issue new read-write and read-only tokens? Clients using the old ones lose access.",
      }),
      teamAction(resource, "index"),
      open(`/vector/${resource.externalId ?? ""}`),
    ],
  };
}

function renderSearch(resource: ResourceInstance): DetailViewSchema {
  const sections: SectionNode[] = [
    section("Index", [
      kv([
        ["Region", str(resource, "region")],
        ["Plan", str(resource, "plan")],
        ["Endpoint", str(resource, "endpoint")],
        ["Max documents", str(resource, "maxDocuments")],
        ["Max daily queries", str(resource, "maxDailyQueries")],
        ["Input enrichment", flag(resource, "inputEnrichment")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
  ];
  const stats = indexStatsSection(resource, "Documents");
  if (stats) sections.push(stats);
  sections.push(tokenSection());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Search index", str(resource, "region")),
    sections,
    headerActions: [
      refresh(),
      pluginAction("Reset tokens", "reset-password", {
        confirm:
          "Issue new read-write and read-only tokens? Clients using the old ones lose access.",
      }),
      teamAction(resource, "index"),
      open(`/search/${resource.externalId ?? ""}`),
    ],
  };
}

function publishPanel(subtitle: string, withDestination: boolean): PublishPanelCapability {
  return {
    subtitle,
    bodyFormat: "json",
    defaultBody: '{\n  "hello": "world"\n}',
    extraFields: [
      ...(withDestination
        ? [
            {
              key: "destination",
              label: "Destination URL",
              kind: "text" as const,
              placeholder: "https://example.com/api/webhook",
            },
          ]
        : []),
      {
        key: "delay",
        label: "Delay",
        kind: "text",
        placeholder: "10s, 5m, 1h",
        optional: true,
        helpText: "Deliver later instead of right away.",
      },
      { key: "retries", label: "Retries", kind: "number", optional: true, placeholder: "3" },
      { key: "headers", label: "Forwarded headers", kind: "key-value-list", optional: true },
    ],
    submitLabel: "Publish",
  };
}

function renderQStash(resource: ResourceInstance): DetailViewSchema {
  const dlq = enriched<
    Array<{ id: string; url: string; status: string; created: string; source: string }>
  >(resource, ENRICH.dlq);
  const counts = enriched<{ schedules?: number; queues?: number; groups?: number }>(
    resource,
    ENRICH.counts,
  );
  const stats = enriched<{ monthlyCost?: number; messagesToday?: number }>(resource, ENRICH.stats);
  const prod = flag(resource, "prodPack") === true;
  const sections: SectionNode[] = [
    section("QStash", [
      kv([
        ["Region", str(resource, "region")],
        ["State", str(resource, "state")],
        ["Plan", str(resource, "reservedPlan") || str(resource, "plan")],
        [
          "Monthly budget",
          str(resource, "budget") === "0"
            ? "No limit"
            : str(resource, "budget")
              ? `$${str(resource, "budget")}`
              : "",
        ],
        ["Production pack", flag(resource, "prodPack")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
    section("Limits", [
      kv([
        ["Messages per day", str(resource, "maxRequestsPerDay")],
        ["Messages per second", str(resource, "maxRequestsPerSecond")],
        [
          "Schedules",
          counts?.schedules !== undefined
            ? `${counts.schedules} of ${str(resource, "maxSchedules")}`
            : str(resource, "maxSchedules"),
        ],
        [
          "Queues",
          counts?.queues !== undefined
            ? `${counts.queues} of ${str(resource, "maxQueues")}`
            : str(resource, "maxQueues"),
        ],
        [
          "URL groups",
          counts?.groups !== undefined
            ? `${counts.groups} of ${str(resource, "maxTopics")}`
            : str(resource, "maxTopics"),
        ],
        ["Retries", str(resource, "maxRetries")],
      ]),
    ]),
  ];
  if (stats) sections.push(section("Usage", [kv([["Cost this period", usd(stats.monthlyCost)]])]));
  if (dlq) {
    sections.push(
      section("Dead letter queue", [
        dlq.length
          ? {
              kind: "table",
              columns: [
                { key: "created", label: "Failed" },
                { key: "url", label: "Destination" },
                { key: "source", label: "From" },
                { key: "status", label: "Status" },
                { key: "retry", label: "" },
                { key: "remove", label: "" },
              ],
              rows: dlq.map((m) => ({
                cells: {
                  created: m.created,
                  url: m.url,
                  source: m.source,
                  status: m.status,
                  retry: pluginAction("Retry", `dlq-retry:${m.id}`, { success: "Retried." }),
                  remove: pluginAction("Delete", `dlq-delete:${m.id}`, {
                    confirm: "Delete this message from the dead letter queue?",
                    destructive: true,
                  }),
                },
              })),
            }
          : { kind: "text", variant: "muted", content: "No failed messages." },
      ]),
    );
  }
  sections.push(tokenSection());
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("QStash", str(resource, "region")),
    status: {
      kind: "status-dot",
      status: upStatus(str(resource, "state")),
      label: str(resource, "state"),
    },
    sections,
    headerActions: [
      refresh(),
      prompt(
        "Change plan",
        "set-plan",
        "Change plan",
        "Pay as you go bills per message; fixed plans include a monthly message allowance.",
        [
          {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            options: QSTASH_PLANS.map((p) => ({
              id: p,
              label:
                p === "paid"
                  ? "Pay as you go"
                  : `Fixed ${p.replace("qstash_fixed_", "").toUpperCase()} messages`,
            })),
          },
        ],
        "Change plan",
      ),
      prod
        ? pluginAction("Disable production pack", "disable-prodpack", {
            confirm: "Disable the production pack?",
          })
        : pluginAction("Enable production pack", "enable-prodpack", {
            confirm:
              "Enable the production pack (uptime SLA, SOC 2, monitoring)? It adds a monthly fee.",
          }),
      pluginAction("Retry all failed", "dlq-retry-all", {
        confirm: "Retry every message in the dead letter queue?",
        success: "Retrying.",
      }),
      pluginAction("Purge dead letter queue", "dlq-purge", {
        confirm: "Delete every message in the dead letter queue?",
        destructive: true,
      }),
      pluginAction("Rotate signing keys", "rotate-keys", {
        confirm:
          "Rotate signing keys? The next key becomes current; receivers must know both while they roll over.",
      }),
      pluginAction("Reset token", "reset-token", {
        confirm: "Issue a new QStash token? Every publisher using the old one stops working.",
        destructive: true,
      }),
      teamAction(resource, "QStash account"),
      open("/qstash"),
    ],
    logs: { defaultTailLines: 100 },
    publishPanel: publishPanel("Publish a message to any URL through this QStash account.", true),
  };
}

function renderSchedule(resource: ResourceInstance): DetailViewSchema {
  const paused = flag(resource, "paused") === true;
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Schedule", str(resource, "cron")),
    status: {
      kind: "status-dot",
      status: paused ? "info" : "healthy",
      label: paused ? "paused" : "active",
    },
    sections: [
      section("Schedule", [
        kv([
          ["Cron", str(resource, "cron")],
          ["Destination", str(resource, "destination")],
          ["Method", str(resource, "method")],
          ["Retries", str(resource, "retries")],
          ["Delay", str(resource, "delay") ? `${str(resource, "delay")} s` : ""],
          ["Callback", str(resource, "callback")],
          ["Labels", str(resource, "labels")],
          ["Last run", date(str(resource, "lastRun"))],
          ["Next run", date(str(resource, "nextRun"))],
          ["Created", date(str(resource, "createdAt"))],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      paused
        ? pluginAction("Resume", "resume", { success: "Resumed." })
        : pluginAction("Pause", "pause", {
            confirm: "Stop publishing on this schedule until resumed?",
          }),
      open("/qstash?tab=schedules"),
    ],
  };
}

function renderQueue(resource: ResourceInstance): DetailViewSchema {
  const paused = flag(resource, "paused") === true;
  return {
    title: resource.displayName,
    subtitle: "QStash queue",
    status: {
      kind: "status-dot",
      status: paused ? "info" : "healthy",
      label: paused ? "paused" : "active",
    },
    sections: [
      section("Queue", [
        kv([
          ["Parallelism", str(resource, "parallelism")],
          ["Waiting messages", str(resource, "lag")],
          ["Paused", paused],
          ["Created", date(str(resource, "createdAt"))],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      paused
        ? pluginAction("Resume", "resume", { success: "Resumed." })
        : pluginAction("Pause", "pause", {
            confirm: "Stop delivering from this queue? Messages keep queueing.",
          }),
      open("/qstash?tab=queues"),
    ],
    publishPanel: publishPanel("Enqueue a message for delivery to a URL.", true),
  };
}

function renderUrlGroup(resource: ResourceInstance): DetailViewSchema {
  const endpoints = str(resource, "endpoints")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    title: resource.displayName,
    subtitle: "QStash URL group",
    sections: [
      section("Endpoints", [
        endpoints.length
          ? {
              kind: "table",
              columns: [{ key: "url", label: "URL" }],
              rows: endpoints.map((url) => ({ cells: { url } })),
            }
          : { kind: "text", variant: "muted", content: "No endpoints yet. Add them with Edit." },
      ]),
    ],
    headerActions: [refresh(), open("/qstash?tab=url-groups")],
    publishPanel: publishPanel("Publish a message to every endpoint in this group.", false),
  };
}

function renderTeam(resource: ResourceInstance): DetailViewSchema {
  const members = enriched<Array<{ email: string; role: string }>>(resource, ENRICH.members);
  return {
    title: resource.displayName,
    subtitle: "Team",
    sections: [
      section("Team", [
        kv([
          ["Members", str(resource, "members")],
          ["Your role", str(resource, "role")],
        ]),
      ]),
      ...(members?.length
        ? [
            section("Members", [
              {
                kind: "table",
                columns: [
                  { key: "email", label: "Email" },
                  { key: "role", label: "Role" },
                  { key: "remove", label: "" },
                ],
                rows: members.map((m) => ({
                  cells: {
                    email: m.email,
                    role: m.role,
                    remove:
                      m.role === "owner"
                        ? ""
                        : pluginAction("Remove", `remove-member:${m.email}`, {
                            confirm: `Remove ${m.email} from the team?`,
                            destructive: true,
                          }),
                  },
                })),
              },
            ]),
          ]
        : []),
    ],
    headerActions: [
      refresh(),
      prompt(
        "Add member",
        "add-member",
        "Add a team member",
        "Invites an existing Upstash user to the team.",
        [
          {
            key: "email",
            label: "Email",
            kind: "text",
            required: true,
            placeholder: "teammate@example.com",
          },
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            defaultValue: "dev",
            options: [
              { id: "admin", label: "Admin" },
              { id: "dev", label: "Developer" },
              { id: "finance", label: "Finance" },
            ],
          },
        ],
        "Add",
      ),
      open("/teams"),
    ],
  };
}

export function renderUpstashDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.account:
      return renderAccount(resource);
    case T.redis:
      return renderRedis(resource);
    case T.vector:
      return renderVector(resource);
    case T.search:
      return renderSearch(resource);
    case T.qstash:
      return renderQStash(resource);
    case T.schedule:
      return renderSchedule(resource);
    case T.queue:
      return renderQueue(resource);
    case T.urlGroup:
      return renderUrlGroup(resource);
    case T.team:
      return renderTeam(resource);
    default:
      return {
        title: resource.displayName,
        sections: [section("Resource", [kv([["ID", resource.externalId]])])],
      };
  }
}

export function renderUpstashSidebar(resource: ResourceInstance): SidebarItemSchema {
  let raw = "";
  if (resource.resourceTypeId === T.redis || resource.resourceTypeId === T.qstash)
    raw = str(resource, "state");
  if (resource.resourceTypeId === T.schedule || resource.resourceTypeId === T.queue) {
    raw = flag(resource, "paused") ? "paused" : "active";
  }
  return {
    id: resource.id,
    label: resource.displayName,
    ...(raw ? { status: { kind: "status-dot" as const, status: upStatus(raw), label: raw } } : {}),
  };
}
