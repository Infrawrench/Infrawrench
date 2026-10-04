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
import { instanceTypeLabel, lineItemCategory } from "./cost-data.js";
import { CONSOLE_URL } from "./mappers.js";
import { COST_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import type { EcCostsOverview, EcInstanceCosts, EcTiers, EcTrafficRule } from "./types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const OVERVIEW_KEY = "__overview__";
export const INSTANCE_COSTS_KEY = "__instanceCosts__";
export const TIERS_KEY = "__tiers__";
export const REGION_FILTERS_KEY = "__regionFilters__";
export const DEPLOYMENT_NAMES_KEY = "__deploymentNames__";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function openUrl(label: string, url: string | undefined): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
    },
  };
}

export function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const list = (value: unknown): string[] =>
  str(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function deploymentStatusDot(status: string, healthy: unknown): ResourceStatus {
  switch (status) {
    case "started":
      return healthy === false ? "degraded" : "healthy";
    case "initializing":
      return "provisioning";
    case "reconfiguring":
    case "restarting":
    case "rebooting":
    case "stopping":
      return "degraded";
    case "stopped":
      return "unknown";
    default:
      return healthy === false ? "error" : healthy === true ? "healthy" : "unknown";
  }
}

export function projectStatusDot(phase: string): ResourceStatus {
  switch (phase) {
    case "initialized":
      return "healthy";
    case "initializing":
      return "provisioning";
    case "suspended":
    case "deleting":
      return "degraded";
    case "":
      return "info";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const overview = parseJson<EcCostsOverview>(r.resolvedOutputs[OVERVIEW_KEY]);
  const costs = parseJson<EcInstanceCosts>(r.resolvedOutputs[INSTANCE_COSTS_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"]],
        ["Organization ID", f["organizationId"], true],
        ["Billing contacts", f["billingContacts"]],
      ]),
    ]),
    section("This month", [
      kv([
        ["Month to date", usd(overview?.costs?.total ?? f["monthToDate"])],
        ["Current hourly rate", usd(overview?.hourly_rate ?? f["hourlyRate"])],
        ["Covered by trial", overview?.trials ? usd(overview.trials) : ""],
      ]),
      muted(
        "Elastic Cloud bills in Elastic Consumption Units (ECU); one ECU has a nominal value of $1.00, so amounts are shown in US dollars.",
      ),
      ...((overview?.costs?.dimensions ?? []).length > 0
        ? [
            {
              kind: "table" as const,
              columns: [
                { key: "category", label: "Category", width: "wide" as const },
                { key: "cost", label: "Month to date" },
              ],
              rows: (overview?.costs?.dimensions ?? [])
                .filter((d) => (d.cost ?? 0) !== 0)
                .map<TableRow>((d) => ({
                  cells: { category: lineItemCategory(d.type), cost: usd(d.cost) },
                })),
            },
          ]
        : []),
    ]),
  ];
  const instances = [...(costs?.instances ?? [])].sort(
    (a, b) => (b.total_ecu ?? 0) - (a.total_ecu ?? 0),
  );
  if (instances.length > 0) {
    sections.push(
      section("Spend by deployment and project (month to date)", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Name", width: "wide" },
            { key: "type", label: "Type" },
            { key: "cost", label: "Cost" },
          ],
          rows: instances.slice(0, 100).map<TableRow>((i) => ({
            cells: {
              name: i.name || i.id || "",
              type: instanceTypeLabel(i.type),
              cost: usd(i.total_ecu),
            },
          })),
        },
      ]),
    );
  }
  const lineItems = overview?.balance?.line_items ?? [];
  if (overview?.balance) {
    sections.push(
      section("Prepaid balance", [
        kv([
          ["Remaining (ECU)", overview.balance.remaining],
          ["Available (ECU)", overview.balance.available],
        ]),
        ...(lineItems.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "id", label: "Order line", mono: true },
                  { key: "balance", label: "Remaining (ECU)" },
                  { key: "quantity", label: "Purchased (ECU)" },
                  { key: "start", label: "Starts" },
                  { key: "end", label: "Expires" },
                ],
                rows: lineItems.map<TableRow>((l) => ({
                  cells: {
                    id: str(l.id),
                    balance: str(l.ecu_balance),
                    quantity: str(l.ecu_quantity),
                    start: str(l.start).slice(0, 10),
                    end: str(l.end).slice(0, 10),
                  },
                })),
              },
            ]
          : []),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Organization",
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: openUrl("Open billing in Elastic Cloud", `${CONSOLE_URL}/billing/usage`),
  };
}

