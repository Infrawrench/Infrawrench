import { createContext, useContext, type ReactNode } from "react";
import { useUIStore } from "../store/ui.store.js";

// Provided by WorkspaceTabsViewport so each rendered tab panel knows which
// tab it belongs to. Panels use useTabId() instead of activeWorkspaceTabId
// when mutating their own tab (title updates, etc), because multiple tabs
// are mounted simultaneously and only one is active.
const WorkspaceTabContext = createContext<string | null>(null);

export function WorkspaceTabProvider({ tabId, children }: { tabId: string; children: ReactNode }) {
  return <WorkspaceTabContext.Provider value={tabId}>{children}</WorkspaceTabContext.Provider>;
}

/** Tab id for the panel currently rendering, or the active tab id as a fallback. */
export function useTabId(): string | null {
  const ctx = useContext(WorkspaceTabContext);
  const activeId = useUIStore((s) => s.activeWorkspaceTabId);
  return ctx ?? activeId;
}
