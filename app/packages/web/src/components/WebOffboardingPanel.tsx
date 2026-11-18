import { useMemo } from "react";
import {
  OffboardingPanel,
  type OffboardingClient,
} from "@infrawrench/ui/offboarding/OffboardingPanel";
import type { OffboardingItem } from "@infrawrench/client-core";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

interface WebOffboardingPanelProps {
  orgId: string;
  offboardingId?: string | undefined;
  onSelect: (offboardingId: string | undefined) => void;
  openResource: (item: OffboardingItem) => void;
}

/**
 * Web host for the shared offboarding tab: cookie-authenticated fetch as the
 * transport. The export is a plain navigation, so the browser takes the
 * server's `Content-Disposition` filename.
 */
export function WebOffboardingPanel({
  orgId,
  offboardingId,
  onSelect,
  openResource,
}: WebOffboardingPanelProps) {
  const client = useMemo<OffboardingClient>(() => {
    const base = `/api/org/${orgId}/offboardings`;
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
    return {
      list: () => apiGet(base),
      get: (id) => apiGet(one(id)),
      start: (input) => apiPost(base, input),
      update: (id, patch) => apiPatch(one(id), patch),
      rescan: (id) => apiPost(`${one(id)}/rescan`),
      updateItem: (id, itemId, patch) =>
        apiPatch(`${one(id)}/items/${encodeURIComponent(itemId)}`, patch),
      act: (id, itemId, input) =>
        apiPost(`${one(id)}/items/${encodeURIComponent(itemId)}/action`, input),
      members: () => apiGet(`${base}/members`),
      exportCsv: (offboarding) => {
        window.location.href = `${one(offboarding.id)}/export?format=csv`;
      },
    };
  }, [orgId]);

  return (
    <OffboardingPanel
      client={client}
      offboardingId={offboardingId}
      onSelect={onSelect}
      onOpenResource={openResource}
    />
  );
}
