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
  TableNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

export const ENRICH = {
  plans: "__plans",
  clouds: "__clouds",
  alerts: "__alerts",
  backups: "__backups",
  nodes: "__nodes",
  maintenance: "__maintenance",
  credits: "__credits",
  invoices: "__invoices",
  billingGroups: "__billingGroups",
  connectorStatus: "__connectorStatus",
  schema: "__schema",
  peerings: "__peerings",
  services: "__services",
} as const;

export const CONSOLE = "https://console.aiven.io";

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

export function aivenStatus(raw: string): ResourceStatus {
  const s = raw.toUpperCase();
  if (!s) return "unknown";
  if (["RUNNING", "ACTIVE"].includes(s)) return "healthy";
  if (["POWEROFF", "PAUSED", "STOPPED"].includes(s)) return "info";
  if (/FAIL|ERROR|INVALID|REJECTED|DELETED/.test(s)) return "error";
  if (/REBUILD|REBALANC|CONFIGUR|PENDING|APPROVED|CREAT|UNASSIGNED/.test(s)) return "provisioning";
  if (/DELETING/.test(s)) return "degraded";
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
const open = (path: string): ActionNode =>
  action("Open in Aiven", { type: "open-url", url: `${CONSOLE}${path}` });

function date(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString().replace("T", " ").slice(0, 16);
}

function gb(mb: string): string {
  const n = Number(mb);
  if (!mb || !Number.isFinite(n)) return "";
  return n >= 1024 ? `${Math.round((n / 1024) * 10) / 10} GB` : `${n} MB`;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------

function renderProject(resource: ResourceInstance): DetailViewSchema {
  const alerts = enriched<Array<Record<string, string>>>(resource, ENRICH.alerts);
  const credits = enriched<Array<Record<string, string>>>(resource, ENRICH.credits);
  const groups = enriched<SelectOption[]>(resource, ENRICH.billingGroups) ?? [];
  const clouds = enriched<SelectOption[]>(resource, ENRICH.clouds) ?? [];
  const sections: SectionNode[] = [
    section("Project", [
      kv([
        ["Default cloud", str(resource, "defaultCloud")],
        ["Billing group", str(resource, "billingGroupName") || str(resource, "billingGroupId")],
        ["Organization", str(resource, "organizationId")],
        [
          "Estimated balance",
          str(resource, "estimatedBalance") ? `$${str(resource, "estimatedBalance")}` : "",
        ],
        ["Payment method", str(resource, "paymentMethod")],
        ["Technical contacts", str(resource, "techEmails")],
        ["Tags", str(resource, "tags")],
        ["Trial ends", date(str(resource, "trialExpires"))],
      ]),
    ]),
  ];
  if (alerts?.length) {
    sections.unshift(
      section("Active alerts", [
        table(
          [
            ["time", "Since"],
            ["service", "Service"],
            ["severity", "Severity"],
            ["event", "Alert"],
          ],
          alerts,
        ),
      ]),
    );
  }
  if (credits?.length) {
    sections.push(
      section("Credits", [
        table(
          [
            ["code", "Code"],
            ["type", "Type"],
            ["remaining", "Remaining"],
            ["expires", "Expires"],
          ],
          credits,
        ),
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Project", str(resource, "defaultCloud")),
    sections,
    headerActions: [
      refresh(),
      prompt(
        "Default cloud",
        "set-cloud",
        "Default cloud",
        "New services in this project start in this cloud unless you pick another.",
        [
          clouds.length
            ? {
                key: "cloud",
                label: "Cloud",
                kind: "select",
                required: true,
                options: clouds,
                defaultValue: str(resource, "defaultCloud"),
              }
            : {
                key: "cloud",
                label: "Cloud",
                kind: "text",
                required: true,
                defaultValue: str(resource, "defaultCloud"),
              },
        ],
        "Save",
      ),
      prompt(
        "Billing group",
        "set-billing-group",
        "Move to a billing group",
        groups.length
          ? "Charges for the project go to this billing group from now on."
          : "No billing group is visible to this token.",
        [
          {
            key: "billingGroupId",
            label: "Billing group",
            kind: "select",
            required: true,
            options: groups,
            defaultValue: str(resource, "billingGroupId"),
          },
        ],
        "Move",
        { blocked: groups.length === 0 },
      ),
      prompt(
        "Claim credit code",
        "claim-credit",
        "Claim a credit code",
        "Adds promotional or prepaid credit to the project.",
        [{ key: "code", label: "Code", kind: "text", required: true }],
        "Claim",
      ),
      open(`/account/projects/${enc(str(resource, "name"))}`),
    ],
    logs: { defaultTailLines: 100 },
  };
}

function planPrompt(resource: ResourceInstance): ActionNode {
  const plans = enriched<SelectOption[]>(resource, ENRICH.plans) ?? [];
  return prompt(
    "Change plan",
    "change-plan",
    "Change plan",
    plans.length
      ? `Currently ${str(resource, "plan")}. Aiven migrates the service to new nodes with no downtime; prices are for ${str(resource, "cloud")}.`
      : "Plans for this service type could not be loaded.",
    [
      plans.length
        ? {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            options: plans,
            defaultValue: str(resource, "plan"),
          }
        : {
            key: "plan",
            label: "Plan",
            kind: "text",
            required: true,
            defaultValue: str(resource, "plan"),
          },
    ],
    "Change plan",
  );
}

function renderService(resource: ResourceInstance): DetailViewSchema {
  const type = str(resource, "serviceType");
  const state = str(resource, "state");
  const project = str(resource, "project");
  const name = str(resource, "name");
  const clouds = enriched<SelectOption[]>(resource, ENRICH.clouds) ?? [];
  const nodes = enriched<Array<Record<string, string>>>(resource, ENRICH.nodes);
  const backups = enriched<Array<Record<string, string>>>(resource, ENRICH.backups);
  const alerts = enriched<Array<Record<string, string>>>(resource, ENRICH.alerts);
  const maintenance = enriched<Array<Record<string, string>>>(resource, ENRICH.maintenance);
  const sections: SectionNode[] = [
    section("Service", [
      kv([
        ["Type", type],
        ["State", state],
        ["Version", str(resource, "version")],
        ["Plan", str(resource, "plan")],
        ["Cloud", str(resource, "cloudDescription") || str(resource, "cloud")],
        ["Nodes", str(resource, "nodeCount")],
        ["CPUs per node", str(resource, "cpuPerNode")],
        ["Memory per node", gb(str(resource, "memoryMbPerNode"))],
        ["Disk", gb(str(resource, "diskSpaceMb"))],
        ["Termination protection", flag(resource, "terminationProtection")],
        ["VPC", str(resource, "projectVpcId")],
        ["Tags", str(resource, "tags")],
        ["Created", date(str(resource, "createdAt"))],
      ]),
    ]),
    section("Connection", [
      kv([
        ["Host", str(resource, "host")],
        ["Port", str(resource, "port")],
        ["Kafka SASL endpoint", str(resource, "kafkaSasl")],
      ]),
      {
        kind: "text",
        variant: "muted",
        content: "The service URI, admin password and project CA are outputs.",
      },
    ]),
    section("Maintenance", [
      kv([
        [
          "Window",
          str(resource, "maintenanceDow")
            ? `${str(resource, "maintenanceDow")} ${str(resource, "maintenanceTime")} UTC`
            : "",
        ],
        ["Pending updates", str(resource, "pendingMaintenance") || "0"],
      ]),
      ...(maintenance?.length
        ? [
            table(
              [
                ["description", "Update"],
                ["deadline", "Deadline"],
              ],
              maintenance,
            ),
          ]
        : []),
    ]),
  ];
  if (alerts?.length) {
    sections.unshift(
      section("Active alerts", [
        table(
          [
            ["time", "Since"],
            ["severity", "Severity"],
            ["event", "Alert"],
            ["node", "Node"],
          ],
          alerts,
        ),
      ]),
    );
  }
  if (nodes?.length)
    sections.push(
      section("Nodes", [
        table(
          [
            ["name", "Node"],
            ["role", "Role"],
            ["state", "State"],
          ],
          nodes,
        ),
      ]),
    );
  if (backups?.length)
    sections.push(
      section("Backups", [
        table(
          [
            ["name", "Backup"],
            ["time", "Taken"],
            ["size", "Size"],
          ],
          backups,
        ),
      ]),
    );
  const powered = state !== "POWEROFF";
  const headerActions: ActionNode[] = [
    refresh(),
    powered
      ? pluginAction("Power off", "power-off", {
          confirm:
            "Power off the service? Data is kept in backups, but anything newer than the last backup is lost and the service stops serving.",
          destructive: true,
        })
      : pluginAction("Power on", "power-on", { success: "Powering on." }),
    planPrompt(resource),
    prompt(
      "Move cloud",
      "move-cloud",
      "Move to another cloud or region",
      "Aiven migrates the service online. Clients reconnect to the same hostname.",
      [
        clouds.length
          ? {
              key: "cloud",
              label: "Cloud",
              kind: "select",
              required: true,
              options: clouds,
              defaultValue: str(resource, "cloud"),
            }
          : {
              key: "cloud",
              label: "Cloud",
              kind: "text",
              required: true,
              defaultValue: str(resource, "cloud"),
            },
      ],
      "Move",
    ),
  ];
  if (Number(str(resource, "pendingMaintenance") || 0) > 0) {
    headerActions.push(
      pluginAction("Apply maintenance now", "start-maintenance", {
        confirm: "Start the pending maintenance updates now instead of in the next window?",
      }),
    );
  }
  headerActions.push(
    prompt(
      "Tags",
      "set-tags",
      "Service tags",
      "Tags appear on the service's invoice lines, so they become cost allocation keys here too.",
      [
        {
          key: "tags",
          label: "Tags",
          kind: "string-list",
          required: false,
          placeholder: "team=payments",
          defaultValue: str(resource, "tags"),
        },
      ],
      "Save tags",
    ),
    open(`/project/${enc(project)}/services/${enc(name)}/overview`),
  );
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(type, str(resource, "plan"), str(resource, "cloud")),
    status: { kind: "status-dot", status: aivenStatus(state), label: state.toLowerCase() },
    sections,
    headerActions,
    logs: { defaultTailLines: 200 },
  };
}

function renderUser(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Service user", str(resource, "serviceName")),
    sections: [
      section("User", [
        kv([
          ["Type", str(resource, "type")],
          ["Authentication", str(resource, "authentication")],
          ["Password updated", date(str(resource, "passwordUpdated"))],
          ["Access certificate expires", date(str(resource, "certExpires"))],
        ]),
        {
          kind: "text",
          variant: "muted",
          content: "The password (and Kafka access certificate and key) are outputs.",
        },
      ]),
    ],
    headerActions: [
      refresh(),
      prompt(
        "Set password",
        "set-password",
        "Set password",
        "Leave empty to have Aiven generate a new random password.",
        [{ key: "password", label: "New password", kind: "password", required: false }],
        "Save",
      ),
      ...(str(resource, "certExpires")
        ? [
            pluginAction("Renew certificate", "acknowledge-renewal", {
              success: "Renewal acknowledged.",
            }),
          ]
        : []),
    ],
  };
}

function simpleChild(
  resource: ResourceInstance,
  subtitle: string,
  items: Array<[string, string | number | boolean | undefined]>,
): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(subtitle, str(resource, "serviceName")),
    sections: [section(subtitle, [kv(items)])],
    headerActions: [refresh()],
  };
}

function renderTopic(resource: ResourceInstance): DetailViewSchema {
  const view = simpleChild(resource, "Kafka topic", [
    ["Partitions", str(resource, "partitions")],
    ["Replication", str(resource, "replication")],
    [
      "Retention",
      str(resource, "retentionHours") === "-1"
        ? "Forever"
        : str(resource, "retentionHours")
          ? `${str(resource, "retentionHours")} h`
          : "",
    ],
    ["Min in-sync replicas", str(resource, "minInsyncReplicas")],
    ["Cleanup policy", str(resource, "cleanupPolicy")],
    ["State", str(resource, "state")],
    ["Description", str(resource, "description")],
  ]);
  const publish: PublishPanelCapability = {
    subtitle:
      "Produce a message to this topic through Aiven's Kafka REST proxy (Karapace must be enabled on the service).",
    bodyFormat: "json",
    defaultBody: '{\n  "hello": "world"\n}',
    extraFields: [
      { key: "key", label: "Key", kind: "text", optional: true },
      { key: "partition", label: "Partition", kind: "number", optional: true },
    ],
    submitLabel: "Produce",
  };
  return {
    ...view,
    status: {
      kind: "status-dot",
      status: aivenStatus(str(resource, "state")),
      label: str(resource, "state").toLowerCase(),
    },
    publishPanel: publish,
  };
}

function renderConnector(resource: ResourceInstance): DetailViewSchema {
  const status = enriched<{
    state?: string;
    tasks?: Array<{ id?: number; state?: string; trace?: string }>;
  }>(resource, ENRICH.connectorStatus);
  const state = status?.state ?? str(resource, "state");
  const sections: SectionNode[] = [
    section("Connector", [
      kv([
        ["Class", str(resource, "connectorClass")],
        ["Plugin", str(resource, "pluginTitle")],
        ["Direction", str(resource, "direction")],
        ["State", state],
        ["Tasks", str(resource, "tasks")],
      ]),
    ]),
  ];
  if (status?.tasks?.length) {
    sections.push(
      section("Tasks", [
        table(
          [
            ["id", "Task"],
            ["state", "State"],
            ["restart", ""],
          ],
          status.tasks.map((t) => ({
            id: String(t.id ?? ""),
            state: t.state ?? "",
            restart: pluginAction("Restart", `restart-task:${t.id ?? 0}`, {
              success: "Task restarting.",
            }),
          })),
        ),
      ]),
    );
    const trace = status.tasks.find((t) => t.trace)?.trace;
    if (trace)
      sections.push(
        section("Last error", [{ kind: "text", variant: "mono", content: trace.slice(0, 4000) }]),
      );
  }
  const paused = /PAUSED|STOPPED/i.test(state);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Kafka connector", str(resource, "serviceName")),
    status: { kind: "status-dot", status: aivenStatus(state), label: state.toLowerCase() },
    sections,
    headerActions: [
      refresh(),
      paused
        ? pluginAction("Resume", "resume", { success: "Resumed." })
        : pluginAction("Pause", "pause", { confirm: "Pause the connector?" }),
      pluginAction("Restart", "restart", { success: "Restarting." }),
      prompt(
        "Edit config",
        "set-config",
        "Connector configuration",
        "The full connector configuration as JSON. Saving replaces it.",
        [
          {
            key: "config",
            label: "Configuration",
            kind: "code",
            codeLanguage: "json",
            required: true,
          },
        ],
        "Save",
      ),
    ],
  };
}

