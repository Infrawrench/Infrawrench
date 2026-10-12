import { useEffect, useState } from "react";
import {
  openLeaksForAccount,
  type LeakedSecret,
  type LeakedSecretListResponse,
} from "@infrawrench/client-core";
import { AccountLeakBanner } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

/**
 * The account page's leaked-credential banner: open leaks matched to, or
 * possibly belonging to, this account. Silent on failure; the Posture tab is
 * where a broken leak list gets reported.
 */
export function WebAccountLeakBanner({
  orgId,
  accountId,
  onReview,
}: {
  orgId: string;
  accountId: string;
  onReview: () => void;
}) {
  const [leaks, setLeaks] = useState<LeakedSecret[]>([]);
  useEffect(() => {
    let cancelled = false;
    setLeaks([]);
    const query = new URLSearchParams({ status: "open", accountId });
    apiGet<LeakedSecretListResponse>(`/api/org/${orgId}/leaked-secrets?${query.toString()}`)
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
