import { useDraggable, useDroppable } from "@dnd-kit/core";
import { GlobalTabBar as SharedGlobalTabBar, type WorkspaceTab } from "@infrawrench/ui";

interface GlobalTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}

export function GlobalTabBar({ tabs, activeTabId, onActivate, onClose, onNew }: GlobalTabBarProps) {
  const { setNodeRef, isOver } = useDroppable({ id: "global-tabs-bar" });

  return (
    <SharedGlobalTabBar
      tabs={tabs}
      activeTabId={activeTabId}
      onActivate={onActivate}
      onClose={onClose}
      onNew={onNew}
      rootRef={setNodeRef}
      className={isOver ? "ring-1 ring-inset ring-blue-500/40" : ""}
      showEmptyHint
      renderTabWrapper={(tab, children) => (
        <DraggableTabWrapper key={tab.id} tab={tab}>
          {children}
        </DraggableTabWrapper>
      )}
    />
  );
}

function DraggableTabWrapper({ tab, children }: { tab: WorkspaceTab; children: React.ReactNode }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `global-tab:${tab.id}` });
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
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
      className={`${isOver ? "ring-1 ring-inset ring-blue-500/40" : ""} ${isDragging ? "opacity-40" : ""}`}
      style={{ cursor: isDragging ? "grabbing" : "grab" }}
    >
      {children}
    </div>
  );
}