function renderSubject(resource: ResourceInstance): DetailViewSchema {
  const schema = enriched<{
    version?: number;
    schemaType?: string;
    schema?: string;
    versions?: number[];
  }>(resource, ENRICH.schema);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Schema subject", str(resource, "serviceName")),
    sections: [
      section("Latest version", [
        kv([
          ["Version", schema?.version],
          ["Type", schema?.schemaType ?? (schema ? "AVRO" : undefined)],
          ["All versions", schema?.versions?.join(", ")],
        ]),
        ...(schema?.schema
          ? [
              {
                kind: "text" as const,
                variant: "mono" as const,
                content: schema.schema,
                copyable: true,
              },
            ]
          : []),
      ]),
    ],
    headerActions: [
      refresh(),
      prompt(
        "Register version",
        "register",
        "Register a new schema version",
        "Registers a schema under this subject; the registry rejects it if it breaks the subject's compatibility setting.",
        [
          {
            key: "schemaType",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: schema?.schemaType ?? "AVRO",
            options: [
              { id: "AVRO", label: "Avro" },
              { id: "JSON", label: "JSON Schema" },
              { id: "PROTOBUF", label: "Protobuf" },
            ],
          },
          {
            key: "schema",
            label: "Schema",
            kind: "code",
            codeLanguage: "json",
            required: true,
            ...(schema?.schema ? { defaultValue: schema.schema } : {}),
          },
        ],
        "Register",
      ),
    ],
  };
}

