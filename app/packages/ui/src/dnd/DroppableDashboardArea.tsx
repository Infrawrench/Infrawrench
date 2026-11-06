import { useDroppable } from "@dnd-kit/core";
import { useGT } from "gt-react";

export interface DroppableDashboardAreaProps {
  dashboardId: string;
  children: React.ReactNode;
}

export function DroppableDashboardArea({ dashboardId, children }: DroppableDashboardAreaProps) {
  const gt = useGT();
  const { setNodeRef, isOver } = useDroppable({
    id: `dashboard:${dashboardId}`,
  });

  return (
    <div
      ref={setNodeRef}
      className={`relative ${isOver ? "ring-2 ring-inset ring-accent/50 rounded-xl" : ""}`}
    >
      {children}
      {isOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="px-4 py-2 rounded-md bg-accent-muted border border-accent/50 text-sm text-accent-on-muted">
            {gt("Drop to pin")}
          </div>
        </div>
      )}
    </div>
  );
}
