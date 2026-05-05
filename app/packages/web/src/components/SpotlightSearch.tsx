import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SpotlightSearch as SharedSpotlightSearch, type SpotlightResult } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface SpotlightSearchProps {
  dashboardId?: string;
  mode: "pin" | "navigate" | "drop";
  onClose: () => void;
  onPinned?: () => void;
  onDrop?: (result: SpotlightResult) => void;
}

export function SpotlightSearch({
  dashboardId,
  mode,
  onClose,
  onPinned,
  onDrop,
}: SpotlightSearchProps) {
  const navigate = useNavigate();
  const orgId = useOrgId();

  const loadResults = useCallback(
    (query: string) =>
      apiGet<SpotlightResult[]>(`/api/org/${orgId}/search?q=${encodeURIComponent(query)}`),
    [orgId],
  );

  const handleSelect = useCallback(
    async (result: SpotlightResult) => {
      if (mode === "navigate") {
        onClose();
        void navigate({
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: {
            orgId,
            pluginId: result.pluginId,
            resourceTypeId: result.resourceTypeId,
            resourceId: result.id,
          },
        });
        return;
      }
      if (mode === "drop") {
        onDrop?.(result);
        onClose();
        return;
      }
      if (dashboardId) {
        await apiPost(`/api/org/${orgId}/dashboards/pin`, {
          dashboardId,
          resourceId: result.id,
        });
        onPinned?.();
      }
      onClose();
    },
    [mode, dashboardId, onClose, onPinned, onDrop, navigate, orgId],
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
