/**
 * Detail views, sidebar items and dashboard stats, synchronous over the
 * `__name__` stashes `enrichDetail` writes.
 */

import type {
  ActionNode,
  CreateFieldConfig,
  DashboardStat,
  DetailViewSchema,
  KVItem,
  PolicyOption,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  SizeOption,
  TableNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, resourceTypeDisplayName } from "@infrawrench/plugin-base";
import { regionLabel } from "./regions.js";
import type {
  CivoCharge,
  CivoDatabaseBackup,
  CivoFirewallRule,
  CivoLoadBalancer,
  CivoPoolInstance,
} from "./types.js";

export function parseStash<T>(resource: ResourceInstance, key: string): T | null {
  const raw = resource.resolvedOutputs[`__${key}__`];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const s = (v: unknown) => (v == null ? "" : String(v));

export function statusFor(r: ResourceInstance): ResourceStatus {
  const st = s(r.fields["status"] ?? r.fields["state"]).toUpperCase();
  switch (r.resourceTypeId) {
    case "instance":
      if (st === "ACTIVE") return "healthy";
      if (st === "SHUTOFF" || st === "STOPPED") return "error";
      if (
        st.includes("BUILD") ||
        st.includes("PENDING") ||
        st.includes("REBOOT") ||
        st.includes("STARTING")
      )
        return "provisioning";
      return st ? "degraded" : "unknown";
    case "kubernetes-cluster":
    case "database":
    case "object-store":
    case "load-balancer":
      if (["ACTIVE", "READY", "RUNNING", "AVAILABLE"].includes(st)) return "healthy";
      if (
        st.includes("BUILD") ||
        st.includes("PENDING") ||
        st.includes("CREAT") ||
        st.includes("SCALING") ||
        st.includes("UPGRAD")
      )
        return "provisioning";
      if (st.includes("FAIL") || st.includes("ERROR")) return "error";
      return st ? "degraded" : "unknown";
    case "volume":
      return r.fields["instanceId"] || r.fields["clusterId"] ? "healthy" : "info";
    case "reserved-ip":
      return r.fields["assignedToId"] ? "healthy" : "info";
    case "firewall":
      return s(r.fields["openToWorld"]) ? "degraded" : "healthy";
    default:
      return "info";
  }
}

const HIDDEN: Record<string, string[]> = {
  "ssh-key": ["publicKey"],
  "volume-snapshot": ["sourceRef"],
  "instance-snapshot": ["sourceRef"],
  "database-backup": ["sourceRef"],
};

function detailItems(r: ResourceInstance, types: ResourceTypeDefinition[]): KVItem[] {
  const hidden = new Set(HIDDEN[r.resourceTypeId] ?? []);
  const fields = Object.fromEntries(Object.entries(r.fields).filter(([k]) => !hidden.has(k)));
  return labeledFieldItems(fields, types, r.resourceTypeId).map((item) =>
    item.key === "Region" && item.value
      ? { ...item, value: `${regionLabel(String(item.value))} (${String(item.value)})` }
      : item,
  );
}

const action = (
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean } = {},
): ActionNode => ({
  kind: "action",
  label,
  action: {
    type: "plugin-action",
    actionId,
    ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
    ...(opts.success ? { successMessage: opts.success } : {}),
  },
  ...(opts.danger ? { variant: "danger" as const } : {}),
});

const prompt = (
  label: string,
  command: string,
  fields: CreateFieldConfig[],
  opts: { description?: string; submit?: string; danger?: boolean; blocked?: boolean } = {},
): ActionNode => ({
  kind: "action",
  label,
  action: {
    type: "prompt-nosql-command",
    command,
    title: label.replace(/…$/, ""),
    fields,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.submit ? { submitLabel: opts.submit } : {}),
    ...(opts.danger ? { danger: true } : {}),
    ...(opts.blocked ? { blocked: true, descriptionVariant: "error" as const } : {}),
  },
  ...(opts.danger ? { variant: "danger" as const } : {}),
});

const hidden = (key: string, value: string): CreateFieldConfig => ({
  key,
  label: key,
  kind: "text",
  required: true,
  defaultValue: value,
  hidden: true,
});

