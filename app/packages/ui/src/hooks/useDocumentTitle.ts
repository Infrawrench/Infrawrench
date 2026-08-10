import { useEffect } from "react";
import { useUIStore } from "../store/ui.store.js";

const APP_NAME = "Infrawrench";

/**
 * Keep `document.title` in sync with what the user is looking at.
 *
 * Two sources, in precedence order:
 * - `routeTitle` — the host passes this for *plain* routes (Moment, Admin)
 *   that render outside the workspace-tab system. While one is active the
 *   workspace tabs are all background, so the active tab's title would be
 *   stale.
 * - the active workspace tab's title otherwise.
 */
export function useWorkspaceTabDocumentTitle(options?: {
  suffix?: boolean;
  routeTitle?: string | null;
}) {
  const suffix = options?.suffix ?? true;
  const routeTitle = options?.routeTitle?.trim() || null;
  const workspaceTabs = useUIStore((s) => s.workspaceTabs);
  const activeWorkspaceTabId = useUIStore((s) => s.activeWorkspaceTabId);

  useEffect(() => {
    const active = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
    const title = routeTitle ?? active?.title?.trim();
    if (!title) {
      document.title = APP_NAME;
      return;
    }
    document.title = suffix ? `${title} | ${APP_NAME}` : title;
  }, [workspaceTabs, activeWorkspaceTabId, suffix, routeTitle]);
}
