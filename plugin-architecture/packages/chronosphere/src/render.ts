import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { METRICS_WINDOW_MS } from "./prom.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key the client sets so the renderer can build links into the tenant. */
export const BASE_KEY = "__base__";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

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
const mono = (content: string): SchemaNode => ({
  kind: "text",
  variant: "mono",
  content,
  copyable: true,
});

function act(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
    },
  };
}

function openUrl(label: string, url: string): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

const LABELS: Record<string, Array<[string, string, boolean?]>> = {
  monitor: [
    ["Description", "description"],
    ["Query type", "queryType"],
    ["Conditions", "conditions"],
    ["Interval", "intervalSecs"],
    ["Collection", "collectionSlug"],
    ["Bucket", "bucketSlug"],
    ["Notification policy", "notificationPolicySlug"],
    ["Labels", "labels"],
    ["Signals", "signalGrouping"],
    ["Has schedule", "scheduled"],
  ],
  "notification-policy": [
    ["Warn routes to", "warnRoute"],
    ["Critical routes to", "criticalRoute"],
    ["Overrides", "overrideCount"],
    ["Team", "teamSlug"],
  ],
  notifier: [
    ["Type", "type"],
    ["Target", "target"],
    ["Skip resolved", "skipResolved"],
  ],
  collection: [
    ["Description", "description"],
    ["Team", "teamSlug"],
    ["Default notification policy", "notificationPolicySlug"],
  ],
  bucket: [
    ["Description", "description"],
    ["Team", "teamSlug"],
    ["Default notification policy", "notificationPolicySlug"],
    ["Labels", "labels"],
  ],
  team: [
    ["Description", "description"],
    ["Members", "userEmails"],
  ],
  dashboard: [
    ["Collection", "collectionSlug"],
    ["Labels", "labels"],
  ],
  slo: [
    ["Description", "description"],
    ["Objective", "objective"],
    ["Window", "timeWindow"],
    ["Indicator", "indicator"],
    ["Burn-rate alerting", "burnRateAlerting"],
    ["Collection", "collectionSlug"],
    ["Notification policy", "notificationPolicySlug"],
  ],
  "rollup-rule": [
    ["Mode", "mode"],
    ["Output metric", "metricName"],
    ["Aggregation", "aggregation"],
    ["Matches", "filters"],
    ["Drops raw series", "dropRaw"],
    ["Bucket", "bucketSlug"],
  ],
  "drop-rule": [
    ["Mode", "mode"],
    ["Matches", "filters"],
    ["Conditional", "conditional"],
    ["Drops NaN", "dropNaN"],
  ],
  "recording-rule": [
    ["Metric", "metricName"],
    ["Interval", "intervalSecs"],
    ["Execution group", "executionGroup"],
    ["Bucket", "bucketSlug"],
  ],
  "muting-rule": [
    ["Matches", "matchers"],
    ["Starts", "startsAt"],
    ["Ends", "endsAt"],
    ["Comment", "comment"],
  ],
  "service-account": [
    ["Email", "email"],
    ["Unrestricted", "unrestricted"],
    ["Metrics restriction", "restriction"],
    ["Created", "createdAt"],
  ],
  service: [
    ["Description", "description"],
    ["Team", "teamSlug"],
    ["Notification policy", "notificationPolicySlug"],
  ],
};

function mutingActive(f: Record<string, unknown>): boolean {
  const end = Date.parse(str(f["endsAt"]));
  return !Number.isFinite(end) || end > Date.now();
}

export function statusFor(r: ResourceInstance): { status: ResourceStatus; label: string } {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "drop-rule":
    case "rollup-rule": {
      const mode = str(f["mode"]) || "ENABLED";
      return {
        status: mode === "ENABLED" ? "healthy" : mode === "PREVIEW" ? "info" : "unknown",
        label: mode,
      };
    }
    case "muting-rule":
      return mutingActive(f)
        ? { status: "info", label: "Muting" }
        : { status: "unknown", label: "Ended" };
    default:
      return {
        status: "healthy",
        label: RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId)?.displayName ?? "",
      };
  }
}

