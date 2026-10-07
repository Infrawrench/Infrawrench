import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
  TableNode,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledFieldItems,
  resourceTypeDisplayName,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import {
  BACKUP,
  BACKUP_JOB,
  CLUSTER,
  CT,
  FW_RULE,
  HA_RESOURCE,
  HA_RULE,
  IPSET,
  NODE,
  POOL,
  SECURITY_GROUP,
  STORAGE,
  VM,
  resourceTypes,
} from "./resources.js";

/** resolvedOutputs key carrying `enrichDetail` data to the renderer. */
export const ENRICH_KEY = "__proxmox";

export interface ProxmoxEnrichment {
  nodes?: string[];
  pools?: string[];
  storages?: string[];
  backupStorages?: string[];
  disks?: string[];
  snapshots?: Array<{
    name: string;
    description: string;
    time: string;
    vmstate: boolean;
    parent: string;
  }>;
  firewallRules?: Array<Record<string, string | number | boolean>>;
  storageStatus?: { totalGb: number; usedGb: number; availGb: number };
  content?: Array<{ volid: string; content: string; format: string; sizeGb: number; vmid: string }>;
  ipsetEntries?: Array<{ cidr: string; comment: string; nomatch: boolean }>;
  haStatus?: Array<{ id: string; node: string; status: string }>;
  notBackedUp?: Array<{ vmid: string; name: string; type: string }>;
  clusterLog?: Array<{ time: string; node: string; user: string; msg: string }>;
}

function enrichment(resource: ResourceInstance): ProxmoxEnrichment {
  const raw = resource.resolvedOutputs[ENRICH_KEY];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProxmoxEnrichment;
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
): ActionNode {
  return {
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
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  fields: CreateFieldConfig[],
  opts: { description?: string; submitLabel?: string; danger?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      fields,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.submitLabel ? { submitLabel: opts.submitLabel } : {}),
      ...(opts.danger ? { danger: true } : {}),
    },
    ...(opts.danger ? { variant: "danger" as const } : {}),
  };
}

/** A select when we know the options, a text box when enrichment failed. */
function pickField(
  key: string,
  label: string,
  options: string[] | undefined,
  opts: {
    required?: boolean;
    defaultValue?: string;
    description?: string;
    emptyLabel?: string;
  } = {},
): CreateFieldConfig {
  const base = {
    key,
    label,
    required: opts.required ?? true,
    ...(opts.description ? { description: opts.description } : {}),
  };
  if (options && options.length > 0) {
    const list = opts.emptyLabel ? [{ id: "", label: opts.emptyLabel }] : [];
    return {
      ...base,
      kind: "select",
      options: [...list, ...options.map((o) => ({ id: o, label: o }))],
      ...(opts.defaultValue !== undefined
        ? { defaultValue: opts.defaultValue }
        : options[0]
          ? { defaultValue: options[0] }
          : {}),
    };
  }
  return {
    ...base,
    kind: "text",
    ...(opts.defaultValue ? { defaultValue: opts.defaultValue } : {}),
  };
}

function guestStatus(status: string, template: boolean): ResourceStatus {
  if (template) return "info";
  if (status === "running") return "healthy";
  if (status === "paused") return "degraded";
  if (status === "stopped") return "unknown";
  return "unknown";
}

export function statusOf(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case VM:
    case CT:
      return guestStatus(str(f["status"]), f["template"] === true);
    case NODE:
      return f["status"] === "online" ? "healthy" : f["status"] === "offline" ? "error" : "unknown";
    case CLUSTER:
      return f["quorate"] === false ? "error" : "healthy";
    case STORAGE:
      return f["enabled"] === false ? "unknown" : "healthy";
    case BACKUP_JOB:
    case FW_RULE:
      return f[resource.resourceTypeId === FW_RULE ? "enable" : "enabled"] === false
        ? "unknown"
        : "healthy";
    case HA_RESOURCE: {
      const s = str(f["currentState"]);
      if (s === "error" || s === "fence") return "error";
      if (s === "started") return "healthy";
      return "info";
    }
    case HA_RULE:
      return f["disable"] === true ? "unknown" : "healthy";
    default:
      return "info";
  }
}

export function renderProxmoxSidebar(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName || resource.externalId || resource.id,
    status: { kind: "status-dot", status: statusOf(resource) },
  };
}

