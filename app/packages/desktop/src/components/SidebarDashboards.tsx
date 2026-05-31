import { useState, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getDb } from "../db/client";
import { createDashboard } from "../lib/pins";
import { DroppableDashboardItem, useUIStore } from "@infrawrench/ui";
import { dashboardTabTarget, navigateToWorkspaceTarget } from "../lib/workspace-tabs";
import { listCloudDashboards, createCloudDashboard, deleteCloudDashboard } from "../lib/cloud-api";

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
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  async function load() {
    try {
      if (activeCloudOrgId) {
        const cloud = await listCloudDashboards(activeCloudOrgId);
        setDashboards(
          cloud.map((d) => ({ id: d.id, name: d.name, is_default: d.isDefault ? 1 : 0 })),
        );
      } else {
        const db = await getDb();
        const rows = await db.select<DashboardRow[]>(
          "SELECT id, name, is_default FROM dashboards ORDER BY is_default DESC, created_at ASC",
        );
        setDashboards(rows);
      }
    } catch (err) {
      console.error("[sidebar-dashboards] Failed to load dashboards:", err);
      setDashboards([]);
    }
  }

  useEffect(() => {
    void load();
  }, [dashboardPinsVersion, activeCloudOrgId]);

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
      if (activeCloudOrgId) {
        await createCloudDashboard(activeCloudOrgId, name);
      } else {
        const db = await getDb();
        await createDashboard(name, db);
      }
      setNewName("");
      setAddingNew(false);
      await load();
    } catch (err) {
      console.error("[sidebar-dashboards] Failed to create dashboard:", err);
    }
  }

  return (
    <div className="mb-2">
      {/* Workflows entry — opens the Workflows workspace tab. */}
      <button
        type="button"
        onClick={() => useUIStore.getState().pinWorkspaceTab({ kind: "workflows" }, "Workflows")}
        className="w-full flex items-center px-3 py-1.5 mb-1 rounded text-xs text-on-surface-secondary hover:text-on-surface hover:bg-surface-overlay transition-colors"
      >
        Workflows
      </button>

      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
          Dashboards
        </span>
        <button
          type="button"
          onClick={() => setAddingNew(true)}
          title="New dashboard"
          aria-label="Create new dashboard"
          className="text-on-surface-faint hover:text-on-surface-secondary text-sm leading-none size-5 flex items-center justify-center rounded hover:bg-surface-overlay transition-colors"
        >
          +
        </button>
      </div>

      {dashboards.map((dash) => (
        <DroppableDashboardItem
          key={dash.id}
          dashboardId={dash.id}
          name={dash.name}
          isActive={pathname === `/dashboard/${dash.id}`}
          isDefault={dash.is_default === 1}
          draggable
          extraDragData={{ workspaceTabTarget: dashboardTabTarget(dash.id) }}
          onClick={() =>
            void navigateToWorkspaceTarget(navigate, dashboardTabTarget(dash.id), {
              label: dash.name,
            })
          }
          onDelete={
            dash.is_default !== 1
              ? () => {
                  void (async () => {
                    try {
                      if (activeCloudOrgId) {
                        await deleteCloudDashboard(activeCloudOrgId, dash.id);
                      } else {
                        const db = await getDb();
                        await db.execute("DELETE FROM dashboard_pins WHERE dashboard_id = $1", [
                          dash.id,
                        ]);
                        await db.execute("DELETE FROM dashboards WHERE id = $1", [dash.id]);
                      }
                      removeWorkspaceTabs(
                        useUIStore
                          .getState()
                          .workspaceTabs.flatMap((tab) =>
                            tab.target.kind === "dashboard" && tab.target.dashboardId === dash.id
                              ? [tab.id]
                              : [],
                          ),
                      );
                      setDashboards((prev) => prev.filter((d) => d.id !== dash.id));
                      // Navigate home if we just deleted the active dashboard
                      void navigate({ to: "/" });
                    } catch (err) {
                      console.error("[sidebar-dashboards] Failed to delete dashboard:", err);
                    }
                  })();
                }
              : undefined
          }
        />
      ))}

      {/* New dashboard inline input */}
      {addingNew && (
        <div className="mx-2 px-3 py-1.5">
          <input
            ref={newInputRef}
            aria-label="New dashboard name"
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
            className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
          />
        </div>
      )}
    </div>
  );
}
