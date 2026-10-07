/** Detail views, sidebar items and dashboard stats over the `__name__` stashes. */

import type {
  ActionNode,
  CreateFieldConfig,
  DashboardStat,
  DetailViewSchema,
  ImageOption,
  KVItem,
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

export function parseStash<T>(r: ResourceInstance, key: string): T | null {
  const raw = r.resolvedOutputs[`__${key}__`];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const s = (v: unknown) => (v == null ? "" : String(v));

export function statusFor(r: ResourceInstance): ResourceStatus {
  const st = s(r.fields["state"]).toLowerCase();
  switch (r.resourceTypeId) {
    case "instance":
      if (st === "running") return "healthy";
      if (st === "stopped") return "error";
      if (["starting", "stopping", "migrating"].includes(st)) return "provisioning";
      return st === "error" ? "error" : st ? "degraded" : "unknown";
    case "block-storage":
      if (st === "attached") return "healthy";
      if (st === "detached") return "info";
      return st === "error" ? "error" : st ? "provisioning" : "unknown";
    case "sks-cluster":
    case "sks-nodepool":
    case "nlb":
    case "instance-pool":
    case "dbaas":
      if (st === "running") return "healthy";
      if (st === "error") return "error";
      if (st === "poweroff" || st === "suspended") return "degraded";
      return st ? "provisioning" : "unknown";
    case "snapshot":
    case "block-storage-snapshot":
      return ["ready", "created", "exported"].includes(st)
        ? "healthy"
        : st === "error"
          ? "error"
          : st
            ? "provisioning"
            : "info";
    case "elastic-ip":
      return r.fields["instanceIds"] ? "healthy" : "info";
    case "security-group":
      return s(r.fields["openToWorld"]) ? "degraded" : "healthy";
    default:
      return "info";
  }
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

const exoPicker = (
  key: string,
  label: string,
  typeId: string,
  outputKey: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required: true,
  associationSources: [{ pluginId: "exoscale", resourceTypeId: typeId, outputKey }],
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
  const st = s(r.fields["state"]);
  const managed = s(r.fields["managedBy"]) !== "";
  const actions: ActionNode[] = [];
  if (st === "stopped") actions.push(action("Start", "start", { success: "Start requested." }));
  if (st === "running") {
    actions.push(
      action("Stop", "stop", {
        confirm: "Stop this instance? Its disk is still billed while it is stopped.",
        success: "Stop requested.",
      }),
      action("Reboot", "reboot", {
        confirm: "Reboot this instance?",
        success: "Reboot requested.",
      }),
    );
  }
  const types = parseStash<SizeOption[]>(r, "types") ?? [];
  if (!managed) {
    actions.push(
      prompt(
        "Change type…",
        "scale",
        st === "stopped" && types.length
          ? [
              {
                key: "instanceType",
                label: "Type",
                kind: "size-picker",
                required: true,
                sizes: types,
                defaultValue: types[0]?.id ?? "",
              },
            ]
          : [],
        st === "stopped" && types.length
          ? { description: `Current type: ${s(r.fields["instanceType"])}.`, submit: "Change type" }
          : {
              description:
                "Stop the instance first: Exoscale changes the type only on a stopped instance.",
              blocked: true,
            },
      ),
      prompt(
        "Grow disk…",
        "resize-disk",
        [
          {
            key: "diskGb",
            label: "Disk",
            kind: "disk-slider",
            required: true,
            minGb: Number(r.fields["diskGb"] ?? 10),
            maxGb: 1600,
            defaultGb: Number(r.fields["diskGb"] ?? 10) + 10,
            stepGb: 10,
          },
        ],
        {
          description:
            "The disk can only grow; extend the filesystem inside the instance afterwards.",
          submit: "Grow",
        },
      ),
      action("Take snapshot", "snapshot", {
        confirm: "Snapshot this instance's disk? Snapshots are billed per GB.",
        success: "Snapshot started.",
      }),
    );
    const snapshots = parseStash<Array<{ id: string; label: string }>>(r, "snapshots") ?? [];
    actions.push(
      prompt(
        "Revert to snapshot…",
        "revert-snapshot",
        [
          {
            key: "snapshotId",
            label: "Snapshot",
            kind: "select",
            required: true,
            options: snapshots,
          },
        ],
        snapshots.length
          ? {
              description:
                "DESTRUCTIVE: the disk is replaced with the snapshot. The instance must be stopped.",
              submit: "Revert",
              danger: true,
            }
          : { description: "This instance has no snapshots.", blocked: true },
      ),
    );
    const images = parseStash<ImageOption[]>(r, "images") ?? [];
    if (images.length) {
      actions.push(
        prompt(
          "Reinstall…",
          "reset",
          [{ key: "template", label: "Template", kind: "image-picker", required: true, images }],
          {
            description:
              "DESTRUCTIVE: the disk is erased and the instance reinstalled from the template.",
            submit: "Reinstall",
            danger: true,
          },
        ),
      );
    }
    actions.push(
      action("Protect from deletion", "add-protection", { success: "Protection on." }),
      action("Remove protection", "remove-protection", {
        confirm: "Allow this instance to be deleted again?",
        success: "Protection off.",
      }),
    );
  }
  const sections: SectionNode[] = [];
  const net: KVItem[] = [];
  if (r.resolvedOutputs["ipv4"])
    net.push({ key: "Public IPv4", value: r.resolvedOutputs["ipv4"], copyable: true });
  if (r.resolvedOutputs["ipv6"])
    net.push({ key: "IPv6", value: r.resolvedOutputs["ipv6"], copyable: true });
  if (net.length) sections.push(section("Networking", [{ kind: "key-value-list", items: net }]));
  const rows: Array<Record<string, string | ActionNode>> = [];
  const add = (key: string, kind: string, command: string, idKey: string) => {
    for (const x of parseStash<Array<{ id: string; label: string }>>(r, key) ?? []) {
      rows.push({
        kind,
        name: x.label,
        detach: prompt("Detach", command, [hidden(idKey, x.id)], {
          description: `Detach ${x.label} from this instance?`,
          submit: "Detach",
          danger: true,
        }),
      });
    }
  };
  add("securityGroups", "Security group", "detach-security-group", "securityGroupId");
  add("elasticIps", "Elastic IP", "detach-elastic-ip", "elasticIpId");
  add("privateNetworks", "Private network", "detach-private-network", "networkId");
  if (rows.length) {
    sections.push(
      section("Attachments", [
        table(
          [
            ["kind", "Kind"],
            ["name", "Name"],
            ["detach", ""],
          ],
          rows,
        ),
      ]),
    );
  }
  return { actions, sections };
}

function securityGroupParts(r: ResourceInstance): Parts {
  const rules = parseStash<Json[]>(r, "rules") ?? [];
  return {
    actions: [
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
            key: "protocol",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: "tcp",
            options: ["tcp", "udp", "icmp", "all"].map((p) => ({ id: p, label: p.toUpperCase() })),
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
            key: "network",
            label: "Source Network",
            kind: "text",
            required: false,
            defaultValue: "0.0.0.0/0",
            description: "CIDR; ignored when a source group is picked",
          },
          {
            key: "sourceGroupId",
            label: "Source Security Group",
            kind: "resource-picker",
            required: false,
            associationSources: [
              {
                pluginId: "exoscale",
                resourceTypeId: "security-group",
                outputKey: "securityGroupId",
              },
            ],
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
        { submit: "Add rule" },
      ),
    ],
    sections: [
      section("Rules", [
        table(
          [
            ["dir", "Direction"],
            ["proto", "Protocol"],
            ["ports", "Ports"],
            ["source", "Source"],
            ["description", "Description"],
            ["remove", ""],
          ],
          rules.map((ru) => {
            const start = s(ru["start-port"]);
            const end = s(ru["end-port"]);
            return {
              dir: s(ru["flow-direction"]),
              proto: s(ru["protocol"]).toUpperCase(),
              ports: start ? (end && end !== start ? `${start}-${end}` : start) : "all",
              source: s(ru["network"]) || s((ru["security-group"] as Json | undefined)?.["name"]),
              description: s(ru["description"]),
              remove: prompt("Remove", "remove-rule", [hidden("ruleId", s(ru["id"]))], {
                description: "Remove this rule?",
                submit: "Remove",
                danger: true,
              }),
            };
          }),
        ),
      ]),
    ],
  };
}

function nlbParts(r: ResourceInstance): Parts {
  const services = parseStash<Json[]>(r, "services") ?? [];
  const pools = parseStash<Array<{ id: string; label: string }>>(r, "pools") ?? [];
  return {
    actions: [
      prompt(
        "+ Service",
        "add-service",
        [
          { key: "name", label: "Name", kind: "text", required: true, defaultValue: "web" },
          { key: "poolId", label: "Instance Pool", kind: "select", required: true, options: pools },
          {
            key: "protocol",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: "tcp",
            options: [
              { id: "tcp", label: "TCP" },
              { id: "udp", label: "UDP" },
            ],
          },
          { key: "port", label: "Port", kind: "number", required: true, defaultValue: "80" },
          {
            key: "targetPort",
            label: "Target Port",
            kind: "number",
            required: true,
            defaultValue: "80",
          },
          {
            key: "strategy",
            label: "Strategy",
            kind: "select",
            required: false,
            defaultValue: "round-robin",
            options: ["round-robin", "maglev-hash", "source-hash"].map((x) => ({
              id: x,
              label: x,
            })),
          },
          {
            key: "healthMode",
            label: "Health Check",
            kind: "select",
            required: false,
            defaultValue: "tcp",
            options: ["tcp", "http", "https"].map((x) => ({ id: x, label: x.toUpperCase() })),
          },
          {
            key: "healthUri",
            label: "Health Check Path",
            kind: "text",
            required: false,
            defaultValue: "/",
            showWhen: { fieldKey: "healthMode", fieldValues: ["http", "https"] },
          },
        ],
        pools.length
          ? { submit: "Add service" }
          : {
              description: "A service forwards to an instance pool; there is none in this zone.",
              blocked: true,
            },
      ),
    ],
    sections: [
      section("Services", [
        table(
          [
            ["name", "Service"],
            ["ports", "Ports"],
            ["strategy", "Strategy"],
            ["state", "State"],
            ["remove", ""],
          ],
          services.map((sv) => ({
            name: s(sv["name"]),
            ports: `${s(sv["protocol"]).toUpperCase()} ${s(sv["port"])} → ${s(sv["target-port"])}`,
            strategy: s(sv["strategy"]),
            state: s(sv["state"]),
            remove: prompt("Remove", "remove-service", [hidden("serviceId", s(sv["id"]))], {
              description: `Remove ${s(sv["name"])}?`,
              submit: "Remove",
              danger: true,
            }),
          })),
        ),
      ]),
    ],
  };
}

function simpleActions(r: ResourceInstance): ActionNode[] {
  switch (r.resourceTypeId) {
    case "block-storage":
      return [
        r.fields["instanceId"]
          ? action("Detach", "detach", {
              confirm: "Detach this volume? Unmount it first.",
              success: "Detach requested.",
              danger: true,
            })
          : prompt(
              "Attach…",
              "attach",
              [exoPicker("instanceId", "Instance", "instance", "instanceId")],
              { description: "The instance must be in the same zone.", submit: "Attach" },
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
              defaultValue: `${s(r.fields["name"])}-${new Date().toISOString().slice(0, 10)}`,
            },
          ],
          { submit: "Snapshot" },
        ),
      ];
    case "elastic-ip":
      return [
        prompt(
          "Attach…",
          "attach",
          [exoPicker("instanceId", "Instance", "instance", "instanceId")],
          { description: "The instance must be in the same zone.", submit: "Attach" },
        ),
      ];
    case "sks-cluster": {
      const versions = parseStash<string[]>(r, "versions") ?? [];
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
              options: versions.map((v) => ({ id: v, label: v })),
            },
          ],
          versions.length
            ? { submit: "Upgrade" }
            : {
                description: "This cluster is on the newest version Exoscale offers.",
                blocked: true,
              },
        ),
        ...(s(r.fields["level"]) === "starter"
          ? [
              prompt("Upgrade to Pro…", "upgrade-level", [], {
                description:
                  "Move the control plane to the Pro level (HA with an SLA, billed). This cannot be undone.",
                submit: "Upgrade",
              }),
            ]
          : []),
      ];
    }
    case "dbaas": {
      const users = parseStash<Json[]>(r, "users") ?? [];
      return [
        action("Start maintenance", "maintenance", {
          confirm: "Apply pending maintenance now? Expect a brief interruption.",
          success: "Maintenance started.",
        }),
        ...(users.length
          ? [
              prompt(
                "Reveal password…",
                "reveal-password",
                [
                  {
                    key: "username",
                    label: "User",
                    kind: "select",
                    required: true,
                    options: users.map((u) => ({ id: s(u["username"]), label: s(u["username"]) })),
                  },
                ],
                { submit: "Reveal" },
              ),
            ]
          : []),
      ];
    }
    default:
      return [];
  }
}