function detailsSection(resource: ResourceInstance): SectionNode {
  const items: KVItem[] = labeledFieldItems(
    resource.fields,
    resourceTypes,
    resource.resourceTypeId,
  );
  return { kind: "section", title: "Details", children: [{ kind: "key-value-list", items }] };
}

function outputsItems(resource: ResourceInstance): KVItem[] {
  return Object.entries(resource.resolvedOutputs)
    .filter(([k, v]) => !k.startsWith("__") && v)
    .map(([k, v]) => ({
      key:
        k === "ipv4"
          ? "IPv4"
          : k === "ipv6"
            ? "IPv6"
            : k === "vmid"
              ? "VMID"
              : k === "node"
                ? "Node"
                : k,
      value: v,
      copyable: true,
    }));
}

function table(title: string, columns: TableNode["columns"], rows: TableNode["rows"]): SectionNode {
  return { kind: "section", title, children: [{ kind: "table", columns, rows }] };
}

function firewallTable(
  title: string,
  rules: Array<Record<string, string | number | boolean>>,
  deletePrefix: string,
): SectionNode {
  return table(
    title,
    [
      { key: "pos", label: "#", width: "narrow" },
      { key: "dir", label: "Direction", width: "narrow" },
      { key: "action", label: "Action" },
      { key: "match", label: "Match" },
      { key: "source", label: "Source" },
      { key: "enabled", label: "On", width: "narrow" },
      { key: "comment", label: "Comment" },
      { key: "remove", label: "", width: "narrow" },
    ],
    rules.map((r) => ({
      id: String(r["pos"]),
      cells: {
        pos: str(r["pos"]),
        dir: str(r["type"]),
        action: str(r["action"]),
        match: r["macro"]
          ? str(r["macro"])
          : [r["proto"], r["dport"]].filter(Boolean).join("/") || "any",
        source: str(r["source"]) || "any",
        enabled: r["enable"] ? "yes" : "no",
        comment: str(r["comment"]),
        remove: action("Delete", `${deletePrefix}:${str(r["pos"])}`, {
          confirm: `Delete firewall rule #${str(r["pos"])}?`,
          success: "Rule deleted.",
          danger: true,
          destructive: true,
        }),
      },
    })),
  );
}

const FIREWALL_RULE_FIELDS: CreateFieldConfig[] = [
  {
    key: "type",
    label: "Direction",
    kind: "select",
    required: true,
    defaultValue: "in",
    options: [
      { id: "in", label: "In" },
      { id: "out", label: "Out" },
    ],
  },
  {
    key: "action",
    label: "Action",
    kind: "select",
    required: true,
    defaultValue: "ACCEPT",
    options: [
      { id: "ACCEPT", label: "ACCEPT" },
      { id: "DROP", label: "DROP" },
      { id: "REJECT", label: "REJECT" },
    ],
  },
  {
    key: "macro",
    label: "Macro",
    kind: "text",
    required: false,
    placeholder: "SSH",
    description: "A predefined service, or leave empty and set protocol and port",
  },
  { key: "proto", label: "Protocol", kind: "text", required: false, placeholder: "tcp" },
  { key: "dport", label: "Destination Port", kind: "text", required: false, placeholder: "443" },
  {
    key: "source",
    label: "Source",
    kind: "text",
    required: false,
    placeholder: "10.0.0.0/8, +ipset or alias. Empty is any",
  },
  { key: "comment", label: "Comment", kind: "text", required: false },
];

export { FIREWALL_RULE_FIELDS };

