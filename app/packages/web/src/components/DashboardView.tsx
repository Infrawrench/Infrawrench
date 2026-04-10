import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DroppableDashboardArea } from "@infrawrench/ui";
import { apiPost } from "@/lib/api";

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

interface DashboardViewProps {
  dashboardId: string;
  dashboardName: string;
  pins: PinnedResource[];
}

export function DashboardView({ dashboardId, dashboardName, pins: initialPins }: DashboardViewProps) {
  const navigate = useNavigate();
  const [pins, setPins] = useState(initialPins);
  const [unpinning, setUnpinning] = useState<string | null>(null);

  async function handleUnpin(pinId: string, resourceId: string) {
    setUnpinning(pinId);
    try {
      await apiPost("/api/dashboards/unpin", { dashboardId, resourceId });
      setPins((prev) => prev.filter((p) => p.pinId !== pinId));
    } catch (e) {
      console.error("Failed to unpin:", e);
    } finally {
      setUnpinning(null);
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-6">{dashboardName}</h1>
      <DroppableDashboardArea dashboardId={dashboardId}>
        {pins.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed border-gray-800 text-gray-700">
            <span className="text-3xl mb-3">&#8862;</span>
            <p className="text-sm">No pinned resources yet.</p>
            <p className="text-xs mt-1 opacity-60">
              Drag resources from your accounts to pin them here.
            </p>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {pins.map((pin) => {
              const fields = typeof pin.fieldsJson === "string"
                ? (() => { try { return JSON.parse(pin.fieldsJson) as Record<string, unknown>; } catch { return {}; } })()
                : (pin.fieldsJson as Record<string, unknown> ?? {});
              const rawHost = String(fields["host"] ?? fields["region"] ?? fields["engine"] ?? "");
              const host = (() => {
                try {
                  const h = rawHost.includes("://") ? new URL(rawHost).hostname : rawHost;
                  return h.length > 28 ? h.slice(0, 26) + "\u2026" : h;
                } catch {
                  return rawHost.length > 28 ? rawHost.slice(0, 26) + "\u2026" : rawHost;
                }
              })();

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
                        to: "/resources/$pluginId/$resourceTypeId/$resourceId",
                        params: { pluginId: pin.pluginId, resourceTypeId: pin.resourceTypeId, resourceId: pin.resourceId },
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
                      <p className="text-base font-semibold text-gray-100 leading-tight">{pin.displayName}</p>
                      {host && <p className="text-xs text-gray-500 mt-0.5 truncate">{host}</p>}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </DroppableDashboardArea>
    </div>
  );
}