const civoPicker = (
  key: string,
  label: string,
  typeId: string,
  outputKey: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required: true,
  associationSources: [{ pluginId: "civo", resourceTypeId: typeId, outputKey }],
});

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

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});

interface Parts {
  actions: ActionNode[];
  sections: SectionNode[];
}

function instanceParts(r: ResourceInstance): Parts {
  const st = s(r.fields["status"]).toUpperCase();
  const actions: ActionNode[] = [];
  if (st === "SHUTOFF") actions.push(action("Start", "start", { success: "Start requested." }));
  if (st === "ACTIVE") {
    actions.push(
      action("Stop", "stop", {
        confirm:
          "Shut this instance down? Civo keeps billing a shut-off instance; only deleting it stops the charges.",
        success: "Stop requested.",
      }),
      action("Reboot", "reboot", {
        confirm: "Reboot this instance?",
        success: "Reboot requested.",
      }),
      action("Hard reboot", "hard-reboot", {
        confirm: "Power-cycle this instance? Unsaved data is lost.",
        success: "Hard reboot requested.",
        danger: true,
      }),
    );
  }
  const sizes = parseStash<SizeOption[]>(r, "sizes") ?? [];
  actions.push(
    prompt(
      "Resize…",
      "resize",
      sizes.length
        ? [
            {
              key: "size",
              label: "New Size",
              kind: "size-picker",
              required: true,
              sizes,
              defaultValue: sizes[0]?.id ?? "",
            },
          ]
        : [],
      sizes.length
        ? {
            description: `Current size: ${s(r.fields["size"])}. Civo restarts the instance; it cannot be resized down.`,
            submit: "Resize",
          }
        : { description: "There is no larger size to move to.", blocked: true },
    ),
    prompt(
      "Firewall…",
      "set-firewall",
      [civoPicker("firewallId", "Firewall", "firewall", "firewallId")],
      { submit: "Apply" },
    ),
    prompt(
      "Take snapshot…",
      "snapshot",
      [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          defaultValue: `${s(r.fields["hostname"])}-${new Date().toISOString().slice(0, 10)}`,
        },
        { key: "description", label: "Description", kind: "text", required: false },
      ],
      { submit: "Take snapshot" },
    ),
    action("Recovery mode", "enable-recovery", {
      confirm: "Boot the instance into Civo's recovery environment? It restarts.",
      success: "Recovery mode requested.",
    }),
    action("Leave recovery mode", "disable-recovery", {
      confirm: "Boot the instance normally again?",
      success: "Requested.",
    }),
  );
  const net: KVItem[] = [];
  for (const [key, label] of [
    ["ipv4", "Public IPv4"],
    ["ipv4Private", "Private IPv4"],
    ["ipv6", "IPv6"],
  ] as const) {
    const v = r.resolvedOutputs[key];
    if (v) net.push({ key: label, value: v, copyable: true });
  }
  return {
    actions,
    sections: net.length ? [section("Networking", [{ kind: "key-value-list", items: net }])] : [],
  };
}

