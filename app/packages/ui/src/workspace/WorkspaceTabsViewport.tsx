import type { ReactNode } from "react";
import { useUIStore, type WorkspaceTab } from "../store/ui.store.js";
import { WorkspaceTabProvider } from "./WorkspaceTabContext.js";
import { workspaceTabDomId, workspaceTabPanelDomId } from "./tab-dom-ids.js";

interface WorkspaceTabsViewportProps {
  /** Maps a workspace tab to the React element that renders its content. */
  renderTabPanel: (tab: WorkspaceTab) => ReactNode;
  /**
   * When false, every tab renders hidden (display: none). Pass `false` when
   * the URL points at a non-tab route (settings, onboarding) so the viewport
   * doesn't draw on top of the route's <Outlet />. Tabs stay mounted either
   * way — SSH sessions etc. survive the route switch.
   */
  showActive?: boolean;
  /**
   * When provided, only tabs it returns true for have their content mounted.
   * Used while restored tabs are being validated against the current org, so a
   * tab persisted from another org never mounts and fires fetches that 404.
   * Omit (the default) to mount every tab.
   *
   * The (hidden, empty) panel element is still rendered for an excluded tab:
   * its tab button is in the strip either way, and its `aria-controls` must
   * resolve to something.
   */
  shouldMountTab?: (tab: WorkspaceTab) => boolean;
}

/**
 * Renders every open workspace tab as a sibling, with inactive tabs hidden
 * via `display: none`. This keeps long-lived resources inside each tab
 * (SSH sessions, k8s exec PTYs, xterm scrollback, websocket subscriptions)
 * alive when the user switches tabs.
 *
 * Each panel is wrapped in `WorkspaceTabProvider` so it can read its own
 * tab id via `useTabId()`.
 *
 * Every panel is the `role="tabpanel"` that the matching `role="tab"` button
 * in `GlobalTabBar` points at with `aria-controls`; both sides derive the ids
 * from the tab id (see `tab-dom-ids.ts`). `display: none` keeps the inactive
 * panels out of the accessibility tree, so a screen reader sees exactly one
 * panel — the selected tab's — while the DOM keeps them all alive.
 */
export function WorkspaceTabsViewport({
  renderTabPanel,
  showActive = true,
  shouldMountTab,
}: WorkspaceTabsViewportProps) {
  const tabs = useUIStore((s) => s.workspaceTabs);
  const activeTabId = useUIStore((s) => s.activeWorkspaceTabId);

  return (
    <>
      {tabs.map((tab) => {
        const mounted = shouldMountTab?.(tab) ?? true;
        const isActive = mounted && showActive && tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            id={workspaceTabPanelDomId(tab.id)}
            role="tabpanel"
            aria-labelledby={workspaceTabDomId(tab.id)}
            // `hidden` rather than unmount: the DOM and React state for
            // inactive tabs stay alive, preserving terminal sessions etc.
            style={{ display: isActive ? "flex" : "none" }}
            className="flex-col flex-1 min-h-0 min-w-0 overflow-auto"
          >
            {mounted ? (
              <WorkspaceTabProvider tabId={tab.id}>{renderTabPanel(tab)}</WorkspaceTabProvider>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
