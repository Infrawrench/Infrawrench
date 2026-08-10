import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  DnsSection,
  type DnsInventoryResponse,
  type DnsRecordEntry,
  type DnsZoneEntry,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebDnsPanelProps {
  orgId: string;
  openRecord: (record: DnsRecordEntry) => void;
  openZone: (zone: DnsZoneEntry) => void;
}

/**
 * Web host for the shared Domains surface: fetches the org's DNS inventory
 * from the API and refreshes when resources change. Same wiring as
 * WebPosturePanel — a failed *refresh* must not blank an inventory that is
 * already drawn, so the last loaded data stays on screen under the section's
 * banner.
 */
export function WebDnsPanel({ orgId, openRecord, openZone }: WebDnsPanelProps) {
  const [data, setData] = useState<DnsInventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Refreshes within this effect (initial load + RESOURCES_CHANGED_EVENT)
    // can resolve out of order; only the newest request may write state.
    let latestRequest = 0;
    // Clear on org change: without this the previous org's zones stay on
    // screen until the new fetch resolves, which reads as this org's DNS.
    setData(null);
    setError(null);
    function load() {
      const request = ++latestRequest;
      apiGet<DnsInventoryResponse>(`/api/org/${orgId}/dns`)
        .then((d) => {
          if (!cancelled && request === latestRequest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && request === latestRequest)
            setError(e instanceof Error ? e.message : "Failed to load the DNS inventory");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, reloadKey]);

  return (
    <DnsSection
      data={data}
      error={error}
      onRetry={retry}
      onOpenRecord={openRecord}
      onOpenZone={openZone}
    />
  );
}
