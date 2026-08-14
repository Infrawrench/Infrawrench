import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import { summarizeStatusIncident, type OrgStatusIncident } from "@infrawrench/client-core";
import type { StatusIncidentsClient } from "./types.js";

const POLL_INTERVAL_MS = 60_000;

export interface ProviderIncidentBannerProps {
  client: StatusIncidentsClient;
  /**
   * Open an external URL (the provider's incident page). Injected because the
   * two hosts differ: web opens a new tab, desktop routes through the shell's
   * external-URL handler. Omitted, the link is not rendered.
   */
  onOpenUrl?: ((url: string) => void) | undefined;
}

/**
 * The "is it me or is it them?" banner: shown across the app whenever an
 * active provider status-page incident overlaps resources the org holds.
 * Renders nothing when there is nothing to say, so hosts mount it
 * unconditionally in the shell — same contract as web's ChangeFreezeBanner.
 *
 * Fails closed and quiet: a fetch error renders nothing rather than an error
 * banner. The feature is advisory; it must never add noise of its own.
 */
export function ProviderIncidentBanner({ client, onOpenUrl }: ProviderIncidentBannerProps) {
  const gt = useGT();
  const [incidents, setIncidents] = useState<OrgStatusIncident[]>([]);
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const response = await client.listStatusIncidents();
      setIncidents(response.incidents);
    } catch {
      // Advisory surface — stay silent on failure.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const relevant = incidents.filter(
    (i) =>
      !i.resolvedAt &&
      i.impact !== "maintenance" &&
      i.affectedResourceCount > 0 &&
      !dismissedIds.includes(i.id),
  );
  const top = relevant[0];
  if (!top) return null;

  const critical = top.impact === "critical";
  const tone = critical
    ? "bg-red-500/15 text-danger border-red-500/30"
    : "bg-amber-500/15 text-warning border-amber-500/30";

  return (
    <div
      role="status"
      className={`flex items-center gap-2 px-4 py-1.5 text-sm border-b ${tone}`}
      data-testid="provider-incident-banner"
    >
      <span aria-hidden="true">⚠</span>
      <span className="truncate">
        <span className="font-medium">{summarizeStatusIncident(top)}</span>
        <span className="opacity-80"> — {top.title}</span>
        {relevant.length > 1 && (
          <span className="opacity-80">
            {" "}
            (
            {relevant.length === 2
              ? gt("+1 more provider incident")
              : gt("+{count} more provider incidents", { count: relevant.length - 1 })}
            )
          </span>
        )}
      </span>
      <span className="ml-auto flex items-center gap-3 shrink-0">
        {onOpenUrl && top.url && (
          <button
            type="button"
            onClick={() => onOpenUrl(top.url as string)}
            className="underline underline-offset-2"
          >
            {gt("Provider status")}
          </button>
        )}
        <button
          type="button"
          aria-label={gt("Dismiss provider incident banner")}
          onClick={() => setDismissedIds((ids) => [...ids, ...relevant.map((i) => i.id)])}
          className="opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </span>
    </div>
  );
}