function renderVpc(resource: ResourceInstance): DetailViewSchema {
  const peerings = enriched<Array<Record<string, string>>>(resource, ENRICH.peerings);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Project VPC", str(resource, "cloud")),
    status: {
      kind: "status-dot",
      status: aivenStatus(str(resource, "state")),
      label: str(resource, "state").toLowerCase(),
    },
    sections: [
      section("VPC", [
        kv([
          ["Cloud", str(resource, "cloud")],
          ["Network", str(resource, "networkCidr")],
          ["State", str(resource, "state")],
          ["Peerings", str(resource, "peerings")],
          ["Created", date(str(resource, "createdAt"))],
        ]),
      ]),
      ...(peerings?.length
        ? [
            section("Peering connections", [
              table(
                [
                  ["peer", "Peer"],
                  ["state", "State"],
                  ["info", "Details"],
                ],
                peerings,
              ),
            ]),
          ]
        : []),
    ],
    headerActions: [refresh(), open(`/project/${enc(str(resource, "project"))}/vpcs`)],
  };
}

function renderPeering(resource: ResourceInstance): DetailViewSchema {
  const state = str(resource, "state");
  return {
    title: resource.displayName,
    subtitle: "VPC peering",
    status: { kind: "status-dot", status: aivenStatus(state), label: state.toLowerCase() },
    sections: [
      section("Peering", [
        kv([
          ["Peer account", str(resource, "peerCloudAccount")],
          ["Peer network", str(resource, "peerVpc")],
          ["Peer region", str(resource, "peerRegion")],
          ["Resource group", str(resource, "peerResourceGroup")],
          ["State", state],
          ["Details", str(resource, "stateMessage")],
          ["Routed CIDRs", str(resource, "cidrs")],
        ]),
      ]),
      ...(state === "PENDING_PEER"
        ? [
            section("Next step", [
              {
                kind: "text",
                variant: "body",
                content: "Accept the peering request in your cloud account, then refresh.",
              } as SchemaNode,
            ]),
          ]
        : []),
    ],
    headerActions: [
      refresh(),
      pluginAction("Check state", "refresh-peerings", {
        success: "Aiven is re-checking the peering.",
      }),
    ],
  };
}

