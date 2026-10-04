/**
 * Detail views, sidebar items and dashboard stats.
 *
 * `enrichDetail` (see `enrich.ts`) stashes the extra reads a detail view
 * needs as JSON strings in `resolvedOutputs.__name__`; everything here is
 * synchronous over that.
 */

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
import { regionLabel } from "./regions.js";

export function parseStash<T>(resource: ResourceInstance, key: string): T | null {
  const raw = resource.resolvedOutputs[`__${key}__`];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function statusFor(resource: ResourceInstance): ResourceStatus {
  const s = String(resource.fields["status"] ?? "").toLowerCase();
  switch (resource.resourceTypeId) {
    case "linode":
      if (s === "running") return "healthy";
      if (["offline", "stopped", "billing_suspension"].includes(s)) return "error";
      if (
        [
          "booting",
          "provisioning",
          "rebooting",
          "rebuilding",
          "cloning",
          "restoring",
          "migrating",
        ].includes(s)
      )
        return "provisioning";
      if (s) return "degraded";
      return "unknown";
    case "database":
      if (s === "active") return "healthy";
      if (["provisioning", "resuming", "updating", "resizing"].includes(s)) return "provisioning";
      if (["failed"].includes(s)) return "error";
      if (s) return "degraded";
      return "unknown";
    case "volume":
      if (s === "active") return resource.fields["linodeId"] ? "healthy" : "info";
      return s ? "provisioning" : "unknown";
    case "nodebalancer": {
      const down = Number(resource.fields["nodesDown"] ?? 0);
      const up = Number(resource.fields["nodesUp"] ?? 0);
      if (down > 0 && up === 0) return "error";
      if (down > 0) return "degraded";
      return up > 0 ? "healthy" : "info";
    }
    case "firewall":
      return s === "enabled" ? "healthy" : s === "disabled" ? "degraded" : "info";
    case "domain":
      return s === "active" ? "healthy" : s ? "degraded" : "info";
    case "image":
      return s === "available" ? "healthy" : s ? "provisioning" : "info";
    case "lke-node-pool": {
      const ready = Number(resource.fields["nodesReady"] ?? 0);
      const count = Number(resource.fields["count"] ?? 0);
      return ready >= count ? "healthy" : "provisioning";
    }
    default:
      return "info";
  }
}

const HIDDEN_FIELDS: Record<string, string[]> = {
  stackscript: ["script"],
};

function detailItems(resource: ResourceInstance, types: ResourceTypeDefinition[]): KVItem[] {
  const hidden = new Set(HIDDEN_FIELDS[resource.resourceTypeId] ?? []);
  const fields = Object.fromEntries(
    Object.entries(resource.fields).filter(([k]) => !hidden.has(k)),
  );
  return labeledFieldItems(fields, types, resource.resourceTypeId).map((item) =>
    item.key === "Region"
      ? { ...item, value: `${regionLabel(String(item.value))} (${String(item.value)})` }
      : item,
  );
}

const action = (
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

const prompt = (
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
    title: opts.title ?? label,
    fields,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.submit ? { submitLabel: opts.submit } : {}),
    ...(opts.danger ? { danger: true } : {}),
    ...(opts.blocked ? { blocked: true, descriptionVariant: "error" as const } : {}),
  },
  ...(opts.danger ? { variant: "danger" as const } : {}),
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

const money = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`;
const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});

// --- per-type pieces ----------------------------------------------------------------

function linodeParts(r: ResourceInstance): { actions: ActionNode[]; sections: SectionNode[] } {
  const s = String(r.fields["status"] ?? "");
  const actions: ActionNode[] = [];
  const isLke = String(r.fields["lkeClusterId"] ?? "") !== "";
  if (s === "offline" || s === "stopped")
    actions.push(action("Boot", "boot", { success: "Boot requested." }));
  if (s === "running") {
    actions.push(
      action("Shut down", "shutdown", {
        confirm:
          "Shut this Linode down? Linode keeps billing a powered-off Linode; only deleting it stops the charges.",
        success: "Shutdown requested.",
      }),
      action("Reboot", "reboot", { confirm: "Reboot this Linode?", success: "Reboot requested." }),
    );
  }
  const plans = parseStash<SizeOption[]>(r, "plans") ?? [];
  const images = parseStash<ImageOption[]>(r, "images") ?? [];
  if (!isLke && plans.length) {
    actions.push(
      prompt(
        "Resize…",
        "resize",
        [
          {
            key: "type",
            label: "New Plan",
            kind: "size-picker",
            required: true,
            sizes: plans,
            defaultValue: String(r.fields["type"] ?? ""),
          },
          {
            key: "migrationType",
            label: "Migration",
            kind: "select",
            required: false,
            defaultValue: "cold",
            options: [
              { id: "cold", label: "Cold: power off, migrate, boot (any size change)" },
              { id: "warm", label: "Warm: stays running until a final reboot" },
            ],
          },
          {
            key: "autoDiskResize",
            label: "Resize disk automatically",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
          },
        ],
        {
          description: `Current plan: ${String(r.fields["type"] ?? "unknown")}. Moving to a smaller plan only works when the data fits on the smaller disk.`,
          submit: "Resize",
        },
      ),
    );
  }
  const backupsOn = r.fields["backupsEnabled"] === true;
  if (!isLke) {
    actions.push(
      backupsOn
        ? action("Cancel backups", "cancel_backups", {
            confirm:
              "Cancel the Backups add-on? Linode deletes every existing backup of this Linode.",
            success: "Backups cancelled.",
            danger: true,
            destructive: true,
          })
        : action("Enable backups", "enable_backups", {
            confirm: "Enable the Backups add-on? It is billed per plan on top of the Linode.",
            success: "Backups enabled.",
          }),
    );
  }
  if (backupsOn) {
    actions.push(
      prompt(
        "Take snapshot…",
        "snapshot-named",
        [
          {
            key: "label",
            label: "Snapshot Label",
            kind: "text",
            required: true,
            defaultValue: `${String(r.fields["label"] ?? "linode")}-${new Date().toISOString().slice(0, 10)}`,
          },
        ],
        {
          description:
            "Linode keeps one manual snapshot per Linode; taking a new one replaces the previous snapshot.",
          submit: "Take snapshot",
        },
      ),
    );
    const backups = parseStash<Array<{ id: number; label: string }>>(r, "backups") ?? [];
    actions.push(
      prompt(
        "Restore backup…",
        "restore-backup",
        [
          {
            key: "backupId",
            label: "Backup",
            kind: "select",
            required: true,
            options: backups.map((b) => ({ id: String(b.id), label: b.label })),
          },
          {
            key: "overwrite",
            label: "Overwrite",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "Replace the current disks" },
              { id: "false", label: "Keep the current disks (needs free space)" },
            ],
          },
        ],
        backups.length
          ? {
              description: "Restoring powers the Linode off first.",
              submit: "Restore",
              danger: true,
            }
          : { description: "No backups are available to restore yet.", blocked: true },
      ),
    );
  }
  if (images.length) {
    actions.push(
      prompt(
        "Rebuild…",
        "rebuild",
        [
          { key: "image", label: "Image", kind: "image-picker", required: true, images },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
          {
            key: "rootPass",
            label: "Root Password",
            kind: "password",
            required: false,
            description: "Leave empty to generate one",
          },
        ],
        {
          description:
            "DESTRUCTIVE: every disk on this Linode is erased and rebuilt from the image. The IP addresses are kept.",
          submit: "Rebuild",
          danger: true,
        },
      ),
    );
  }
  const sections: SectionNode[] = [];
  const transfer = parseStash<{ used?: number; quota?: number; billable?: number }>(r, "transfer");
  if (transfer) {
    sections.push(
      section("Network Transfer (this month)", [
        {
          kind: "key-value-list",
          items: [
            { key: "Used", value: `${((transfer.used ?? 0) / 1e9).toFixed(2)} GB` },
            { key: "Contributed to pool", value: `${transfer.quota ?? 0} GB` },
            { key: "Billable overage", value: `${transfer.billable ?? 0} GB` },
          ],
        },
      ]),
    );
  }
  return { actions, sections };
}

function nodeBalancerParts(r: ResourceInstance): {
  actions: ActionNode[];
  sections: SectionNode[];
} {
  const configs =
    parseStash<
      Array<{
        id: number;
        port: number;
        protocol: string;
        algorithm: string;
        check: string;
        nodes: Array<{
          id: number;
          label: string;
          address: string;
          status: string;
          weight: number;
          mode: string;
        }>;
      }>
    >(r, "configs") ?? [];
  const portOptions = configs.map((c) => ({
    id: String(c.id),
    label: `${c.port} (${c.protocol})`,
  }));
  const actions: ActionNode[] = [
    prompt(
      "+ Add port",
      "add-port",
      [
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 65534,
          defaultValue: "80",
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          defaultValue: "http",
          options: ["http", "https", "tcp", "udp"].map((p) => ({ id: p, label: p.toUpperCase() })),
        },
        {
          key: "algorithm",
          label: "Algorithm",
          kind: "select",
          required: false,
          defaultValue: "roundrobin",
          options: [
            { id: "roundrobin", label: "Round robin" },
            { id: "leastconn", label: "Least connections" },
            { id: "source", label: "Source IP" },
          ],
        },
        {
          key: "check",
          label: "Health Check",
          kind: "select",
          required: false,
          defaultValue: "connection",
          options: [
            { id: "none", label: "None" },
            { id: "connection", label: "TCP connection" },
            { id: "http", label: "HTTP status" },
            { id: "http_body", label: "HTTP body" },
          ],
        },
        {
          key: "checkPath",
          label: "Check Path",
          kind: "text",
          required: false,
          defaultValue: "/",
          showWhen: { fieldKey: "check", fieldValues: ["http", "http_body"] },
        },
        {
          key: "sslCert",
          label: "TLS Certificate (PEM)",
          kind: "code",
          required: false,
          codeLanguage: "plaintext",
          showWhen: { fieldKey: "protocol", fieldValue: "https" },
        },
        {
          key: "sslKey",
          label: "TLS Private Key (PEM)",
          kind: "code",
          required: false,
          codeLanguage: "plaintext",
          showWhen: { fieldKey: "protocol", fieldValue: "https" },
        },
      ],
      { submit: "Add port" },
    ),
    prompt(
      "+ Add backend",
      "add-node",
      [
        {
          key: "configId",
          label: "Port",
          kind: "select",
          required: true,
          options: portOptions,
          ...(portOptions[0] ? { defaultValue: portOptions[0].id } : {}),
        },
        {
          key: "address",
          label: "Backend Linode",
          kind: "resource-picker",
          required: true,
          description: "NodeBalancers reach backends on their private IPv4 address",
          associationSources: [
            { pluginId: "linode", resourceTypeId: "linode", outputKey: "ipv4Private" },
          ],
        },
        {
          key: "port",
          label: "Backend Port",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 65535,
          defaultValue: "80",
        },
        {
          key: "weight",
          label: "Weight",
          kind: "number",
          required: false,
          minValue: 1,
          maxValue: 255,
          defaultValue: "100",
        },
      ],
      portOptions.length
        ? {
            description: "The Linode needs a private IPv4 address in the same region.",
            submit: "Add backend",
          }
        : { description: "Add a port first; backends attach to a port.", blocked: true },
    ),
  ];
  const rows = configs.flatMap((c) =>
    (c.nodes.length ? c.nodes : [null]).map((n) => ({
      port: `${c.port} (${c.protocol}, ${c.algorithm})`,
      backend: n ? `${n.label} ${n.address}` : "No backends",
      status: n ? n.status : "",
      weight: n ? String(n.weight) : "",
      remove: n
        ? prompt(
            "Remove",
            "remove-node",
            [
              {
                key: "configId",
                label: "Port",
                kind: "text",
                required: true,
                defaultValue: String(c.id),
                hidden: true,
              },
              {
                key: "nodeId",
                label: "Backend",
                kind: "text",
                required: true,
                defaultValue: String(n.id),
                hidden: true,
              },
            ],
            {
              description: `Remove ${n.label} from port ${c.port}?`,
              submit: "Remove",
              danger: true,
            },
          )
        : prompt(
            "Remove port",
            "remove-port",
            [
              {
                key: "configId",
                label: "Port",
                kind: "text",
                required: true,
                defaultValue: String(c.id),
                hidden: true,
              },
            ],
            { description: `Remove port ${c.port}?`, submit: "Remove", danger: true },
          ),
    })),
  );
  const sections = configs.length
    ? [
        section("Ports and Backends", [
          table(
            [
              ["port", "Port"],
              ["backend", "Backend"],
              ["status", "Status"],
              ["weight", "Weight"],
              ["remove", ""],
            ],
            rows,
          ),
        ]),
      ]
    : [
        section("Ports and Backends", [
          {
            kind: "text",
            content: "No ports yet. Add a port, then attach backend Linodes to it.",
            variant: "muted",
          },
        ]),
      ];
  return { actions, sections };
}

function firewallParts(r: ResourceInstance): { actions: ActionNode[]; sections: SectionNode[] } {
  const rules = parseStash<{
    inbound: Array<Record<string, unknown>>;
    outbound: Array<Record<string, unknown>>;
  }>(r, "rules");
  const devices =
    parseStash<Array<{ id: number; label: string; type: string; deviceId: number }>>(
      r,
      "devices",
    ) ?? [];
  const ruleFields = (direction: string): CreateFieldConfig[] => [
    {
      key: "direction",
      label: "Direction",
      kind: "text",
      required: true,
      defaultValue: direction,
      hidden: true,
    },
    { key: "label", label: "Label", kind: "text", required: false },
    {
      key: "action",
      label: "Action",
      kind: "select",
      required: true,
      defaultValue: "ACCEPT",
      options: [
        { id: "ACCEPT", label: "Accept" },
        { id: "DROP", label: "Drop" },
      ],
    },
    {
      key: "protocol",
      label: "Protocol",
      kind: "select",
      required: true,
      defaultValue: "TCP",
      options: ["TCP", "UDP", "ICMP", "IPENCAP"].map((p) => ({ id: p, label: p })),
    },
    {
      key: "ports",
      label: "Ports",
      kind: "text",
      required: false,
      placeholder: "22, 80, 8000-9000",
      showWhen: { fieldKey: "protocol", fieldValues: ["TCP", "UDP"] },
    },
    {
      key: "addresses",
      label: "Addresses",
      kind: "string-list",
      required: false,
      addLabel: "Add IP or CIDR",
      description: "Leave empty for any address",
    },
  ];
  const actions = [
    prompt("+ Inbound rule", "add-rule", ruleFields("inbound"), { submit: "Add rule" }),
    prompt("+ Outbound rule", "add-rule", ruleFields("outbound"), { submit: "Add rule" }),
  ];
  const ruleRows = (direction: "inbound" | "outbound") =>
    (rules?.[direction] ?? []).map((ru, index) => {
      const addresses = ru["addresses"] as { ipv4?: string[]; ipv6?: string[] } | undefined;
      return {
        label: String(ru["label"] ?? ""),
        action: String(ru["action"] ?? ""),
        protocol: String(ru["protocol"] ?? ""),
        ports: String(ru["ports"] ?? "all"),
        sources: [...(addresses?.ipv4 ?? []), ...(addresses?.ipv6 ?? [])].join(", "),
        remove: prompt(
          "Remove",
          "remove-rule",
          [
            {
              key: "direction",
              label: "Direction",
              kind: "text",
              required: true,
              defaultValue: direction,
              hidden: true,
            },
            {
              key: "index",
              label: "Rule",
              kind: "text",
              required: true,
              defaultValue: String(index),
              hidden: true,
            },
          ],
          {
            description: `Remove the ${direction} rule "${String(ru["label"] ?? index)}"?`,
            submit: "Remove",
            danger: true,
          },
        ),
      };
    });
  const cols: Array<[string, string]> = [
    ["label", "Label"],
    ["action", "Action"],
    ["protocol", "Protocol"],
    ["ports", "Ports"],
    ["sources", "Addresses"],
    ["remove", ""],
  ];
  const sections: SectionNode[] = [
    section(`Inbound rules (default ${String(r.fields["inboundPolicy"] ?? "")})`, [
      table(cols, ruleRows("inbound")),
    ]),
    section(`Outbound rules (default ${String(r.fields["outboundPolicy"] ?? "")})`, [
      table(cols, ruleRows("outbound")),
    ]),
  ];
  if (devices.length) {
    sections.push(
      section("Protected devices", [
        table(
          [
            ["label", "Device"],
            ["type", "Type"],
            ["remove", ""],
          ],
          devices.map((d) => ({
            label: d.label,
            type: d.type,
            remove: prompt(
              "Remove",
              "remove-device",
              [
                {
                  key: "deviceId",
                  label: "Device",
                  kind: "text",
                  required: true,
                  defaultValue: String(d.deviceId),
                  hidden: true,
                },
              ],
              {
                description: `Stop protecting ${d.label} with this firewall?`,
                submit: "Remove",
                danger: true,
              },
            ),
          })),
        ),
      ]),
    );
  }
  return { actions, sections };
}

function vpcParts(r: ResourceInstance): { actions: ActionNode[]; sections: SectionNode[] } {
  const subnets =
    parseStash<Array<{ id: number; label: string; ipv4: string; linodes: number }>>(r, "subnets") ??
    [];
  return {
    actions: [
      prompt(
        "+ Add subnet",
        "add-subnet",
        [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "ipv4",
            label: "IPv4 Range",
            kind: "text",
            required: true,
            placeholder: "10.0.1.0/24",
          },
        ],
        { submit: "Add subnet" },
      ),
    ],
    sections: [
      section("Subnets", [
        table(
          [
            ["label", "Label"],
            ["ipv4", "Range"],
            ["linodes", "Linodes"],
            ["remove", ""],
          ],
          subnets.map((s) => ({
            label: s.label,
            ipv4: s.ipv4,
            linodes: String(s.linodes),
            remove: prompt(
              "Remove",
              "remove-subnet",
              [
                {
                  key: "subnetId",
                  label: "Subnet",
                  kind: "text",
                  required: true,
                  defaultValue: String(s.id),
                  hidden: true,
                },
              ],
              {
                description: `Delete subnet ${s.label}? It must have no Linodes attached.`,
                submit: "Delete",
                danger: true,
              },
            ),
          })),
        ),
      ]),
    ],
  };
}

function accountParts(r: ResourceInstance): SectionNode[] {
  const promos =
    parseStash<
      Array<{
        summary?: string;
        service_type?: string;
        credit_remaining?: string;
        this_month_credit_remaining?: string;
        expire_dt?: string | null;
      }>
    >(r, "promotions") ?? [];
  const regions =
    parseStash<Array<{ id?: string; used?: number; quota?: number; billable?: number }>>(
      r,
      "regionTransfers",
    ) ?? [];
  const out: SectionNode[] = [];
  out.push(
    section("Promotions and credits", [
      promos.length
        ? table(
            [
              ["summary", "Promotion"],
              ["service", "Applies to"],
              ["remaining", "Remaining"],
              ["month", "Left this month"],
              ["expires", "Expires"],
            ],
            promos.map((p) => ({
              summary: p.summary ?? "",
              service: p.service_type ?? "all",
              remaining: money(p.credit_remaining),
              month: money(p.this_month_credit_remaining),
              expires: (p.expire_dt ?? "").slice(0, 10),
            })),
          )
        : { kind: "text", content: "No active promotions.", variant: "muted" },
    ]),
  );
  if (regions.length) {
    out.push(
      section("Network transfer pool by region", [
        table(
          [
            ["region", "Region"],
            ["used", "Used (GB)"],
            ["quota", "Pool (GB)"],
            ["billable", "Billable (GB)"],
          ],
          regions.map((t) => ({
            region: t.id ? `${regionLabel(t.id)} (${t.id})` : "Global",
            used: String(t.used ?? 0),
            quota: String(t.quota ?? 0),
            billable: String(t.billable ?? 0),
          })),
        ),
      ]),
    );
  }
  return out;
}

function invoiceParts(r: ResourceInstance): SectionNode[] {
  const items = parseStash<
    Array<{
      label?: string;
      from?: string;
      to?: string;
      quantity?: number;
      unit_price?: string;
      amount?: number;
      tax?: number;
      total?: number;
      region?: string | null;
    }>
  >(r, "items");
  if (!items) return [];
  return [
    section("Line items", [
      table(
        [
          ["label", "Description"],
          ["period", "Period"],
          ["region", "Region"],
          ["quantity", "Quantity"],
          ["amount", "Amount"],
          ["tax", "Tax"],
          ["total", "Total"],
        ],
        items.map((it) => ({
          label: it.label ?? "",
          period: `${(it.from ?? "").slice(0, 10)} to ${(it.to ?? "").slice(0, 10)}`,
          region: it.region ?? "",
          quantity: it.quantity != null ? String(it.quantity) : "",
          amount: money(it.amount),
          tax: money(it.tax),
          total: money(it.total),
        })),
      ),
    ]),
  ];
}

function simpleActions(r: ResourceInstance): ActionNode[] {
  switch (r.resourceTypeId) {
    case "volume": {
      if (r.fields["linodeId"]) {
        return [
          action("Detach", "detach", {
            confirm: `Detach this volume from ${String(r.fields["linodeLabel"] || r.fields["linodeId"])}? Unmount it first.`,
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
              key: "linodeId",
              label: "Linode",
              kind: "resource-picker",
              required: true,
              description: "Must be in the same region as the volume",
              associationSources: [
                { pluginId: "linode", resourceTypeId: "linode", outputKey: "linodeId" },
              ],
            },
          ],
          { submit: "Attach" },
        ),
      ];
    }
    case "lke-cluster":
      return [
        action("Recycle all nodes", "recycle", {
          confirm:
            "Replace every worker node with a fresh one? Nodes are drained and rebuilt in turn.",
          success: "Recycle requested.",
        }),
        action("Regenerate kubeconfig", "regenerate_kubeconfig", {
          confirm:
            "Revoke the current kubeconfig and issue a new one? Everything using the old file loses access.",
          success: "Kubeconfig regenerated.",
          danger: true,
        }),
      ];
    case "lke-node-pool":
      return [
        action("Recycle nodes", "recycle", {
          confirm: "Replace every node in this pool with a fresh one?",
          success: "Recycle requested.",
        }),
      ];
    case "database": {
      const s = String(r.fields["status"] ?? "");
      const out: ActionNode[] = [];
      if (s === "active") {
        out.push(
          action("Suspend", "suspend", {
            confirm:
              "Suspend this database? It stops serving and is billed at a reduced rate until resumed.",
            success: "Suspend requested.",
          }),
        );
        out.push(
          action("Apply updates", "patch", {
            confirm: "Apply pending maintenance updates now? Expect a brief interruption.",
            success: "Updates requested.",
          }),
        );
      }
      if (s === "suspended") out.push(action("Resume", "resume", { success: "Resume requested." }));
      out.push(
        action("Reset root password", "reset_credentials", {
          confirm: "Generate a new root password? Clients using the old one disconnect.",
          success: "Credentials reset.",
          danger: true,
        }),
      );
      return out;
    }
    default:
      return [];
  }
}

export function renderDetail(
  resource: ResourceInstance,
  types: ResourceTypeDefinition[],
): DetailViewSchema {
  let actions: ActionNode[] = [];
  let extra: SectionNode[] = [];
  switch (resource.resourceTypeId) {
    case "linode": {
      const p = linodeParts(resource);
      actions = p.actions;
      extra = p.sections;
      break;
    }
    case "nodebalancer": {
      const p = nodeBalancerParts(resource);
      actions = p.actions;
      extra = p.sections;
      break;
    }
    case "firewall": {
      const p = firewallParts(resource);
      actions = p.actions;
      extra = p.sections;
      break;
    }
    case "vpc": {
      const p = vpcParts(resource);
      actions = p.actions;
      extra = p.sections;
      break;
    }
    case "account":
      extra = accountParts(resource);
      break;
    case "invoice":
      extra = invoiceParts(resource);
      break;
    case "stackscript": {
      const script = String(resource.fields["script"] ?? "");
      if (script)
        extra = [
          section("Script", [{ kind: "text", content: script, variant: "mono", copyable: true }]),
        ];
      break;
    }
    default:
      actions = simpleActions(resource);
  }
  const ipv4 = resource.resolvedOutputs["ipv4"];
  const details: SchemaNode[] = [{ kind: "key-value-list", items: detailItems(resource, types) }];
  if (resource.resourceTypeId === "linode" && ipv4) {
    details.push({
      kind: "key-value-list",
      items: [
        { key: "Public IPv4", value: ipv4, copyable: true },
        ...(resource.resolvedOutputs["ipv4Private"]
          ? [
              {
                key: "Private IPv4",
                value: resource.resolvedOutputs["ipv4Private"],
                copyable: true,
              },
            ]
          : []),
        ...(resource.resolvedOutputs["ipv6"]
          ? [{ key: "IPv6", value: resource.resolvedOutputs["ipv6"], copyable: true }]
          : []),
      ],
    });
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(types, resource.resourceTypeId),
      resource.fields["region"]
        ? regionLabel(String(resource.fields["region"]))
        : resource.fields["domainName"],
    ),
    status: { kind: "status-dot", status: statusFor(resource) },
    sections: [section("Details", details), ...extra],
    headerActions: [
      ...actions,
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
  const variant = (s: ResourceStatus): NonNullable<DashboardStat["variant"]> =>
    s === "healthy"
      ? "status-healthy"
      : s === "error"
        ? "status-error"
        : s === "degraded"
          ? "status-degraded"
          : "default";
  const st = statusFor(resource);
  const ip = resource.resolvedOutputs["ipv4"];
  switch (resource.resourceTypeId) {
    case "linode":
      return [
        { label: "Status", value: String(f["status"] ?? ""), variant: variant(st) },
        { label: "Plan", value: String(f["type"] ?? "") },
        { label: "Region", value: regionLabel(String(f["region"] ?? "")) },
        ...(ip ? [{ label: "IPv4", value: ip }] : []),
      ];
    case "volume":
      return [
        { label: "Size", value: `${String(f["sizeGb"] ?? 0)} GB` },
        { label: "Attached", value: String(f["linodeLabel"] || "No") },
      ];
    case "nodebalancer":
      return [
        {
          label: "Backends up",
          value: `${String(f["nodesUp"] ?? 0)} / ${String(f["nodeCount"] ?? 0)}`,
          variant: variant(st),
        },
        { label: "IPv4", value: String(f["ipv4"] ?? "") },
      ];
    case "lke-cluster":
      return [
        { label: "Version", value: String(f["k8sVersion"] ?? "") },
        { label: "Nodes", value: String(f["nodeCount"] ?? 0) },
        { label: "HA", value: f["highAvailability"] === true ? "Yes" : "No" },
      ];
    case "database":
      return [
        { label: "Status", value: String(f["status"] ?? ""), variant: variant(st) },
        { label: "Engine", value: `${String(f["engine"] ?? "")} ${String(f["version"] ?? "")}` },
        { label: "Nodes", value: String(f["clusterSize"] ?? 1) },
      ];
    case "bucket":
      return [
        { label: "Objects", value: String(f["objects"] ?? 0) },
        { label: "Size", value: `${(Number(f["sizeBytes"] ?? 0) / 1e9).toFixed(2)} GB` },
      ];
    case "account":
      return [
        { label: "Uninvoiced", value: money(f["uninvoiced"]) },
        { label: "Balance", value: money(f["balance"]) },
        {
          label: "Transfer",
          value: `${String(f["transferUsedGb"] ?? 0)} / ${String(f["transferQuotaGb"] ?? 0)} GB`,
        },
      ];
    default:
      return [];
  }
}
