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
    async (query: string) => {
      const all = await apiGet<SpotlightResult[]>(
        `/api/org/${orgId}/search?q=${encodeURIComponent(query)}`,
      );
      // Workflows are navigation targets only — keep them out of pin/drop.
      return mode === "navigate" ? all : all.filter((r) => r.resourceTypeId !== "__workflow__");
    },
    [orgId, mode],
  );

  const handleSelect = useCallback(
    async (result: SpotlightResult) => {
      if (mode === "navigate") {
        onClose();
        if (result.resourceTypeId === "__workflow__") {
          void navigate({ to: "/org/$orgId/workflows", params: { orgId } });
        } else {
          void navigate({
            to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
            params: {
              orgId,
              pluginId: result.pluginId,
              resourceTypeId: result.resourceTypeId,
              resourceId: result.id,
            },
          });
        }
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