export function renderChronoDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const base = str(r.resolvedOutputs[BASE_KEY]);
  const typeName =
    RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId)?.displayName ?? r.resourceTypeId;
  const st = statusFor(r);
  let schema: DetailViewSchema;
  if (r.resourceTypeId === "tenant") {
    schema = {
      title: r.displayName,
      subtitle: "Tenant",
      status: { kind: "status-dot", status: "healthy", label: str(f["org"]) },
      sections: [
        section("Tenant", [
          kv([
            ["Organization", f["org"], true],
            ["URL", f["url"], true],
            ["Monitors", f["monitorCount"]],
            ["Collections", f["collectionCount"]],
            ["Dashboards", f["dashboardCount"]],
            ["SLOs", f["sloCount"]],
          ]),
          {
            kind: "text",
            variant: "muted",
            content: "Run PromQL against the tenant from the Query tab.",
          },
        ]),
      ],
      headerActions: openUrl("Open Chronosphere", str(f["url"])),
      sqlEditor: { connectionStringOutputKey: "promUrl", defaultQuery: "sum by (job) (up)" },
    };
  } else {
    const rows: Array<[string, unknown, boolean?]> = (LABELS[r.resourceTypeId] ?? []).map(
      ([label, key]) => [label, f[key]],
    );
    rows.push(["Slug", f["slug"], true], ["Updated", f["updatedAt"]]);
    const sections: SectionNode[] = [section(typeName, [kv(rows)])];
    if (r.resourceTypeId === "monitor" && f["query"])
      sections.push(section("Query", [mono(str(f["query"]))]));
    if (r.resourceTypeId === "recording-rule" && f["expr"])
      sections.push(section("Expression", [mono(str(f["expr"]))]));
    const actions: ActionNode[] = [];
    if (r.resourceTypeId === "drop-rule") {
      const mode = str(f["mode"]) || "ENABLED";
      if (mode !== "ENABLED")
        actions.push(act("Enable", "mode-enabled", { success: "Drop rule enabled" }));
      if (mode !== "DISABLED")
        actions.push(
          act("Disable", "mode-disabled", {
            confirm: "Stop dropping matching series? Ingest volume goes up.",
            success: "Drop rule disabled",
          }),
        );
      if (mode !== "PREVIEW")
        actions.push(act("Preview", "mode-preview", { success: "Drop rule in preview" }));
    }
    if (r.resourceTypeId === "rollup-rule") {
      actions.push(
        str(f["mode"]) === "PREVIEW"
          ? act("Enable", "mode-enabled", { success: "Rollup rule enabled" })
          : act("Preview", "mode-preview", {
              confirm: "Switch this rollup rule to preview?",
              success: "Rollup rule in preview",
            }),
      );
    }
    if (r.resourceTypeId === "muting-rule" && mutingActive(f)) {
      actions.push(
        act("End now", "end", {
          confirm: "End this muting rule now? Matching alerts notify again.",
          success: "Muting ended",
        }),
      );
    }
    if (r.resourceTypeId === "dashboard")
      actions.push(...openUrl("Open dashboard", str(r.resolvedOutputs["url"])));
    if (r.resourceTypeId === "monitor" && base)
      actions.push(...openUrl("Open in Chronosphere", `${base}/monitors/${str(f["slug"])}`));
    schema = {
      title: r.displayName,
      subtitle: joinSubtitle(typeName, f["teamSlug"] ?? f["collectionSlug"]),
      status: { kind: "status-dot", status: st.status, label: st.label },
      sections,
      headerActions: actions,
    };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderChronoSidebar(r: ResourceInstance): SidebarItemSchema {
  const st = statusFor(r);
  return {
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status: st.status, label: st.label },
  };
}
