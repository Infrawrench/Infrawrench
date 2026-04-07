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
      className={`h-9 shrink-0 border-b border-gray-800 bg-gray-950 flex items-end gap-0 overflow-x-auto overflow-y-hidden ${
        isOver ? "ring-1 ring-inset ring-blue-500/40" : ""
      }`}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {tabs.length === 0 ? (
        <div className="px-4 pb-2 text-xs text-gray-700">
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
      className={`group relative min-w-0 max-w-52 flex items-center gap-1.5 px-3 h-8 rounded-t-md transition-colors cursor-grab active:cursor-grabbing select-none ${
        active
          ? "bg-gray-800 text-gray-100 border border-b-0 border-gray-700"
          : "bg-transparent text-gray-500 border border-transparent hover:text-gray-300 hover:bg-gray-800/50"
      } ${isOver ? "ring-1 ring-inset ring-blue-500/40" : ""} ${isDragging ? "opacity-40" : ""}`}
      onClick={() => onActivate(tab.id)}
    >
      {active && (
        <span className="absolute bottom-0 left-0 right-0 h-px bg-gray-800" />
      )}
      <span className="truncate text-xs font-medium">{tab.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className="shrink-0 w-3.5 h-3.5 flex items-center justify-center rounded text-gray-600 hover:text-gray-200 hover:bg-gray-700 transition-colors opacity-0 group-hover:opacity-100"
        aria-label={`Close ${tab.title}`}
        title={`Close ${tab.title}`}
      >
        ×
      </button>
    </div>
  );
}