export function renderDetail(
  resource: ResourceInstance,
  types: ResourceTypeDefinition[],
): DetailViewSchema {
  let parts: Parts = { actions: simpleActions(resource), sections: [] };
  if (resource.resourceTypeId === "instance") parts = instanceParts(resource);
  if (resource.resourceTypeId === "security-group") parts = securityGroupParts(resource);
  if (resource.resourceTypeId === "nlb") parts = nlbParts(resource);
  if (resource.resourceTypeId === "dbaas") {
    const backups = parseStash<Json[]>(resource, "backups") ?? [];
    if (backups.length) {
      parts.sections.push(
        section("Backups", [
          table(
            [
              ["time", "Taken"],
              ["size", "Size (GB)"],
            ],
            backups.map((b) => ({
              time: s(b["backup-time"]),
              size: (Number(b["data-size"] ?? 0) / 1e9).toFixed(2),
            })),
          ),
        ]),
      );
    }
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(types, resource.resourceTypeId),
      resource.fields["region"] ?? resource.fields["domainName"],
    ),
    status: { kind: "status-dot", status: statusFor(resource) },
    sections: [
      section("Details", [
        {
          kind: "key-value-list",
          items: labeledFieldItems(resource.fields, types, resource.resourceTypeId),
        },
      ]),
      ...parts.sections,
    ],
    headerActions: [
      ...parts.actions,
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
    ...(resource.resourceTypeId === "dbaas" ? { logs: { defaultTailLines: 200 } } : {}),
    ...(resource.resourceTypeId === "bucket" && resource.externalId
      ? { storageBrowser: { bucketName: resource.externalId } }
      : {}),
  };
}

export function renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
  return { id: r.id, label: r.displayName, status: { kind: "status-dot", status: statusFor(r) } };
}

export function dashboardStats(r: ResourceInstance): DashboardStat[] {
  const f = r.fields;
  const st = statusFor(r);
  const variant: NonNullable<DashboardStat["variant"]> =
    st === "healthy"
      ? "status-healthy"
      : st === "error"
        ? "status-error"
        : st === "degraded"
          ? "status-degraded"
          : "default";
  switch (r.resourceTypeId) {
    case "instance":
      return [
        { label: "State", value: s(f["state"]), variant },
        { label: "Type", value: s(f["instanceType"]) },
        ...(r.resolvedOutputs["ipv4"] ? [{ label: "IPv4", value: r.resolvedOutputs["ipv4"] }] : []),
      ];
    case "dbaas":
      return [
        { label: "State", value: s(f["state"]), variant },
        { label: "Type", value: `${s(f["type"])} ${s(f["version"])}` },
        { label: "Plan", value: s(f["plan"]) },
      ];
    case "sks-cluster":
      return [
        { label: "Version", value: s(f["version"]) },
        { label: "Nodes", value: s(f["nodeCount"]) },
      ];
    default:
      return [];
  }
}