// ---------------------------------------------------------------------------
// Hosted deployment
// ---------------------------------------------------------------------------

interface TopologyRow {
  id?: string;
  size?: number;
  resource?: string;
  zones?: number;
  instanceConfiguration?: string;
  autoscalingMax?: number;
}

interface InstanceRow {
  name?: string;
  zone?: string;
  healthy?: boolean;
  capacityMb?: number;
  memoryPressure?: number;
  diskUsedMb?: number;
  diskAvailableMb?: number;
}

const gb = (mb: number | undefined) =>
  typeof mb === "number" ? `${Math.round((mb / 1024) * 100) / 100} GB` : "";

function renderDeployment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const id = str(r.externalId);
  const status = str(f["status"]);
  const topology = parseJson<TopologyRow[]>(f["topologyJson"]) ?? [];
  const instances = parseJson<InstanceRow[]>(f["instancesJson"]) ?? [];
  const tiers = parseJson<EcTiers>(r.resolvedOutputs[TIERS_KEY]);
  const regionFilters =
    parseJson<Array<{ id: string; name: string; type?: string }>>(
      r.resolvedOutputs[REGION_FILTERS_KEY],
    ) ?? [];
  const attached = new Set(list(f["trafficFilterIds"]));
  const filterNames = new Map(regionFilters.map((x) => [x.id, x.name]));
  const sections: SectionNode[] = [
    section("Deployment", [
      kv([
        ["Name", f["name"]],
        ["Status", status],
        ["Healthy", f["healthy"]],
        ["Version", f["version"]],
        ["Region", f["region"]],
        ["Hardware profile", f["template"]],
        ["Solution", f["solution"]],
        ["Total memory", f["totalMemoryGb"] !== undefined ? `${str(f["totalMemoryGb"])} GB` : ""],
        ["Autoscaling", f["autoscaling"]],
        ["Tags", f["tags"]],
        ["Alias", f["alias"]],
        ["Deployment ID", id, true],
      ]),
    ]),
    section("Endpoints", [
      kv([
        ["Elasticsearch", f["esEndpoint"], true],
        ["Kibana", f["kibanaUrl"], true],
        ["Cloud ID", f["cloudId"], true],
      ]),
    ]),
  ];
  if (topology.length > 0) {
    sections.push(
      section("Topology", [
        {
          kind: "table",
          columns: [
            { key: "tier", label: "Tier", width: "wide" },
            { key: "size", label: "Size per zone" },
            { key: "zones", label: "Zones" },
            { key: "max", label: "Autoscaling max" },
          ],
          rows: topology.map<TableRow>((t) => ({
            cells: {
              tier: str(t.id),
              size: t.resource === "memory" ? gb(t.size) : `${str(t.size)} ${str(t.resource)}`,
              zones: str(t.zones),
              max: gb(t.autoscalingMax),
            },
          })),
        },
        ...(tiers?.hot_content?.available_sizes?.length
          ? [
              muted(
                `Hot tier sizes you can pick with Edit (GB RAM per zone): ${tiers.hot_content.available_sizes
                  .map((mb) => Math.round((mb / 1024) * 100) / 100)
                  .join(", ")}.`,
              ),
            ]
          : []),
      ]),
    );
  }
  if (instances.length > 0) {
    sections.push(
      section("Elasticsearch instances", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Instance", mono: true },
            { key: "zone", label: "Zone" },
            { key: "health", label: "Health" },
            { key: "memory", label: "Memory" },
            { key: "pressure", label: "JVM memory pressure" },
            { key: "disk", label: "Disk used" },
          ],
          rows: instances.map<TableRow>((i) => ({
            cells: {
              name: str(i.name),
              zone: str(i.zone),
              health: i.healthy === false ? "Unhealthy" : "Healthy",
              memory: gb(i.capacityMb),
              pressure: typeof i.memoryPressure === "number" ? `${i.memoryPressure}%` : "",
              disk:
                typeof i.diskUsedMb === "number"
                  ? `${gb(i.diskUsedMb)}${i.diskAvailableMb ? ` of ${gb(i.diskAvailableMb)}` : ""}`
                  : "",
            },
          })),
        },
      ]),
    );
  }
  const filterRows: TableRow[] = [
    ...[...attached].map<TableRow>((fid) => ({
      cells: {
        name: filterNames.get(fid) ?? fid,
        state: "Applied",
        action: pluginAction("Remove", `detach-filter:${fid}`, {
          confirm: "Remove this traffic filter from the deployment?",
          success: "Traffic filter removed.",
          variant: "ghost",
        }),
      },
    })),
    ...regionFilters
      .filter((x) => !attached.has(x.id))
      .map<TableRow>((x) => ({
        cells: {
          name: x.name,
          state: "Not applied",
          action: pluginAction("Apply", `attach-filter:${x.id}`, {
            success: "Traffic filter applied.",
            variant: "ghost",
          }),
        },
      })),
  ];
  sections.push(
    section("Traffic filters", [
      ...(filterRows.length > 0
        ? [
            {
              kind: "table" as const,
              columns: [
                { key: "name", label: "Filter", width: "wide" as const },
                { key: "state", label: "State" },
                { key: "action", label: "" },
              ],
              rows: filterRows,
            },
          ]
        : [
            muted(
              "No traffic filters exist in this deployment's region. Create one under Traffic Filters.",
            ),
          ]),
    ]),
  );
  const esRef = str(f["esRefId"]);
  const kbRef = str(f["kibanaRefId"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Hosted deployment", f["version"], f["region"]),
    status: {
      kind: "status-dot",
      status: deploymentStatusDot(status, f["healthy"]),
      label: status || (f["healthy"] === false ? "Unhealthy" : "Deployment"),
    },
    sections,
    headerActions: [
      ...openUrl("Open Kibana", str(f["kibanaUrl"]) || undefined),
      ...openUrl("Open in Elastic Cloud", `${CONSOLE_URL}/deployments/${encodeURIComponent(id)}`),
      ...(esRef
        ? [
            pluginAction("Restart Elasticsearch", "restart-elasticsearch", {
              confirm:
                "Restart Elasticsearch? Nodes restart one availability zone at a time; a single-zone deployment is unavailable while it restarts.",
              success: "Elasticsearch restart started.",
            }),
          ]
        : []),
      ...(kbRef
        ? [
            pluginAction("Restart Kibana", "restart-kibana", {
              confirm: "Restart Kibana? It is unavailable for a minute or two.",
              success: "Kibana restart started.",
            }),
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Serverless project
// ---------------------------------------------------------------------------

function renderProject(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const phase = str(f["phase"]);
  const type = str(f["typeId"]);
  const id = str(f["projectId"]);
  const suspended = phase === "suspended" || Boolean(f["suspendedReason"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle(`${str(f["projectType"])} project`, f["region"]),
    status: {
      kind: "status-dot",
      status: suspended ? "degraded" : projectStatusDot(phase),
      label: suspended ? "Suspended" : phase || "Project",
    },
    sections: [
      section("Project", [
        kv([
          ["Name", f["name"]],
          ["Type", f["projectType"]],
          ["Status", phase],
          ["Region", f["region"]],
          ["Optimized for", f["optimizedFor"]],
          ["Product tier", f["productTier"]],
          ["Search power", f["searchPower"]],
          ["Boost window (days)", f["boostWindow"]],
          ["Tags", f["tags"]],
          ["Alias", f["alias"]],
          ["Suspended reason", f["suspendedReason"]],
          ["Created", f["createdAt"]],
          ["Project ID", id, true],
        ]),
      ]),
      section("Endpoints", [
        kv([
          ["Elasticsearch", f["esEndpoint"], true],
          ["Kibana", f["kibanaUrl"], true],
          ["APM", f["apmEndpoint"], true],
          ["Managed OTLP", f["ingestEndpoint"], true],
          ["Cloud ID", f["cloudId"], true],
        ]),
        muted(
          "The admin password is only shown when a project is created or its credentials are reset. Reset credentials stores the new password as this resource's Admin Password output.",
        ),
      ]),
    ],
    headerActions: [
      ...openUrl("Open Kibana", str(f["kibanaUrl"]) || undefined),
      ...openUrl(
        "Open in Elastic Cloud",
        type && id ? `${CONSOLE_URL}/projects/${type}/${encodeURIComponent(id)}` : undefined,
      ),
      ...(suspended
        ? [pluginAction("Resume", "resume", { success: "Project resume started." })]
        : []),
      pluginAction("Reset credentials", "reset-credentials", {
        confirm:
          "Reset the admin credentials? The current admin password stops working immediately.",
        success: "Credentials reset. The new password is in the Admin Password output.",
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Traffic filters, extensions, budgets
// ---------------------------------------------------------------------------

function rulesTable(rules: EcTrafficRule[]): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "source", label: "Source", mono: true, width: "wide" },
      { key: "description", label: "Description" },
    ],
    rows: rules.map<TableRow>((rule) => ({
      cells: {
        source:
          rule.source ??
          (rule.azure_endpoint_name
            ? `${rule.azure_endpoint_name} (${str(rule.azure_endpoint_guid)})`
            : rule.egress_rule?.target
              ? `egress ${rule.egress_rule.target} ${str(rule.egress_rule.protocol)}`
              : str(rule.remote_cluster_id)),
        description: str(rule.description),
      },
    })),
  };
}

function renderTrafficFilter(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const rules = parseJson<EcTrafficRule[]>(f["rulesJson"]) ?? [];
  const names = parseJson<Record<string, string>>(r.resolvedOutputs[DEPLOYMENT_NAMES_KEY]) ?? {};
  const deployments = list(f["deploymentIds"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Traffic filter", f["filterType"], f["region"]),
    status: { kind: "status-dot", status: "info", label: str(f["filterType"]) || "Filter" },
    sections: [
      section("Traffic filter", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Type", f["filterType"]],
          ["Region", f["region"]],
          ["Applied to new deployments", f["includeByDefault"]],
          ["Ruleset ID", r.externalId, true],
        ]),
      ]),
      section("Rules", rules.length > 0 ? [rulesTable(rules)] : [muted("No rules.")]),
      section("Deployments", [
        ...(deployments.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "name", label: "Deployment", width: "wide" as const },
                  { key: "action", label: "" },
                ],
                rows: deployments.map<TableRow>((d) => ({
                  cells: {
                    name: names[d] ?? d,
                    action: pluginAction("Remove", `detach-deployment:${d}`, {
                      confirm: "Remove this traffic filter from the deployment?",
                      success: "Traffic filter removed from the deployment.",
                      variant: "ghost",
                    }),
                  },
                })),
              },
            ]
          : []),
        muted("Apply this filter to another deployment from that deployment's page."),
      ]),
    ],
    headerActions: openUrl(
      "Open in Elastic Cloud",
      `${CONSOLE_URL}/deployment-features/traffic-filters`,
    ),
  };
}

function renderServerlessTrafficFilter(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const rules = parseJson<EcTrafficRule[]>(f["rulesJson"]) ?? [];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Serverless traffic filter", f["filterType"], f["region"]),
    status: { kind: "status-dot", status: "info", label: str(f["filterType"]) || "Filter" },
    sections: [
      section("Traffic filter", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Type", f["filterType"]],
          ["Region", f["region"]],
          ["Applied to new projects", f["includeByDefault"]],
          ["Filter ID", r.externalId, true],
        ]),
      ]),
      section("Rules", rules.length > 0 ? [rulesTable(rules)] : [muted("No rules.")]),
    ],
  };
}

