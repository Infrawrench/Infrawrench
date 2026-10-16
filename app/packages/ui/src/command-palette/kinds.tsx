import { msg } from "gt-react";
import type { ReactNode } from "react";
import {
  searchResultKind,
  type SearchResult,
  type SearchResultKind,
  type StarRef,
} from "@infrawrench/client-core";
import type { WorkspaceTabTarget } from "../store/ui.store.js";
import {
  costCanvasesTabTarget,
  costReportsTabTarget,
  costsTabTarget,
  dashboardTabTarget,
  logsTabTarget,
  probesTabTarget,
  queryMonitorsTabTarget,
  resourceTabTarget,
  runbooksTabTarget,
  servicesTabTarget,
  settingsTabTarget,
  slosTabTarget,
  statusPagesTabTarget,
  workflowsTabTarget,
} from "../workspace-tabs.js";
import { LogsIcon } from "../components/icons/LogsIcon.js";
import { ProbesIcon } from "../components/icons/ProbesIcon.js";
import { QueryMonitorIcon } from "../components/icons/QueryMonitorIcon.js";
import { RunbookIcon } from "../components/icons/RunbookIcon.js";
import { ServicesIcon } from "../components/icons/ServicesIcon.js";
import { SlosIcon } from "../components/icons/SlosIcon.js";
import { StatusPagesIcon } from "../components/icons/StatusPagesIcon.js";
import type { PaletteIntent } from "./intents.js";

/**
 * Group headings for each kind, gt-encoded with `msg()`: render through
 * `useMessages()`, never raw.
 */
export const PALETTE_KIND_GROUP_LABELS: Record<SearchResultKind, string> = {
  resource: msg("Resources"),
  workflow: msg("Workflows"),
  cost_report: msg("Cost reports"),
  cost_report_folder: msg("Report folders"),
  dashboard: msg("Dashboards"),
  budget: msg("Budgets"),
  cost_canvas: msg("Canvases"),
  saved_cost_filter: msg("Saved filters"),
  virtual_tag: msg("Virtual tags"),
  business_metric: msg("Business metrics"),
  scenario_model: msg("Scenario models"),
  slo: msg("SLOs"),
  service: msg("Services"),
  runbook: msg("Runbooks"),
  status_page: msg("Status pages"),
  probe: msg("Probes"),
  log_query: msg("Saved log queries"),
  query_monitor: msg("Query monitors"),
};

/** What opening a hit does: the tab to open, and anything to tell its panel. */
export interface PaletteDestination {
  target: WorkspaceTabTarget;
  /** Sent once the tab is open, for kinds that live inside a larger page. */
  intent?: PaletteIntent;
}

/**
 * Where a hit opens. Kinds with a tab of their own open it by id; kinds that
 * live inside a larger page open that page and send a focus intent its panel
 * may act on (Costs switches to the sub-tab that lists the object).
 */
export function paletteDestination(
  hit: Pick<SearchResult, "id" | "kind" | "pluginId" | "resourceTypeId" | "accountId">,
): PaletteDestination {
  const kind = searchResultKind(hit);
  switch (kind) {
    case "resource":
      return {
        target: resourceTabTarget(hit.accountId, hit.id, hit.pluginId, hit.resourceTypeId),
      };
    case "workflow":
      return { target: workflowsTabTarget(hit.id) };
    case "cost_report":
      return { target: costReportsTabTarget(hit.id) };
    case "cost_report_folder":
      return { target: costReportsTabTarget() };
    case "dashboard":
      return { target: dashboardTabTarget(hit.id) };
    case "cost_canvas":
      return { target: costCanvasesTabTarget(hit.id) };
    case "budget":
    case "saved_cost_filter":
    case "business_metric":
    case "scenario_model":
      return { target: costsTabTarget(), intent: { type: "focus", kind, id: hit.id } };
    case "virtual_tag":
      return { target: settingsTabTarget("virtual-tags") };
    case "slo":
      return { target: slosTabTarget(hit.id) };
    case "service":
      return { target: servicesTabTarget(hit.id) };
    case "runbook":
      return { target: runbooksTabTarget(), intent: { type: "focus", kind, id: hit.id } };
    case "status_page":
      return { target: statusPagesTabTarget(), intent: { type: "focus", kind, id: hit.id } };
    case "probe":
      return { target: probesTabTarget(), intent: { type: "focus", kind, id: hit.id } };
    case "log_query":
      return { target: logsTabTarget(), intent: { type: "focus", kind, id: hit.id } };
    case "query_monitor":
      return { target: queryMonitorsTabTarget(), intent: { type: "focus", kind, id: hit.id } };
  }
}

