import { useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  DroppableDashboardArea,
  SortableDashboardCard,
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  SparklineChart,
  useUIStore,
  formatErrorMessage,
  extractHostLabel,
  toast,
} from "@infrawrench/ui";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { SpotlightSearch } from "./SpotlightSearch";

interface PinnedResource {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

interface CardStatus {
  phase: "ok" | "error";
  resourceCounts?: Array<{ typeLabel: string; count: number }>;
  stats?: Array<{ label: string; value: string; variant?: string }>;
  sparkline?: Array<{ timestamp: number; value: number }>;
  sparklineLabel?: string;
  error?: string;
}

interface PinDetail {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  displayName: string;
  pluginId: string;
  pluginLogoSvg: string;
  pluginDisplayName: string;
  resourceTypeId: string;
  accountId: string;
  fieldsJson: unknown;
  outputsJson: unknown;
  status: CardStatus;
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
  const [spotlightMode, setSpotlightMode] = useState<"pin" | "navigate" | null>(null);
  const [dashboardName, setDashboardName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);

  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);

  useEffect(() => {
    setPins(initialPins);
  }, [initialPins]);

  const handleReorder = useCallback(
    (e: Event) => {
      const { activeResourceId, overResourceId } = (e as CustomEvent).detail as {
        activeResourceId: string;
        overResourceId: string;
      };
      setPins((prev) => {
        const oldIndex = prev.findIndex((p) => p.resourceId === activeResourceId);
        const newIndex = prev.findIndex((p) => p.resourceId === overResourceId);
        if (oldIndex === -1 || newIndex === -1) return prev;
        const next = arrayMove(prev, oldIndex, newIndex);
        void apiPost(`/api/org/${orgId}/dashboards/${dashboardId}/reorder`, {
          resourceIds: next.map((p) => p.resourceId),
        });
        return next;
      });
    },
    [dashboardId, orgId],
  );

