import { useState, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useDroppable } from "@dnd-kit/core";
import { getDb } from "../db/client";
import { createDashboard } from "../lib/pins";
import { useUIStore } from "@infrawrench/ui";

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
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Dashboards</span>
        <button
          onClick={() => setAddingNew(true)}
          title="New dashboard"
          className="text-gray-600 hover:text-gray-300 text-sm leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-gray-800 transition-colors"
        >
          +
        </button>
      </div>

      {dashboards.map((dash) => (
        <DroppableDashboardLink key={dash.id} dash={dash} />
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

function DroppableDashboardLink({ dash }: { dash: DashboardRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: `dashboard:${dash.id}` });

  return (
    <div ref={setNodeRef}>
      <Link
        to="/dashboard/$dashboardId"
        params={{ dashboardId: dash.id }}
        draggable={false}
        className={`flex items-center gap-2 mx-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
          isOver
            ? "bg-blue-500/20 border border-blue-500 text-blue-300"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-800 border border-transparent"
        }`}
        activeProps={{ className: "bg-gray-800 text-gray-100 border border-transparent" }}
      >
        <span className="opacity-50">⊞</span>
        <span className="truncate">{dash.name}</span>
        {isOver && <span className="ml-auto text-blue-400">Drop</span>}
      </Link>
    </div>
  );
}
