import { useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import {
  DroppableDashboardArea,
  useUIStore,
  formatErrorMessage,
  extractHostLabel,
} from "@infrawrench/ui";
import { apiPost, apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { SpotlightSearch } from "./SpotlightSearch";

interface PinnedResource {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  displayName: string;
  pluginId: string;
  pluginLogoSvg?: string | undefined;
  pluginDisplayName?: string | undefined;
  resourceTypeId: string;
  accountId: string;
  fieldsJson: unknown;
  outputsJson: unknown;
}

interface CardStatus {
  phase: "connecting" | "ok" | "error";
  pgVersion?: string;
  dbSize?: string;
  tableCount?: number;
  tableCountLabel?: string;
  resourceCounts?: Array<{ typeLabel: string; count: number }>;
  error?: string;
}

interface DashboardViewProps {
  dashboardId: string;
  dashboardName: string;
  isHome?: boolean | undefined;
  pins: PinnedResource[];
}

export function DashboardView({
  dashboardId,
  dashboardName: initialName,
  isHome = false,
  pins: initialPins,
}: DashboardViewProps) {
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [pins, setPins] = useState(initialPins);
  const [unpinning, setUnpinning] = useState<string | null>(null);
  const [spotlightMode, setSpotlightMode] = useState<"pin" | "navigate" | null>(null);
  const [dashboardName, setDashboardName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);
  const [cardStatus, setCardStatus] = useState<Record<string, CardStatus>>({});
  const probeAbortRef = useRef<AbortController | null>(null);

  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);

  useEffect(() => {
    if (pins.length === 0) return;
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;

    setCardStatus((prev) => {
      const next: Record<string, CardStatus> = {};
      for (const pin of pins) {
        if (prev[pin.resourceId]?.phase === "ok") next[pin.resourceId] = prev[pin.resourceId]!;
        else next[pin.resourceId] = { phase: "connecting" };
      }
      return next;
    });

    apiPost<Record<string, Omit<CardStatus, "phase"> & { phase: "ok" | "error" }>>(
      `/api/org/${orgId}/dashboards/probe`,
      {
        items: pins.map((p) => ({
          resourceId: p.resourceId,
          accountId: p.accountId,
          pluginId: p.pluginId,
          resourceTypeId: p.resourceTypeId,
        })),
      },
    )
      .then((results) => {
        if (controller.signal.aborted) return;
        setCardStatus(results);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const error = formatErrorMessage(e);
        setCardStatus(
          Object.fromEntries(pins.map((p) => [p.resourceId, { phase: "error" as const, error }])),
        );
      });

    return () => controller.abort();
  }, [pins]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightMode("navigate");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleUnpin(pinId: string, resourceId: string) {
    setUnpinning(pinId);
    try {
      await apiPost(`/api/org/${orgId}/dashboards/unpin`, { dashboardId, resourceId });
      setPins((prev) => prev.filter((p) => p.pinId !== pinId));
    } catch (e) {
      console.error("Failed to unpin:", e);
    } finally {
      setUnpinning(null);
    }
  }

  async function saveName(name: string) {
    const trimmed = name.trim() || "Dashboard";
    setDashboardName(trimmed);
    setEditingName(false);
    try {
      await apiPost(`/api/org/${orgId}/dashboards/${dashboardId}/rename`, { name: trimmed });
    } catch (e) {
      console.error("Failed to rename:", e);
    }
  }

  async function deleteDashboard() {
    if (isHome) return;
    try {
      await apiDelete(`/api/org/${orgId}/dashboards/${dashboardId}`);
      void navigate({ to: "/org/$orgId", params: { orgId } });
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-4 border-b border-gray-800/50 flex items-center justify-between">
        <div>
          {editingName ? (
            <input
              autoFocus
              defaultValue={dashboardName}
              onBlur={(e) => void saveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName(e.currentTarget.value);
                if (e.key === "Escape") setEditingName(false);
              }}
              className="text-2xl font-semibold bg-transparent border-b border-blue-500 text-gray-100 focus:outline-none"
            />
          ) : (
            <h1
              className="text-2xl font-semibold text-gray-100 cursor-default hover:text-white"
              onDoubleClick={() => setEditingName(true)}
              title="Double-click to rename"
            >
              {dashboardName}
            </h1>
          )}
        </div>

        {!isHome && (
          <button
            onClick={() => void deleteDashboard()}
            title="Delete dashboard"
            className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Delete
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 py-6">
        <DroppableDashboardArea dashboardId={dashboardId}>
          {pins.length === 0 ? (
            <button
              onClick={() => setSpotlightMode("pin")}
              className="w-full flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed border-gray-800 text-gray-700 hover:border-gray-600 hover:text-gray-500 transition-colors"
            >
              <span className="text-3xl mb-3">&#8862;</span>
              <p className="text-sm">Click to add a resource</p>
              <p className="text-xs mt-1 opacity-60">or drag one here</p>
            </button>
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
            >
              {pins.map((pin) => {
                const fields =
                  typeof pin.fieldsJson === "string"
                    ? (() => {
                        try {
                          return JSON.parse(pin.fieldsJson) as Record<string, unknown>;
                        } catch {
                          return {};
                        }
                      })()
                    : ((pin.fieldsJson as Record<string, unknown>) ?? {});
                const host = extractHostLabel(fields);

                return (
                  <div
                    key={pin.pinId}
                    className="group relative rounded-2xl border border-gray-800 bg-gray-900 hover:border-gray-700 transition-colors flex flex-col overflow-hidden"
                  >
                    {/* Unpin button */}
                    <button
                      onClick={() => void handleUnpin(pin.pinId, pin.resourceId)}
                      disabled={unpinning === pin.pinId}
                      title="Remove from dashboard"
                      className="absolute top-2 right-2 w-5 h-5 rounded-full text-gray-700 hover:text-gray-300 hover:bg-gray-700 transition-all opacity-0 group-hover:opacity-100 text-xs flex items-center justify-center"
                    >
                      &#10005;
                    </button>

                    <button
                      onClick={() =>
                        void navigate({
                          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                          params: {
                            orgId,
                            pluginId: pin.pluginId,
                            resourceTypeId: pin.resourceTypeId,
                            resourceId: pin.resourceId,
                          },
                        })
                      }
                      className="flex-1 flex flex-col p-5 text-left gap-3"
                    >
                      {/* Plugin logo + name */}
                      <div className="flex items-center gap-2">
                        {pin.pluginLogoSvg ? (
                          <div
                            className="w-6 h-6 flex-shrink-0"
                            dangerouslySetInnerHTML={{ __html: pin.pluginLogoSvg }}
                          />
                        ) : (
                          <span className="text-xs text-gray-600 font-mono">{pin.pluginId}</span>
                        )}
                        <span className="text-xs text-gray-500">
                          {pin.pluginDisplayName ?? pin.pluginId}
                        </span>
                      </div>

                      {/* Resource name */}
                      <div>
                        <p className="text-base font-semibold text-gray-100 leading-tight">
                          {pin.displayName}
                        </p>
                        {host && <p className="text-xs text-gray-500 mt-0.5 truncate">{host}</p>}
                      </div>
                    </button>

                    {/* Status footer */}
                    <ConnectionFooter status={cardStatus[pin.resourceId]} />
                  </div>
                );
              })}

              {/* Add resource button */}
              <button
                onClick={() => setSpotlightMode("pin")}
                className="rounded-2xl border-2 border-dashed border-gray-800 text-gray-700 hover:border-gray-600 hover:text-gray-500 flex flex-col items-center justify-center gap-1.5 transition-colors min-h-[140px]"
              >
                <span className="text-2xl">+</span>
                <span className="text-xs">Add resource</span>
              </button>
            </div>
          )}
        </DroppableDashboardArea>

        {spotlightMode && (
          <SpotlightSearch
            dashboardId={dashboardId}
            mode={spotlightMode}
            onClose={() => setSpotlightMode(null)}
            onPinned={() => {
              bumpDashboardPins();
              setSpotlightMode(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ConnectionFooter({ status }: { status?: CardStatus | undefined }) {
  if (!status) return null;

  if (status.phase === "connecting") {
    return (
      <div className="px-4 py-2 border-t border-gray-800/50">
        <span className="text-xs text-gray-600 animate-pulse">Connecting...</span>
      </div>
    );
  }

  if (status.phase === "error") {
    return (
      <div className="px-4 py-2 border-t border-gray-800/50">
        <span className="text-xs text-red-400 truncate" title={status.error}>
          {status.error}
        </span>
      </div>
    );
  }

  // Resource counts (account summary card)
  if (status.resourceCounts && status.resourceCounts.length > 0) {
    return (
      <div className="px-4 py-2 border-t border-gray-800/50 flex flex-wrap gap-x-3 gap-y-0.5">
        {status.resourceCounts.map((rc) => (
          <span key={rc.typeLabel} className="text-xs text-gray-500">
            <span className="text-gray-300 font-medium">{rc.count}</span> {rc.typeLabel}
          </span>
        ))}
      </div>
    );
  }

  // DB/service stats
  const parts: string[] = [];
  if (status.pgVersion) parts.push(status.pgVersion);
  if (status.dbSize) parts.push(status.dbSize);
  if (status.tableCount !== undefined) {
    parts.push(`${status.tableCount} ${status.tableCountLabel ?? "Tables"}`);
  }

  if (parts.length === 0) return null;

  return (
    <div className="px-4 py-2 border-t border-gray-800/50">
      <span className="text-xs text-gray-500">{parts.join(" · ")}</span>
    </div>
  );
}
