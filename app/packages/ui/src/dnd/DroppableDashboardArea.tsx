import { useDroppable } from "@dnd-kit/core";

export interface DroppableDashboardAreaProps {
  dashboardId: string;
  children: React.ReactNode;
}

export function DroppableDashboardArea({ dashboardId, children }: DroppableDashboardAreaProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `dashboard:${dashboardId}`,
  });

  return (
    <div
      ref={setNodeRef}
      className={`relative ${isOver ? "ring-2 ring-inset ring-blue-500/50 rounded-xl" : ""}`}
    >
      {children}
      {isOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="px-4 py-2 rounded-full bg-accent-muted border border-blue-500/50 text-sm text-accent-on-muted">
            Drop to pin
          </div>
        </div>
      )}
    </div>
  );
}
