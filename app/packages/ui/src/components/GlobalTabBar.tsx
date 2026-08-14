import { useRef, type KeyboardEvent } from "react";
import { T, useGT } from "gt-react";
import type { WorkspaceTab } from "../store/ui.store.js";
import { workspaceTabDomId, workspaceTabPanelDomId } from "../workspace/tab-dom-ids.js";

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
  const gt = useGT();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (!showEmptyHint && tabs.length === 0) return null;

  const focusTab = (index: number) => {
    const target = tabRefs.current[index];
    if (target) {
      target.focus();
      const id = tabs[index]?.id;
      if (id) onActivate(id);
    }
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusTab((index + 1) % tabs.length);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusTab((index - 1 + tabs.length) % tabs.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTab(tabs.length - 1);
    }
  };

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label={gt("Workspace tabs")}
      aria-orientation="horizontal"
      className={`h-9 shrink-0 border-b border-border bg-surface flex items-end gap-0 overflow-x-auto overflow-y-hidden ${className ?? ""}`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {tabs.length === 0 && showEmptyHint ? (
        <div className="px-4 pb-2 text-xs text-on-surface-faint">
          <T>Drag dashboards, accounts, or resources here to pin tabs</T>
        </div>
      ) : (
        tabs.map((tab, index) => {
          const item = (
            <TabBarItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              onActivate={onActivate}
              onClose={onClose}
              // Derived from the tab id rather than a useId(): the panel this
              // tab controls is rendered by WorkspaceTabsViewport, a sibling
              // component that has to arrive at the same string. See
              // workspace/tab-dom-ids.ts.
              tabId={workspaceTabDomId(tab.id)}
              panelId={workspaceTabPanelDomId(tab.id)}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              buttonRef={(el) => {
                tabRefs.current[index] = el;
              }}
            />
          );
          return renderTabWrapper ? renderTabWrapper(tab, item) : item;
        })
      )}
      <button
        type="button"
        onClick={onNew}
        className="ml-1 self-center size-5 flex items-center justify-center rounded text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-colors text-base leading-none"
        aria-label={gt("New tab")}
        title={gt("New tab")}
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
  tabId,
  panelId,
  tabIndex,
  onKeyDown,
  buttonRef,
}: {
  tab: WorkspaceTab;
  active: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  tabId: string;
  panelId: string;
  tabIndex: number;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const gt = useGT();
  // Outer container preserves drag wrapper hooks; the inner button carries
  // tab semantics so screen-reader and keyboard semantics are correct.
  return (
    <div
      role="presentation"
      className={`group relative min-w-0 max-w-52 flex items-center gap-1.5 rounded-t-md transition-colors select-none ${
        active
          ? "bg-surface-overlay text-on-surface border border-b-0 border-border-strong"
          : "bg-transparent text-on-surface-muted border border-transparent hover:text-on-surface-secondary hover:bg-surface-overlay/50"
      }`}
    >
      {active && <span className="absolute bottom-0 left-0 right-0 h-px bg-surface-overlay" />}
      <button
        ref={buttonRef}
        type="button"
        role="tab"
        id={tabId}
        aria-selected={active}
        aria-controls={panelId}
        tabIndex={tabIndex}
        onClick={() => onActivate(tab.id)}
        onKeyDown={onKeyDown}
        className="flex-1 min-w-0 flex items-center pl-3 pr-1 h-8 cursor-pointer bg-transparent text-left"
      >
        <span className="truncate text-xs font-medium">{tab.title}</span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className="shrink-0 mr-2 size-3.5 flex items-center justify-center rounded text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        aria-label={gt("Close tab {title}", { title: tab.title })}
        title={gt("Close {title}", { title: tab.title })}
      >
        &times;
      </button>
    </div>
  );
}
