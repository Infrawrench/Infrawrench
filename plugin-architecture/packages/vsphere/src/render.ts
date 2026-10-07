import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, resourceTypeDisplayName } from "@infrawrench/plugin-base";
import {
  CLUSTER,
  DATASTORE,
  HOST,
  LIBRARY_ITEM,
  RESOURCE_POOL,
  VCENTER,
  VM,
  resourceTypes,
} from "./resources.js";

export const ENRICH_KEY = "__vsphere";

type Opt = { id: string; label: string };

export interface VsphereEnrichment {
  hosts?: Opt[];
  clusters?: Opt[];
  pools?: Opt[];
  datastores?: Opt[];
  folders?: Opt[];
  specs?: string[];
  attachedTags?: Opt[];
  availableTags?: Opt[];
  isos?: Opt[];
  consoleTicket?: string;
  guestFullName?: string;
  toolsRunState?: string;
  toolsVersionStatus?: string;
  datastoreUsage?: { capacityGb: number; freeGb: number };
  vms?: Array<{ id: string; name: string; power: string }>;
}

function enrichment(r: ResourceInstance): VsphereEnrichment {
  try {
    return JSON.parse(r.resolvedOutputs[ENRICH_KEY] ?? "{}") as VsphereEnrichment;
  } catch {
    return {};
  }
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

function act(
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

export function pick(
  key: string,
  label: string,
  options: Opt[] | undefined,
  required = false,
  emptyLabel = "Default",
): CreateFieldConfig {
  if (options && options.length) {
    return {
      key,
      label,
      kind: "select",
      required,
      ...(required ? {} : { defaultValue: "" }),
      options: [
        ...(required ? [] : [{ id: "", label: emptyLabel }]),
        ...options.map((o) => ({ id: o.id, label: o.label, description: o.id })),
      ],
    };
  }
  return { key, label, kind: "text", required };
}

/** Placement pickers shared by clone, relocate and deploy. */
export function placementFields(
  d: VsphereEnrichment,
  opts: { withCluster?: boolean } = {},
): CreateFieldConfig[] {
  return [
    ...(opts.withCluster ? [pick("cluster", "Cluster", d.clusters, false, "Same as source")] : []),
    pick("host", "Host", d.hosts, false, "Same as source / let DRS pick"),
    pick("resourcePool", "Resource Pool", d.pools, false, "Same as source"),
    pick("datastore", "Datastore", d.datastores, false, "Same as source"),
    pick("folder", "Folder", d.folders, false, "Same as source"),
  ];
}

export function statusOf(r: ResourceInstance): ResourceStatus {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case VM:
      return f["powerState"] === "POWERED_ON"
        ? "healthy"
        : f["powerState"] === "SUSPENDED"
          ? "degraded"
          : "unknown";
    case HOST:
      return f["connectionState"] === "CONNECTED"
        ? "healthy"
        : f["connectionState"] === "NOT_RESPONDING"
          ? "error"
          : "unknown";
    case DATASTORE:
      return f["accessible"] === false ? "error" : "healthy";
    case VCENTER: {
      const h = str(f["health"]);
      return h === "green"
        ? "healthy"
        : h === "yellow" || h === "orange"
          ? "degraded"
          : h === "red"
            ? "error"
            : "unknown";
    }
    default:
      return "info";
  }
}

export function renderVsphereSidebar(r: ResourceInstance): SidebarItemSchema {
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

function vmTable(vms: NonNullable<VsphereEnrichment["vms"]>): SectionNode {
  return {
    kind: "section",
    title: "Virtual machines",
    children: [
      {
        kind: "table",
        columns: [
          { key: "name", label: "Name" },
          { key: "power", label: "Power" },
          { key: "id", label: "ID", mono: true, width: "narrow" },
        ],
        rows: vms.map((v) => ({ id: v.id, cells: { name: v.name, power: v.power, id: v.id } })),
      },
    ],
  };
}

export function renderVsphereDetail(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  const d = enrichment(r);
  const typeName = resourceTypeDisplayName(resourceTypes, r.resourceTypeId);
  const refresh: ActionNode = {
    kind: "action",
    label: "Refresh",
    action: { type: "refresh-resource" },
  };
  const openClient: ActionNode = {
    kind: "action",
    label: "Open vSphere Client",
    action: { type: "open-url", url: `${baseUrl}/ui/` },
  };
  const base: DetailViewSchema = {
    title: r.displayName || typeName,
    subtitle: typeName,
    status: { kind: "status-dot", status: statusOf(r) },
    sections: [details(r)],
    headerActions: [refresh],
  };

  if (r.resourceTypeId === VM) {
    const power = str(f["powerState"]);
    const actions: ActionNode[] = [];
    if (power !== "POWERED_ON")
      actions.push(act("Power on", "start", { success: "Power on requested." }));
    if (power === "POWERED_ON") {
      actions.push(
        act("Shut down guest", "guest-shutdown", {
          confirm: "Ask VMware Tools to shut the guest OS down?",
          success: "Guest shutdown requested.",
        }),
        act("Restart guest", "guest-reboot", {
          confirm: "Ask VMware Tools to restart the guest OS?",
          success: "Guest restart requested.",
        }),
        act("Suspend", "suspend", { success: "Suspend requested." }),
        act("Power off", "stop", {
          confirm: "Power the VM off immediately? Unsaved guest data is lost.",
          success: "Power off requested.",
          danger: true,
        }),
        act("Reset", "reset", {
          confirm: "Hard reset the VM?",
          success: "Reset requested.",
          danger: true,
        }),
      );
      if (d.consoleTicket) {
        actions.push({
          kind: "action",
          label: "Open remote console",
          action: { type: "open-url", url: d.consoleTicket },
        });
      }
      if (
        d.toolsVersionStatus &&
        /UNSUPPORTED|TOO_OLD|NEEDS_UPGRADE|OLD/i.test(d.toolsVersionStatus)
      ) {
        actions.push(
          act("Upgrade VMware Tools", "tools-upgrade", {
            confirm: "Upgrade VMware Tools in this VM? The guest may reboot.",
            success: "Tools upgrade started.",
          }),
        );
      }
    }
    actions.push(
      prompt(
        "Clone…",
        "clone",
        "Clone virtual machine",
        [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            defaultValue: `${str(f["name"])}-clone`,
          },
          ...placementFields(d),
          ...(d.specs?.length
            ? [
                {
                  key: "spec",
                  label: "Guest Customization",
                  kind: "select" as const,
                  required: false,
                  defaultValue: "",
                  options: [
                    { id: "", label: "None" },
                    ...d.specs.map((s) => ({ id: s, label: s })),
                  ],
                },
              ]
            : []),
          {
            key: "powerOn",
            label: "Power on",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
          },
        ],
        "Clone",
      ),
      prompt(
        "Migrate…",
        "relocate",
        "Migrate virtual machine",
        placementFields(d),
        "Migrate",
        "vMotion to another host, resource pool or datastore. Empty picks stay where they are.",
      ),
      prompt(
        "Add disk…",
        "add-disk",
        "Add a virtual disk",
        [
          {
            key: "sizeGb",
            label: "Size (GiB)",
            kind: "number",
            required: true,
            defaultValue: "20",
            minValue: 1,
          },
        ],
        "Add disk",
        "Creates a new thin disk on the VM's datastore.",
      ),
    );
    if (d.isos?.length) {
      actions.push(
        prompt(
          "Mount ISO…",
          "mount-iso",
          "Mount ISO from content library",
          [pick("item", "ISO", d.isos, true)],
          "Mount",
        ),
      );
    }
    if (d.availableTags?.length) {
      actions.push(
        prompt(
          "Add tag…",
          "attach-tag",
          "Attach tag",
          [pick("tag", "Tag", d.availableTags, true)],
          "Attach",
        ),
      );
    }
    const sections: SectionNode[] = [details(r)];
    const conn = [
      ...(r.resolvedOutputs["ipAddress"]
        ? [{ key: "IP Address", value: r.resolvedOutputs["ipAddress"], copyable: true }]
        : []),
      ...(r.resolvedOutputs["guestHostname"]
        ? [{ key: "Guest Hostname", value: r.resolvedOutputs["guestHostname"], copyable: true }]
        : []),
      ...(d.guestFullName ? [{ key: "Guest OS (reported)", value: d.guestFullName }] : []),
      ...(d.toolsRunState
        ? [
            {
              key: "VMware Tools",
              value: `${d.toolsRunState}${d.toolsVersionStatus ? ` (${d.toolsVersionStatus})` : ""}`,
            },
          ]
        : []),
    ];
    if (conn.length)
      sections.push({
        kind: "section",
        title: "Guest",
        children: [{ kind: "key-value-list", items: conn }],
      });
    if (d.attachedTags?.length) {
      sections.push({
        kind: "section",
        title: "Tags",
        children: [
          {
            kind: "table",
            columns: [
              { key: "tag", label: "Tag" },
              { key: "remove", label: "", width: "narrow" },
            ],
            rows: d.attachedTags.map((t) => ({
              id: t.id,
              cells: {
                tag: t.label,
                remove: act("Detach", `detach-tag:${t.id}`, { success: "Tag detached." }),
              },
            })),
          },
        ],
      });
    }
    return {
      ...base,
      subtitle: joinSubtitle(typeName, f["guestOs"]),
      sections,
      headerActions: [...actions, openClient, refresh],
    };
  }

  if (r.resourceTypeId === HOST) {
    const connected = f["connectionState"] === "CONNECTED";
    return {
      ...base,
      sections: [details(r), ...(d.vms?.length ? [vmTable(d.vms)] : [])],
      headerActions: [
        connected
          ? act("Disconnect", "disconnect", {
              confirm:
                "Disconnect this host from vCenter? Its VMs keep running but are unmanaged until reconnected.",
              success: "Disconnect requested.",
              danger: true,
            })
          : act("Connect", "connect", { success: "Connect requested." }),
        openClient,
        refresh,
      ],
    };
  }

  if (r.resourceTypeId === CLUSTER || r.resourceTypeId === RESOURCE_POOL) {
    return {
      ...base,
      sections: [details(r), ...(d.vms?.length ? [vmTable(d.vms)] : [])],
      headerActions: [openClient, refresh],
    };
  }

  if (r.resourceTypeId === DATASTORE && d.datastoreUsage) {
    const u = d.datastoreUsage;
    const used = Math.round((u.capacityGb - u.freeGb) * 10) / 10;
    return {
      ...base,
      sections: [
        {
          kind: "section",
          title: "Usage",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Used", value: `${used} GiB` },
                { key: "Free", value: `${u.freeGb} GiB` },
                { key: "Capacity", value: `${u.capacityGb} GiB` },
                {
                  key: "Usage",
                  value: u.capacityGb ? `${((used / u.capacityGb) * 100).toFixed(1)}%` : "-",
                },
              ],
            },
          ],
        },
        details(r),
      ],
    };
  }

  if (r.resourceTypeId === LIBRARY_ITEM) {
    const type = str(f["type"]).toLowerCase();
    if (type === "vm-template" || type === "ovf") {
      return {
        ...base,
        subtitle: joinSubtitle(typeName, type === "ovf" ? "OVF package" : "VM template"),
        headerActions: [
          prompt(
            "Deploy VM…",
            "deploy",
            "Deploy a VM from this item",
            [
              { key: "name", label: "VM Name", kind: "text", required: true },
              ...placementFields(d, { withCluster: true }),
              ...(type === "vm-template"
                ? [
                    { key: "cpuCount", label: "vCPUs", kind: "number" as const, required: false },
                    {
                      key: "memoryMb",
                      label: "Memory (MiB)",
                      kind: "number" as const,
                      required: false,
                    },
                    {
                      key: "powerOn",
                      label: "Power on",
                      kind: "select" as const,
                      required: false,
                      defaultValue: "true",
                      options: [
                        { id: "true", label: "Yes" },
                        { id: "false", label: "No" },
                      ],
                    },
                  ]
                : []),
            ],
            "Deploy",
            type === "ovf" ? "OVF deployments need a cluster or resource pool." : undefined,
          ),
          refresh,
        ],
      };
    }
  }

  if (r.resourceTypeId === VCENTER) return { ...base, headerActions: [openClient, refresh] };
  return base;
}
