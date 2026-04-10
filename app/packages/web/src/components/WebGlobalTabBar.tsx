import { GlobalTabBar } from "@infrawrench/ui";
import type { WorkspaceTab } from "@infrawrench/ui";

interface WebGlobalTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}

export function WebGlobalTabBar(props: WebGlobalTabBarProps) {
  return <GlobalTabBar {...props} />;
}
