import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledFieldItems,
  resourceTypeDisplayName,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import {
  CONTAINER,
  DNS_ZONE,
  FLOATING_IP,
  IMAGE,
  LB_POOL,
  LOADBALANCER,
  ROUTER,
  SECURITY_GROUP,
  SERVER,
  STACK,
  VOLUME,
  resourceTypes,
} from "./resources.js";

export const ENRICH_KEY = "__openstack";

export type Opt = { id: string; label: string; description?: string };

export interface OpenStackEnrichment {
  flavors?: Opt[];
  freeFloatingIps?: Opt[];
  attachedFloatingIps?: Opt[];
  securityGroups?: Opt[];
  freeVolumes?: Opt[];
  consoleUrl?: string;
  rules?: Opt[];
  subnets?: Opt[];
  externalNetworks?: Opt[];
  members?: Opt[];
  pools?: Opt[];
  stackOutputs?: Opt[];
  stackParameters?: Opt[];
  stackResources?: Opt[];
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function data(r: ResourceInstance): OpenStackEnrichment {
  try {
    return JSON.parse(r.resolvedOutputs[ENRICH_KEY] ?? "{}") as OpenStackEnrichment;
  } catch {
    return {};
  }
}

export function act(
  label: string,
  actionId: string,
  o: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(o.confirm ? { confirmMessage: o.confirm } : {}),
      ...(o.success ? { successMessage: o.success } : {}),
      ...(o.destructive ? { destructive: true } : {}),
    },
    ...(o.danger ? { variant: "danger" as const } : {}),
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
  description?: string,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      fields,
      submitLabel,
      ...(description ? { description } : {}),
    },
  };
}

function pick(
  key: string,
  label: string,
  options: Opt[] | undefined,
  required = true,
): CreateFieldConfig {
  if (options && options.length) {
    return {
      key,
      label,
      kind: "select",
      required,
      options: options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
    };
  }
  return { key, label, kind: "text", required };
}

export const RULE_FIELDS: CreateFieldConfig[] = [
  {
    key: "direction",
    label: "Direction",
    kind: "select",
    required: true,
    defaultValue: "ingress",
    options: [
      { id: "ingress", label: "Ingress" },
      { id: "egress", label: "Egress" },
    ],
  },
  {
    key: "ethertype",
    label: "Ether Type",
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
    required: false,
    defaultValue: "tcp",
    options: [
      { id: "tcp", label: "TCP" },
      { id: "udp", label: "UDP" },
      { id: "icmp", label: "ICMP" },
      { id: "", label: "Any" },
    ],
  },
  {
    key: "portMin",
    label: "Port From",
    kind: "number",
    required: false,
    placeholder: "22",
    minValue: 1,
    maxValue: 65535,
  },
  {
    key: "portMax",
    label: "Port To",
    kind: "number",
    required: false,
    placeholder: "22",
    minValue: 1,
    maxValue: 65535,
  },
  {
    key: "remoteIpPrefix",
    label: "Remote CIDR",
    kind: "text",
    required: false,
    placeholder: "203.0.113.0/24",
    description: "Empty allows any address",
  },
  { key: "description", label: "Description", kind: "text", required: false },
];

export function statusOf(r: ResourceInstance): ResourceStatus {
  const s = str(r.fields["status"] ?? r.fields["provisioningStatus"]).toUpperCase();
  if (!s) return "info";
  if (
    [
      "ACTIVE",
      "AVAILABLE",
      "IN-USE",
      "CREATE_COMPLETE",
      "UPDATE_COMPLETE",
      "RESUME_COMPLETE",
      "CHECK_COMPLETE",
      "DOWN",
    ].includes(s)
  ) {
    return s === "DOWN" && r.resourceTypeId === FLOATING_IP ? "info" : "healthy";
  }
  if (s.includes("ERROR") || s.includes("FAILED")) return "error";
  if (
    ["SHUTOFF", "SHELVED", "SHELVED_OFFLOADED", "SUSPENDED", "PAUSED", "SUSPEND_COMPLETE"].includes(
      s,
    )
  )
    return "unknown";
  if (
    s.includes("PROGRESS") ||
    s.startsWith("PENDING") ||
    [
      "BUILD",
      "REBOOT",
      "HARD_REBOOT",
      "RESIZE",
      "CREATING",
      "DELETING",
      "ATTACHING",
      "DETACHING",
      "EXTENDING",
      "VERIFY_RESIZE",
    ].includes(s)
  ) {
    return "provisioning";
  }
  return "info";
}

