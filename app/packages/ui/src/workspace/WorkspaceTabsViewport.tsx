import type { ReactNode } from "react";
import { useUIStore, type WorkspaceTab } from "../store/ui.store.js";
import { WorkspaceTabProvider } from "./WorkspaceTabContext.js";

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
}

/**
 * Renders every open workspace tab as a sibling, with inactive tabs hidden
 * via `display: none`. This keeps long-lived resources inside each tab
 * (SSH sessions, k8s exec PTYs, xterm scrollback, websocket subscriptions)
 * alive when the user switches tabs.
 *
 * Each panel is wrapped in `WorkspaceTabProvider` so it can read its own
 * tab id via `useTabId()`.
 */
export function WorkspaceTabsViewport({
  renderTabPanel,
  showActive = true,
}: WorkspaceTabsViewportProps) {
  const tabs = useUIStore((s) => s.workspaceTabs);
  const activeTabId = useUIStore((s) => s.activeWorkspaceTabId);

  return (
    <>
      {tabs.map((tab) => {
        const isActive = showActive && tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            // `hidden` rather than unmount: the DOM and React state for
            // inactive tabs stay alive, preserving terminal sessions etc.
            style={{ display: isActive ? "flex" : "none" }}
            className="flex-col flex-1 min-h-0 min-w-0 overflow-auto"
          >
            <WorkspaceTabProvider tabId={tab.id}>{renderTabPanel(tab)}</WorkspaceTabProvider>
          </div>
        );
      })}
    </>
  );
}
