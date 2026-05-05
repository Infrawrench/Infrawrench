import type { WorkspaceTab } from "../store/ui.store.js";

export interface GlobalTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  /** Optional wrapper around each tab item — used by desktop for drag-drop refs. */
  renderTabWrapper?: (tab: WorkspaceTab, children: React.ReactNode) => React.ReactNode;
  /** Extra className for the root container (e.g. drag-drop highlight ring). */
  className?: string | undefined;
  /** Ref callback for the root element (e.g. for droppable). */
  rootRef?: React.Ref<HTMLDivElement>;
  /** Whether to show the "drag to pin" hint when empty. Default: false. */
  showEmptyHint?: boolean | undefined;
}

export function GlobalTabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNew,
  renderTabWrapper,
  className,
  rootRef,
  showEmptyHint = false,
}: GlobalTabBarProps) {
  if (!showEmptyHint && tabs.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={`h-9 shrink-0 border-b border-border bg-surface flex items-end gap-0 overflow-x-auto overflow-y-hidden ${className ?? ""}`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {tabs.length === 0 && showEmptyHint ? (
        <div className="px-4 pb-2 text-xs text-on-surface-faint">
          Drag dashboards, accounts, or resources here to pin tabs
        </div>
      ) : (
        tabs.map((tab) => {
          const item = (
            <TabBarItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              onActivate={onActivate}
              onClose={onClose}
            />
          );
          return renderTabWrapper ? renderTabWrapper(tab, item) : item;
        })
      )}
      <button
        onClick={onNew}
        className="ml-1 self-center w-5 h-5 flex items-center justify-center rounded text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-colors text-base leading-none"
        aria-label="New tab"
        title="New tab"
      >
        +
      </button>
    </div>
  );
}

function TabBarItem({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: WorkspaceTab;
  active: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  return (
    <div
      className={`group relative min-w-0 max-w-52 flex items-center gap-1.5 px-3 h-8 rounded-t-md transition-colors cursor-pointer select-none ${
        active
          ? "bg-surface-overlay text-on-surface border border-b-0 border-border-strong"
          : "bg-transparent text-on-surface-muted border border-transparent hover:text-on-surface-secondary hover:bg-surface-overlay/50"
      }`}
      onClick={() => onActivate(tab.id)}
    >
      {active && <span className="absolute bottom-0 left-0 right-0 h-px bg-surface-overlay" />}
      <span className="truncate text-xs font-medium">{tab.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className="shrink-0 w-3.5 h-3.5 flex items-center justify-center rounded text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-colors opacity-0 group-hover:opacity-100"
        aria-label={`Close ${tab.title}`}
        title={`Close ${tab.title}`}
      >
        &times;
      </button>
    </div>
  );
}