export function renderOpenStackSidebar(r: ResourceInstance): SidebarItemSchema {
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    status: { kind: "status-dot", status: statusOf(r) },
  };
}

function details(r: ResourceInstance): SectionNode {
  return {
    kind: "section",
    title: "Details",
    children: [
      {
        kind: "key-value-list",
        items: labeledFieldItems(r.fields, resourceTypes, r.resourceTypeId),
      },
    ],
  };
}

function optTable(
  title: string,
  cols: [string, string, string],
  rows: Opt[],
  rowAction?: (o: Opt) => ActionNode,
): SectionNode {
  return {
    kind: "section",
    title,
    children: [
      {
        kind: "table",
        columns: [
          { key: "id", label: cols[0] },
          { key: "label", label: cols[1] },
          { key: "description", label: cols[2] },
          ...(rowAction ? [{ key: "action", label: "", width: "narrow" as const }] : []),
        ],
        rows: rows.map((o) => ({
          id: o.id,
          cells: {
            id: o.id,
            label: o.label,
            description: o.description ?? "",
            ...(rowAction ? { action: rowAction(o) } : {}),
          },
        })),
      },
    ],
  };
}

function serverActions(r: ResourceInstance, d: OpenStackEnrichment): ActionNode[] {
  const s = str(r.fields["status"]);
  const a: ActionNode[] = [];
  if (s === "SHUTOFF") a.push(act("Start", "start", { success: "Start requested." }));
  if (s === "ACTIVE") {
    a.push(
      act("Stop", "stop", { confirm: "Stop this server?", success: "Stop requested." }),
      act("Reboot", "reboot-soft", {
        confirm: "Soft-reboot this server?",
        success: "Reboot requested.",
      }),
      act("Hard reboot", "reboot-hard", {
        confirm: "Hard-reboot this server? Like pulling the power cord.",
        success: "Hard reboot requested.",
        danger: true,
      }),
      act("Pause", "pause", { success: "Pause requested." }),
      act("Suspend", "suspend", { success: "Suspend requested." }),
    );
    if (d.consoleUrl)
      a.push({
        kind: "action",
        label: "Open console",
        action: { type: "open-url", url: d.consoleUrl },
      });
  }
  if (s === "PAUSED") a.push(act("Unpause", "unpause", { success: "Unpause requested." }));
  if (s === "SUSPENDED") a.push(act("Resume", "resume", { success: "Resume requested." }));
  if (s === "ACTIVE" || s === "SHUTOFF") {
    a.push(
      act("Shelve", "shelve", {
        confirm: "Shelve this server? It is snapshotted and its compute resources are released.",
        success: "Shelve requested.",
      }),
    );
  }
  if (s === "SHELVED" || s === "SHELVED_OFFLOADED")
    a.push(act("Unshelve", "unshelve", { success: "Unshelve requested." }));
  if (s === "VERIFY_RESIZE") {
    a.push(
      act("Confirm resize", "confirm-resize", { success: "Resize confirmed." }),
      act("Revert resize", "revert-resize", {
        confirm: "Return to the previous flavor?",
        success: "Revert requested.",
      }),
    );
  }
  if (s === "ACTIVE" || s === "SHUTOFF") {
    a.push(
      prompt(
        "Resize…",
        "resize",
        "Resize server",
        [pick("flavorRef", "New Flavor", d.flavors)],
        "Resize",
        "The server moves to VERIFY_RESIZE; confirm or revert afterwards.",
      ),
      prompt(
        "Create image…",
        "create-image",
        "Snapshot to an image",
        [
          {
            key: "name",
            label: "Image Name",
            kind: "text",
            required: true,
            defaultValue: `${str(r.fields["name"])}-${new Date().toISOString().slice(0, 10)}`,
          },
        ],
        "Create image",
      ),
    );
  }
  if (d.freeFloatingIps?.length)
    a.push(
      prompt(
        "Associate floating IP…",
        "fip-associate",
        "Associate floating IP",
        [pick("floatingIpId", "Floating IP", d.freeFloatingIps)],
        "Associate",
      ),
    );
  for (const ip of d.attachedFloatingIps ?? []) {
    a.push(
      act(`Disassociate ${ip.label}`, `fip-disassociate:${ip.id}`, {
        confirm: `Remove ${ip.label} from this server?`,
        success: "Disassociated.",
      }),
    );
  }
  if (d.freeVolumes?.length)
    a.push(
      prompt(
        "Attach volume…",
        "attach-volume",
        "Attach volume",
        [pick("volumeId", "Volume", d.freeVolumes)],
        "Attach",
      ),
    );
  if (d.securityGroups?.length) {
    a.push(
      prompt(
        "Add security group…",
        "add-sg",
        "Add security group",
        [pick("name", "Security Group", d.securityGroups)],
        "Add",
      ),
      prompt(
        "Remove security group…",
        "remove-sg",
        "Remove security group",
        [
          pick(
            "name",
            "Security Group",
            str(r.fields["securityGroups"])
              .split(", ")
              .filter(Boolean)
              .map((n) => ({ id: n, label: n })),
          ),
        ],
        "Remove",
      ),
    );
  }
  a.push(
    r.fields["locked"] === true
      ? act("Unlock", "unlock", { success: "Unlocked." })
      : act("Lock", "lock", { success: "Locked." }),
  );
  return a;
}

