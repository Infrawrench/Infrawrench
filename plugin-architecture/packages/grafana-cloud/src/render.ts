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
import type { GrafanaBillSummary } from "./cost-data.js";
import { BILL_METRICS_WINDOW_MS, STACK_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes the bill the synchronous renderer needs. */
export const BILL_SUMMARY_KEY = "__billSummary__";

const PORTAL_URL = "https://grafana.com";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(value: unknown, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
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

function openUrl(label: string, url: string): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function pluginAction(
  label: string,
  actionId: string,
  opts: {
    confirm?: string;
    success?: string;
    destructive?: boolean;
    variant?: ActionNode["variant"];
  } = {},
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
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function stackStatus(status: string): ResourceStatus {
  switch (status) {
    case "active":
      return "healthy";
    case "pending":
    case "creating":
    case "provisioning":
    case "restarting":
      return "provisioning";
    case "paused":
    case "archived":
    case "archiving":
      return "unknown";
    case "deleting":
    case "deleted":
    case "error":
      return "error";
    default:
      return status ? "info" : "unknown";
  }
}

function stackUrlOf(r: ResourceInstance): string {
  return str(r.fields["url"]);
}

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const bill = parseJson<GrafanaBillSummary>(r.resolvedOutputs[BILL_SUMMARY_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"] ?? r.displayName],
        ["Slug", f["slug"], true],
        ["Plan", f["plan"]],
        ["Trial", f["trial"] === true ? true : undefined],
        ["Trial ends", f["trialEndsAt"]],
        ["Contract", f["contractType"]],
        ["Stacks", f["stackCount"]],
        ["Created", f["createdAt"]],
      ]),
    ]),
  ];
  const billChildren: SchemaNode[] = [
    kv([["Billed this month so far", usd(bill?.total ?? f["monthToDate"])]]),
    muted(
      "Usage charges by product, at your organization's rates, as Grafana bills them. The platform fee, taxes and credits are invoiced separately and are not included.",
    ),
  ];
  if (bill && bill.products.length > 0) {
    billChildren.push({
      kind: "table",
      columns: [
        { key: "product", label: "Product", width: "wide" },
        { key: "usage", label: "Usage" },
        { key: "included", label: "Included" },
        { key: "overage", label: "Billable" },
        { key: "amount", label: "Amount" },
      ],
      rows: bill.products.map<TableRow>((p) => ({
        cells: {
          product: p.product,
          usage: p.usage !== undefined ? `${num(p.usage)} ${p.unit}`.trim() : "",
          included: p.included !== undefined ? `${num(p.included)} ${p.unit}`.trim() : "",
          overage: p.overage !== undefined ? `${num(p.overage)} ${p.unit}`.trim() : "",
          amount: usd(p.amount),
        },
      })),
    });
  }
  if (bill && bill.stacks.length > 0) {
    billChildren.push({
      kind: "table",
      columns: [
        { key: "stack", label: "Stack", width: "wide" },
        { key: "amount", label: "Amount" },
      ],
      rows: bill.stacks.map<TableRow>((s) => ({
        cells: { stack: s.stack, amount: usd(s.amount) },
      })),
    });
  }
  sections.push(section(`Bill for ${bill?.month ?? "this month"}`, billChildren));
  const slug = str(f["slug"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Organization", f["plan"]),
    status: { kind: "status-dot", status: "healthy", label: str(f["plan"]) || "Organization" },
    sections,
    headerActions: openUrl(
      "Open billing",
      slug ? `${PORTAL_URL}/orgs/${encodeURIComponent(slug)}/billing` : PORTAL_URL,
    ),
  };
}

