import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { APP_BASE } from "./api.js";
import { ACTIVE_STATUSES, PULL_REQUESTS_KEY, SUMMARY_KEY } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) return "";
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

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});

const muted = (content: string): SchemaNode => ({ kind: "text", variant: "muted", content });

const openUrl = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function priceNote(acuPrice: number): SchemaNode {
  return muted(
    `Estimated at $${acuPrice} per ACU. Devin's API reports ACUs but not prices; set your contract's rate under Edit credentials.`,
  );
}

export function sessionStatus(status: string, detail: string): StatusDotNode {
  if (status === "running") {
    if (detail === "waiting_for_user" || detail === "waiting_for_approval") {
      return { kind: "status-dot", status: "degraded", label: "Waiting for input" };
    }
    return { kind: "status-dot", status: "healthy", label: "Running" };
  }
  switch (status) {
    case "new":
    case "claimed":
    case "resuming":
      return { kind: "status-dot", status: "provisioning", label: "Starting" };
    case "suspended":
      return { kind: "status-dot", status: "info", label: "Sleeping" };
    case "error":
      return { kind: "status-dot", status: "error", label: "Error" };
    case "exit":
      return { kind: "status-dot", status: "unknown", label: "Finished" };
    default:
      return { kind: "status-dot", status: "unknown", label: status || "Unknown" };
  }
}

/** What `getResource("organization")` stashes for the renderer. */
export interface OrgSummary {
  month: string;
  totalAcus: number;
  totalCost: number;
  byProduct: Array<{ product: string; acus: number; cost: number }>;
  usage?: {
    sessions?: number | undefined;
    prs_created?: number | undefined;
    prs_merged?: number | undefined;
    searches?: number | undefined;
  };
}

function renderOrganization(r: ResourceInstance, acuPrice: number): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<OrgSummary>(r.resolvedOutputs[SUMMARY_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"]],
        ["Organization ID", f["orgId"], true],
        ["ACU limit per session", f["sessionAcuLimit"]],
        ["ACU limit per cycle", f["cycleAcuLimit"]],
      ]),
    ]),
  ];
  if (summary) {
    sections.push(
      section(`Consumption this month (${summary.month})`, [
        {
          kind: "table",
          columns: [
            { key: "product", label: "Product", width: "wide" },
            { key: "acus", label: "ACUs" },
            { key: "cost", label: "Estimated cost" },
          ],
          rows: summary.byProduct.map<TableRow>((p) => ({
            cells: { product: p.product, acus: p.acus.toFixed(2), cost: usd(p.cost) },
          })),
        },
        kv([
          ["Total ACUs", summary.totalAcus.toFixed(2)],
          ["Estimated total", usd(summary.totalCost)],
        ]),
        priceNote(acuPrice),
      ]),
    );
    if (summary.usage) {
      sections.push(
        section("Activity this month", [
          kv([
            ["Sessions", summary.usage.sessions],
            ["Pull requests created", summary.usage.prs_created],
            ["Pull requests merged", summary.usage.prs_merged],
            ["Searches", summary.usage.searches],
          ]),
        ]),
      );
    }
  }
  return {
    title: r.displayName,
    subtitle: "Organization",
    status: { kind: "status-dot", status: "healthy", label: "Connected" },
    sections,
    headerActions: [openUrl("Open in Devin", `${APP_BASE}/settings`)],
  };
}

function renderSession(r: ResourceInstance, acuPrice: number): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const url = r.resolvedOutputs["url"] ?? "";
  const prs =
    parseJson<Array<{ url: string; state: string }>>(r.resolvedOutputs[PULL_REQUESTS_KEY]) ?? [];
  const sections: SectionNode[] = [
    section("Session", [
      kv([
        ["Status", status],
        ["Detail", str(f["statusDetail"]).replace(/_/g, " ")],
        ["Started by", f["user"]],
        ["Playbook", f["playbook"]],
        ["Tags", f["tags"]],
        ["Origin", f["origin"]],
        ["Category", str(f["category"]).replace(/_/g, " ")],
        ["Mode", f["mode"]],
        ["Archived", f["archived"]],
        ["Created", f["createdAt"]],
        ["Updated", f["updatedAt"]],
        ["Session ID", f["sessionId"], true],
        ["Organization", f["orgName"]],
      ]),
    ]),
    section("Consumption", [
      kv([
        ["ACUs consumed", f["acus"]],
        ["Estimated cost", usd(f["estimatedCost"])],
      ]),
      priceNote(acuPrice),
    ]),
  ];
  if (prs.length > 0) {
    sections.push(
      section("Pull requests", [
        {
          kind: "table",
          columns: [
            { key: "url", label: "Pull request", width: "wide", mono: true },
            { key: "state", label: "State" },
            { key: "open", label: "" },
          ],
          rows: prs.map<TableRow>((p) => ({
            cells: { url: p.url, state: p.state, open: openUrl("Open", p.url) },
          })),
        },
      ]),
    );
  }
  const actions: ActionNode[] = [];
  if (url) actions.push(openUrl("Open in Devin", url));
  if (ACTIVE_STATUSES.has(status)) {
    actions.push({
      kind: "action",
      label: "Terminate",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "terminate",
        confirmMessage:
          "Terminate this Devin session? Devin stops working immediately and the session cannot be resumed.",
        successMessage: "Session terminated",
        destructive: true,
      },
    });
  }
  actions.push(
    f["archived"] === true
      ? {
          kind: "action",
          label: "Unarchive",
          action: {
            type: "plugin-action",
            actionId: "unarchive",
            successMessage: "Session unarchived",
          },
        }
      : {
          kind: "action",
          label: "Archive",
          action: {
            type: "plugin-action",
            actionId: "archive",
            successMessage: "Session archived",
          },
        },
  );
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Session", str(f["orgName"])),
    status: sessionStatus(status, str(f["statusDetail"])),
    sections,
    headerActions: actions,
  };
}