export function renderOpenStackDetail(r: ResourceInstance): DetailViewSchema {
  const d = data(r);
  const f = r.fields;
  const t = r.resourceTypeId;
  const typeName = resourceTypeDisplayName(resourceTypes, t);
  const refresh: ActionNode = {
    kind: "action",
    label: "Refresh",
    action: { type: "refresh-resource" },
  };
  let schema: DetailViewSchema = {
    title: r.displayName || typeName,
    subtitle: typeName,
    status: { kind: "status-dot", status: statusOf(r) },
    sections: [details(r)],
    headerActions: [refresh],
  };

  if (t === SERVER) {
    const conn = ["publicIp", "privateIp"]
      .filter((k) => r.resolvedOutputs[k])
      .map((k) => ({
        key: k === "publicIp" ? "Public IP" : "Private IP",
        value: r.resolvedOutputs[k] as string,
        copyable: true,
      }));
    schema = {
      ...schema,
      subtitle: joinSubtitle(typeName, f["flavor"], f["availabilityZone"]),
      sections: [
        details(r),
        ...(conn.length
          ? [
              {
                kind: "section" as const,
                title: "Addresses",
                children: [{ kind: "key-value-list" as const, items: conn }],
              },
            ]
          : []),
      ],
      headerActions: [...serverActions(r, d), refresh],
      logs: { defaultTailLines: 200 },
    };
  } else if (t === VOLUME) {
    const attached = !!f["serverId"];
    schema.headerActions = [
      prompt(
        "Extend…",
        "extend",
        "Extend volume",
        [
          {
            key: "newSize",
            label: "New Size (GiB)",
            kind: "number",
            required: true,
            defaultValue: String(Number(f["sizeGb"] ?? 1) + 10),
            minValue: Number(f["sizeGb"] ?? 1) + 1,
          },
        ],
        "Extend",
      ),
      prompt(
        "Snapshot…",
        "snapshot",
        "Snapshot volume",
        [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            defaultValue: `${str(f["name"]) || "vol"}-${new Date().toISOString().slice(0, 10)}`,
          },
          {
            key: "force",
            label: "Snapshot while attached",
            kind: "select",
            required: false,
            defaultValue: attached ? "true" : "false",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
          },
        ],
        "Snapshot",
      ),
      prompt(
        "Back up…",
        "backup",
        "Back up volume",
        [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            defaultValue: `${str(f["name"]) || "vol"}-backup`,
          },
          {
            key: "incremental",
            label: "Incremental",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
          },
        ],
        "Back up",
        "Needs the Cinder backup service.",
      ),
      ...(attached
        ? [
            act("Detach", "detach", {
              confirm: "Detach this volume from its server? Unmount it in the guest first.",
              success: "Detach requested.",
              danger: true,
            }),
          ]
        : []),
      refresh,
    ];
  } else if (t === SECURITY_GROUP) {
    schema.sections = [
      details(r),
      ...(d.rules
        ? [
            optTable("Rules", ["Rule ID", "Rule", "Description"], d.rules, (o) =>
              act("Delete", `rule-delete:${o.id}`, {
                confirm: `Delete rule "${o.label}"?`,
                success: "Rule deleted.",
                danger: true,
                destructive: true,
              }),
            ),
          ]
        : []),
    ];
    schema.headerActions = [
      prompt("Add rule…", "rule-add", "Add security group rule", RULE_FIELDS, "Add rule"),
      refresh,
    ];
  } else if (t === ROUTER) {
    const ifaces = str(f["subnetIds"]).split(", ").filter(Boolean);
    schema.headerActions = [
      prompt(
        "Add interface…",
        "router-add-interface",
        "Connect a subnet",
        [pick("subnetId", "Subnet", d.subnets)],
        "Connect",
      ),
      ...(ifaces.length
        ? [
            prompt(
              "Remove interface…",
              "router-remove-interface",
              "Disconnect a subnet",
              [
                pick(
                  "subnetId",
                  "Subnet",
                  d.subnets?.filter((s) => ifaces.includes(s.id)) ??
                    ifaces.map((i) => ({ id: i, label: i })),
                ),
              ],
              "Disconnect",
            ),
          ]
        : []),
      prompt(
        "Set gateway…",
        "router-gateway",
        "Set external gateway",
        [
          {
            ...pick("networkId", "External Network", d.externalNetworks, false),
            ...(d.externalNetworks?.length
              ? {
                  options: [
                    { id: "", label: "None (clear gateway)" },
                    ...d.externalNetworks.map((n) => ({ id: n.id, label: n.label })),
                  ],
                }
              : {}),
          },
        ],
        "Save",
      ),
      refresh,
    ];
  } else if (t === FLOATING_IP) {
    schema.headerActions = [
      ...(f["portId"]
        ? [
            act("Disassociate", "disassociate", {
              confirm: "Disassociate this floating IP?",
              success: "Disassociated.",
            }),
          ]
        : []),
      refresh,
    ];
  } else if (t === LOADBALANCER) {
    schema.headerActions = [
      act("Failover", "failover", {
        confirm: "Fail the load balancer over to new amphorae?",
        success: "Failover requested.",
      }),
      refresh,
    ];
  } else if (t === LB_POOL) {
    schema.sections = [
      details(r),
      ...(d.members
        ? [
            optTable("Members", ["Member ID", "Address", "Status"], d.members, (o) =>
              act("Remove", `member-delete:${o.id}`, {
                confirm: `Remove member ${o.label}?`,
                success: "Member removed.",
                danger: true,
              }),
            ),
          ]
        : []),
    ];
    schema.headerActions = [
      prompt(
        "Add member…",
        "member-add",
        "Add pool member",
        [
          {
            key: "address",
            label: "Address",
            kind: "text",
            required: true,
            placeholder: "10.0.0.12",
          },
          {
            key: "port",
            label: "Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          {
            ...pick("subnetId", "Subnet", d.subnets, false),
            description: "Subnet the member is reached on",
          },
          {
            key: "weight",
            label: "Weight",
            kind: "number",
            required: false,
            defaultValue: "1",
            minValue: 0,
            maxValue: 256,
          },
        ],
        "Add",
      ),
      refresh,
    ];
  } else if (t === CONTAINER) {
    schema = { ...schema, storageBrowser: { bucketName: str(f["name"]) || str(r.externalId) } };
  } else if (t === STACK) {
    const st = str(f["status"]);
    schema.sections = [
      details(r),
      ...(d.stackOutputs?.length
        ? [optTable("Outputs", ["Output", "Value", "Description"], d.stackOutputs)]
        : []),
      ...(d.stackParameters?.length
        ? [optTable("Parameters", ["Parameter", "Value", ""], d.stackParameters)]
        : []),
      ...(d.stackResources?.length
        ? [optTable("Resources", ["Resource", "Type", "Status"], d.stackResources)]
        : []),
    ];
    schema.headerActions = [
      ...(st.startsWith("SUSPEND")
        ? [act("Resume", "stack-resume", { success: "Resume requested." })]
        : [
            act("Suspend", "stack-suspend", {
              confirm: "Suspend every resource in this stack?",
              success: "Suspend requested.",
            }),
          ]),
      act("Check", "stack-check", { success: "Check requested." }),
      ...(st === "UPDATE_IN_PROGRESS"
        ? [
            act("Cancel update", "stack-cancel-update", {
              confirm: "Cancel the running update and roll back?",
              success: "Cancel requested.",
              danger: true,
            }),
          ]
        : []),
      refresh,
    ];
    schema.logs = { defaultTailLines: 200 };
  } else if (t === DNS_ZONE || t === IMAGE) {
    schema.subtitle = joinSubtitle(typeName, f["status"]);
  }
  return withMetricsCapability(schema, resourceTypes, t, 3_600_000);
}
