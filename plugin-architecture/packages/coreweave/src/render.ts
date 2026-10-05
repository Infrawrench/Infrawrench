import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { PRICING_AS_OF } from "./catalog.js";
import type { UsageSummary } from "./cost-data.js";
import { DEFAULT_METRICS_WINDOW_MS, USAGE_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes the organization summary for the renderer. */
export const SUMMARY_KEY = "__usageSummary__";

const CONSOLE = "https://console.coreweave.com";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown, digits = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function num(value: unknown, digits = 0): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function openInConsole(url: string): ActionNode {
  return { kind: "action", label: "Open in CoreWeave Console", action: { type: "open-url", url } };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function clusterStatus(status: string): ResourceStatus {
  const s = status.toLowerCase();
  if (s.includes("healthy") && !s.includes("unhealthy")) return "healthy";
  if (s.includes("running") || s.includes("ready")) return "healthy";
  if (s.includes("unhealthy") || s.includes("fail") || s.includes("error")) return "error";
  if (s.includes("creat") || s.includes("updat") || s.includes("provision")) return "provisioning";
  if (s.includes("delet")) return "info";
  return "unknown";
}

function nodePoolStatus(f: ResourceInstance["fields"]): ResourceStatus {
  if (f["state"] === "scaled-to-zero") return "info";
  const ready = str(f["ready"]);
  if (ready.startsWith("True")) return "healthy";
  if (ready.startsWith("False")) return "degraded";
  if (Number(f["queuedNodes"] ?? 0) > 0 || Number(f["inProgressNodes"] ?? 0) > 0) return "degraded";
  return "unknown";
}

function statusFor(r: ResourceInstance): ResourceStatus | undefined {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "cks-cluster":
      return clusterStatus(str(f["status"]));
    case "vpc":
      return clusterStatus(str(f["status"]));
    case "node-pool":
      return nodePoolStatus(f);
    case "access-key":
      return str(f["status"]).toLowerCase() === "active" ? "healthy" : "info";
    default:
      return undefined;
  }
}

const PRICING_NOTE = `Estimated: FOCUS export usage times your negotiated rates, else CoreWeave's published on-demand prices (read ${PRICING_AS_OF}). Credits, other discounts and tax are not included.`;

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<UsageSummary>(r.resolvedOutputs[SUMMARY_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"] ?? r.displayName],
        ["Pricing", f["pricing"]],
        ["Usage export", f["usageExport"]],
      ]),
    ]),
  ];
  if (summary) {
    sections.push(
      section("This month", [
        kv([
          ["GPU-hours", num(summary.gpuHours, 1)],
          ["Estimated spend", usd(summary.estimatedUsd)],
        ]),
        muted(PRICING_NOTE),
        ...(summary.unpricedSkus.length > 0
          ? [
              muted(
                `No published price for ${summary.unpricedSkus.join(", ")}: their usage is shown without money. Add your contract rate under Negotiated rates on the account to price it.`,
              ),
            ]
          : []),
      ]),
    );
    if (summary.bySku.length > 0) {
      sections.push(
        section("By instance type", [
          {
            kind: "table",
            columns: [
              { key: "sku", label: "SKU", mono: true, width: "wide" },
              { key: "quantity", label: "Usage" },
              { key: "usd", label: "Estimated" },
              { key: "pricing", label: "Priced at" },
            ],
            rows: summary.bySku.map<TableRow>((s) => ({
              cells: {
                sku: s.sku,
                quantity: `${num(s.quantity, 1)} ${s.unit}`.trim(),
                usd: s.pricing === "unpriced" ? "" : usd(s.usd),
                pricing:
                  s.pricing === "negotiated"
                    ? "Negotiated rate"
                    : s.pricing === "list"
                      ? "List price"
                      : "Not published",
              },
            })),
          },
        ]),
      );
    }
    if (summary.byCluster.length > 0) {
      sections.push(
        section("By cluster", [
          {
            kind: "table",
            columns: [
              { key: "cluster", label: "Cluster", width: "wide" },
              { key: "gpuHours", label: "GPU-hours" },
              { key: "usd", label: "Estimated" },
            ],
            rows: summary.byCluster.map<TableRow>((c) => ({
              cells: { cluster: c.cluster, gpuHours: num(c.gpuHours, 1), usd: usd(c.usd) },
            })),
          },
        ]),
      );
    }
    if (summary.byPlan.length > 0) {
      sections.push(
        section("By capacity plan", [
          {
            kind: "table",
            columns: [
              { key: "plan", label: "Capacity plan", width: "wide" },
              { key: "usd", label: "Estimated" },
            ],
            rows: summary.byPlan.map<TableRow>((p) => ({
              cells: { plan: p.plan, usd: usd(p.usd) },
            })),
          },
        ]),
      );
    }
  } else {
    sections.push(
      section("This month", [
        muted(
          "No usage could be read. The FOCUS usage export is in public preview and CoreWeave Support enables it per organization; Check credentials on the account says whether it is on.",
        ),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "CoreWeave organization",
    sections,
    headerActions: [openInConsole(`${CONSOLE}/billing`)],
  };
}

function renderCluster(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const name = str(f["name"]);
  const zone = str(f["zone"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("CKS cluster", zone, str(f["version"])),
    status: {
      kind: "status-dot",
      status: clusterStatus(str(f["status"])),
      label: str(f["status"]),
    },
    sections: [
      section("Cluster", [
        kv([
          ["Status", f["status"]],
          ["Zone", zone],
          ["Kubernetes version", f["version"]],
          ["Self-serve upgrade available", f["upgradeable"]],
          ["Public API server", f["public"]],
          ["API server endpoint", f["apiServerEndpoint"], true],
          ["Cluster ID", r.externalId, true],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Capacity", [
        kv([
          ["Node Pools", num(f["nodePoolCount"])],
          ["Nodes", num(f["nodeCount"])],
          ["GPUs", num(f["gpuCount"])],
          [
            "Estimated run rate",
            f["hourlyRunRate"] !== undefined ? `${usd(f["hourlyRunRate"])}/hour` : "",
          ],
        ]),
        ...(f["hourlyRunRate"] !== undefined
          ? [muted("Current Nodes at your negotiated rate or the on-demand list price.")]
          : []),
      ]),
      section("Network", [
        kv([
          ["VPC", f["vpcName"] || f["vpcId"]],
          ["Pod CIDR prefix", f["podCidrName"]],
          ["Service CIDR prefix", f["serviceCidrName"]],
          ["Internal load balancer prefixes", f["internalLbCidrNames"]],
        ]),
      ]),
    ],
    childTables: [
      {
        title: "Node Pools",
        typeId: "node-pool",
        createLabel: "Create Node Pool",
        emptyText:
          "No Node Pools yet. A new cluster has no compute until you add one, and provisioning can take up to 15 minutes.",
        columns: [
          { key: "name", label: "Name", source: { kind: "display-name" } },
          {
            key: "instanceType",
            label: "Instance type",
            source: { kind: "field", fieldKey: "instanceType" },
            format: "mono",
          },
          { key: "target", label: "Target", source: { kind: "field", fieldKey: "targetNodes" } },
          { key: "current", label: "Current", source: { kind: "field", fieldKey: "currentNodes" } },
          { key: "gpus", label: "GPUs", source: { kind: "field", fieldKey: "gpuCount" } },
          { key: "rate", label: "USD/hour", source: { kind: "field", fieldKey: "hourlyRunRate" } },
        ],
      },
    ],
    headerActions: [
      openInConsole(
        zone && name
          ? `${CONSOLE}/zones/${encodeURIComponent(zone)}/clusters/${encodeURIComponent(name)}/node-pools`
          : `${CONSOLE}/clusters`,
      ),
    ],
  };
}

function renderNodePool(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const scaledToZero = f["state"] === "scaled-to-zero";
  const actions: ActionNode[] = [
    scaledToZero
      ? {
          kind: "action",
          label: "Restore size",
          action: {
            type: "plugin-action",
            actionId: "restore",
            successMessage: "Node Pool scaling back up",
          },
        }
      : {
          kind: "action",
          label: "Scale to zero",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: "scale-to-zero",
            confirmMessage:
              "Scale this Node Pool to zero Nodes? Running workloads are evicted. Restore size brings it back, but capacity is not held.",
            successMessage: "Node Pool scaling to zero",
          },
        },
  ];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Node Pool", str(f["clusterName"]), str(f["instanceType"])),
    status: {
      kind: "status-dot",
      status: nodePoolStatus(f),
      label: str(f["ready"]) || str(f["state"]),
    },
    sections: [
      section("Node Pool", [
        kv([
          ["Cluster", f["clusterName"]],
          ["Instance type", f["instanceType"], true],
          ["GPU", f["gpuModel"]],
          ["Compute class", f["computeClass"]],
          ["State", f["state"]],
          ["Ready", f["ready"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Size", [
        kv([
          ["Target Nodes", num(f["targetNodes"])],
          ["Current Nodes", num(f["currentNodes"])],
          ["Queued Nodes", num(f["queuedNodes"])],
          ["Booting Nodes", num(f["inProgressNodes"])],
          ["GPUs", num(f["gpuCount"])],
          ["Autoscaling", f["autoscaling"]],
          ["Autoscaler minimum", f["autoscaling"] === true ? num(f["minNodes"]) : ""],
          ["Autoscaler maximum", f["autoscaling"] === true ? num(f["maxNodes"]) : ""],
          ["Scale-down strategy", f["scaleDownStrategy"]],
        ]),
      ]),
      section("Cost", [
        kv([
          [
            "Instance price",
            f["hourlyRate"] !== undefined ? `${usd(f["hourlyRate"])}/hour` : "Not published",
          ],
          [
            "Estimated run rate",
            f["hourlyRunRate"] !== undefined ? `${usd(f["hourlyRunRate"])}/hour` : "",
          ],
        ]),
      ]),
      section("Configuration", [
        kv([
          ["Active configuration", f["nodeProfile"], true],
          ["Pending configuration", f["pendingConfiguration"]],
          ["GPU driver", f["gpuDriver"]],
        ]),
      ]),
    ],
    headerActions: actions,
  };
}

function renderInstanceType(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: str(f["name"]) || r.displayName,
    subtitle: joinSubtitle("Instance type", r.externalId, str(f["family"])),
    sections: [
      section("Hardware", [
        kv([
          ["Instance ID", r.externalId, true],
          ["GPU", f["gpuModel"]],
          ["GPUs", num(f["gpuCount"])],
          ["Memory per GPU", f["gpuMemoryGb"] !== undefined ? `${num(f["gpuMemoryGb"])} GB` : ""],
          ["CPU", f["cpuModel"]],
          ["vCPUs", num(f["vcpus"])],
          ["RAM", f["ramGb"] !== undefined ? `${num(f["ramGb"])} GB` : ""],
          ["Local storage", f["storageTb"] !== undefined ? `${num(f["storageTb"], 2)} TB` : ""],
          ["Rack-scale (NVL72)", f["rackScale"]],
        ]),
      ]),
      section("Price", [
        kv([
          ["Per instance-hour", usd(f["hourlyUsd"])],
          ["Per GPU-hour", usd(f["gpuHourlyUsd"], 4)],
          ["Per month (730 hours)", usd(f["monthlyUsd"])],
          ["Source", f["priceSource"]],
        ]),
        muted(`Published North America on-demand prices as of ${PRICING_AS_OF}.`),
      ]),
      section("Availability", [
        kv([
          ["Zones", f["zones"] || "Contact CoreWeave for availability"],
          ["Nodes in use in this account", num(f["inUseNodes"])],
        ]),
      ]),
    ],
  };
}

function renderVpc(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const prefixes = str(f["prefixes"])
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("VPC", str(f["zone"])),
    status: {
      kind: "status-dot",
      status: clusterStatus(str(f["status"])),
      label: str(f["status"]),
    },
    sections: [
      section("VPC", [
        kv([
          ["Status", f["status"]],
          ["Zone", f["zone"]],
          ["VPC ID", r.externalId, true],
          ["Host prefixes", f["hostPrefixes"]],
          ["Block public ingress", f["disablePublicServices"]],
          ["Block Internet egress", f["disablePublicAccess"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("VPC prefixes", [
        prefixes.length > 0
          ? {
              kind: "table",
              columns: [
                { key: "name", label: "Name", width: "wide" },
                { key: "cidr", label: "CIDR", mono: true },
              ],
              rows: prefixes.map<TableRow>((p) => {
                const eq = p.lastIndexOf("=");
                return { cells: { name: p.slice(0, eq), cidr: p.slice(eq + 1) } };
              }),
            }
          : muted(
              "No named prefixes. A CKS cluster needs a pod, a service and an internal load balancer prefix.",
            ),
      ]),
    ],
    headerActions: [openInConsole(`${CONSOLE}/vpcs`)],
  };
}

function renderBucket(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Object Storage bucket", str(f["zone"])),
    sections: [
      section("Bucket", [
        kv([
          ["Zone", f["zone"]],
          ["Size", f["size"]],
          [
            "Estimated monthly cost",
            f["estimatedMonthlyUsd"] !== undefined ? usd(f["estimatedMonthlyUsd"]) : "",
          ],
          ["Audit logging", f["auditLogging"]],
          ["Archive idle objects", f["archiveEnabled"]],
          [
            "Archive after",
            f["archiveEnabled"] === true && f["archiveAfterDays"] !== undefined
              ? `${num(f["archiveAfterDays"])} days without access`
              : "",
          ],
          [
            "Capacity cap",
            f["capacityCapGb"] !== undefined ? `${num(f["capacityCapGb"], 2)} GB` : "None",
          ],
          ["Created", f["createdAt"]],
        ]),
        muted(
          "Estimated at the hot-tier rate (or your negotiated object storage rate). CoreWeave bills objects by access tier, so data that has gone warm or cold costs less.",
        ),
      ]),
      section("S3 access", [
        kv([
          ["Endpoint", "https://cwobject.com", true],
          ["Region", f["zone"], true],
          ["Addressing", "Virtual-hosted"],
        ]),
      ]),
    ],
    storageBrowser: { bucketName: str(f["name"]) || r.externalId || "" },
  };
}

function renderAccessKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const active = str(f["status"]).toLowerCase() === "active";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Object Storage access key", str(f["principal"])),
    status: { kind: "status-dot", status: active ? "healthy" : "info", label: str(f["status"]) },
    sections: [
      section("Access key", [
        kv([
          ["Access key ID", f["accessKeyId"], true],
          ["Name", f["name"]],
          ["Status", f["status"]],
          ["Owner", f["principal"], true],
          ["Expires", f["expiresAt"] || "Never"],
        ]),
        muted(
          "CoreWeave suspends and reactivates keys per owner, so these actions apply to every key this principal holds.",
        ),
      ]),
    ],
    headerActions: [
      active
        ? {
            kind: "action",
            label: "Suspend owner's keys",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "suspend-principal",
              confirmMessage:
                "Suspend every Object Storage access key this principal owns? Anything using them stops authenticating until they are reactivated.",
              successMessage: "Access keys suspended",
            },
          }
        : {
            kind: "action",
            label: "Reactivate owner's keys",
            action: {
              type: "plugin-action",
              actionId: "activate-principal",
              successMessage: "Access keys reactivated",
            },
          },
    ],
  };
}

export function renderCoreWeaveDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs: number | undefined = DEFAULT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      windowMs = USAGE_METRICS_WINDOW_MS;
      break;
    case "cks-cluster":
      schema = renderCluster(r);
      break;
    case "node-pool":
      schema = renderNodePool(r);
      break;
    case "instance-type":
      schema = renderInstanceType(r);
      break;
    case "vpc":
      schema = renderVpc(r);
      break;
    case "bucket":
      schema = renderBucket(r);
      break;
    case "access-key":
      schema = renderAccessKey(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderCoreWeaveSidebar(r: ResourceInstance): SidebarItemSchema {
  const status = statusFor(r);
  return {
    id: r.id,
    label: r.displayName,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
