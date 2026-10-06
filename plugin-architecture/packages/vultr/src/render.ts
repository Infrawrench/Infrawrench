/**
 * Detail views, sidebar items and dashboard stats. `enrichDetail` stashes the
 * extra reads as JSON in `resolvedOutputs.__name__`; everything here is
 * synchronous over that.
 */

import type {
  ActionNode,
  CreateFieldConfig,
  DashboardStat,
  DetailViewSchema,
  ImageOption,
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
import { ENGINE_LABELS, maintenanceFields } from "./create.js";
import { regionLabel } from "./regions.js";
import type {
  VultrFirewallRule,
  VultrInvoiceItem,
  VultrLoadBalancer,
  VultrNodePool,
  VultrVpcAttachment,
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

export function statusFor(resource: ResourceInstance): ResourceStatus {
  const st = s(resource.fields["status"]).toLowerCase();
  const power = s(resource.fields["powerStatus"]).toLowerCase();
  switch (resource.resourceTypeId) {
    case "instance":
    case "bare-metal":
      if (st === "pending" || st === "resizing") return "provisioning";
      if (st === "suspended") return "error";
      if (power === "stopped") return "error";
      if (power === "running") {
        const server = s(resource.fields["serverStatus"]).toLowerCase();
        return server && server !== "ok" ? "provisioning" : "healthy";
      }
      return "unknown";
    case "block-storage":
      if (st === "active") return resource.fields["attachedInstanceId"] ? "healthy" : "info";
      return st ? "provisioning" : "unknown";
    case "kubernetes-cluster":
    case "database":
    case "load-balancer":
    case "object-storage":
    case "node-pool":
      if (["active", "running"].includes(st)) return "healthy";
      if (["pending", "rebuilding", "rebalancing", "configuring"].includes(st))
        return "provisioning";
      if (["error", "failed"].includes(st)) return "error";
      return st ? "degraded" : "unknown";
    case "snapshot":
    case "backup":
      return st === "complete" ? "healthy" : st ? "provisioning" : "info";
    case "reserved-ip":
      return resource.fields["instanceId"] ? "healthy" : "info";
    case "firewall-group":
      return s(resource.fields["openToWorld"]) ? "degraded" : "healthy";
    default:
      return "info";
  }
}

const HIDDEN_FIELDS: Record<string, string[]> = {
  "startup-script": ["script"],
  "ssh-key": ["publicKey"],
};

function detailItems(resource: ResourceInstance, types: ResourceTypeDefinition[]): KVItem[] {
  const hidden = new Set(HIDDEN_FIELDS[resource.resourceTypeId] ?? []);
  const fields = Object.fromEntries(
    Object.entries(resource.fields).filter(([k]) => !hidden.has(k)),
  );
  return labeledFieldItems(fields, types, resource.resourceTypeId).map((item) =>
    item.key === "Region" && item.value
      ? { ...item, value: `${regionLabel(String(item.value))} (${String(item.value)})` }
      : item,
  );
}

export const action = (
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
): ActionNode => ({
  kind: "action",
  label,
  action: {
    type: "plugin-action",
    actionId,
    ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
    ...(opts.success ? { successMessage: opts.success } : {}),
    ...(opts.destructive ? { destructive: true } : {}),
  },
  ...(opts.danger ? { variant: "danger" as const } : {}),
});

export const prompt = (
  label: string,
  command: string,
  fields: CreateFieldConfig[],
  opts: {
    title?: string;
    description?: string;
    submit?: string;
    danger?: boolean;
    blocked?: boolean;
  } = {},
): ActionNode => ({
  kind: "action",
  label,
  action: {
    type: "prompt-nosql-command",
    command,
    title: opts.title ?? label.replace(/…$/, ""),
    fields,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.submit ? { submitLabel: opts.submit } : {}),
    ...(opts.danger ? { danger: true } : {}),
    ...(opts.blocked ? { blocked: true, descriptionVariant: "error" as const } : {}),
  },
  ...(opts.danger ? { variant: "danger" as const } : {}),
});

const hiddenField = (key: string, value: string): CreateFieldConfig => ({
  key,
  label: key,
  kind: "text",
  required: true,
  defaultValue: value,
  hidden: true,
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
const money = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`;
const yesNoOptions = [
  { id: "true", label: "Yes" },
  { id: "false", label: "No" },
];

interface Parts {
  actions: ActionNode[];
  sections: SectionNode[];
}

function instanceParts(r: ResourceInstance): Parts {
  const power = s(r.fields["powerStatus"]);
  const actions: ActionNode[] = [];
  if (power === "stopped") actions.push(action("Start", "start", { success: "Start requested." }));
  if (power === "running") {
    actions.push(
      action("Stop", "halt", {
        confirm:
          "Stop this instance? Vultr keeps billing a stopped instance; only destroying it stops the charges.",
        success: "Stop requested.",
      }),
      action("Reboot", "reboot", {
        confirm: "Reboot this instance?",
        success: "Reboot requested.",
      }),
    );
  }
  const plans = parseStash<SizeOption[]>(r, "resizePlans") ?? [];
  actions.push(
    prompt(
      "Upgrade plan…",
      "resize",
      plans.length
        ? [
            {
              key: "plan",
              label: "New Plan",
              kind: "size-picker",
              required: true,
              sizes: plans,
              defaultValue: plans[0]?.id ?? "",
            },
          ]
        : [],
      plans.length
        ? {
            description: `Current plan: ${s(r.fields["plan"])}. Vultr restarts the instance and only moves to plans with at least as much disk; you cannot downgrade.`,
            submit: "Upgrade",
          }
        : {
            description: "Vultr offers no larger plan for this instance in its region.",
            blocked: true,
          },
    ),
  );
  actions.push(
    prompt(
      "Firewall group…",
      "set-firewall",
      [
        {
          key: "firewallGroupId",
          label: "Firewall Group",
          kind: "resource-picker",
          required: false,
          associationSources: [
            { pluginId: "vultr", resourceTypeId: "firewall-group", outputKey: "firewallGroupId" },
          ],
          description: "Leave empty to remove the current firewall group",
        },
      ],
      { submit: "Apply" },
    ),
  );
  actions.push(
    prompt(
      "Take snapshot…",
      "snapshot",
      [
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
          defaultValue: `${s(r.fields["label"]) || "instance"}-${new Date().toISOString().slice(0, 10)}`,
        },
      ],
      { description: "Snapshots are billed per GB stored.", submit: "Take snapshot" },
    ),
  );
  const backups = parseStash<Array<{ id: string; label: string }>>(r, "backups") ?? [];
  const snapshots = parseStash<Array<{ id: string; label: string }>>(r, "snapshots") ?? [];
  const restoreOptions = [
    ...backups.map((b) => ({ id: `backup:${b.id}`, label: `Backup: ${b.label}` })),
    ...snapshots.map((x) => ({ id: `snapshot:${x.id}`, label: `Snapshot: ${x.label}` })),
  ];
  actions.push(
    prompt(
      "Restore…",
      "restore",
      [
        {
          key: "source",
          label: "Restore From",
          kind: "select",
          required: true,
          options: restoreOptions,
        },
      ],
      restoreOptions.length
        ? {
            description:
              "DESTRUCTIVE: the instance's disk is replaced with the backup or snapshot.",
            submit: "Restore",
            danger: true,
          }
        : { description: "There are no backups or snapshots to restore from yet.", blocked: true },
    ),
  );
  const images = parseStash<ImageOption[]>(r, "images") ?? [];
  if (images.length) {
    actions.push(
      prompt(
        "Rebuild with another image…",
        "rebuild",
        [{ key: "image", label: "Image", kind: "image-picker", required: true, images }],
        {
          description:
            "DESTRUCTIVE: the disk is erased and the instance is reinstalled from the image. The IP addresses are kept.",
          submit: "Rebuild",
          danger: true,
        },
      ),
    );
  }
  actions.push(
    prompt(
      "Reinstall…",
      "reinstall",
      [
        {
          key: "hostname",
          label: "Hostname",
          kind: "text",
          required: false,
          defaultValue: s(r.fields["hostname"]),
        },
      ],
      {
        description:
          "DESTRUCTIVE: reinstalls the current operating system and erases all data on the disk.",
        submit: "Reinstall",
        danger: true,
      },
    ),
  );
  const schedule = parseStash<Record<string, unknown>>(r, "backupSchedule");
  if (r.fields["backupsEnabled"] === true) {
    actions.push(
      prompt(
        "Backup schedule…",
        "backup-schedule",
        [
          {
            key: "type",
            label: "Frequency",
            kind: "select",
            required: true,
            defaultValue: s(schedule?.["type"]) || "daily",
            options: [
              { id: "daily", label: "Daily" },
              { id: "weekly", label: "Weekly" },
              { id: "monthly", label: "Monthly" },
              { id: "daily_alt_even", label: "Every other day (even days)" },
              { id: "daily_alt_odd", label: "Every other day (odd days)" },
            ],
          },
          {
            key: "hour",
            label: "Hour (UTC)",
            kind: "number",
            required: false,
            minValue: 0,
            maxValue: 23,
            defaultValue: s(schedule?.["hour"]) || "0",
          },
          {
            key: "dow",
            label: "Day of Week",
            kind: "select",
            required: false,
            defaultValue: s(schedule?.["dow"]) || "1",
            options: [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ].map((d, i) => ({ id: String(i + 1), label: d })),
            showWhen: { fieldKey: "type", fieldValue: "weekly" },
          },
          {
            key: "dom",
            label: "Day of Month",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 28,
            defaultValue: s(schedule?.["dom"]) || "1",
            showWhen: { fieldKey: "type", fieldValue: "monthly" },
          },
        ],
        { submit: "Save schedule" },
      ),
    );
  }
  const regionVpcs = parseStash<Array<{ id: string; label: string }>>(r, "regionVpcs") ?? [];
  actions.push(
    prompt(
      "Attach VPC…",
      "attach-vpc",
      [{ key: "vpcId", label: "VPC", kind: "select", required: true, options: regionVpcs }],
      regionVpcs.length
        ? { submit: "Attach" }
        : { description: "There is no VPC in this instance's region yet.", blocked: true },
    ),
  );

  const sections: SectionNode[] = [];
  const net: KVItem[] = [];
  for (const [key, label] of [
    ["ipv4", "Public IPv4"],
    ["ipv4Private", "Private IPv4"],
    ["ipv6", "IPv6"],
  ] as const) {
    const v = r.resolvedOutputs[key];
    if (v) net.push({ key: label, value: v, copyable: true });
  }
  if (net.length) sections.push(section("Networking", [{ kind: "key-value-list", items: net }]));
  const vpcs = parseStash<Array<{ id: string; name: string; ip: string }>>(r, "vpcs");
  if (vpcs && vpcs.length) {
    sections.push(
      section("VPCs", [
        table(
          [
            ["name", "VPC"],
            ["ip", "Private IP"],
            ["detach", ""],
          ],
          vpcs.map((v) => ({
            name: v.name,
            ip: v.ip,
            detach: prompt("Detach", "detach-vpc", [hiddenField("vpcId", v.id)], {
              description: `Detach ${v.name} from this instance? Traffic over the private network stops.`,
              submit: "Detach",
              danger: true,
            }),
          })),
        ),
      ]),
    );
  }
  if (schedule && r.fields["backupsEnabled"] === true) {
    sections.push(
      section("Backup Schedule", [
        {
          kind: "key-value-list",
          items: [
            { key: "Frequency", value: s(schedule["type"]) },
            { key: "Next Backup (UTC)", value: s(schedule["next_scheduled_time_utc"]) },
          ].filter((i) => i.value),
        },
      ]),
    );
  }
  return { actions, sections };
}

function firewallParts(r: ResourceInstance): Parts {
  const rules = parseStash<VultrFirewallRule[]>(r, "rules") ?? [];
  const actions = [
    prompt(
      "+ Rule",
      "add-rule",
      [
        {
          key: "ipType",
          label: "IP Version",
          kind: "select",
          required: true,
          defaultValue: "v4",
          options: [
            { id: "v4", label: "IPv4" },
            { id: "v6", label: "IPv6" },
          ],
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          defaultValue: "tcp",
          options: ["tcp", "udp", "icmp", "gre", "esp", "ah"].map((p) => ({
            id: p,
            label: p.toUpperCase(),
          })),
        },
        {
          key: "port",
          label: "Port",
          kind: "text",
          required: false,
          placeholder: "22 or 8000:9000",
          showWhen: { fieldKey: "protocol", fieldValues: ["tcp", "udp"] },
        },
        {
          key: "source",
          label: "Source",
          kind: "select",
          required: true,
          defaultValue: "anywhere",
          options: [
            { id: "anywhere", label: "Anywhere" },
            { id: "cidr", label: "A specific address or range" },
            { id: "cloudflare", label: "Cloudflare's IP ranges" },
          ],
        },
        {
          key: "cidr",
          label: "Address or Range",
          kind: "text",
          required: false,
          placeholder: "203.0.113.0/24",
          showWhen: { fieldKey: "source", fieldValue: "cidr" },
        },
        { key: "notes", label: "Notes", kind: "text", required: false },
      ],
      {
        description: "Vultr firewall rules allow traffic; anything no rule allows is dropped.",
        submit: "Add rule",
      },
    ),
  ];
  const rows = rules.map((ru) => ({
    proto: s(ru.protocol).toUpperCase(),
    port: s(ru.port) || "all",
    source:
      ru.source === "cloudflare"
        ? "Cloudflare"
        : `${s(ru.subnet)}/${s(ru.subnet_size)}${ru.ip_type ? ` (${ru.ip_type})` : ""}`,
    notes: s(ru.notes),
    remove: prompt("Remove", "remove-rule", [hiddenField("ruleId", String(ru.id))], {
      description: `Remove the ${s(ru.protocol).toUpperCase()} ${s(ru.port) || ""} rule? Matching traffic is dropped immediately.`,
      submit: "Remove",
      danger: true,
    }),
  }));
  return {
    actions,
    sections: [
      section("Inbound Rules", [
        rows.length
          ? table(
              [
                ["proto", "Protocol"],
                ["port", "Port"],
                ["source", "Source"],
                ["notes", "Notes"],
                ["remove", ""],
              ],
              rows,
            )
          : { kind: "text", content: "No rules: all inbound traffic is dropped." },
      ]),
    ],
  };
}

function loadBalancerParts(r: ResourceInstance): Parts {
  const lb = parseStash<VultrLoadBalancer>(r, "lb");
  const instanceOptions = parseStash<PolicyOption[]>(r, "instanceOptions") ?? [];
  const protoOptions = ["http", "https", "tcp"].map((p) => ({ id: p, label: p.toUpperCase() }));
  const actions: ActionNode[] = [
    prompt(
      "+ Forwarding rule",
      "add-forwarding-rule",
      [
        {
          key: "frontendProtocol",
          label: "Frontend Protocol",
          kind: "select",
          required: true,
          defaultValue: "https",
          options: protoOptions,
        },
        {
          key: "frontendPort",
          label: "Frontend Port",
          kind: "number",
          required: true,
          defaultValue: "443",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "backendProtocol",
          label: "Backend Protocol",
          kind: "select",
          required: true,
          defaultValue: "http",
          options: protoOptions,
        },
        {
          key: "backendPort",
          label: "Backend Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          minValue: 1,
          maxValue: 65535,
        },
      ],
      { submit: "Add rule" },
    ),
    prompt(
      "Backends…",
      "set-backends",
      [
        {
          key: "instances",
          label: "Backend Instances",
          kind: "policy-picker",
          required: false,
          policies: instanceOptions,
          defaultValue: JSON.stringify(lb?.instances ?? []),
        },
      ],
      { description: "Pick every instance that should receive traffic.", submit: "Save" },
    ),
    prompt(
      "Health check…",
      "health-check",
      [
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          defaultValue: lb?.health_check?.protocol ?? "http",
          options: protoOptions,
        },
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          defaultValue: s(lb?.health_check?.port ?? 80),
        },
        {
          key: "path",
          label: "Path",
          kind: "text",
          required: false,
          defaultValue: lb?.health_check?.path ?? "/",
        },
        {
          key: "checkInterval",
          label: "Interval (s)",
          kind: "number",
          required: false,
          defaultValue: s(lb?.health_check?.check_interval ?? 15),
        },
        {
          key: "responseTimeout",
          label: "Timeout (s)",
          kind: "number",
          required: false,
          defaultValue: s(lb?.health_check?.response_timeout ?? 5),
        },
        {
          key: "unhealthyThreshold",
          label: "Unhealthy Threshold",
          kind: "number",
          required: false,
          defaultValue: s(lb?.health_check?.unhealthy_threshold ?? 5),
        },
        {
          key: "healthyThreshold",
          label: "Healthy Threshold",
          kind: "number",
          required: false,
          defaultValue: s(lb?.health_check?.healthy_threshold ?? 5),
        },
      ],
      { submit: "Save" },
    ),
    prompt(
      "+ Firewall rule",
      "add-lb-firewall-rule",
      [
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 65535,
          defaultValue: "443",
        },
        {
          key: "ipType",
          label: "IP Version",
          kind: "select",
          required: true,
          defaultValue: "v4",
          options: [
            { id: "v4", label: "IPv4" },
            { id: "v6", label: "IPv6" },
          ],
        },
        {
          key: "source",
          label: "Source",
          kind: "text",
          required: true,
          placeholder: "0.0.0.0/0 or cloudflare",
        },
      ],
      {
        description:
          "Once any firewall rule exists, only listed sources can reach the load balancer.",
        submit: "Add rule",
      },
    ),
    prompt(
      "SSL certificate…",
      "set-ssl",
      [
        {
          key: "certificate",
          label: "Certificate (PEM)",
          kind: "text",
          multiline: true,
          required: true,
        },
        { key: "privateKey", label: "Private Key (PEM)", kind: "password", required: true },
        { key: "chain", label: "Chain (PEM)", kind: "text", multiline: true, required: false },
      ],
      { submit: "Upload" },
    ),
  ];
  if (r.fields["hasSsl"] === true) {
    actions.push(
      action("Remove SSL", "remove-ssl", {
        confirm: "Remove the SSL certificate? HTTPS forwarding rules stop working.",
        success: "Certificate removed.",
        danger: true,
      }),
    );
  }
  const sections: SectionNode[] = [];
  const rules = lb?.forwarding_rules ?? [];
  sections.push(
    section("Forwarding Rules", [
      table(
        [
          ["front", "Frontend"],
          ["back", "Backend"],
          ["remove", ""],
        ],
        rules.map((ru) => ({
          front: `${s(ru.frontend_protocol).toUpperCase()} :${s(ru.frontend_port)}`,
          back: `${s(ru.backend_protocol).toUpperCase()} :${s(ru.backend_port)}`,
          remove: prompt("Remove", "remove-forwarding-rule", [hiddenField("ruleId", s(ru.id))], {
            description: "Remove this forwarding rule? The port stops accepting traffic.",
            submit: "Remove",
            danger: true,
          }),
        })),
      ),
    ]),
  );
  const labels = new Map(instanceOptions.map((i) => [i.id, i.label]));
  if ((lb?.instances ?? []).length) {
    sections.push(
      section("Backends", [
        table(
          [["name", "Instance"]],
          (lb?.instances ?? []).map((id) => ({ name: labels.get(id) ?? id })),
        ),
      ]),
    );
  }
  const fw = lb?.firewall_rules ?? [];
  if (fw.length) {
    sections.push(
      section("Firewall Rules", [
        table(
          [
            ["port", "Port"],
            ["source", "Source"],
            ["type", "IP"],
            ["remove", ""],
          ],
          fw.map((ru) => ({
            port: s(ru.port),
            source: s(ru.source),
            type: s(ru.ip_type),
            remove: prompt("Remove", "remove-lb-firewall-rule", [hiddenField("ruleId", s(ru.id))], {
              description: "Remove this firewall rule?",
              submit: "Remove",
              danger: true,
            }),
          })),
        ),
      ]),
    );
  }
  return { actions, sections };
}

function clusterParts(r: ResourceInstance): Parts {
  const upgrades = parseStash<string[]>(r, "upgrades") ?? [];
  const actions: ActionNode[] = [
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
          defaultValue: upgrades[0] ?? "",
        },
      ],
      upgrades.length
        ? {
            description: "Vultr upgrades the control plane, then replaces the nodes one at a time.",
            submit: "Upgrade",
          }
        : { description: "This cluster is on the newest version Vultr offers.", blocked: true },
    ),
    prompt("Delete with linked resources…", "delete-with-linked", [], {
      description:
        "DESTRUCTIVE: deletes the cluster together with the load balancers and block storage volumes Kubernetes created for it.",
      submit: "Delete everything",
      danger: true,
    }),
  ];
  return { actions, sections: [] };
}

function nodePoolParts(r: ResourceInstance): Parts {
  const nodes = parseStash<VultrNodePool["nodes"]>(r, "nodes") ?? [];
  return {
    actions: [],
    sections: nodes.length
      ? [
          section("Nodes", [
            table(
              [
                ["label", "Node"],
                ["status", "Status"],
                ["ip", "IP"],
                ["recycle", ""],
                ["remove", ""],
              ],
              nodes.map((n) => ({
                label: s(n.label) || n.id,
                status: s(n.status),
                ip: s(n.ip),
                recycle: prompt("Recycle", "recycle-node", [hiddenField("nodeId", n.id)], {
                  description: `Destroy ${s(n.label) || n.id} and deploy a fresh node in its place?`,
                  submit: "Recycle",
                }),
                remove: prompt("Remove", "delete-node", [hiddenField("nodeId", n.id)], {
                  description: `Remove ${s(n.label) || n.id} from the pool? The pool shrinks by one node.`,
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
  const versions = parseStash<string[]>(r, "versions") ?? [];
  const plans = parseStash<SizeOption[]>(r, "plans") ?? [];
  const usage = parseStash<Record<string, Record<string, number>>>(r, "usage");
  const backups = parseStash<{
    latest_backup?: { date?: string; time?: string };
    oldest_backup?: { date?: string; time?: string };
  }>(r, "backups");
  const engine = s(r.fields["engine"]);
  const actions: ActionNode[] = [
    prompt(
      "Upgrade version…",
      "upgrade-version",
      [
        {
          key: "version",
          label: "Version",
          kind: "select",
          required: true,
          options: versions.map((v) => ({ id: v, label: v })),
          defaultValue: versions[0] ?? "",
        },
      ],
      versions.length
        ? {
            description: "Major version upgrades cannot be rolled back.",
            submit: "Upgrade",
            danger: true,
          }
        : { description: "No newer engine version is available for this cluster.", blocked: true },
    ),
    action("Start maintenance", "maintenance", {
      confirm: "Apply pending maintenance updates now? Expect a brief interruption.",
      success: "Maintenance started.",
    }),
  ];
  if (engine !== "kafka") {
    const backupFields: CreateFieldConfig[] = [
      {
        key: "label",
        label: "New Database Label",
        kind: "text",
        required: true,
        defaultValue: `${s(r.fields["label"])}-restore`,
      },
      {
        key: "type",
        label: "Restore Point",
        kind: "select",
        required: true,
        defaultValue: "latest",
        options: [
          { id: "latest", label: "Latest backup" },
          { id: "pitr", label: "Point in time" },
        ],
      },
      {
        key: "date",
        label: "Date",
        kind: "datetime",
        datetimeMode: "date",
        required: false,
        showWhen: { fieldKey: "type", fieldValue: "pitr" },
      },
      {
        key: "time",
        label: "Time (UTC, HH:MM:SS)",
        kind: "text",
        required: false,
        placeholder: "13:45:00",
        showWhen: { fieldKey: "type", fieldValue: "pitr" },
      },
    ];
    actions.push(
      prompt("Restore to new database…", "restore", backupFields, {
        description:
          "Creates a new database of the same plan from a backup; this one is untouched.",
        submit: "Restore",
      }),
      prompt(
        "Fork…",
        "fork",
        [
          ...backupFields,
          hiddenField("region", s(r.fields["region"])),
          {
            key: "plan",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes: plans,
            defaultValue: s(r.fields["plan"]),
          },
        ],
        {
          description: "Creates a new database on any plan from a backup of this one.",
          submit: "Fork",
        },
      ),
      prompt(
        "Add read replica…",
        "read-replica",
        [
          {
            key: "label",
            label: "Replica Label",
            kind: "text",
            required: true,
            defaultValue: `${s(r.fields["label"])}-replica`,
          },
        ],
        {
          description: "The replica is billed like a separate database on the same plan.",
          submit: "Create replica",
        },
      ),
    );
  }
  if (plans.length) {
    actions.push(
      prompt(
        "Change plan…",
        "change-plan",
        [
          {
            key: "plan",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes: plans,
            defaultValue: s(r.fields["plan"]),
          },
        ],
        { description: "Vultr resizes the cluster in place.", submit: "Change plan" },
      ),
    );
  }
  actions.push(
    prompt(
      "Maintenance window…",
      "maintenance-window",
      maintenanceFields({
        dow: s(r.fields["maintenanceDow"]),
        time: s(r.fields["maintenanceTime"]),
      }),
      { submit: "Save" },
    ),
  );
  const sections: SectionNode[] = [];
  if (usage) {
    const items: KVItem[] = [];
    if (usage["cpu"]?.["percentage"] != null)
      items.push({ key: "CPU", value: `${usage["cpu"]["percentage"]}%` });
    if (usage["memory"])
      items.push({
        key: "Memory",
        value: `${usage["memory"]["current_mb"] ?? 0} / ${usage["memory"]["max_mb"] ?? 0} MB (${usage["memory"]["percentage"] ?? 0}%)`,
      });
    if (usage["disk"])
      items.push({
        key: "Disk",
        value: `${usage["disk"]["current_gb"] ?? 0} / ${usage["disk"]["max_gb"] ?? 0} GB (${usage["disk"]["percentage"] ?? 0}%)`,
      });
    if (items.length) sections.push(section("Current Usage", [{ kind: "key-value-list", items }]));
  }
  if (backups?.latest_backup?.date) {
    sections.push(
      section("Backups", [
        {
          kind: "key-value-list",
          items: [
            {
              key: "Latest",
              value: `${s(backups.latest_backup.date)} ${s(backups.latest_backup.time)}`,
            },
            {
              key: "Oldest",
              value: `${s(backups.oldest_backup?.date)} ${s(backups.oldest_backup?.time)}`,
            },
          ],
        },
      ]),
    );
  }
  return { actions, sections };
}

function vpcParts(r: ResourceInstance): Parts {
  const attachments = parseStash<VultrVpcAttachment[]>(r, "attachments") ?? [];
  return {
    actions: [],
    sections: [
      section("Attached", [
        attachments.length
          ? table(
              [
                ["type", "Type"],
                ["id", "ID"],
                ["ip", "Private IP"],
              ],
              attachments.map((a) => ({ type: s(a.type), id: a.id, ip: s(a.ip?.v4) })),
            )
          : { kind: "text", content: "Nothing is attached to this VPC." },
      ]),
    ],
  };
}

function invoiceTable(items: VultrInvoiceItem[]): TableNode {
  return table(
    [
      ["product", "Product"],
      ["description", "Description"],
      ["period", "Period"],
      ["units", "Units"],
      ["total", "Total"],
    ],
    items.map((i) => ({
      product: s(i.product),
      description: s(i.description),
      period: `${s(i.start_date).slice(0, 10)} to ${s(i.end_date).slice(0, 10)}`,
      units: `${s(i.units)} ${s(i.unit_type)}`.trim(),
      total: money(i.total),
    })),
  );
}

function simpleActions(r: ResourceInstance): ActionNode[] {
  switch (r.resourceTypeId) {
    case "bare-metal": {
      const power = s(r.fields["powerStatus"]);
      return [
        ...(power === "stopped" ? [action("Start", "start", { success: "Start requested." })] : []),
        ...(power === "running"
          ? [
              action("Stop", "halt", {
                confirm: "Stop this server? Vultr keeps billing a stopped bare metal server.",
                success: "Stop requested.",
              }),
              action("Reboot", "reboot", {
                confirm: "Reboot this server?",
                success: "Reboot requested.",
              }),
            ]
          : []),
        action("Reinstall", "reinstall", {
          confirm: "Reinstall the operating system? Every disk is erased.",
          success: "Reinstall started.",
          danger: true,
          destructive: true,
        }),
      ];
    }
    case "block-storage":
      if (r.fields["attachedInstanceId"]) {
        return [
          action("Detach", "detach", {
            confirm: "Detach this volume? Unmount it inside the instance first to avoid data loss.",
            success: "Detach requested.",
            danger: true,
          }),
        ];
      }
      return [
        prompt(
          "Attach…",
          "attach",
          [
            {
              key: "instanceId",
              label: "Instance",
              kind: "resource-picker",
              required: true,
              description: "Must be in the same region as the volume",
              associationSources: [
                { pluginId: "vultr", resourceTypeId: "instance", outputKey: "instanceId" },
              ],
            },
            {
              key: "live",
              label: "Attach without restarting",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: yesNoOptions,
            },
          ],
          { submit: "Attach" },
        ),
      ];
    case "reserved-ip":
      if (r.fields["instanceId"]) {
        return [
          action("Detach", "detach", {
            confirm: "Detach this reserved IP? The instance loses the address.",
            success: "Detach requested.",
            danger: true,
          }),
        ];
      }
      return [
        prompt(
          "Attach…",
          "attach",
          [
            {
              key: "instanceId",
              label: "Instance",
              kind: "resource-picker",
              required: true,
              description: "Must be in the same region",
              associationSources: [
                { pluginId: "vultr", resourceTypeId: "instance", outputKey: "instanceId" },
              ],
            },
          ],
          { submit: "Attach" },
        ),
      ];
    case "object-storage":
      return [
        action("Regenerate keys", "regenerate-keys", {
          confirm: "Issue new S3 keys? Everything using the current keys loses access.",
          success: "Keys regenerated.",
          danger: true,
        }),
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
    case "firewall-group":
      parts = firewallParts(resource);
      break;
    case "load-balancer":
      parts = loadBalancerParts(resource);
      break;
    case "kubernetes-cluster":
      parts = clusterParts(resource);
      break;
    case "node-pool":
      parts = nodePoolParts(resource);
      break;
    case "database":
      parts = databaseParts(resource);
      break;
    case "vpc":
      parts = vpcParts(resource);
      break;
    case "invoice": {
      const items = parseStash<VultrInvoiceItem[]>(resource, "items") ?? [];
      parts.sections = [section("Line Items", [invoiceTable(items)])];
      break;
    }
    case "account": {
      const pending = parseStash<VultrInvoiceItem[]>(resource, "pending");
      if (pending) parts.sections = [section("Month-to-date Charges", [invoiceTable(pending)])];
      break;
    }
    case "startup-script": {
      const script = s(resource.fields["script"]);
      if (script)
        parts.sections = [
          section("Script", [{ kind: "text", content: script, variant: "mono", copyable: true }]),
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
  const engine = s(resource.fields["engine"]);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resource.resourceTypeId === "database" && engine
        ? `${ENGINE_LABELS[engine] ?? engine} ${s(resource.fields["version"])}`
        : resourceTypeDisplayName(types, resource.resourceTypeId),
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
    ...(resource.resourceTypeId === "bucket" && resource.externalId
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
        { label: "Power", value: s(f["powerStatus"]), variant },
        { label: "Plan", value: s(f["plan"]) },
        { label: "Region", value: regionLabel(s(f["region"])) },
        ...(resource.resolvedOutputs["ipv4"]
          ? [{ label: "IPv4", value: resource.resolvedOutputs["ipv4"] }]
          : []),
      ];
    case "block-storage":
      return [
        { label: "Size", value: `${s(f["sizeGb"])} GB` },
        { label: "Attached", value: s(f["attachedInstanceLabel"]) || "No" },
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
        {
          label: "Engine",
          value: `${ENGINE_LABELS[s(f["engine"])] ?? s(f["engine"])} ${s(f["version"])}`,
        },
        { label: "Plan", value: s(f["plan"]) },
      ];
    case "load-balancer":
      return [
        { label: "Status", value: s(f["status"]), variant },
        { label: "Backends", value: s(f["instanceCount"]) },
        { label: "IPv4", value: s(f["ipv4"]) },
      ];
    case "account":
      return [
        { label: "Month to date", value: money(f["pendingCharges"]) },
        { label: "Balance", value: money(f["balance"]) },
      ];
    default:
      return [];
  }
}
