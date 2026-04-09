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
          <div className="text-center py-20">
            <p className="text-gray-500 text-sm">No pinned resources yet.</p>
            <p className="text-gray-600 text-xs mt-1">
              Drag resources from your accounts to pin them here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {pins.map((pin) => (
              <div
                key={pin.pinId}
                className="group relative bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors"
              >
                <button
                  onClick={() =>
                    void navigate({
                      to: "/resources/$pluginId/$resourceTypeId/$resourceId",
                      params: { pluginId: pin.pluginId, resourceTypeId: pin.resourceTypeId, resourceId: encodeURIComponent(pin.resourceId) },
                    })
                  }
                  className="block w-full text-left"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-sm font-medium text-gray-200 truncate">
                      {pin.displayName}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {pin.pluginId} / {pin.resourceTypeId}
                  </div>
                </button>
                <button
                  onClick={() => void handleUnpin(pin.pinId, pin.resourceId)}
                  disabled={unpinning === pin.pinId}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all text-xs"
                  title="Unpin"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </DroppableDashboardArea>
    </div>
  );
}
