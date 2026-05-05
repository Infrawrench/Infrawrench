import { useEffect } from "react";
import { useUIStore } from "../store/ui.store.js";

const APP_NAME = "Infrawrench";

export function useWorkspaceTabDocumentTitle(options?: { suffix?: boolean }) {
  const suffix = options?.suffix ?? true;
  const workspaceTabs = useUIStore((s) => s.workspaceTabs);
  const activeWorkspaceTabId = useUIStore((s) => s.activeWorkspaceTabId);

  useEffect(() => {
    const active = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
    const title = active?.title?.trim();
    if (!title) {
      document.title = APP_NAME;
      return;
    }
    document.title = suffix ? `${title} | ${APP_NAME}` : title;
  }, [workspaceTabs, activeWorkspaceTabId, suffix]);
}
