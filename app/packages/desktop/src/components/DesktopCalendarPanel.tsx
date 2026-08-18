import { useCallback, useEffect, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  CalendarSection,
  useUIStore,
  type CalendarEventKind,
  type CalendarRange,
  type CalendarResponse,
  type CalendarSubscription,
} from "@infrawrench/ui";
import {
  createCloudCalendarSubscription,
  fetchCloudCalendar,
  fetchCloudCalendarSubscriptions,
  revokeCloudCalendarSubscription,
} from "@/lib/cloud-resources";

/**
 * Desktop host for the shared operations calendar. Cloud only, like Backups:
 * five of its six sources are org state, and a local workspace has nowhere to
 * keep them. Local mode gets the Changes/Costs treatment — an explicit "sign
 * in" message rather than an empty month.
 */
export function DesktopCalendarPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<CalendarRange | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const latestRequest = useRef(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const onRangeChange = useCallback((next: CalendarRange) => {
    setRange((current) =>
      current &&
      current.from === next.from &&
      current.to === next.to &&
      current.kinds.join(",") === next.kinds.join(",")
        ? current
        : next,
    );
  }, []);

  useEffect(() => {
    setData(null);
    setSubscriptions(null);
    setError(null);
  }, [activeCloudOrgId]);

  useEffect(() => {
    const orgId = activeCloudOrgId;
    if (!orgId || !range) return;
    let cancelled = false;
    // Paging quickly through months is exactly how a stale response lands on
    // top of a newer one; only the newest request may write state.
    const request = ++latestRequest.current;
    fetchCloudCalendar(orgId, range)
      .then((response) => {
        if (cancelled || request !== latestRequest.current) return;
        setData(response);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || request !== latestRequest.current) return;
        setError(e instanceof Error ? e.message : gt("Failed to load the calendar"));
      });
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId, range, reloadKey]);

  const loadSubscriptions = useCallback(() => {
    const orgId = activeCloudOrgId;
    if (!orgId) return;
    fetchCloudCalendarSubscriptions(orgId)
      .then(setSubscriptions)
      // A member without `org:settings:write` gets a 403 here; an empty list is
      // the honest rendering, and the create button's own error says why.
      .catch(() => setSubscriptions([]));
  }, [activeCloudOrgId]);

  useEffect(loadSubscriptions, [loadSubscriptions]);

  const createSubscription = useCallback(
    async (input: { name: string; kinds: CalendarEventKind[] }) => {
      const orgId = activeCloudOrgId;
      if (!orgId) throw new Error("No organization is selected");
      const url = await createCloudCalendarSubscription(orgId, input);
      loadSubscriptions();
      return url;
    },
    [activeCloudOrgId, loadSubscriptions],
  );

  const revokeSubscription = useCallback(
    async (subscriptionId: string) => {
      const orgId = activeCloudOrgId;
      if (!orgId) return;
      await revokeCloudCalendarSubscription(orgId, subscriptionId);
      loadSubscriptions();
    },
    [activeCloudOrgId, loadSubscriptions],
  );

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">{gt("Calendar")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted">
            The operations calendar is a cloud feature. Sign in to an organization to see its change
            freezes, sleep windows, expiring certificates and leases, commitment terms, scheduled
            workflow runs and incidents on one axis.
          </p>
        </T>
      </div>
    );
  }

  return (
    <CalendarSection
      data={data}
      error={error}
      onRetry={retry}
      onRangeChange={onRangeChange}
      subscriptions={subscriptions}
      // The desktop does not read `/team/me`, so the editors are always offered
      // and a member without `org:settings:write` gets the server's 403 in the
      // section's error banner — the Backups stance.
      onCreateSubscription={createSubscription}
      onRevokeSubscription={revokeSubscription}
    />
  );
}