function renderExtension(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Extension", f["extensionType"], f["version"]),
    status: { kind: "status-dot", status: "info", label: str(f["extensionType"]) || "Extension" },
    sections: [
      section("Extension", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Type", f["extensionType"]],
          ["Elasticsearch version", f["version"]],
          ["Download URL", f["downloadUrl"], true],
          ["Plan URL", r.resolvedOutputs["url"], true],
          ["Size", f["sizeBytes"] !== undefined ? `${str(f["sizeBytes"])} bytes` : ""],
          ["Last modified", f["lastModified"]],
          ["Used by", f["deploymentIds"]],
          ["Extension ID", r.externalId, true],
        ]),
      ]),
    ],
  };
}

function renderBudget(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const alerts =
    parseJson<
      Array<{
        operator?: string;
        threshold?: number;
        threshold_type?: string;
        last_exceeded_at?: string;
      }>
    >(f["alertsJson"]) ?? [];
  const active = f["active"] !== false;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Budget", f["scope"]),
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "unknown",
      label: active ? "Active" : "Paused",
    },
    sections: [
      section("Budget", [
        kv([
          ["Name", f["name"]],
          ["Monthly amount", f["amount"] !== undefined ? `${str(f["amount"])} ECU` : ""],
          ["Active", active],
          ["Scope", f["scope"]],
          ["Scoped to", f["scopeIds"]],
          ["Recipients", f["recipients"]],
          ["Last exceeded", f["lastExceededAt"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Alerts", [
        ...(alerts.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "threshold", label: "Threshold" },
                  { key: "exceeded", label: "Last exceeded" },
                ],
                rows: alerts.map<TableRow>((a) => ({
                  cells: {
                    threshold:
                      a.threshold_type === "percentage"
                        ? `${a.operator === "lte" ? "≤" : "≥"} ${str(a.threshold)}%`
                        : `${a.operator === "lte" ? "≤" : "≥"} ${str(a.threshold)} ECU`,
                    exceeded: str(a.last_exceeded_at),
                  },
                })),
              },
            ]
          : [muted("No alert thresholds.")]),
      ]),
    ],
    headerActions: openUrl("Open billing in Elastic Cloud", `${CONSOLE_URL}/billing/usage`),
  };
}