function renderBillingGroup(resource: ResourceInstance): DetailViewSchema {
  const invoices = enriched<Array<Record<string, string>>>(resource, ENRICH.invoices);
  const credits = enriched<Array<Record<string, string>>>(resource, ENRICH.credits);
  return {
    title: resource.displayName,
    subtitle: "Billing group",
    sections: [
      section("Billing group", [
        kv([
          ["Currency", str(resource, "currency")],
          ["Payment method", str(resource, "paymentMethod")],
          [
            "Estimated balance",
            str(resource, "estimatedBalance") ? `$${str(resource, "estimatedBalance")}` : "",
          ],
          ["Organization", str(resource, "organization")],
          ["Billing emails", str(resource, "billingEmails")],
        ]),
      ]),
      ...(invoices?.length
        ? [
            section("Invoices", [
              table(
                [
                  ["number", "Invoice"],
                  ["period", "Period"],
                  ["state", "State"],
                  ["total", "Total"],
                ],
                invoices,
              ),
            ]),
          ]
        : []),
      ...(credits?.length
        ? [
            section("Credits", [
              table(
                [
                  ["code", "Code"],
                  ["type", "Type"],
                  ["remaining", "Remaining"],
                  ["expires", "Expires"],
                ],
                credits,
              ),
            ]),
          ]
        : []),
    ],
    headerActions: [
      refresh(),
      prompt(
        "Claim credit code",
        "claim-credit",
        "Claim a credit code",
        "Adds credit to this billing group.",
        [{ key: "code", label: "Code", kind: "text", required: true }],
        "Claim",
      ),
      open("/billing"),
    ],
  };
}