/**
 * The starrable object a workspace tab shows, when it shows exactly one: what
 * lets a recent tab be starred from the palette. Null for list pages and
 * views without an object identity (settings, a resource's SSH session).
 */
export function starRefFromTarget(target: WorkspaceTabTarget): StarRef | null {
  switch (target.kind) {
    case "dashboard":
      return target.dashboardId ? { kind: "dashboard", id: target.dashboardId } : null;
    case "cost-reports":
      return target.reportId ? { kind: "cost_report", id: target.reportId } : null;
    case "cost-canvases":
      return target.canvasId ? { kind: "cost_canvas", id: target.canvasId } : null;
    case "slos":
      return target.sloId ? { kind: "slo", id: target.sloId } : null;
    case "services":
      return target.serviceId && !target.view ? { kind: "service", id: target.serviceId } : null;
    case "workflows":
      return target.workflowId ? { kind: "workflow", id: target.workflowId } : null;
    case "resource":
      return !target.view || target.view === "details"
        ? { kind: "resource", id: target.resourceId }
        : null;
    default:
      return null;
  }
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A small, stroke-drawn glyph per kind; decorative (the group heading names it). */
export function PaletteKindIcon({ kind }: { kind: SearchResultKind | "action" | "recent" }) {
  switch (kind) {
    case "slo":
      return <SlosIcon />;
    case "service":
      return <ServicesIcon />;
    case "runbook":
      return <RunbookIcon />;
    case "status_page":
      return <StatusPagesIcon />;
    case "probe":
      return <ProbesIcon />;
    case "log_query":
      return <LogsIcon />;
    case "query_monitor":
      return <QueryMonitorIcon />;
    case "resource":
      return (
        <Glyph>
          <path d="M21 8l-9-5-9 5 9 5 9-5z" />
          <path d="M3 8v8l9 5 9-5V8" />
          <path d="M12 13v8" />
        </Glyph>
      );
    case "workflow":
      return (
        <Glyph>
          <rect width="8" height="8" x="3" y="3" rx="2" />
          <path d="M7 11v4a2 2 0 0 0 2 2h4" />
          <rect width="8" height="8" x="13" y="13" rx="2" />
        </Glyph>
      );
    case "cost_report":
      return (
        <Glyph>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6" />
          <path d="M8 17v-3M12 17v-6M16 17v-4" />
        </Glyph>
      );
    case "cost_report_folder":
      return (
        <Glyph>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </Glyph>
      );
    case "dashboard":
      return (
        <Glyph>
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </Glyph>
      );
    case "budget":
      return (
        <Glyph>
          <path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
          <path d="M4 7l11-3v3" />
          <circle cx="16" cy="13.5" r="1" />
        </Glyph>
      );
    case "cost_canvas":
      return (
        <Glyph>
          <path d="M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z" />
          <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
        </Glyph>
      );
    case "saved_cost_filter":
      return (
        <Glyph>
          <path d="M3 4h18l-7 8v6l-4 2v-8z" />
        </Glyph>
      );
    case "virtual_tag":
      return (
        <Glyph>
          <path d="M3 12V4h8l10 10-8 8z" />
          <circle cx="7.5" cy="8.5" r="1" />
        </Glyph>
      );
    case "business_metric":
      return (
        <Glyph>
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </Glyph>
      );
    case "scenario_model":
      return (
        <Glyph>
          <circle cx="6" cy="6" r="2" />
          <circle cx="6" cy="18" r="2" />
          <circle cx="18" cy="8" r="2" />
          <path d="M6 8v8M8 6.5c5 0 8 0 8 1.5M16 9.5C14 14 10 16 8 17" />
        </Glyph>
      );
    case "recent":
      return (
        <Glyph>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </Glyph>
      );
    case "action":
      return (
        <Glyph>
          <path d="M13 3L4 14h7l-1 7 9-11h-7z" />
        </Glyph>
      );
  }
}
