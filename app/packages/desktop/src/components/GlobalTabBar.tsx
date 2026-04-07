import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { WorkspaceTab } from "@infrawrench/ui";

interface GlobalTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export function GlobalTabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
}: GlobalTabBarProps) {
  const { setNodeRef, isOver } = useDroppable({ id: "global-tabs-bar" });

  return (
    <div
      ref={setNodeRef}
      className={`h-10 shrink-0 border-b border-gray-800/80 bg-gray-950/95 px-3 flex items-center gap-1 overflow-x-auto ${
        isOver ? "ring-1 ring-inset ring-blue-500/60" : ""
      }`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {tabs.length === 0 ? (
        <div className="px-3 text-xs text-gray-600">
          Drag dashboards, accounts, or resources here to pin tabs
        </div>
      ) : (
        tabs.map((tab) => (
          <GlobalTabBarItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onActivate={onActivate}
            onClose={onClose}
          />
        ))
      )}
    </div>
  );
}

function GlobalTabBarItem({
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
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `global-tab:${tab.id}` });
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `workspace-tab:${tab.id}`,
    data: { workspaceTabId: tab.id, dragLabel: tab.title },
  });

  function setNodeRef(node: HTMLDivElement | null) {
    setDropRef(node);
    setDragRef(node);
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`group min-w-0 max-w-60 flex items-center gap-2 px-3 h-8 rounded-lg border transition-colors cursor-grab active:cursor-grabbing ${
        active
          ? "border-gray-700 bg-gray-900 text-gray-100"
          : "border-transparent bg-transparent text-gray-500 hover:text-gray-200 hover:bg-gray-900/70"
      } ${isOver ? "ring-1 ring-inset ring-blue-500/60" : ""} ${isDragging ? "opacity-40" : ""}`}
      onClick={() => onActivate(tab.id)}
    >
      <span className="truncate text-sm">{tab.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className="shrink-0 w-4 h-4 rounded text-gray-600 hover:text-gray-200 hover:bg-gray-700/70 transition-colors opacity-0 group-hover:opacity-100"
        aria-label={`Close ${tab.title}`}
        title={`Close ${tab.title}`}
      >
        ×
      </button>
    </div>
  );
}