export function renderAivenDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.project:
      return renderProject(resource);
    case T.service:
      return renderService(resource);
    case T.user:
      return renderUser(resource);
    case T.database:
      return simpleChild(resource, "Database", [["Service", str(resource, "serviceName")]]);
    case T.pool:
      return simpleChild(resource, "Connection pool", [
        ["Database", str(resource, "database")],
        ["User", str(resource, "username")],
        ["Mode", str(resource, "poolMode")],
        ["Size", str(resource, "poolSize")],
      ]);
    case T.topic:
      return renderTopic(resource);
    case T.acl:
      return simpleChild(resource, "Kafka ACL", [
        ["User pattern", str(resource, "username")],
        ["Topic pattern", str(resource, "topic")],
        ["Permission", str(resource, "permission")],
      ]);
    case T.connector:
      return renderConnector(resource);
    case T.subject:
      return renderSubject(resource);
    case T.integration:
      return {
        title: resource.displayName,
        subtitle: "Service integration",
        sections: [
          section("Integration", [
            kv([
              ["Type", str(resource, "integrationType")],
              ["Source", str(resource, "source")],
              ["Destination", str(resource, "destination")],
              ["Enabled", flag(resource, "enabled")],
              ["Active", flag(resource, "active")],
            ]),
          ]),
        ],
        headerActions: [refresh()],
      };
    case T.vpc:
      return renderVpc(resource);
    case T.peering:
      return renderPeering(resource);
    case T.billingGroup:
      return renderBillingGroup(resource);
    default:
      return {
        title: resource.displayName,
        sections: [section("Resource", [kv([["ID", resource.externalId]])])],
      };
  }
}

export function renderAivenSidebar(resource: ResourceInstance): SidebarItemSchema {
  const key = (
    {
      [T.service]: "state",
      [T.topic]: "state",
      [T.connector]: "state",
      [T.vpc]: "state",
      [T.peering]: "state",
    } as Record<string, string>
  )[resource.resourceTypeId];
  const raw = key ? str(resource, key) : "";
  return {
    id: resource.id,
    label: resource.displayName,
    ...(raw
      ? {
          status: {
            kind: "status-dot" as const,
            status: aivenStatus(raw),
            label: raw.toLowerCase(),
          },
        }
      : {}),
  };
}
