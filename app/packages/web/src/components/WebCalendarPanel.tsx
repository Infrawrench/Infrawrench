import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarSection,
  type CalendarRange,
  type CalendarResponse,
  type CalendarEventKind,
  type CalendarSubscription,
} from "@infrawrench/ui";
import { usePermissions } from "@/auth/permissions-context";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

interface WebCalendarPanelProps {
  orgId: string;
  openResource: (target: { accountId: string; resourceId: string }) => void;
  openTab: (tab: "expiring" | "incidents" | "workflows" | "costs" | "settings") => void;
}

/**
 * Web host for the shared operations calendar.
 *
 * Unlike the other section hosts this one does not own the window: the section
 * does, and asks for a range through `onRangeChange`. The fetch is therefore
 * keyed on that range, and out-of-order responses are discarded by request
 * number — paging quickly through months is exactly how a stale month lands on
 * top of a newer one.
 */
export function WebCalendarPanel({ orgId, openResource, openTab }: WebCalendarPanelProps) {
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<CalendarRange | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Until the shell's permission read lands `has()` is false, so the
  // subscription editors stay hidden rather than offering an action that
  // would 403.
  const { has } = usePermissions();
  const canManageFeeds = has("org:settings:write");

  const latestRequest = useRef(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const onRangeChange = useCallback((next: CalendarRange) => {
    // The section re-derives its range object each render; only a real change
    // of window or filter should refetch.
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
    if (!range) return;
    let cancelled = false;
    const request = ++latestRequest.current;
    const params = new URLSearchParams({ from: range.from, to: range.to });
    // Omitted rather than sent empty: an empty `kinds` means "every kind" on
    // the server, and spelling that out here would break the moment a kind is
    // added that this build does not know about.
    if (range.kinds.length > 0 && range.kinds.length < 6) {
      params.set("kinds", range.kinds.join(","));
    }
    apiGet<CalendarResponse>(`/api/org/${orgId}/calendar?${params.toString()}`)
      .then((response) => {
        if (cancelled || request !== latestRequest.current) return;
        setData(response);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || request !== latestRequest.current) return;
        setError(e instanceof Error ? e.message : "Failed to load the calendar");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, range, reloadKey]);

  // Clear on org change so the previous org's events cannot sit on screen
  // looking like this one's while the new fetch is in flight.
  useEffect(() => {
    setData(null);
    setSubscriptions(null);
    setError(null);
  }, [orgId]);

  const loadSubscriptions = useCallback(() => {
    if (!canManageFeeds) return;
    apiGet<{ subscriptions: CalendarSubscription[] }>(`/api/org/${orgId}/calendar/subscriptions`)
      .then((response) => setSubscriptions(response.subscriptions))
      .catch(() => setSubscriptions([]));
  }, [orgId, canManageFeeds]);

  useEffect(loadSubscriptions, [loadSubscriptions]);

  const createSubscription = useCallback(
    async (input: { name: string; kinds: CalendarEventKind[] }) => {
      const created = await apiPost<CalendarSubscription>(
        `/api/org/${orgId}/calendar/subscriptions`,
        input,
      );
      loadSubscriptions();
      // The server returns the URL exactly once; if it ever stopped, showing
      // an empty box would be worse than saying so.
      if (!created.url) throw new Error("The server did not return a subscription URL");
      return created.url;
    },
    [orgId, loadSubscriptions],
  );

  const revokeSubscription = useCallback(
    async (subscriptionId: string) => {
      await apiDelete(`/api/org/${orgId}/calendar/subscriptions/${subscriptionId}`);
      loadSubscriptions();
    },
    [orgId, loadSubscriptions],
  );

  return (
    <CalendarSection
      data={data}
      error={error}
      onRetry={retry}
      onRangeChange={onRangeChange}
      onOpenResource={openResource}
      onOpenTab={openTab}
      // Undefined rather than null without the permission: the whole
      // Subscriptions tab disappears instead of showing a list nobody here
      // can act on.
      subscriptions={canManageFeeds ? subscriptions : undefined}
      onCreateSubscription={canManageFeeds ? createSubscription : undefined}
      onRevokeSubscription={canManageFeeds ? revokeSubscription : undefined}
    />
  );
}