function renderStack(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const connected = f["connected"] === true;
  const outputs = r.resolvedOutputs;
  const sections: SectionNode[] = [
    section("Stack", [
      kv([
        ["Name", f["name"]],
        ["Slug", f["slug"], true],
        ["URL", f["url"], true],
        ["Description", f["description"]],
        ["Labels", f["labels"]],
        ["Region", joinSubtitle(f["regionName"], f["region"])],
        ["Cloud provider", f["provider"]],
        ["Plan", f["plan"]],
        ["Grafana version", f["version"]],
        ["Delete protection", f["deleteProtection"] === true],
        ["Stack ID", f["stackId"], true],
        ["Created", f["createdAt"]],
      ]),
    ]),
    section("Usage", [
      kv([
        ["Active series", num(f["activeSeries"], 0)],
        ["Logs (GB this month)", num(f["logsUsage"])],
        ["Traces (GB this month)", num(f["tracesUsage"])],
        ["Profiles (GB this month)", num(f["profilesUsage"])],
        ["Dashboards", f["dashboards"]],
        ["Alerts", f["alerts"]],
        ["Active users", f["activeUsers"]],
      ]),
    ]),
    section("Endpoints", [
      kv([
        ["Prometheus", outputs["prometheusUrl"], true],
        ["Prometheus user", outputs["prometheusUser"], true],
        ["Loki", outputs["lokiUrl"], true],
        ["Loki user", outputs["lokiUser"], true],
        ["Tempo", outputs["tempoUrl"], true],
        ["Tempo user", outputs["tempoUser"], true],
        ["Pyroscope", outputs["pyroscopeUrl"], true],
        ["Alertmanager", outputs["alertmanagerUrl"], true],
      ]),
    ]),
    section("Stack access", [
      muted(
        connected
          ? "Connected: Infrawrench lists this stack's dashboards, alert rules, contact points and data sources with the stored service account token. Edit the stack to replace the token."
          : "Not connected. Use Connect stack to create a service account and token for Infrawrench (needs the stack-service-accounts:write scope), or edit the stack and paste a service account token. Dashboards, alert rules, contact points and data sources appear once connected.",
      ),
      muted(
        "Synthetic checks list once a Synthetic Monitoring access token is saved on the stack (Edit).",
      ),
    ]),
  ];
  const url = stackUrlOf(r);
  const headerActions: ActionNode[] = [
    ...openUrl("Open Grafana", url),
    pluginAction(connected ? "Reconnect stack" : "Connect stack", "connect", {
      success: "Stack connected",
      ...(connected
        ? {
            confirm:
              "Create a new service account token for Infrawrench and replace the stored one?",
          }
        : {}),
    }),
    pluginAction("Restart Grafana", "restart", {
      confirm: "Restart this stack's Grafana? It is unavailable for a minute or two.",
      success: "Restart requested",
    }),
  ];
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Stack", f["region"], f["plan"]),
      status: { kind: "status-dot", status: stackStatus(status), label: status || "Stack" },
      sections,
      headerActions,
    },
    RESOURCE_TYPES,
    "stack",
    STACK_METRICS_WINDOW_MS,
  );
}

function renderStackPlugin(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const update = f["updateAvailable"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Installed plugin", f["stack"]),
    status: {
      kind: "status-dot",
      status: update ? "degraded" : "healthy",
      label: update ? "Update available" : "Up to date",
    },
    sections: [
      section("Plugin", [
        kv([
          ["Plugin", f["pluginName"]],
          ["Plugin ID", f["pluginSlug"], true],
          ["Installed version", f["version"]],
          ["Latest version", f["latestVersion"]],
          ["Stack", f["stack"]],
          ["Installed", f["installedAt"]],
        ]),
      ]),
    ],
    headerActions: [
      ...openUrl(
        "View in catalog",
        `${PORTAL_URL}/grafana/plugins/${encodeURIComponent(str(f["pluginSlug"]))}`,
      ),
      ...(update
        ? [
            pluginAction("Update to latest", "update", {
              confirm: `Update ${r.displayName} to ${str(f["latestVersion"])}? The stack's Grafana restarts to load it.`,
              success: "Plugin update requested",
            }),
          ]
        : []),
    ],
  };
}

function renderAccessPolicy(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const active = str(f["status"]) !== "inactive";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Access policy", f["region"]),
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "unknown",
      label: active ? "Active" : "Inactive",
    },
    sections: [
      section("Access policy", [
        kv([
          ["Display name", f["displayName"]],
          ["Name", f["name"], true],
          ["Applies to", f["realms"]],
          ["Allowed subnets", f["allowedSubnets"]],
          ["Region", f["region"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]),
      ]),
      section("Scopes", [
        {
          kind: "text",
          variant: "mono",
          content: str(f["scopes"]).split(", ").filter(Boolean).join("\n") || "None",
        },
      ]),
    ],
    headerActions: [
      active
        ? pluginAction("Turn off", "disable", {
            confirm:
              "Turn this access policy off? Every token minted from it is rejected until it is turned back on.",
            success: "Access policy turned off",
          })
        : pluginAction("Turn on", "enable", { success: "Access policy turned on" }),
    ],
  };
}

