import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SpotlightSearch as SharedSpotlightSearch, type SpotlightResult } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";

interface SpotlightSearchProps {
  dashboardId?: string;
  mode: "pin" | "navigate";
  onClose: () => void;
  onPinned?: () => void;
}

export function SpotlightSearch({ dashboardId, mode, onClose, onPinned }: SpotlightSearchProps) {
  const navigate = useNavigate();

  const loadResults = useCallback(
    (query: string) =>
      apiGet<SpotlightResult[]>(`/api/search?q=${encodeURIComponent(query)}`),
    [],
  );

  const handleSelect = useCallback(
    async (result: SpotlightResult) => {
      if (mode === "navigate") {
        onClose();
        void navigate({
          to: "/resources/$pluginId/$resourceTypeId/$resourceId",
          params: { pluginId: result.pluginId, resourceTypeId: result.resourceTypeId, resourceId: result.id },
        });
        return;
      }
      if (dashboardId) {
        await apiPost("/api/dashboards/pin", {
          dashboardId,
          resourceId: result.id,
        });
        onPinned?.();
      }
      onClose();
    },
    [mode, dashboardId, onClose, onPinned, navigate],
  );

  return (
    <SharedSpotlightSearch
      mode={mode}
      onClose={onClose}
      onSelect={handleSelect}
      loadResults={loadResults}
      groupKey={(r) => `${r.pluginId}:${r.accountName}`}
    />
  );
}
