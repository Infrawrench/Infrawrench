import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface SortableDashboardCardProps {
  /**
   * Card identity within the grid — build it with `dashboardCardId(kind, id)`
   * so resource pins, workflow pins, and widgets share one sortable sequence.
   */
  id: string;
  /**
   * Grid classes for the wrapper. The wrapper is the grid item once a card is
   * sortable, so anything that positions the card (`col-span-2` for a cost
   * graph) has to live here rather than on the card itself.
   */
  className?: string | undefined;
  children: React.ReactNode;
}

export function SortableDashboardCard({ id, className, children }: SortableDashboardCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `dashboard-card:${id}`,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    cursor: "grab",
  };

  return (
    // `[&>*]:h-full` keeps the card filling the grid row: the wrapper is the
    // grid item and stretches, the card inside would otherwise sit at its
    // natural height next to a taller neighbour.
    <div
      ref={setNodeRef}
      style={style}
      className={className ? `${className} [&>*]:h-full` : "[&>*]:h-full"}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
