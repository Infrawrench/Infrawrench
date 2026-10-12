import { useEffect, useState } from "react";
import { openLeaksForAccount, type LeakedSecret } from "@infrawrench/client-core";
import { AccountLeakBanner, useUIStore } from "@infrawrench/ui";
import { fetchCloudAccountLeaks } from "@/lib/cloud-resources";

/**
 * The account page's leaked-credential banner, cloud mode only (scanning runs
 * in the cloud poller). Silent on failure; the Posture tab reports a broken
 * leak list.
 */
export function DesktopAccountLeakBanner({
  accountId,
  onReview,
}: {
  accountId: string;
  onReview: () => void;
}) {
  const orgId = useUIStore((s) => s.activeCloudOrgId);
  const [leaks, setLeaks] = useState<LeakedSecret[]>([]);
  useEffect(() => {
    setLeaks([]);
    if (!orgId) return;
    let cancelled = false;
    fetchCloudAccountLeaks(orgId, accountId)
      .then((r) => {
        if (!cancelled) setLeaks(openLeaksForAccount(r.leaks, accountId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orgId, accountId]);
  if (leaks.length === 0) return null;
  return (
    <div className="px-6 pt-4">
      <AccountLeakBanner leaks={leaks} onReview={onReview} />
    </div>
  );
}