function firewallParts(r: ResourceInstance): Parts {
  const rules = parseStash<CivoFirewallRule[]>(r, "rules") ?? [];
  const actions = [
    prompt(
      "+ Rule",
      "add-rule",
      [
        {
          key: "direction",
          label: "Direction",
          kind: "select",
          required: true,
          defaultValue: "ingress",
          options: [
            { id: "ingress", label: "Inbound" },
            { id: "egress", label: "Outbound" },
          ],
        },
        {
          key: "action",
          label: "Action",
          kind: "select",
          required: true,
          defaultValue: "allow",
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          defaultValue: "tcp",
          options: ["tcp", "udp", "icmp"].map((p) => ({ id: p, label: p.toUpperCase() })),
        },
        {
          key: "ports",
          label: "Port or Range",
          kind: "text",
          required: false,
          placeholder: "22 or 8000-9000",
          showWhen: { fieldKey: "protocol", fieldValues: ["tcp", "udp"] },
        },
        {
          key: "cidr",
          label: "Addresses",
          kind: "string-list",
          required: false,
          addLabel: "Add CIDR",
          description: "Leave empty for 0.0.0.0/0",
        },
        { key: "label", label: "Label", kind: "text", required: false },
      ],
      { submit: "Add rule" },
    ),
  ];
  return {
    actions,
    sections: [
      section("Rules", [
        table(
          [
            ["dir", "Direction"],
            ["action", "Action"],
            ["proto", "Protocol"],
            ["ports", "Ports"],
            ["cidr", "Addresses"],
            ["label", "Label"],
            ["remove", ""],
          ],
          rules.map((ru) => ({
            dir: s(ru.direction),
            action: s(ru.action),
            proto: s(ru.protocol).toUpperCase(),
            ports: s(
              ru.ports ||
                (ru.start_port
                  ? ru.end_port && ru.end_port !== ru.start_port
                    ? `${ru.start_port}-${ru.end_port}`
                    : ru.start_port
                  : "all"),
            ),
            cidr: (ru.cidr ?? []).join(", "),
            label: s(ru.label),
            remove: prompt("Remove", "remove-rule", [hidden("ruleId", s(ru.id))], {
              description: "Remove this rule?",
              submit: "Remove",
              danger: true,
            }),
          })),
        ),
      ]),
    ],
  };
}

function clusterParts(r: ResourceInstance): Parts {
  const nodes =
    parseStash<Array<{ hostname: string; status: string; ip: string; pool: string }>>(r, "nodes") ??
    [];
  const apps = parseStash<PolicyOption[]>(r, "apps") ?? [];
  const upgrade = s(r.fields["upgradeAvailableTo"]);
  const actions: ActionNode[] = [];
  if (upgrade) {
    actions.push(
      action(`Upgrade to ${upgrade}`, "upgrade", {
        confirm: `Upgrade the cluster to Kubernetes ${upgrade}? Nodes are replaced in turn.`,
        success: "Upgrade started.",
      }),
    );
  }
  actions.push(
    prompt(
      "Install applications…",
      "install-apps",
      [
        {
          key: "applications",
          label: "Applications",
          kind: "policy-picker",
          required: true,
          policies: apps,
        },
      ],
      apps.length
        ? { submit: "Install" }
        : { description: "Every marketplace application is already installed.", blocked: true },
    ),
    prompt(
      "Firewall…",
      "set-firewall",
      [civoPicker("firewallId", "Firewall", "firewall", "firewallId")],
      { submit: "Apply" },
    ),
  );
  return {
    actions,
    sections: nodes.length
      ? [
          section("Nodes", [
            table(
              [
                ["hostname", "Node"],
                ["pool", "Pool"],
                ["status", "Status"],
                ["ip", "Public IP"],
                ["recycle", ""],
              ],
              nodes.map((n) => ({
                ...n,
                recycle: prompt("Recycle", "recycle-node", [hidden("hostname", n.hostname)], {
                  description: `Delete ${n.hostname} and replace it with a fresh node?`,
                  submit: "Recycle",
                }),
              })),
            ),
          ]),
        ]
      : [],
  };
}

function poolParts(r: ResourceInstance): Parts {
  const nodes = parseStash<CivoPoolInstance[]>(r, "nodes") ?? [];
  return {
    actions: [],
    sections: nodes.length
      ? [
          section("Nodes", [
            table(
              [
                ["hostname", "Node"],
                ["status", "Status"],
                ["size", "Size"],
                ["remove", ""],
              ],
              nodes.map((n) => ({
                hostname: s(n.hostname),
                status: s(n.status),
                size: s(n.size),
                remove: prompt("Remove", "delete-node", [hidden("nodeId", s(n.id))], {
                  description: `Remove ${s(n.hostname)} from the pool? The pool shrinks by one node.`,
                  submit: "Remove",
                  danger: true,
                }),
              })),
            ),
          ]),
        ]
      : [],
  };
}

