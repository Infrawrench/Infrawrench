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
import { METRICS_WINDOW_MS } from "./query.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key the client sets so the renderer can build links into the app. */
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
const muted = (content: string): SchemaNode => ({ kind: "text", variant: "muted", content });

function act(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; destructive?: boolean } = {},
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
  };
}

function openUrl(label: string, url: string): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function usd(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n)
    ? ""
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function statusFor(r: ResourceInstance): { status: ResourceStatus; label: string } {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "feature-flag":
      return f["active"] === true
        ? { status: "healthy", label: "Enabled" }
        : { status: "unknown", label: "Disabled" };
    case "experiment": {
      const s = str(f["status"]);
      return {
        status:
          s === "running"
            ? "healthy"
            : s === "paused"
              ? "degraded"
              : s === "draft"
                ? "info"
                : "unknown",
        label: s || "Experiment",
      };
    }
    case "hog-function":
      return f["enabled"] === true
        ? { status: "healthy", label: str(f["type"]) || "Enabled" }
        : { status: "unknown", label: "Disabled" };
    case "batch-export": {
      if (f["paused"] === true) return { status: "unknown", label: "Paused" };
      const last = str(f["lastRunStatus"]);
      return {
        status: last === "Failed" || last === "FailedRetryable" ? "error" : "healthy",
        label: last || "Active",
      };
    }
    case "cohort":
      return f["isCalculating"] === true
        ? { status: "provisioning", label: "Calculating" }
        : { status: "info", label: `${str(f["count"]) || "0"} persons` };
    default:
      return {
        status: "info",
        label: RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId)?.displayName ?? "",
      };
  }
}

function projectApp(r: ResourceInstance): string {
  const base = str(r.resolvedOutputs[BASE_KEY]);
  const project = str(r.fields["projectId"]);
  return base && project ? `${base}/project/${project}` : "";
}