  useEffect(() => {
    window.addEventListener("iw:dashboard-card-reorder", handleReorder);
    return () => window.removeEventListener("iw:dashboard-card-reorder", handleReorder);
  }, [handleReorder]);

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
    try {
      await apiPost(`/api/org/${orgId}/dashboards/unpin`, { dashboardId, resourceId });
      setPins((prev) => prev.filter((p) => p.pinId !== pinId));
    } catch (e) {
      console.error("Failed to unpin:", e);
      toast.error("Couldn't unpin", {
        description: e instanceof Error ? e.message : String(e),
      });
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
      toast.error("Couldn't rename dashboard", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function deleteDashboard() {
    if (isHome) return;
    try {
      await apiDelete(`/api/org/${orgId}/dashboards/${dashboardId}`);
      void navigate({ to: "/org/$orgId", params: { orgId } });
    } catch (e) {
      console.error("Failed to delete:", e);
      toast.error("Couldn't delete dashboard", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-8 pt-8 pb-4 border-b border-border/50 flex items-center justify-between">
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
              className="text-2xl font-semibold bg-transparent border-b border-blue-500 text-on-surface focus:outline-none"
            />
          ) : (
            <h1
              className="text-2xl font-semibold text-on-surface cursor-default hover:text-white"
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
            className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
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
              className="w-full flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed border-border text-on-surface-faint hover:border-border-strong hover:text-on-surface-muted transition-colors"
            >
              <span className="text-3xl mb-3">&#8862;</span>
              <p className="text-sm">Click to add a resource</p>
              <p className="text-xs mt-1 opacity-60">or drag one here</p>
            </button>
          ) : (
            <SortableContext
              items={pins.map((p) => `dashboard-card:${p.resourceId}`)}
              strategy={rectSortingStrategy}
            >
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
              >
                {pins.map((pin) => (
                  <SortableDashboardCard key={pin.pinId} id={pin.resourceId}>
                    <PinCard
                      pinId={pin.pinId}
                      orgId={orgId}
                      onUnpin={() => void handleUnpin(pin.pinId, pin.resourceId)}
                      onOpen={(detail) =>
                        void navigate({
                          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                          params: {
                            orgId,
                            pluginId: detail.pluginId,
                            resourceTypeId: detail.resourceTypeId,
                            resourceId: detail.resourceId,
                          },
                        })
                      }
                    />
                  </SortableDashboardCard>
                ))}

                <button
                  onClick={() => setSpotlightMode("pin")}
                  className="rounded-2xl border-2 border-dashed border-border text-on-surface-faint hover:border-border-strong hover:text-on-surface-muted flex flex-col items-center justify-center gap-1.5 transition-colors min-h-[140px]"
                >
                  <span className="text-2xl">+</span>
                  <span className="text-xs">Add resource</span>
                </button>
              </div>
            </SortableContext>
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

function PinCard({
  pinId,
  orgId,
  onUnpin,
  onOpen,
}: {
  pinId: string;
  orgId: string;
  onUnpin: () => void;
  onOpen: (detail: PinDetail) => void;
}) {
  const [detail, setDetail] = useState<PinDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unpinning, setUnpinning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    apiGet<PinDetail>(`/api/org/${orgId}/dashboards/pin/${pinId}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(formatErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pinId, orgId]);

  if (loadError) {
    return (
      <div className="rounded-2xl border border-border bg-surface-raised p-5">
        <p className="text-xs text-red-500">{loadError}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="rounded-2xl border border-border bg-surface-raised p-5 flex flex-col gap-3 min-h-[140px] animate-pulse">
        <div className="h-4 w-20 rounded bg-surface-sunken" />
        <div className="h-5 w-32 rounded bg-surface-sunken" />
        <div className="mt-auto h-3 w-24 rounded bg-surface-sunken" />
      </div>
    );
  }

  const fields =
    typeof detail.fieldsJson === "string"
      ? (() => {
          try {
            return JSON.parse(detail.fieldsJson) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : ((detail.fieldsJson as Record<string, unknown>) ?? {});
  const host = extractHostLabel(fields);

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <button
        onClick={async () => {
          setUnpinning(true);
          try {
            onUnpin();
          } finally {
            setUnpinning(false);
          }
        }}
        disabled={unpinning}
        title="Remove from dashboard"
        className="absolute top-2 right-2 w-5 h-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken transition-all opacity-0 group-hover:opacity-100 text-xs flex items-center justify-center z-10"
      >
        &#10005;
      </button>

      <button onClick={() => onOpen(detail)} className="flex-1 flex flex-col p-5 text-left gap-3">
        <div className="flex items-center gap-2">
          {detail.pluginLogoSvg ? (
            <div
              className="w-6 h-6 flex-shrink-0"
              dangerouslySetInnerHTML={{ __html: detail.pluginLogoSvg }}
            />
          ) : (
            <span className="text-xs text-on-surface-faint font-mono">{detail.pluginId}</span>
          )}
          <span className="text-xs text-on-surface-muted">{detail.pluginDisplayName}</span>
        </div>

        <div>
          <p className="text-base font-semibold text-on-surface leading-tight">
            {detail.displayName}
          </p>
          {host && <p className="text-xs text-on-surface-muted mt-0.5 truncate">{host}</p>}
        </div>
      </button>

      <ConnectionFooter status={detail.status} />
    </div>
  );
}

function ConnectionFooter({ status }: { status: CardStatus }) {
  if (status.phase === "error") {
    return (
      <div
        className="px-5 py-3 border-t border-border flex items-center gap-2"
        title={status.error}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
        <span className="text-xs text-red-500 truncate">{status.error ?? "Connection failed"}</span>
      </div>
    );
  }

  return (
    <div className="px-5 py-3 border-t border-border space-y-1">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
        <span className="text-xs text-on-surface-faint">Connected</span>
      </div>
      {status.stats?.map((stat) => {
        const color =
          stat.variant === "status-healthy"
            ? "text-green-400"
            : stat.variant === "status-degraded"
              ? "text-yellow-400"
              : stat.variant === "status-error"
                ? "text-red-400"
                : "text-on-surface-tertiary";
        return (
          <div key={stat.label} className="flex justify-between text-xs">
            <span className="text-on-surface-faint">{stat.label}</span>
            <span className={color}>{stat.value}</span>
          </div>
        );
      })}
      {status.sparkline && status.sparkline.length >= 2 && (
        <div className="flex items-center gap-2 mt-2.5">
          <SparklineChart points={status.sparkline} width={120} height={24} />
          {status.sparklineLabel && (
            <span className="text-[10px] text-on-surface-faint">{status.sparklineLabel}</span>
          )}
        </div>
      )}
      {status.resourceCounts?.map(({ typeLabel, count }) => (
        <div key={typeLabel} className="flex justify-between text-xs">
          <span className="text-on-surface-faint">{typeLabel}</span>
          <span className="text-on-surface-tertiary">{count}</span>
        </div>
      ))}
    </div>
  );
}
