import { useState, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { getDb } from "../db/client";
import { createDashboard } from "../lib/pins";
import { useUIStore } from "@infrawrench/ui";
import { dashboardTabTarget, navigateToWorkspaceTarget } from "../lib/workspace-tabs";

interface DashboardRow {
  id: string;
  name: string;
  is_default: number;
}

export function SidebarDashboards() {
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const navigate = useNavigate();

  async function load() {
    try {
      const db = await getDb();
      const rows = await db.select<DashboardRow[]>(
        "SELECT id, name, is_default FROM dashboards ORDER BY is_default DESC, created_at ASC",
      );
      setDashboards(rows);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void load();
  }, [dashboardPinsVersion]);

  useEffect(() => {
    if (addingNew) {
      newInputRef.current?.focus();
    }
  }, [addingNew]);

  async function handleCreateDashboard() {
    const name = newName.trim();
    if (!name) {
      setAddingNew(false);
      setNewName("");
      return;
    }
    try {
      const db = await getDb();
      await createDashboard(name, db);
      setNewName("");
      setAddingNew(false);
      await load();
    } catch {
      // ignore
    }
  }

  return (
    <div className="mb-2">
      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Dashboards
        </span>
        <button
          onClick={() => setAddingNew(true)}
          title="New dashboard"
          className="text-gray-600 hover:text-gray-300 text-sm leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
        >
          +
        </button>
      </div>

      {dashboards.map((dash) => (
        <DroppableDashboardLink
          key={dash.id}
          dash={dash}
          onDelete={async () => {
            try {
              const db = await getDb();
              await db.execute("DELETE FROM dashboard_pins WHERE dashboard_id = $1", [dash.id]);
              await db.execute("DELETE FROM dashboards WHERE id = $1", [dash.id]);
              removeWorkspaceTabs(
                useUIStore
                  .getState()
                  .workspaceTabs.filter(
                    (tab) => tab.target.kind === "dashboard" && tab.target.dashboardId === dash.id,
                  )
                  .map((tab) => tab.id),
              );
              setDashboards((prev) => prev.filter((d) => d.id !== dash.id));
              // Navigate home if we just deleted the active dashboard
              void navigate({ to: "/" });
            } catch {
              /* ignore */
            }
          }}
        />
      ))}

      {/* New dashboard inline input */}
      {addingNew && (
        <div className="mx-2 px-3 py-1.5">
          <input
            ref={newInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Dashboard name…"
            onBlur={() => void handleCreateDashboard()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateDashboard();
              if (e.key === "Escape") {
                setAddingNew(false);
                setNewName("");
              }
            }}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
        </div>
      )}
    </div>
  );
}

function DroppableDashboardLink({ dash, onDelete }: { dash: DashboardRow; onDelete: () => void }) {
  const navigate = useNavigate();
  const { setNodeRef, isOver } = useDroppable({ id: `sidebar-dashboard:${dash.id}` });
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-dashboard-tab:${dash.id}`,
    data: {
      workspaceTabTarget: dashboardTabTarget(dash.id),
      dragLabel: dash.name,
    },
  });
  const isHome = dash.is_default === 1;
  const isActive = useRouterState({
    select: (s) => s.location.pathname === `/dashboard/${dash.id}`,
  });

  function setRefs(node: HTMLDivElement | null) {
    setNodeRef(node);
    setDragRef(node);
  }

  return (
    <div
      ref={setRefs}
      className={`mx-2 ${isDragging ? "opacity-40" : ""}`}
      {...attributes}
      {...listeners}
    >
      <div
        className={`group flex items-center rounded-lg text-xs transition-colors ${
          isOver
            ? "bg-blue-500/20 border border-blue-500 text-blue-300"
            : isActive
              ? "bg-gray-800 text-gray-100"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        } cursor-grab active:cursor-grabbing`}
      >
        <button
          type="button"
          draggable={false}
          onClick={() =>
            void navigateToWorkspaceTarget(navigate, dashboardTabTarget(dash.id), {
              label: dash.name,
            })
          }
          className="flex flex-1 items-center gap-2 px-3 py-1.5 min-w-0"
        >
          <span className="opacity-50 flex-shrink-0">⊞</span>
          <span className="truncate">{dash.name}</span>
          {isOver && <span className="ml-auto text-blue-400 flex-shrink-0 pr-1">Drop</span>}
        </button>
        {!isHome && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete dashboard"
            className="opacity-0 group-hover:opacity-100 mr-1.5 w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all flex-shrink-0"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
