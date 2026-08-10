import { useCallback, useEffect, useState } from "react";
import {
  RESOURCES_CHANGED_EVENT,
  DnsSection,
  useUIStore,
  type DnsInventoryResponse,
  type DnsRecordEntry,
  type DnsZoneEntry,
} from "@infrawrench/ui";
import { fetchCloudDns } from "@/lib/cloud-resources";
import { loadLocalDns } from "@/lib/local-dns";

interface DesktopDnsPanelProps {
  openRecord: (record: DnsRecordEntry) => void;
  openZone: (zone: DnsZoneEntry) => void;
}

/**
 * Desktop host for the shared Domains surface. Cloud mode fetches the org
 * inventory from the web API; local mode runs the same shared computation over
 * the local SQLite workspace and the locally loaded plugins' `dnsRole` /
 * `dnsServiceHosts` declarations. Same wiring as DesktopPosturePanel — a
 * failed *refresh* must not blank an inventory that is already drawn.
 */
export function DesktopDnsPanel({ openRecord, openZone }: DesktopDnsPanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<DnsInventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    // Clear on mode/org change: without this the previous context's zones stay
    // on screen until the new fetch resolves.
    setData(null);
    setError(null);
    function load() {
      const seq = ++latest;
      const promise = activeCloudOrgId ? fetchCloudDns(activeCloudOrgId) : loadLocalDns();
      promise
        .then((d) => {
          if (!cancelled && seq === latest) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled && seq === latest)
            setError(e instanceof Error ? e.message : "Failed to load the DNS inventory");
        });
    }
    load();
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [activeCloudOrgId, reloadKey]);

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