function renderPlaybook(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stats = parseJson<{ sessions?: number; prsMerged?: number }>(
    r.resolvedOutputs[SUMMARY_KEY],
  );
  const sections: SectionNode[] = [
    section("Playbook", [
      kv([
        ["Title", f["title"]],
        ["Macro", f["macro"], true],
        ["Scope", f["accessType"]],
        ["Updated", f["updatedAt"]],
        ["Playbook ID", f["playbookId"], true],
        ["Organization", f["orgName"]],
      ]),
    ]),
  ];
  if (stats) {
    sections.push(
      section("Last 30 days", [
        kv([
          ["Sessions run", stats.sessions],
          ["Pull requests merged", stats.prsMerged],
        ]),
      ]),
    );
  }
  sections.push(
    section("Instructions", [{ kind: "text", variant: "mono", content: str(f["body"]) }]),
  );
  if (f["structuredOutputSchema"]) {
    sections.push(
      section("Structured output schema", [
        {
          kind: "text",
          variant: "mono",
          content: str(f["structuredOutputSchema"]),
          copyable: true,
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Playbook", str(f["macro"])),
    sections,
    headerActions: [openUrl("Open in Devin", `${APP_BASE}/settings/playbooks`)],
  };
}

function renderNote(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] !== false;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Knowledge", str(f["folder"])),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Note", [
        kv([
          ["Trigger", f["trigger"]],
          ["Pinned repository", f["pinnedRepo"]],
          ["Folder", f["folder"]],
          ["Scope", f["accessType"]],
          ["Updated", f["updatedAt"]],
          ["Note ID", f["noteId"], true],
          ["Organization", f["orgName"]],
        ]),
      ]),
      section("Content", [{ kind: "text", variant: "mono", content: str(f["body"]) }]),
    ],
    headerActions: [
      {
        kind: "action",
        label: enabled ? "Disable" : "Enable",
        action: {
          type: "plugin-action",
          actionId: enabled ? "disable" : "enable",
          successMessage: enabled ? "Note disabled" : "Note enabled",
        },
      },
      openUrl("Open in Devin", `${APP_BASE}/settings/knowledge`),
    ],
  };
}

function renderSecret(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Secret", str(f["secretType"])),
    sections: [
      section("Secret", [
        kv([
          ["Name", f["key"], true],
          ["Type", f["secretType"]],
          ["Note", f["note"]],
          ["Sensitive", f["sensitive"]],
          ["Scope", f["accessType"]],
          ["Created by", f["createdBy"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
          ["Organization", f["orgName"]],
        ]),
        muted("Devin never returns secret values. To change one, delete it and add it again."),
      ]),
    ],
  };
}

function renderMember(r: ResourceInstance, acuPrice: number): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Member", str(f["orgName"])),
    sections: [
      section("Member", [
        kv([
          ["Name", f["name"]],
          ["Email", f["email"], true],
          ["Roles", f["roles"]],
          ["User ID", f["userId"], true],
        ]),
      ]),
      section("Last 30 days", [
        kv([
          ["ACUs consumed", f["acus30d"]],
          ["Estimated cost", usd(f["cost30d"])],
        ]),
        priceNote(acuPrice),
      ]),
    ],
  };
}

function renderAutomation(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Automation", str(f["orgName"])),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Automation", [
        kv([
          ["Triggers", f["triggers"]],
          ["Last run", f["lastRunAt"]],
          ["Last run status", f["lastRunStatus"]],
          ["Next run", f["nextRunAt"]],
          ["Created by", f["createdBy"]],
          ["Automation ID", f["automationId"], true],
        ]),
      ]),
    ],
    headerActions: [
      {
        kind: "action",
        label: enabled ? "Disable" : "Enable",
        action: {
          type: "plugin-action",
          actionId: enabled ? "disable" : "enable",
          successMessage: enabled ? "Automation disabled" : "Automation enabled",
        },
      },
      openUrl("Open in Devin", `${APP_BASE}/automations`),
    ],
  };
}

export function renderDevinDetail(r: ResourceInstance, acuPrice: number): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r, acuPrice);
      break;
    case "session":
      schema = renderSession(r, acuPrice);
      break;
    case "playbook":
      schema = renderPlaybook(r);
      break;
    case "knowledge-note":
      schema = renderNote(r);
      break;
    case "secret":
      schema = renderSecret(r);
      break;
    case "member":
      schema = renderMember(r, acuPrice);
      break;
    case "automation":
      schema = renderAutomation(r);
      break;
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderDevinSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item: SidebarItemSchema = { id: r.id, label: r.displayName };
  if (r.resourceTypeId === "session") {
    item.status = sessionStatus(str(f["status"]), str(f["statusDetail"]));
  } else if (r.resourceTypeId === "automation" || r.resourceTypeId === "knowledge-note") {
    const enabled =
      r.resourceTypeId === "automation" ? f["enabled"] === true : f["enabled"] !== false;
    item.status = {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    };
  }
  return item;
}
