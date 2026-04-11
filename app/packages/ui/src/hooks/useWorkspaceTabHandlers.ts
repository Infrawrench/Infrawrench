import { useCallback } from "react";
import { useUIStore, type WorkspaceTabTarget } from "../store/ui.store.js";
import type { RouteNavigator } from "../workspace-tabs.js";

interface NavigateArgs {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  replace?: boolean;
  hash?: string;
}

export function useWorkspaceTabHandlers(
  navigate: RouteNavigator,
  getNavigateArgs: (target: WorkspaceTabTarget, replace?: boolean) => NavigateArgs,
) {
  const { workspaceTabs, activeWorkspaceTabId, activateWorkspaceTab, closeWorkspaceTab } =
    useUIStore();

  const handleActivateTab = useCallback(
    (tabId: string) => {
      const tab = workspaceTabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      activateWorkspaceTab(tabId);
      void navigate(getNavigateArgs(tab.target));
    },
    [workspaceTabs, activateWorkspaceTab, navigate, getNavigateArgs],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const wasActive = activeWorkspaceTabId === tabId;
      closeWorkspaceTab(tabId);
      if (!wasActive) return;
      const nextState = useUIStore.getState();
      const nextTab = nextState.workspaceTabs.find(
        (tab) => tab.id === nextState.activeWorkspaceTabId,
      );
      if (nextTab) {
        void navigate(getNavigateArgs(nextTab.target, true));
      } else {
        void navigate({ to: "/", replace: true });
      }
    },
    [activeWorkspaceTabId, closeWorkspaceTab, navigate, getNavigateArgs],
  );

  return { handleActivateTab, handleCloseTab };
}