export function renderPostHogDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const st = statusFor(r);
  const app = projectApp(r);
  const id = str(r.externalId).split("/").pop() ?? "";
  const typeName =
    RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId)?.displayName ?? r.resourceTypeId;
  let sections: SectionNode[] = [];
  let actions: ActionNode[] = [];
  let extra: Partial<DetailViewSchema> = {};
  switch (r.resourceTypeId) {
    case "organization":
      sections = [
        section("Organization", [
          kv([
            ["Name", f["name"]],
            ["Slug", f["slug"], true],
            ["Plan", f["plan"]],
            ["Members", f["memberCount"]],
            ["Projects", f["projectCount"]],
            ["Region", f["region"]],
            ["Organization ID", r.externalId, true],
          ]),
        ]),
        section("Billing period", [
          kv([
            ["Spend so far", usd(f["currentTotalUsd"])],
            ["Projected", usd(f["projectedTotalUsd"])],
            ["Period ends", f["periodEnd"]],
          ]),
          muted(
            "Spend comes from PostHog's billing service and needs the billing:read scope. Self-hosted instances have none.",
          ),
        ]),
      ];
      actions = openUrl(
        "Open billing",
        str(r.resolvedOutputs[BASE_KEY])
          ? `${str(r.resolvedOutputs[BASE_KEY])}/organization/billing`
          : "",
      );
      break;
    case "project":
      sections = [
        section("Project", [
          kv([
            ["Project ID", f["projectId"], true],
            ["Time zone", f["timezone"]],
            ["Has events", f["ingestedEvent"] === true],
            ["Demo", f["isDemo"] === true ? true : undefined],
            ["Region", f["region"]],
            ["API host", r.resolvedOutputs["apiHost"], true],
            ["Project API key", r.resolvedOutputs["projectApiKey"], true],
          ]),
          muted(
            "Run HogQL against this project from the Query tab, for example SELECT event, count() FROM events GROUP BY event.",
          ),
        ]),
      ];
      actions = openUrl(
        "Open PostHog",
        str(r.resolvedOutputs[BASE_KEY])
          ? `${str(r.resolvedOutputs[BASE_KEY])}/project/${str(f["projectId"])}`
          : "",
      );
      extra = {
        sqlEditor: {
          connectionStringOutputKey: "projectId",
          defaultQuery:
            "SELECT event, count() AS c FROM events WHERE timestamp > now() - INTERVAL 1 DAY GROUP BY event ORDER BY c DESC LIMIT 50",
        },
      };
      break;
    case "feature-flag": {
      const active = f["active"] === true;
      sections = [
        section("Feature flag", [
          kv([
            ["Key", f["key"], true],
            ["Description", f["name"]],
            ["Enabled", active],
            [
              "Rollout",
              f["rolloutPercentage"] !== undefined ? `${str(f["rolloutPercentage"])}%` : "",
            ],
            ["Release conditions", f["conditionCount"]],
            ["Variants", f["variants"]],
            ["Tags", f["tags"]],
            ["Status", f["status"]],
            ["Last evaluated", f["lastCalledAt"]],
            ["Created", f["createdAt"]],
          ]),
        ]),
        section("Filters", [
          { kind: "text", variant: "mono", content: str(f["filtersJson"]) || "{}", copyable: true },
        ]),
      ];
      actions = [
        ...openUrl("Open in PostHog", app ? `${app}/feature_flags/${id}` : ""),
        active
          ? act("Turn off", "disable", {
              confirm:
                "Turn this flag off? Every user gets the off value until it is turned back on.",
              success: "Flag turned off",
            })
          : act("Turn on", "enable", { success: "Flag turned on" }),
        act("Roll out to everyone", "rollout-all", {
          confirm: "Roll this flag out to 100% of users?",
          success: "Rolled out to everyone",
        }),
      ];
      break;
    }
    case "experiment": {
      const s = str(f["status"]);
      sections = [
        section("Experiment", [
          kv([
            ["Description", f["description"]],
            ["Status", s],
            ["Feature flag", f["featureFlagKey"], true],
            ["Type", f["type"]],
            ["Started", f["startDate"]],
            ["Ended", f["endDate"]],
            ["Conclusion", f["conclusion"]],
            ["Archived", f["archived"] === true ? true : undefined],
          ]),
        ]),
      ];
      actions = [...openUrl("Open in PostHog", app ? `${app}/experiments/${id}` : "")];
      if (s === "draft")
        actions.push(
          act("Launch", "launch", {
            confirm: "Launch this experiment? Its flag turns on and users start getting variants.",
            success: "Experiment launched",
          }),
        );
      if (s === "running") {
        actions.push(
          act("Pause", "pause", {
            confirm: "Pause this experiment? Its flag is turned off.",
            success: "Experiment paused",
          }),
        );
        actions.push(
          act("End", "end", {
            confirm: "End this experiment? Results stop at now; the flag is left as it is.",
            success: "Experiment ended",
          }),
        );
      }
      if (s === "paused") actions.push(act("Resume", "resume", { success: "Experiment resumed" }));
      if (s === "stopped" && f["archived"] !== true)
        actions.push(act("Archive", "archive", { success: "Experiment archived" }));
      break;
    }
    case "batch-export": {
      const paused = f["paused"] === true;
      sections = [
        section("Batch export", [
          kv([
            ["Destination", f["destination"]],
            ["Model", f["model"]],
            ["Interval", f["interval"]],
            ["Paused", paused],
            ["Last run", joinSubtitle(f["lastRunStatus"], f["lastRunAt"])],
          ]),
        ]),
      ];
      actions = [
        ...openUrl("Open in PostHog", app ? `${app}/pipeline/batch-exports/${id}` : ""),
        paused
          ? act("Resume", "unpause", { success: "Batch export resumed" })
          : act("Pause", "pause", {
              confirm:
                "Pause this batch export? Missed intervals are not backfilled automatically.",
              success: "Batch export paused",
            }),
      ];
      break;
    }
    case "hog-function": {
      const enabled = f["enabled"] === true;
      sections = [
        section("Destination", [
          kv([
            ["Type", f["type"]],
            ["Template", f["template"]],
            ["Enabled", enabled],
            ["State", f["state"]],
            ["Description", f["description"]],
          ]),
        ]),
      ];
      actions = [
        ...openUrl("Open in PostHog", app ? `${app}/pipeline/destinations/hog-${id}` : ""),
        enabled
          ? act("Turn off", "disable", {
              confirm: "Turn this off? Events stop flowing to it.",
              success: "Turned off",
            })
          : act("Turn on", "enable", { success: "Turned on" }),
      ];
      break;
    }
    default: {
      const rows: Array<[string, unknown, boolean?]> = Object.entries(f)
        .filter(
          ([k]) =>
            !["projectId", "region", "filtersJson", "stepsJson", "dashboardRefs"].includes(k),
        )
        .map(([k, v]) => [
          RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId)?.fields.find((x) => x.key === k)
            ?.label ?? k,
          v,
        ]);
      sections = [section(typeName, [kv(rows)])];
      const url = str(r.resolvedOutputs["url"]);
      actions = openUrl("Open in PostHog", url);
    }
  }
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle(
        typeName,
        f["projectId"] ? `project ${str(f["projectId"])}` : f["region"],
      ),
      status: { kind: "status-dot", status: st.status, label: st.label },
      sections,
      headerActions: actions,
      ...extra,
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    METRICS_WINDOW_MS,
  );
}

export function renderPostHogSidebar(r: ResourceInstance): SidebarItemSchema {
  const st = statusFor(r);
  return {
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status: st.status, label: st.label },
  };
}
