import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, withMetricsCapability } from "@infrawrench/plugin-base";
import type { CvUsage } from "./api.js";
import { streamName } from "./mappers.js";
import { resourceTypes, USAGE_METRICS } from "./resource-types.js";

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};
const METRIC_LABELS = new Map(USAGE_METRICS);

function str(r: ResourceInstance, key: string): string {
  const v = r.fields[key];
  return v === undefined || v === null ? "" : String(v);
}

function details(r: ResourceInstance): SectionNode {
  const items: KVItem[] = labeledFieldItems(
    Object.fromEntries(Object.entries(r.fields).filter(([k]) => !k.startsWith("_"))),
    resourceTypes,
    r.resourceTypeId,
  ).map((item) =>
    ["Deployment URL", "HTTP Actions URL", "Domain"].includes(item.key)
      ? { ...item, copyable: true }
      : item,
  );
  return { kind: "section", title: "Details", children: [{ kind: "key-value-list", items }] };
}

function action(
  label: string,
  actionId: string,
  confirm?: string,
  destructive = false,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(confirm ? { confirmMessage: confirm } : {}),
      ...(destructive ? { destructive: true } : {}),
    },
  };
}

function link(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url }, variant: "ghost" };
}

function typeName(id: string): string {
  return resourceTypes.find((t) => t.id === id)?.displayName ?? id;
}

export function renderDetail(r: ResourceInstance): DetailViewSchema {
  const base: DetailViewSchema = {
    title: r.displayName,
    subtitle: typeName(r.resourceTypeId),
    status: { kind: "status-dot", status: "info" },
    sections: [details(r)],
    headerActions: [REFRESH],
  };

  switch (r.resourceTypeId) {
    case "convex-team":
      base.subtitle = "Convex team";
      if (str(r, "slug"))
        base.headerActions!.push(
          link("Open in Convex", `https://dashboard.convex.dev/t/${str(r, "slug")}`),
        );
      break;
    case "convex-project":
      base.subtitle = joinSubtitle("Project", str(r, "teamSlug"));
      if (str(r, "teamSlug")) {
        base.headerActions!.push(
          link(
            "Open in Convex",
            `https://dashboard.convex.dev/t/${str(r, "teamSlug")}/${str(r, "slug")}`,
          ),
        );
      }
      break;
    case "convex-deployment": {
      const name = str(r, "name");
      base.subtitle = joinSubtitle("Deployment", str(r, "deploymentType"), str(r, "region"));
      base.status = {
        kind: "status-dot",
        status: "healthy",
        label: str(r, "deploymentType"),
      };
      base.headerActions!.push(
        link("Open in Convex", `https://dashboard.convex.dev/d/${name}`),
        action(
          "Pause",
          "pause",
          "Pause this deployment? Function calls fail and cron jobs are skipped until it is unpaused; storage is still billed.",
        ),
        action("Unpause", "unpause"),
      );
      const raw = r.fields["_usage"];
      if (typeof raw === "string") {
        try {
          const usage = JSON.parse(raw) as CvUsage;
          base.sections.push({
            kind: "section",
            title: "Usage",
            children: [
              {
                kind: "table",
                columns: [
                  { key: "metric", label: "Metric" },
                  { key: "day", label: "Today" },
                  { key: "month", label: "This month" },
                  { key: "unit", label: "Unit", width: "narrow" },
                ],
                rows: Object.entries(usage.metrics).map(([metric, m]) => ({
                  cells: {
                    metric: METRIC_LABELS.get(metric) ?? metric,
                    day: String(round(m.usage.current_day)),
                    month: String(round(m.usage.current_month)),
                    unit: m.unit,
                  },
                })),
                emphasizeFirstColumn: true,
              },
              ...(usage.seedStatus !== "complete"
                ? [
                    {
                      kind: "text" as const,
                      content:
                        "Convex is still backfilling usage history, so these figures may be low.",
                      variant: "muted" as const,
                    },
                  ]
                : []),
            ],
          });
        } catch {
          /* ignore an unparseable stash */
        }
      }
      break;
    }
    case "convex-log-stream": {
      const status = str(r, "status");
      base.subtitle = joinSubtitle("Log stream", streamName(str(r, "streamType")));
      base.status = {
        kind: "status-dot",
        status: status === "active" ? "healthy" : status === "failed" ? "error" : "provisioning",
        label: status,
      };
      if (str(r, "streamType") === "webhook") {
        base.headerActions!.push(
          action(
            "Rotate signing secret",
            "rotate-secret",
            "Rotate the webhook signing secret? Update your receiver with the new secret.",
          ),
        );
      }
      break;
    }
    case "convex-custom-domain":
      base.status = {
        kind: "status-dot",
        status: r.fields["verified"] === true ? "healthy" : "provisioning",
        label: r.fields["verified"] === true ? "Verified" : "Awaiting DNS",
      };
      break;
    case "convex-usage-limit": {
      const used = Number(r.fields["currentUsage"]);
      const limit = Number(r.fields["limit"]);
      const ratio = Number.isFinite(used) && limit > 0 ? used / limit : 0;
      base.status = {
        kind: "status-dot",
        status:
          r.fields["enabled"] !== true
            ? "info"
            : ratio >= 1
              ? "error"
              : ratio >= 0.8
                ? "degraded"
                : "healthy",
        label: r.fields["enabled"] === true ? `${Math.round(ratio * 100)}% used` : "Disabled",
      };
      break;
    }
    case "convex-invite":
      base.headerActions!.push(action("Resend invitation", "resend"));
      break;
  }
  return withMetricsCapability(base, resourceTypes, r.resourceTypeId);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
  if (r.resourceTypeId === "convex-deployment") {
    return {
      id: r.id,
      label: `${r.displayName}${str(r, "deploymentType") ? ` (${str(r, "deploymentType")})` : ""}`,
      status: { kind: "status-dot", status: "healthy" },
    };
  }
  return { id: r.id, label: r.displayName, status: { kind: "status-dot", status: "info" } };
}