function renderToken(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const expiresAt = str(f["expiresAt"]);
  const expired = expiresAt !== "" && Date.parse(expiresAt) < Date.now();
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Access policy token", f["policyName"]),
    status: {
      kind: "status-dot",
      status: expired ? "error" : f["lastUsedAt"] ? "healthy" : "info",
      label: expired ? "Expired" : f["lastUsedAt"] ? "In use" : "Never used",
    },
    sections: [
      section("Token", [
        kv([
          ["Display name", f["displayName"]],
          ["Name", f["name"], true],
          ["Access policy", f["policyName"]],
          ["Expires", expiresAt || "Never"],
          ["First used", f["firstUsedAt"]],
          ["Last used", f["lastUsedAt"]],
          ["Region", f["region"]],
          ["Created", f["createdAt"]],
        ]),
        muted(
          "Grafana only shows a token's secret when it is created. Deleting the token revokes it at once.",
        ),
      ]),
    ],
  };
}

function renderMember(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Member", f["role"]),
    status: { kind: "status-dot", status: "healthy", label: str(f["role"]) || "Member" },
    sections: [
      section("Member", [
        kv([
          ["Name", f["name"]],
          ["Email", f["email"], true],
          ["Username", f["username"], true],
          ["Org role", f["role"]],
          ["MFA", typeof f["mfaEnabled"] === "boolean" ? f["mfaEnabled"] : undefined],
          ["Joined", f["joinedAt"]],
        ]),
      ]),
    ],
  };
}

function renderDashboard(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Dashboard", f["folder"], f["stack"]),
    status: { kind: "status-dot", status: "healthy", label: "Dashboard" },
    sections: [
      section("Dashboard", [
        kv([
          ["Title", f["title"]],
          ["Folder", f["folder"]],
          ["Tags", f["tags"]],
          ["Starred", f["starred"] === true ? true : undefined],
          ["UID", f["uid"], true],
          ["Stack", f["stack"]],
        ]),
      ]),
    ],
    headerActions: openUrl("Open in Grafana", str(f["url"])),
  };
}

function renderAlertRule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const paused = f["paused"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Alert rule", f["folder"], f["ruleGroup"]),
    status: {
      kind: "status-dot",
      status: paused ? "unknown" : "healthy",
      label: paused ? "Paused" : "Evaluating",
    },
    sections: [
      section("Alert rule", [
        kv([
          ["Title", f["title"]],
          ["Summary", f["summary"]],
          ["Folder", f["folder"]],
          ["Evaluation group", f["ruleGroup"]],
          ["Pending period", f["pendingPeriod"]],
          ["When there is no data", f["noDataState"]],
          ["On evaluation error", f["execErrState"]],
          ["Labels", f["labels"]],
          ["Provisioned by", f["provenance"]],
          ["Updated", f["updatedAt"]],
          ["UID", f["uid"], true],
          ["Stack", f["stack"]],
        ]),
        ...(f["provenance"]
          ? [
              muted(
                "This rule is provisioned from files or Terraform; changes made here may be overwritten the next time it is provisioned.",
              ),
            ]
          : []),
      ]),
    ],
    headerActions: [
      ...openUrl("Open in Grafana", str(f["url"])),
      paused
        ? pluginAction("Resume", "resume", { success: "Alert rule resumed" })
        : pluginAction("Pause", "pause", {
            confirm: "Pause this alert rule? It stops evaluating and notifying until resumed.",
            success: "Alert rule paused",
          }),
    ],
  };
}

function renderContactPoint(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Contact point", f["type"], f["stack"]),
    status: { kind: "status-dot", status: "healthy", label: str(f["type"]) || "Contact point" },
    sections: [
      section("Contact point", [
        kv([
          ["Name", f["name"]],
          ["Integration", f["type"]],
          ["Resolved messages off", f["disableResolveMessage"] === true ? true : undefined],
          ["Provisioned by", f["provenance"]],
          ["UID", f["uid"], true],
          ["Stack", f["stack"]],
        ]),
        muted(
          "Integration settings (addresses, webhook URLs, keys) stay in Grafana and are not copied here.",
        ),
      ]),
    ],
  };
}