function databaseParts(r: ResourceInstance): Parts {
  const backups = parseStash<CivoDatabaseBackup[]>(r, "backups") ?? [];
  const usable = backups.filter((b) => !b.is_scheduled || b.name);
  return {
    actions: [
      prompt(
        "Restore…",
        "restore",
        [
          {
            key: "backup",
            label: "Backup",
            kind: "select",
            required: true,
            options: usable.map((b) => ({
              id: s(b.name),
              label: `${s(b.name)} (${s(b.created_at).slice(0, 16).replace("T", " ")})`,
            })),
          },
          { key: "name", label: "Restore Name", kind: "text", required: false },
        ],
        usable.length
          ? {
              description: "DESTRUCTIVE: the database is restored in place from the backup.",
              submit: "Restore",
              danger: true,
            }
          : { description: "This database has no backups yet.", blocked: true },
      ),
      prompt(
        "Firewall…",
        "set-firewall",
        [civoPicker("firewallId", "Firewall", "firewall", "firewallId")],
        { submit: "Apply" },
      ),
    ],
    sections: [],
  };
}

function loadBalancerParts(r: ResourceInstance): Parts {
  const lb = parseStash<CivoLoadBalancer>(r, "lb");
  const instances = parseStash<PolicyOption[]>(r, "instanceOptions") ?? [];
  const backends = lb?.backends ?? [];
  return {
    actions: [
      prompt(
        "Backends…",
        "set-backends",
        [
          {
            key: "backends",
            label: "Backend Instances",
            kind: "policy-picker",
            required: false,
            policies: instances,
            defaultValue: JSON.stringify(backends.map((b) => b.ip).filter(Boolean)),
          },
          {
            key: "sourcePort",
            label: "Listen Port",
            kind: "number",
            required: false,
            defaultValue: s(backends[0]?.source_port ?? 80),
          },
          {
            key: "targetPort",
            label: "Backend Port",
            kind: "number",
            required: false,
            defaultValue: s(backends[0]?.target_port ?? 80),
          },
        ],
        { description: "Pick every instance that should receive traffic.", submit: "Save" },
      ),
      prompt(
        "Firewall…",
        "set-firewall",
        [civoPicker("firewallId", "Firewall", "firewall", "firewallId")],
        { submit: "Apply" },
      ),
    ],
    sections: backends.length
      ? [
          section("Backends", [
            table(
              [
                ["ip", "Address"],
                ["proto", "Protocol"],
                ["ports", "Ports"],
              ],
              backends.map((b) => ({
                ip: s(b.ip),
                proto: s(b.protocol || "TCP"),
                ports: `${s(b.source_port)} → ${s(b.target_port)}`,
              })),
            ),
          ]),
        ]
      : [],
  };
}