export function renderElasticDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      break;
    case "deployment":
      schema = renderDeployment(r);
      break;
    case "project":
      schema = renderProject(r);
      break;
    case "traffic-filter":
      schema = renderTrafficFilter(r);
      break;
    case "serverless-traffic-filter":
      schema = renderServerlessTrafficFilter(r);
      break;
    case "extension":
      schema = renderExtension(r);
      break;
    case "budget":
      schema = renderBudget(r);
      break;
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, COST_METRICS_WINDOW_MS);
}

export function renderElasticSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "organization":
      return item(
        "healthy",
        f["monthToDate"] !== undefined ? usd(f["monthToDate"]) : "Organization",
      );
    case "deployment": {
      const status = str(f["status"]);
      return item(
        deploymentStatusDot(status, f["healthy"]),
        str(f["version"]) || status || "Deployment",
      );
    }
    case "project": {
      const phase = str(f["phase"]);
      return item(projectStatusDot(phase), str(f["projectType"]) || "Project");
    }
    case "budget":
      return item(
        f["active"] === false ? "unknown" : "healthy",
        f["amount"] !== undefined ? `${str(f["amount"])} ECU` : "Budget",
      );
    case "traffic-filter":
    case "serverless-traffic-filter":
      return item("info", str(f["region"]) || "Filter");
    case "extension":
      return item("info", str(f["extensionType"]) || "Extension");
    default:
      return item("info", r.resourceTypeId);
  }
}