function renderDatasource(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Data source", f["type"], f["stack"]),
    status: {
      kind: "status-dot",
      status: "info",
      label: f["isDefault"] === true ? "Default" : str(f["type"]) || "Data source",
    },
    sections: [
      section("Data source", [
        kv([
          ["Name", f["name"]],
          ["Type", f["type"]],
          ["URL", f["url"], true],
          ["Access", f["access"]],
          ["Default", f["isDefault"] === true ? true : undefined],
          ["Read-only", f["readOnly"] === true ? true : undefined],
          ["UID", f["uid"], true],
          ["Stack", f["stack"]],
        ]),
      ]),
    ],
    headerActions: [
      ...openUrl("Open in Grafana", str(f["grafanaUrl"])),
      pluginAction("Test connection", "test", { success: "Data source is working" }),
    ],
  };
}

function renderSyntheticCheck(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Synthetic check", str(f["type"]).toUpperCase(), f["stack"]),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Check", [
        kv([
          ["Job", f["job"]],
          ["Target", f["target"], true],
          ["Type", f["type"]],
          [
            "Frequency",
            f["frequencySeconds"] !== undefined ? `${str(f["frequencySeconds"])} s` : "",
          ],
          ["Timeout", f["timeoutSeconds"] !== undefined ? `${str(f["timeoutSeconds"])} s` : ""],
          ["Probes", f["probes"]],
          ["Labels", f["labels"]],
          ["Check ID", f["checkId"], true],
          ["Stack", f["stack"]],
        ]),
      ]),
    ],
    headerActions: [
      enabled
        ? pluginAction("Disable", "disable", {
            confirm: "Disable this check? It stops running from every probe until enabled.",
            success: "Check disabled",
          })
        : pluginAction("Enable", "enable", { success: "Check enabled" }),
    ],
  };
}

export function renderGrafanaDetail(r: ResourceInstance): DetailViewSchema {
  switch (r.resourceTypeId) {
    case "organization":
      return withMetricsCapability(
        renderOrganization(r),
        RESOURCE_TYPES,
        "organization",
        BILL_METRICS_WINDOW_MS,
      );
    case "stack":
      return renderStack(r);
    case "stack-plugin":
      return renderStackPlugin(r);
    case "access-policy":
      return renderAccessPolicy(r);
    case "access-policy-token":
      return renderToken(r);
    case "member":
      return renderMember(r);
    case "dashboard":
      return renderDashboard(r);
    case "alert-rule":
      return renderAlertRule(r);
    case "contact-point":
      return renderContactPoint(r);
    case "datasource":
      return renderDatasource(r);
    case "synthetic-check":
      return renderSyntheticCheck(r);
    default:
      return {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
}

export function renderGrafanaSidebar(r: ResourceInstance): SidebarItemSchema {
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
    case "stack":
      return item(stackStatus(str(f["status"])), str(f["region"]) || str(f["status"]) || "Stack");
    case "stack-plugin":
      return f["updateAvailable"] === true
        ? item("degraded", "Update available")
        : item("healthy", str(f["version"]) || "Plugin");
    case "access-policy":
      return str(f["status"]) === "inactive"
        ? item("unknown", "Inactive")
        : item("healthy", "Active");
    case "access-policy-token": {
      const exp = str(f["expiresAt"]);
      if (exp && Date.parse(exp) < Date.now()) return item("error", "Expired");
      return item(f["lastUsedAt"] ? "healthy" : "info", f["lastUsedAt"] ? "In use" : "Never used");
    }
    case "member":
      return item("healthy", str(f["role"]) || "Member");
    case "alert-rule":
      return f["paused"] === true ? item("unknown", "Paused") : item("healthy", "Evaluating");
    case "synthetic-check":
      return f["enabled"] === true
        ? item("healthy", str(f["type"]) || "Enabled")
        : item("unknown", "Disabled");
    case "contact-point":
    case "datasource":
      return item("info", str(f["type"]) || r.resourceTypeId);
    default:
      return item("info", str(f["folder"]) || "Dashboard");
  }
}
