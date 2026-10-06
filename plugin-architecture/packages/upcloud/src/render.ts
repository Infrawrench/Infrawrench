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
import type { Json } from "./listers.js";

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
  const st = s(r.fields["state"] ?? r.fields["operationalState"]).toLowerCase();
  switch (r.resourceTypeId) {
    case "server":
      if (st === "started") return "healthy";
      if (st === "stopped") return "error";
      if (st === "maintenance") return "provisioning";
      return st === "error" ? "error" : st ? "degraded" : "unknown";
    case "storage":
      if (st === "online") return r.fields["serverIds"] ? "healthy" : "info";
      if (st === "error") return "error";
      return st ? "provisioning" : "unknown";
    case "backup":
    case "template":
      return st === "online" ? "healthy" : st === "error" ? "error" : st ? "provisioning" : "info";
    case "kubernetes-cluster":
    case "node-group":
    case "database":
    case "load-balancer":
    case "object-storage": {
      const op = s(r.fields["operationalState"] || r.fields["state"]).toLowerCase();
      if (["running", "started"].includes(op)) return "healthy";
      if (
        [
          "pending",
          "rebuilding",
          "setup-agent",
          "setup-server",
          "setup-network",
          "setup-lb",
          "setup-dns",
          "checkup",
          "scaling-up",
          "scaling-down",
          "maintenance",
        ].includes(op)
      )
        return "provisioning";
      if (["failed", "error", "stopped"].includes(op)) return "error";
      return op ? "degraded" : "unknown";
    }
    case "floating-ip":
      return r.fields["serverId"] ? "healthy" : "info";
    default:
      return "info";
  }
}

