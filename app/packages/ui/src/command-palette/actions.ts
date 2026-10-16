import { useMemo } from "react";
import { useGT, useMessages } from "gt-react";
import { useUIStore, type WorkspaceTabTarget } from "../store/ui.store.js";
import { SETTINGS_SECTIONS } from "../settings/sections.js";
import {
  costCanvasesTabTarget,
  costReportsTabTarget,
  costsTabTarget,
  incidentsTabTarget,
  logsTabTarget,
  probesTabTarget,
  runbooksTabTarget,
  servicesTabTarget,
  settingsTabTarget,
  slosTabTarget,
  statusPagesTabTarget,
  workflowsTabTarget,
} from "../workspace-tabs.js";
import { requestPaletteIntent, type PaletteCreateKind } from "./intents.js";

/**
 * One quick action. Labels arrive translated; `keywords` are extra words the
 * fuzzy matcher also tries ("new", "add"), so "add budget" finds "Create
 * budget".
 */
export interface PaletteAction {
  id: string;
  label: string;
  group: "create" | "go" | "settings" | "org";
  keywords?: readonly string[];
  /** Shown in the empty state, before anything is typed. */
  suggested?: boolean;
  run: () => void;
}

export interface PaletteOrg {
  id: string;
  name: string;
}

export interface PaletteActionContext {
  /** Open a workspace tab (the platform's `navigateToWorkspaceTarget`). */
  open: (target: WorkspaceTabTarget, label: string) => void;
  /** The caller's permission check; local desktop passes `() => true`. */
  has: (permission: string) => boolean;
  /** Cloud pages exist: always on web, with an org selected on desktop. */
  cloud: boolean;
  orgs?: readonly PaletteOrg[] | undefined;
  activeOrgId?: string | null | undefined;
  switchOrg?: ((orgId: string | null) => void) | undefined;
  /** Desktop: offer switching back to the local workspace. */
  localOption?: boolean | undefined;
}

/**
 * Create flows live in the components that render them; ask them through an
 * intent. The sidebar holds two (new dashboard, add account) and renders
 * nothing while collapsed, so expand it first.
 */
function requestCreate(kind: PaletteCreateKind) {
  if (kind === "dashboard" || kind === "account") {
    const ui = useUIStore.getState();
    if (ui.sidebarCollapsed) ui.toggleSidebar();
  }
  requestPaletteIntent({ type: "create", kind });
}

/**
 * The quick actions both apps offer: create flows, jumps to the main pages,
 * every Settings section the caller may open, and org switching. Gated by the
 * same permissions as the pages and buttons they stand in for, so an action
 * never leads to a refusal.
 */
export function usePaletteActions(ctx: PaletteActionContext): PaletteAction[] {
  const gt = useGT();
  const m = useMessages();
  const { open, has, cloud, orgs, activeOrgId, switchOrg, localOption } = ctx;

  return useMemo(() => {
    const out: PaletteAction[] = [];
    const add = (a: PaletteAction | false) => {
      if (a) out.push(a);
    };

    // Create.
    add(
      cloud &&
        has("costs:write") && {
          id: "create:cost_report",
          label: gt("Create cost report"),
          group: "create",
          keywords: [gt("new"), gt("add"), gt("report")],
          suggested: true,
          run: () => {
            open(costReportsTabTarget(), gt("Cost reports"));
            requestCreate("cost_report");
          },
        },
    );
    add(
      has("dashboards:write") && {
        id: "create:dashboard",
        label: gt("Create dashboard"),
        group: "create",
        keywords: [gt("new"), gt("add")],
        suggested: true,
        run: () => requestCreate("dashboard"),
      },
    );
    add(
      cloud &&
        has("budgets:write") && {
          id: "create:budget",
          label: gt("Create budget"),
          group: "create",
          keywords: [gt("new"), gt("add"), gt("spend limit")],
          suggested: true,
          run: () => {
            open(costsTabTarget(), gt("Costs"));
            requestCreate("budget");
          },
        },
    );
    add(
      cloud &&
        has("resources:write") && {
          id: "create:slo",
          label: gt("New SLO"),
          group: "create",
          keywords: [gt("create"), gt("add"), gt("service level objective")],
          suggested: true,
          run: () => {
            open(slosTabTarget(), gt("SLOs"));
            requestCreate("slo");
          },
        },
    );
    add(
      has("accounts:write") && {
        id: "create:account",
        label: gt("Connect account"),
        group: "create",
        keywords: [gt("add account"), gt("provider"), gt("integration")],
        suggested: true,
        run: () => requestCreate("account"),
      },
    );

    // Go to.
    const go = (
      id: string,
      label: string,
      target: WorkspaceTabTarget,
      permission: string | null,
      needsCloud = true,
    ) =>
      add(
        (!needsCloud || cloud) &&
          (!permission || has(permission)) && {
            id: `go:${id}`,
            label: gt("Go to {page}", { page: label }),
            group: "go",
            keywords: [label],
            run: () => open(target, label),
          },
      );
    go("costs", gt("Costs"), costsTabTarget(), "costs:read");
    go("cost-reports", gt("Cost reports"), costReportsTabTarget(), "costs:read");
    go("cost-canvases", gt("Canvases"), costCanvasesTabTarget(), "costs:read");
    go("slos", gt("SLOs"), slosTabTarget(), "resources:read");
    go("services", gt("Services"), servicesTabTarget(), "resources:read");
    go("incidents", gt("Incidents"), incidentsTabTarget(), "incidents:read");
    go("runbooks", gt("Runbooks"), runbooksTabTarget(), "resources:read");
    go("status-pages", gt("Status pages"), statusPagesTabTarget(), "resources:read");
    go("probes", gt("Probes"), probesTabTarget(), "resources:read");
    go("logs", gt("Logs"), logsTabTarget(), "resources:read");
    go("workflows", gt("Workflows"), workflowsTabTarget(), null, false);

    // Settings sections, the same filter both settings navs apply.
    if (cloud) {
      for (const section of SETTINGS_SECTIONS) {
        if (section.requiresPermission && !has(section.requiresPermission)) continue;
        const name = m(section.label);
        add({
          id: `settings:${section.key || "general"}`,
          label: gt("Open settings: {section}", { section: name }),
          group: "settings",
          keywords: [gt("settings"), name],
          run: () => open(settingsTabTarget(section.key || undefined), gt("Settings")),
        });
      }
    }

    // Switch org.
    if (switchOrg) {
      for (const org of orgs ?? []) {
        if (org.id === activeOrgId) continue;
        add({
          id: `org:${org.id}`,
          label: gt("Switch to {org}", { org: org.name }),
          group: "org",
          keywords: [gt("switch org"), gt("organization"), org.name],
          run: () => switchOrg(org.id),
        });
      }
      if (localOption && activeOrgId) {
        add({
          id: "org:local",
          label: gt("Switch to the local workspace"),
          group: "org",
          keywords: [gt("switch org"), gt("local"), gt("offline")],
          run: () => switchOrg(null),
        });
      }
    }
    return out;
  }, [gt, m, open, has, cloud, orgs, activeOrgId, switchOrg, localOption]);
}
