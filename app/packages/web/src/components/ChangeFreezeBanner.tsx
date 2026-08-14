import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { apiGet } from "@/lib/api";
import { CHANGE_FREEZE_CHANGED_EVENT } from "@/lib/change-freeze-events";

export interface ActiveChangeFreeze {
  id: string;
  name: string;
  reason: string | null;
  startsAt: string;
  endsAt: string | null;
}

const POLL_INTERVAL_MS = 60_000;

function formatEnd(gt: ReturnType<typeof useGT>, endsAt: string | null): string {
  if (!endsAt) return gt("until ended by an admin");
  const date = new Date(endsAt);
  return gt("until {date}", {
    date: date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  });
}

/**
 * App-wide banner shown while an org change freeze is in effect. Destructive
 * actions (resource deletes, destructive plugin actions, secret destroys,
 * deployment rollbacks) are refused server-side for the duration; the banner
 * is the client-side pre-warning.
 */
export function ChangeFreezeBanner({ orgId }: { orgId: string }) {
  const gt = useGT();
  const [freeze, setFreeze] = useState<ActiveChangeFreeze | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await apiGet<{ freeze: ActiveChangeFreeze | null }>(
        `/api/org/${orgId}/change-freezes/status`,
      );
      setFreeze(status.freeze);
    } catch {
      // Keep whatever we last knew — a transient fetch failure shouldn't
      // flap the banner.
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onChanged = () => void refresh();
    window.addEventListener(CHANGE_FREEZE_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(CHANGE_FREEZE_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  if (!freeze) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-sm bg-amber-500/15 text-warning border-b border-amber-500/30">
      <span aria-hidden className="font-semibold">
        ❄
      </span>
      <span className="font-medium">{gt("Change freeze: {name}", { name: freeze.name })}</span>
      <span className="text-warning/80">
        {gt("Destructive actions are blocked {end}.", { end: formatEnd(gt, freeze.endsAt) })}
        {freeze.reason ? ` ${freeze.reason}` : ""}
      </span>
      <Link
        to="/org/$orgId/settings/freezes"
        params={{ orgId }}
        className="ml-auto underline underline-offset-2 hover:opacity-80 whitespace-nowrap"
      >
        {gt("Manage")}
      </Link>
    </div>
  );
}