function detailItems(r: ResourceInstance, types: ResourceTypeDefinition[]): KVItem[] {
  return labeledFieldItems(r.fields, types, r.resourceTypeId);
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

const upPicker = (
  key: string,
  label: string,
  typeId: string,
  outputKey: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required: true,
  associationSources: [{ pluginId: "upcloud", resourceTypeId: typeId, outputKey }],
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

function serverParts(r: ResourceInstance): Parts {
  const st = s(r.fields["state"]);
  const actions: ActionNode[] = [];
  if (st === "stopped") actions.push(action("Start", "start", { success: "Start requested." }));
  if (st === "started") {
    actions.push(
      action("Stop", "stop", {
        confirm:
          "Shut this server down? UpCloud keeps billing its storage and IP addresses while it is stopped.",
        success: "Stop requested.",
      }),
      action("Restart", "restart", {
        confirm: "Restart this server?",
        success: "Restart requested.",
      }),
      action("Force stop", "hard-stop", {
        confirm: "Cut the power to this server? Unsaved data is lost.",
        success: "Stop requested.",
        danger: true,
      }),
    );
  }
  const plans = parseStash<SizeOption[]>(r, "plans") ?? [];
  actions.push(
    prompt(
      "Change plan…",
      "resize",
      st === "stopped" && plans.length
        ? [
            {
              key: "plan",
              label: "Plan",
              kind: "size-picker",
              required: true,
              sizes: plans,
              defaultValue: plans[0]?.id ?? "",
            },
          ]
        : [],
      st === "stopped" && plans.length
        ? {
            description: `Current plan: ${s(r.fields["plan"])}. The storage is not resized.`,
            submit: "Change plan",
          }
        : {
            description: "Stop the server first: UpCloud changes plans only on a stopped server.",
            blocked: true,
          },
    ),
  );
  actions.push(
    r.fields["firewall"] === true
      ? action("Turn firewall off", "firewall-off", {
          confirm: "Turn the server firewall off? Every port becomes reachable.",
          success: "Firewall off.",
          danger: true,
        })
      : action("Turn firewall on", "firewall-on", {
          confirm:
            "Turn the server firewall on? Make sure a rule allows your own SSH access first.",
          success: "Firewall on.",
        }),
  );
  const storages = parseStash<Array<{ id: string; label: string }>>(r, "storages") ?? [];
  actions.push(
    prompt(
      "Attach storage…",
      "attach-storage",
      [{ key: "storageId", label: "Storage", kind: "select", required: true, options: storages }],
      storages.length
        ? { submit: "Attach" }
        : { description: "There is no detached storage in this zone.", blocked: true },
    ),
  );
  const rules = parseStash<Json[]>(r, "rules") ?? [];
  actions.push(
    prompt(
      "+ Firewall rule",
      "add-rule",
      [
        {
          key: "direction",
          label: "Direction",
          kind: "select",
          required: true,
          defaultValue: "in",
          options: [
            { id: "in", label: "Inbound" },
            { id: "out", label: "Outbound" },
          ],
        },
        {
          key: "action",
          label: "Action",
          kind: "select",
          required: true,
          defaultValue: "accept",
          options: [
            { id: "accept", label: "Accept" },
            { id: "drop", label: "Drop" },
          ],
        },
        {
          key: "family",
          label: "IP Version",
          kind: "select",
          required: true,
          defaultValue: "IPv4",
          options: [
            { id: "IPv4", label: "IPv4" },
            { id: "IPv6", label: "IPv6" },
          ],
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          defaultValue: "tcp",
          options: ["tcp", "udp", "icmp", "any"].map((p) => ({ id: p, label: p.toUpperCase() })),
        },
        {
          key: "port",
          label: "Destination Port",
          kind: "text",
          required: false,
          placeholder: "22 or 8000-9000",
          showWhen: { fieldKey: "protocol", fieldValues: ["tcp", "udp"] },
        },
        {
          key: "source",
          label: "Source Address",
          kind: "text",
          required: false,
          placeholder: "203.0.113.4 or 10.0.0.1-10.0.0.255",
          description: "Leave empty for any",
        },
        { key: "comment", label: "Comment", kind: "text", required: false },
      ],
      {
        description: "Rules are evaluated top to bottom; the new rule is added at the end.",
        submit: "Add rule",
      },
    ),
  );
  const net: KVItem[] = [];
  for (const [key, label] of [
    ["ipv4", "Public IPv4"],
    ["ipv4Private", "Utility IPv4"],
    ["ipv6", "IPv6"],
  ] as const) {
    const v = r.resolvedOutputs[key];
    if (v) net.push({ key: label, value: v, copyable: true });
  }
  const sections: SectionNode[] = [];
  if (net.length) sections.push(section("Networking", [{ kind: "key-value-list", items: net }]));
  sections.push(
    section("Firewall Rules", [
      rules.length
        ? table(
            [
              ["pos", "#"],
              ["dir", "Direction"],
              ["action", "Action"],
              ["proto", "Protocol"],
              ["port", "Port"],
              ["source", "Source"],
              ["comment", "Comment"],
              ["remove", ""],
            ],
            rules.map((ru) => ({
              pos: s(ru["position"]),
              dir: s(ru["direction"]),
              action: s(ru["action"]),
              proto: s(ru["protocol"]) || "any",
              port: s(ru["destination_port_start"])
                ? `${s(ru["destination_port_start"])}${ru["destination_port_end"] && ru["destination_port_end"] !== ru["destination_port_start"] ? `-${s(ru["destination_port_end"])}` : ""}`
                : "any",
              source: s(ru["source_address_start"]) || "any",
              comment: s(ru["comment"]),
              remove: prompt("Remove", "remove-rule", [hidden("position", s(ru["position"]))], {
                description: "Remove this firewall rule?",
                submit: "Remove",
                danger: true,
              }),
            })),
          )
        : {
            kind: "text",
            content:
              r.fields["firewall"] === true
                ? "No rules: the firewall drops everything."
                : "The firewall is off.",
          },
    ]),
  );
  return { actions, sections };
}

function simpleActions(r: ResourceInstance): ActionNode[] {
  switch (r.resourceTypeId) {
    case "storage":
      return [
        r.fields["serverIds"]
          ? action("Detach", "detach", {
              confirm: "Detach this storage? Unmount it first; the server may need to be stopped.",
              success: "Detach requested.",
              danger: true,
            })
          : prompt("Attach…", "attach", [upPicker("serverId", "Server", "server", "serverId")], {
              description: "The server must be in the same zone.",
              submit: "Attach",
            }),
        prompt(
          "Back up now…",
          "backup",
          [
            {
              key: "title",
              label: "Title",
              kind: "text",
              required: true,
              defaultValue: `${s(r.fields["title"])}-${new Date().toISOString().slice(0, 10)}`,
            },
          ],
          { submit: "Back up" },
        ),
        prompt(
          "Clone…",
          "clone",
          [
            {
              key: "title",
              label: "Title",
              kind: "text",
              required: true,
              defaultValue: `${s(r.fields["title"])}-clone`,
            },
            hidden("zone", s(r.fields["region"])),
            {
              key: "tier",
              label: "Tier",
              kind: "select",
              required: false,
              defaultValue: s(r.fields["tier"]),
              options: [
                { id: "maxiops", label: "MaxIOPS" },
                { id: "standard", label: "Standard" },
                { id: "hdd", label: "HDD" },
              ],
            },
          ],
          { submit: "Clone" },
        ),
      ];
    case "backup":
      return [
        action("Restore", "restore", {
          confirm:
            "Restore this backup over its source storage? The storage's current data is replaced; detach it or stop its server first.",
          success: "Restore started.",
          danger: true,
        }),
      ];
    case "floating-ip":
      return r.fields["serverId"]
        ? [
            action("Unassign", "unassign", {
              confirm: "Detach this floating IP from its server?",
              success: "Unassigned.",
              danger: true,
            }),
          ]
        : [
            prompt("Assign…", "assign", [upPicker("serverId", "Server", "server", "serverId")], {
              description: "The server must be in the same zone.",
              submit: "Assign",
            }),
          ];
    case "database": {
      const powered = r.fields["powered"] === true;
      const versions = parseStash<string[]>(r, "versions") ?? [];
      return [
        powered
          ? action("Power off", "power-off", {
              confirm: "Power off this database? It stops serving; storage is still billed.",
              success: "Powering off.",
            })
          : action("Power on", "power-on", { success: "Powering on." }),
        prompt(
          "Upgrade version…",
          "upgrade",
          [
            {
              key: "version",
              label: "Version",
              kind: "select",
              required: true,
              options: versions.map((v) => ({ id: v, label: v })),
            },
          ],
          versions.length
            ? {
                description: "Major version upgrades cannot be rolled back.",
                submit: "Upgrade",
                danger: true,
              }
            : { description: "No upgrade is available.", blocked: true },
        ),
        prompt(
          "Fork…",
          "fork",
          [
            {
              key: "title",
              label: "Title",
              kind: "text",
              required: true,
              defaultValue: `${s(r.fields["title"])}-fork`,
            },
            hidden("zone", s(r.fields["region"])),
            hidden("plan", s(r.fields["plan"])),
            {
              key: "cloneTime",
              label: "Point in Time (UTC)",
              kind: "datetime",
              required: false,
              description: "Leave empty for the latest backup",
            },
          ],
          {
            description: "Creates a new database service from this one's backups.",
            submit: "Fork",
          },
        ),
      ];
    }
    case "kubernetes-cluster": {
      const upgrades = parseStash<string[]>(r, "upgrades") ?? [];
      return [
        prompt(
          "Upgrade Kubernetes…",
          "upgrade",
          [
            {
              key: "version",
              label: "Version",
              kind: "select",
              required: true,
              options: upgrades.map((v) => ({ id: v, label: v })),
            },
          ],
          upgrades.length
            ? { submit: "Upgrade" }
            : { description: "This cluster is on the newest version available.", blocked: true },
        ),
      ];
    }
    case "load-balancer":
      return [
        s(r.fields["configuredStatus"]) === "stopped"
          ? action("Start", "start", { success: "Starting." })
          : action("Stop", "stop", {
              confirm: "Stop this load balancer? It stops serving traffic but is still billed.",
              success: "Stopping.",
            }),
      ];
    default:
      return [];
  }
}

function lbParts(r: ResourceInstance): Parts {
  const lb = parseStash<Json>(r, "lb");
  const ips = parseStash<PolicyOption[]>(r, "ips") ?? [];
  const backends = (lb?.["backends"] as Json[] | undefined) ?? [];
  const frontends = (lb?.["frontends"] as Json[] | undefined) ?? [];
  const rows = backends.flatMap((b) =>
    ((b["members"] as Json[] | undefined) ?? []).map((m) => ({
      backend: s(b["name"]),
      member: s(m["name"]),
      address: `${s(m["ip"])}:${s(m["port"])}`,
      enabled: m["enabled"] === false ? "No" : "Yes",
      remove: prompt(
        "Remove",
        "remove-member",
        [hidden("backend", s(b["name"])), hidden("member", s(m["name"]))],
        {
          description: `Remove ${s(m["name"])} from ${s(b["name"])}?`,
          submit: "Remove",
          danger: true,
        },
      ),
    })),
  );
  return {
    actions: [
      ...simpleActions(r),
      prompt(
        "+ Backend member",
        "add-member",
        [
          {
            key: "backend",
            label: "Backend",
            kind: "select",
            required: true,
            options: backends.map((b) => ({ id: s(b["name"]), label: s(b["name"]) })),
            defaultValue: s(backends[0]?.["name"]),
          },
          {
            key: "ip",
            label: "Server Address",
            kind: "select",
            required: true,
            options: ips.map((i) => ({
              id: i.id,
              label: i.label,
              ...(i.description ? { description: i.description } : {}),
            })),
          },
          { key: "port", label: "Port", kind: "number", required: true, defaultValue: "80" },
          {
            key: "weight",
            label: "Weight",
            kind: "number",
            required: false,
            defaultValue: "100",
            minValue: 0,
            maxValue: 100,
          },
        ],
        backends.length
          ? { submit: "Add" }
          : { description: "This load balancer has no backends yet.", blocked: true },
      ),
    ],
    sections: [
      section("Frontends", [
        table(
          [
            ["name", "Name"],
            ["mode", "Mode"],
            ["port", "Port"],
            ["backend", "Default Backend"],
          ],
          frontends.map((f) => ({
            name: s(f["name"]),
            mode: s(f["mode"]),
            port: s(f["port"]),
            backend: s(f["default_backend"]),
          })),
        ),
      ]),
      section("Backend Members", [
        table(
          [
            ["backend", "Backend"],
            ["member", "Member"],
            ["address", "Address"],
            ["enabled", "Enabled"],
            ["remove", ""],
          ],
          rows,
        ),
      ]),
    ],
  };
}

function nodeGroupParts(r: ResourceInstance): Parts {
  const nodes =
    parseStash<Array<{ name?: string; state?: string; uuid?: string }>>(r, "nodes") ?? [];
  return {
    actions: [],
    sections: nodes.length
      ? [
          section("Nodes", [
            table(
              [
                ["name", "Node"],
                ["state", "State"],
                ["remove", ""],
              ],
              nodes.map((n) => ({
                name: s(n.name),
                state: s(n.state),
                remove: prompt("Remove", "delete-node", [hidden("node", s(n.name))], {
                  description: `Remove ${s(n.name)}? The group shrinks by one node.`,
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

export function renderDetail(
  resource: ResourceInstance,
  types: ResourceTypeDefinition[],
): DetailViewSchema {
  let parts: Parts = { actions: simpleActions(resource), sections: [] };
  if (resource.resourceTypeId === "server") parts = serverParts(resource);
  if (resource.resourceTypeId === "load-balancer") parts = lbParts(resource);
  if (resource.resourceTypeId === "node-group") parts = nodeGroupParts(resource);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(types, resource.resourceTypeId),
      resource.fields["region"],
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
    ...(resource.resourceTypeId === "database" ? { logs: { defaultTailLines: 200 } } : {}),
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
    case "server":
      return [
        { label: "State", value: s(f["state"]), variant },
        { label: "Plan", value: s(f["plan"]) },
        ...(resource.resolvedOutputs["ipv4"]
          ? [{ label: "IPv4", value: resource.resolvedOutputs["ipv4"] }]
          : []),
      ];
    case "database":
      return [
        { label: "State", value: s(f["state"]), variant },
        { label: "Engine", value: `${s(f["type"])} ${s(f["version"])}` },
        { label: "Plan", value: s(f["plan"]) },
      ];
    case "kubernetes-cluster":
      return [
        { label: "Version", value: s(f["version"]) },
        { label: "Nodes", value: s(f["nodeCount"]) },
      ];
    case "account":
      return [{ label: "Credits", value: `${s(f["credits"])} ${s(f["currency"])}` }];
    default:
      return [];
  }
}