function simpleActions(r: ResourceInstance): ActionNode[] {
  switch (r.resourceTypeId) {
    case "volume":
      return r.fields["instanceId"]
        ? [
            action("Detach", "detach", {
              confirm: "Detach this volume? Unmount it first.",
              success: "Detach requested.",
              danger: true,
            }),
          ]
        : [
            prompt(
              "Attach…",
              "attach",
              [
                civoPicker("instanceId", "Instance", "instance", "instanceId"),
                {
                  key: "attachAtBoot",
                  label: "Attach at next boot only",
                  kind: "select",
                  required: false,
                  defaultValue: "false",
                  options: [
                    { id: "false", label: "No, attach now" },
                    { id: "true", label: "Yes" },
                  ],
                },
              ],
              { description: "The instance must be in the same region.", submit: "Attach" },
            ),
          ];
    case "reserved-ip":
      return r.fields["assignedToId"]
        ? [
            action("Unassign", "unassign", {
              confirm: "Unassign this IP? The resource loses the address.",
              success: "Unassigned.",
              danger: true,
            }),
          ]
        : [
            prompt(
              "Assign…",
              "assign",
              [civoPicker("instanceId", "Instance", "instance", "instanceId")],
              { submit: "Assign" },
            ),
          ];
    case "instance-snapshot":
      return [
        prompt(
          "Restore…",
          "restore",
          [
            {
              key: "hostname",
              label: "New Hostname",
              kind: "text",
              required: false,
              description: "Leave empty to restore over the original instance",
            },
            {
              key: "overwrite",
              label: "Overwrite the original instance",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No, create a new instance" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
          { submit: "Restore", danger: true },
        ),
      ];
    default:
      return [];
  }
}

export function renderDetail(
  resource: ResourceInstance,
  types: ResourceTypeDefinition[],
): DetailViewSchema {
  let parts: Parts = { actions: simpleActions(resource), sections: [] };
  switch (resource.resourceTypeId) {
    case "instance":
      parts = instanceParts(resource);
      break;
    case "firewall":
      parts = firewallParts(resource);
      break;
    case "kubernetes-cluster":
      parts = clusterParts(resource);
      break;
    case "node-pool":
      parts = poolParts(resource);
      break;
    case "database":
      parts = databaseParts(resource);
      break;
    case "load-balancer":
      parts = loadBalancerParts(resource);
      break;
    case "object-store": {
      const stats = parseStash<{
        size_kb_utilised?: number;
        max_size_kb?: number;
        num_objects?: number;
      }>(resource, "stats");
      if (stats)
        parts.sections = [
          section("Usage", [
            {
              kind: "key-value-list",
              items: [
                { key: "Objects", value: s(stats.num_objects ?? 0) },
                {
                  key: "Used",
                  value: `${((stats.size_kb_utilised ?? 0) / 1024 / 1024).toFixed(2)} GB of ${((stats.max_size_kb ?? 0) / 1024 / 1024).toFixed(0)} GB`,
                },
              ],
            },
          ]),
        ];
      break;
    }
    case "account": {
      const charges = parseStash<CivoCharge[]>(resource, "charges");
      if (charges)
        parts.sections = [
          section("Usage This Month", [
            table(
              [
                ["label", "Resource"],
                ["code", "Product"],
                ["region", "Region"],
                ["hours", "Hours"],
                ["size", "Size (GB)"],
              ],
              charges.map((c) => ({
                label: s(c.label),
                code: s(c.code),
                region: s(c.region),
                hours: s(c.num_hours ?? 0),
                size: c.size_gb == null ? "" : s(c.size_gb),
              })),
            ),
          ]),
        ];
      break;
    }
    case "ssh-key": {
      const key = s(resource.fields["publicKey"]);
      if (key)
        parts.sections = [
          section("Public Key", [{ kind: "text", content: key, variant: "mono", copyable: true }]),
        ];
      break;
    }
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(types, resource.resourceTypeId),
      resource.fields["region"]
        ? regionLabel(s(resource.fields["region"]))
        : resource.fields["domainName"],
    ),
    status: { kind: "status-dot", status: statusFor(resource) },
    sections: [
      section("Details", [{ kind: "key-value-list", items: detailItems(resource, types) }]),
      ...parts.sections,
    ],
    headerActions: [
      ...parts.actions,
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
    ...(resource.resourceTypeId === "object-store" && resource.externalId
      ? { storageBrowser: { bucketName: resource.externalId } }
      : {}),
  };
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: statusFor(resource) },
  };
}

export function dashboardStats(resource: ResourceInstance): DashboardStat[] {
  const f = resource.fields;
  const st = statusFor(resource);
  const variant: NonNullable<DashboardStat["variant"]> =
    st === "healthy"
      ? "status-healthy"
      : st === "error"
        ? "status-error"
        : st === "degraded"
          ? "status-degraded"
          : "default";
  switch (resource.resourceTypeId) {
    case "instance":
      return [
        { label: "Status", value: s(f["status"]), variant },
        { label: "Size", value: s(f["size"]) },
        ...(resource.resolvedOutputs["ipv4"]
          ? [{ label: "IPv4", value: resource.resolvedOutputs["ipv4"] }]
          : []),
      ];
    case "kubernetes-cluster":
      return [
        { label: "Version", value: s(f["version"]) },
        { label: "Nodes", value: s(f["nodeCount"]) },
        { label: "Status", value: s(f["status"]), variant },
      ];
    case "database":
      return [
        { label: "Status", value: s(f["status"]), variant },
        { label: "Engine", value: `${s(f["engine"])} ${s(f["version"])}` },
        { label: "Nodes", value: s(f["nodes"]) },
      ];
    case "volume":
      return [{ label: "Size", value: `${s(f["sizeGb"])} GB` }];
    default:
      return [];
  }
}