function guestActions(
  resource: ResourceInstance,
  data: ProxmoxEnrichment,
  uiUrl: string,
): ActionNode[] {
  const f = resource.fields;
  const isVm = resource.resourceTypeId === VM;
  const what = isVm ? "VM" : "container";
  const status = str(f["status"]);
  const template = f["template"] === true;
  const vmid = str(f["vmid"]) || str(resource.externalId);
  const node = str(f["node"]);
  const actions: ActionNode[] = [];

  if (!template) {
    if (status === "stopped")
      actions.push(action("Start", "start", { success: "Start requested." }));
    if (status === "running") {
      actions.push(
        action("Shut down", "shutdown", {
          confirm: `Send a clean shutdown to this ${what}?`,
          success: "Shutdown requested.",
        }),
        action("Reboot", "reboot", {
          confirm: `Reboot this ${what}?`,
          success: "Reboot requested.",
        }),
        action("Stop", "stop", {
          confirm: `Stop this ${what} immediately? This is like pulling the power plug; unsaved data is lost.`,
          success: "Stop requested.",
          danger: true,
        }),
      );
      if (isVm) {
        actions.push(
          action("Reset", "reset", {
            confirm: "Hard reset this VM? Like pressing the reset button.",
            success: "Reset requested.",
            danger: true,
          }),
          action("Suspend", "suspend", { success: "Suspend requested." }),
        );
      }
    }
    if (status === "paused")
      actions.push(action("Resume", "resume", { success: "Resume requested." }));
    if (uiUrl && node) {
      const consoleUrl = `${uiUrl}/?console=${isVm ? "kvm" : "lxc"}&${isVm ? "novnc=1&" : "xtermjs=1&"}vmid=${encodeURIComponent(vmid)}&node=${encodeURIComponent(node)}&resize=scale`;
      actions.push({
        kind: "action",
        label: "Open console",
        action: { type: "open-url", url: consoleUrl },
      });
    }
    actions.push(
      prompt(
        "Take snapshot…",
        "snapshot",
        "Take snapshot",
        [
          {
            key: "snapname",
            label: "Name",
            kind: "text",
            required: true,
            defaultValue: `snap-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
            description: "Letters, digits, - and _; must start with a letter",
          },
          { key: "description", label: "Description", kind: "text", required: false },
          ...(isVm
            ? [
                {
                  key: "vmstate",
                  label: "Include RAM",
                  kind: "select" as const,
                  required: false,
                  defaultValue: "false",
                  options: [
                    { id: "false", label: "No" },
                    { id: "true", label: "Yes" },
                  ],
                  description: "Saves the running memory state too (VM must be running)",
                },
              ]
            : []),
        ],
        { submitLabel: "Snapshot" },
      ),
      prompt(
        "Back up now…",
        "backup",
        "Back up now",
        [
          pickField("storage", "Storage", data.backupStorages, {
            description: "Backup-capable storage",
          }),
          {
            key: "mode",
            label: "Mode",
            kind: "select",
            required: true,
            defaultValue: "snapshot",
            options: [
              { id: "snapshot", label: "Snapshot", description: "No downtime" },
              { id: "suspend", label: "Suspend", description: "Short pause" },
              { id: "stop", label: "Stop", description: "Most consistent, guest stops" },
            ],
          },
          {
            key: "compress",
            label: "Compression",
            kind: "select",
            required: true,
            defaultValue: "zstd",
            options: [
              { id: "zstd", label: "ZSTD" },
              { id: "lzo", label: "LZO" },
              { id: "gzip", label: "GZIP" },
              { id: "0", label: "None" },
            ],
          },
          {
            key: "notes",
            label: "Notes",
            kind: "text",
            required: false,
            defaultValue: "{{guestname}}",
          },
          {
            key: "protected",
            label: "Protected",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
          },
        ],
        {
          submitLabel: "Back up",
          description:
            "Runs a vzdump backup task on the guest's node. It appears under Backups when it finishes.",
        },
      ),
    );
  }
  actions.push(
    prompt(
      template ? "Deploy from template…" : "Clone…",
      "clone",
      template ? "Deploy from template" : `Clone ${what}`,
      [
        {
          key: "name",
          label: isVm ? "Name" : "Hostname",
          kind: "text",
          required: true,
          defaultValue: `${str(f["name"])}-clone`,
        },
        {
          key: "newid",
          label: "New VMID",
          kind: "number",
          required: false,
          description: "Leave empty for the next free VMID",
        },
        pickField("target", "Target Node", data.nodes, {
          required: false,
          defaultValue: "",
          emptyLabel: "Same node",
          description: "Other nodes need shared storage",
        }),
        {
          key: "full",
          label: "Clone Mode",
          kind: "select",
          required: true,
          defaultValue: template ? "false" : "true",
          options: [
            { id: "true", label: "Full clone", description: "Independent copy of every disk" },
            ...(template
              ? [
                  {
                    id: "false",
                    label: "Linked clone",
                    description: "Fast, shares the template's disks",
                  },
                ]
              : []),
          ],
        },
        pickField("storage", "Target Storage", data.storages, {
          required: false,
          defaultValue: "",
          emptyLabel: "Same as source",
          description: "Full clones only",
        }),
        pickField("pool", "Pool", data.pools, {
          required: false,
          defaultValue: "",
          emptyLabel: "None",
        }),
      ],
      { submitLabel: "Clone" },
    ),
  );
  if (!template && status === "stopped") {
    actions.push(
      action("Convert to template", "template", {
        confirm: `Convert this ${what} to a template? Templates cannot be started; this cannot be undone.`,
        success: "Converted to template.",
        danger: true,
      }),
    );
  }
  if ((data.nodes?.length ?? 0) > 1 || !data.nodes) {
    actions.push(
      prompt(
        "Migrate…",
        "migrate",
        `Migrate ${what}`,
        [
          pickField(
            "target",
            "Target Node",
            data.nodes?.filter((n) => n !== node),
          ),
          ...(isVm
            ? [
                {
                  key: "online",
                  label: "Live migration",
                  kind: "select" as const,
                  required: true,
                  defaultValue: status === "running" ? "true" : "false",
                  options: [
                    { id: "true", label: "Online (live)" },
                    { id: "false", label: "Offline" },
                  ],
                },
                {
                  key: "withLocalDisks",
                  label: "Migrate local disks",
                  kind: "select" as const,
                  required: true,
                  defaultValue: "false",
                  options: [
                    { id: "false", label: "No" },
                    { id: "true", label: "Yes" },
                  ],
                },
              ]
            : [
                {
                  key: "restart",
                  label: "Restart mode",
                  kind: "select" as const,
                  required: true,
                  defaultValue: status === "running" ? "true" : "false",
                  options: [
                    { id: "true", label: "Restart migration (short downtime)" },
                    { id: "false", label: "Offline" },
                  ],
                },
              ]),
        ],
        { submitLabel: "Migrate" },
      ),
    );
  }
  actions.push(
    prompt(
      "Resize disk…",
      "resize",
      "Grow a disk",
      [
        pickField("disk", "Disk", data.disks, {
          defaultValue: data.disks?.[0] ?? (isVm ? "scsi0" : "rootfs"),
        }),
        {
          key: "size",
          label: "Grow by (GiB)",
          kind: "number",
          required: true,
          defaultValue: "10",
          minValue: 1,
          description: "Disks can only grow. Extend the filesystem inside the guest afterwards.",
        },
      ],
      { submitLabel: "Resize" },
    ),
    prompt(
      "Move to pool…",
      "pool",
      "Move to pool",
      [
        pickField("pool", "Pool", data.pools, {
          required: false,
          defaultValue: str(f["pool"]),
          emptyLabel: "No pool",
        }),
      ],
      { submitLabel: "Move" },
    ),
    prompt("Add firewall rule…", "firewall-add", "Add guest firewall rule", FIREWALL_RULE_FIELDS, {
      submitLabel: "Add rule",
      description: "Rules apply when the guest firewall and the NIC's firewall flag are on.",
    }),
  );
  if (!str(f["haState"]) && !template) {
    actions.push(
      prompt(
        "Manage with HA…",
        "ha-add",
        "Add to high availability",
        [
          {
            key: "state",
            label: "Requested State",
            kind: "select",
            required: true,
            defaultValue: "started",
            options: [
              { id: "started", label: "Started" },
              { id: "stopped", label: "Stopped" },
              { id: "disabled", label: "Disabled" },
              { id: "ignored", label: "Ignored" },
            ],
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
        { submitLabel: "Add" },
      ),
    );
  }
  const protectedNow = f["protection"] === true;
  actions.push(
    action(
      protectedNow ? "Disable protection" : "Enable protection",
      protectedNow ? "unprotect" : "protect",
      {
        success: protectedNow ? "Protection disabled." : "Protection enabled.",
        ...(protectedNow ? { confirm: `Allow this ${what} and its disks to be removed?` } : {}),
      },
    ),
  );
  return actions;
}

function guestSections(resource: ResourceInstance, data: ProxmoxEnrichment): SectionNode[] {
  const sections: SectionNode[] = [detailsSection(resource)];
  const outs = outputsItems(resource);
  if (outs.length)
    sections.push({
      kind: "section",
      title: "Connection",
      children: [{ kind: "key-value-list", items: outs }],
    });
  if (data.snapshots) {
    sections.push(
      table(
        "Snapshots",
        [
          { key: "name", label: "Name", mono: true },
          { key: "time", label: "Taken" },
          { key: "ram", label: "RAM", width: "narrow" },
          { key: "description", label: "Description" },
          { key: "rollback", label: "", width: "narrow" },
          { key: "remove", label: "", width: "narrow" },
        ],
        data.snapshots.map((s) => ({
          id: s.name,
          cells: {
            name: s.name,
            time: s.time.slice(0, 16).replace("T", " "),
            ram: s.vmstate ? "yes" : "no",
            description: s.description,
            rollback: action("Roll back", `snapshot-rollback:${s.name}`, {
              confirm: `Roll back to snapshot "${s.name}"? Everything since it was taken is lost.`,
              success: "Rollback requested.",
              danger: true,
              destructive: true,
            }),
            remove: action("Delete", `snapshot-delete:${s.name}`, {
              confirm: `Delete snapshot "${s.name}"?`,
              success: "Snapshot deletion requested.",
              danger: true,
              destructive: true,
            }),
          },
        })),
      ),
    );
  }
  if (data.firewallRules)
    sections.push(firewallTable("Guest firewall rules", data.firewallRules, "firewall-delete"));
  return sections;
}

export function renderProxmoxDetail(resource: ResourceInstance, uiUrl: string): DetailViewSchema {
  const schema = renderInner(resource, uiUrl);
  return withMetricsCapability(schema, resourceTypes, resource.resourceTypeId, 3_600_000);
}

function renderInner(resource: ResourceInstance, uiUrl: string): DetailViewSchema {
  const f = resource.fields;
  const t = resource.resourceTypeId;
  const data = enrichment(resource);
  const typeName = resourceTypeDisplayName(resourceTypes, t);
  const base: DetailViewSchema = {
    title: resource.displayName || typeName,
    subtitle: joinSubtitle(typeName, f["node"]),
    status: { kind: "status-dot", status: statusOf(resource) },
    sections: [detailsSection(resource)],
    headerActions: [],
  };
  const refresh: ActionNode = {
    kind: "action",
    label: "Refresh",
    action: { type: "refresh-resource" },
  };

  if (t === VM || t === CT) {
    return {
      ...base,
      subtitle: joinSubtitle(
        f["template"] === true ? `${typeName} template` : typeName,
        `VMID ${str(f["vmid"])}`,
        f["node"],
      ),
      sections: guestSections(resource, data),
      headerActions: [...guestActions(resource, data, uiUrl), refresh],
      logs: { defaultTailLines: 200 },
      describe: { language: "text" },
    };
  }

  if (t === NODE) {
    const name = str(f["name"]) || str(resource.externalId);
    const online = f["status"] === "online";
    return {
      ...base,
      subtitle: joinSubtitle(typeName, f["pveVersion"]),
      headerActions: [
        ...(uiUrl && online
          ? [
              {
                kind: "action" as const,
                label: "Open shell",
                action: {
                  type: "open-url" as const,
                  url: `${uiUrl}/?console=shell&xtermjs=1&vmid=0&node=${encodeURIComponent(name)}`,
                },
              },
            ]
          : []),
        ...(online
          ? [
              action("Start all guests", "startall", {
                confirm: "Start every VM and container on this node that has Start at Boot set?",
                success: "Start-all requested.",
              }),
              action("Stop all guests", "stopall", {
                confirm: "Stop every VM and container on this node?",
                success: "Stop-all requested.",
                danger: true,
              }),
              action("Refresh package index", "apt-update", { success: "apt update started." }),
              action("Reboot node", "node-reboot", {
                confirm: "Reboot this Proxmox VE node? Guests without HA stop with it.",
                success: "Reboot requested.",
                danger: true,
              }),
              action("Shut down node", "node-shutdown", {
                confirm:
                  "Shut this Proxmox VE node down? It must be powered on again by hand or IPMI.",
                success: "Shutdown requested.",
                danger: true,
                destructive: true,
              }),
            ]
          : []),
        refresh,
      ],
      logs: { defaultTailLines: 200 },
    };
  }

  if (t === CLUSTER) {
    const sections: SectionNode[] = [detailsSection(resource)];
    if (data.haStatus?.length) {
      sections.push(
        table(
          "High availability",
          [
            { key: "id", label: "Entry", mono: true },
            { key: "node", label: "Node" },
            { key: "status", label: "Status" },
          ],
          data.haStatus.map((h) => ({
            id: h.id,
            cells: { id: h.id, node: h.node, status: h.status },
          })),
        ),
      );
    }
    if (data.notBackedUp) {
      sections.push(
        table(
          "Guests without a backup job",
          [
            { key: "vmid", label: "VMID", width: "narrow" },
            { key: "name", label: "Name" },
            { key: "type", label: "Type", width: "narrow" },
          ],
          data.notBackedUp.map((g) => ({
            id: g.vmid,
            cells: { vmid: g.vmid, name: g.name, type: g.type },
          })),
        ),
      );
    }
    if (data.clusterLog?.length) {
      sections.push(
        table(
          "Cluster log",
          [
            { key: "time", label: "Time" },
            { key: "node", label: "Node" },
            { key: "user", label: "User" },
            { key: "msg", label: "Message" },
          ],
          data.clusterLog.map((l, i) => ({
            id: String(i),
            cells: {
              time: l.time.slice(0, 19).replace("T", " "),
              node: l.node,
              user: l.user,
              msg: l.msg,
            },
          })),
        ),
      );
    }
    return {
      ...base,
      subtitle: joinSubtitle(typeName, f["pveVersion"]),
      sections,
      headerActions: [
        ...(uiUrl
          ? [
              {
                kind: "action" as const,
                label: "Open web UI",
                action: { type: "open-url" as const, url: uiUrl },
              },
            ]
          : []),
        refresh,
      ],
    };
  }

  if (t === STORAGE) {
    const sections: SectionNode[] = [];
    if (data.storageStatus) {
      const s = data.storageStatus;
      sections.push({
        kind: "section",
        title: "Usage",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Used", value: `${s.usedGb} GiB` },
              { key: "Available", value: `${s.availGb} GiB` },
              { key: "Total", value: `${s.totalGb} GiB` },
              {
                key: "Usage",
                value: s.totalGb ? `${((s.usedGb / s.totalGb) * 100).toFixed(1)}%` : "-",
              },
            ],
          },
        ],
      });
    }
    sections.push(detailsSection(resource));
    if (data.content) {
      sections.push(
        table(
          "Content",
          [
            { key: "volid", label: "Volume", mono: true, width: "wide" },
            { key: "content", label: "Type", width: "narrow" },
            { key: "format", label: "Format", width: "narrow" },
            { key: "size", label: "Size" },
            { key: "vmid", label: "VMID", width: "narrow" },
            { key: "remove", label: "", width: "narrow" },
          ],
          data.content.map((c) => ({
            id: c.volid,
            cells: {
              volid: c.volid,
              content: c.content,
              format: c.format,
              size: `${c.sizeGb} GiB`,
              vmid: c.vmid,
              remove:
                c.content === "iso" ||
                c.content === "vztmpl" ||
                c.content === "snippets" ||
                c.content === "import"
                  ? action("Delete", `volume-delete:${c.volid}`, {
                      confirm: `Delete ${c.volid} from this storage?`,
                      success: "Deleted.",
                      danger: true,
                      destructive: true,
                    })
                  : "",
            },
          })),
        ),
      );
    }
    const contents = str(f["content"]).split(",");
    const downloadable = ["iso", "vztmpl", "import"].filter((c) => contents.includes(c));
    return {
      ...base,
      sections,
      headerActions: [
        ...(downloadable.length
          ? [
              prompt(
                "Download from URL…",
                "download-url",
                "Download to storage",
                [
                  {
                    key: "url",
                    label: "URL",
                    kind: "text",
                    required: true,
                    placeholder:
                      "https://releases.ubuntu.com/24.04/ubuntu-24.04.3-live-server-amd64.iso",
                  },
                  {
                    key: "content",
                    label: "Content Type",
                    kind: "select",
                    required: true,
                    defaultValue: downloadable[0] ?? "iso",
                    options: downloadable.map((c) => ({
                      id: c,
                      label:
                        c === "iso"
                          ? "ISO image"
                          : c === "vztmpl"
                            ? "Container template"
                            : "Disk image to import",
                    })),
                  },
                  {
                    key: "filename",
                    label: "File Name",
                    kind: "text",
                    required: true,
                    placeholder: "ubuntu-24.04.iso",
                  },
                  {
                    key: "checksum",
                    label: "Checksum",
                    kind: "text",
                    required: false,
                    description: "Optional; verified after download",
                  },
                  {
                    key: "checksumAlgorithm",
                    label: "Checksum Algorithm",
                    kind: "select",
                    required: false,
                    defaultValue: "sha256",
                    options: ["sha256", "sha512", "sha1", "md5"].map((a) => ({ id: a, label: a })),
                  },
                ],
                {
                  submitLabel: "Download",
                  description:
                    "The node fetches the file itself; this needs the node to reach the URL.",
                },
              ),
            ]
          : []),
        refresh,
      ],
    };
  }

  if (t === BACKUP) {
    const isLxc = f["guestType"] === "lxc";
    return {
      ...base,
      subtitle: joinSubtitle(typeName, f["storage"], f["vmid"] ? `VMID ${str(f["vmid"])}` : ""),
      headerActions: [
        prompt(
          "Restore…",
          "restore",
          "Restore backup",
          [
            {
              key: "vmid",
              label: "VMID",
              kind: "number",
              required: false,
              description:
                "Leave empty for the next free VMID. Using the original VMID overwrites that guest (it must be stopped).",
            },
            pickField("node", "Node", data.nodes, { defaultValue: str(f["node"]) }),
            pickField("storage", "Target Storage", data.storages, {
              required: false,
              defaultValue: "",
              emptyLabel: "Original storage",
            }),
            {
              key: "start",
              label: "Start after restore",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
          {
            submitLabel: "Restore",
            description: isLxc ? "Restores the container archive." : "Restores the VM archive.",
          },
        ),
        refresh,
      ],
    };
  }

  if (t === SECURITY_GROUP) {
    return {
      ...base,
      sections: [
        detailsSection(resource),
        ...(data.firewallRules
          ? [firewallTable("Rules", data.firewallRules, "group-rule-delete")]
          : []),
      ],
      headerActions: [
        prompt("Add rule…", "group-rule-add", "Add rule to security group", FIREWALL_RULE_FIELDS, {
          submitLabel: "Add rule",
        }),
        refresh,
      ],
    };
  }

  if (t === IPSET) {
    return {
      ...base,
      sections: [
        detailsSection(resource),
        ...(data.ipsetEntries
          ? [
              table(
                "Entries",
                [
                  { key: "cidr", label: "Address / CIDR", mono: true },
                  { key: "nomatch", label: "Exclude", width: "narrow" },
                  { key: "comment", label: "Comment" },
                  { key: "remove", label: "", width: "narrow" },
                ],
                data.ipsetEntries.map((e) => ({
                  id: e.cidr,
                  cells: {
                    cidr: e.cidr,
                    nomatch: e.nomatch ? "yes" : "no",
                    comment: e.comment,
                    remove: action("Remove", `ipset-remove:${e.cidr}`, {
                      confirm: `Remove ${e.cidr} from this IP set?`,
                      success: "Removed.",
                      danger: true,
                    }),
                  },
                })),
              ),
            ]
          : []),
      ],
      headerActions: [
        prompt(
          "Add entry…",
          "ipset-add",
          "Add to IP set",
          [
            {
              key: "cidr",
              label: "Address / CIDR",
              kind: "text",
              required: true,
              placeholder: "192.0.2.0/24",
            },
            {
              key: "nomatch",
              label: "Exclude (nomatch)",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
          { submitLabel: "Add" },
        ),
        refresh,
      ],
    };
  }

  if (t === HA_RESOURCE) {
    return {
      ...base,
      headerActions: [
        prompt(
          "Migrate…",
          "ha-migrate",
          "Migrate HA resource",
          [pickField("node", "Target Node", data.nodes)],
          {
            submitLabel: "Migrate",
            description: "Live-migrates the guest when possible.",
          },
        ),
        prompt(
          "Relocate…",
          "ha-relocate",
          "Relocate HA resource",
          [pickField("node", "Target Node", data.nodes)],
          {
            submitLabel: "Relocate",
            description: "Stops the guest, moves it and starts it on the target node.",
          },
        ),
        refresh,
      ],
    };
  }

  if (t === BACKUP_JOB || t === POOL || t === HA_RULE || t === FW_RULE) {
    return { ...base, subtitle: typeName, headerActions: [refresh] };
  }

  return { ...base, subtitle: typeName, headerActions: [refresh] };
}
