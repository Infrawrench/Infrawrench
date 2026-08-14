import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { summarizeStatusIncident, type OrgStatusIncident } from "@infrawrench/client-core";
import type { StatusIncidentsClient } from "./types.js";

export interface ProviderIncidentChangesSectionProps {
  client: StatusIncidentsClient;
  /** Open an external URL — see ProviderIncidentBanner. */
  onOpenUrl?: ((url: string) => void) | undefined;
}

const IMPACT_TONE: Record<string, string> = {
  critical: "bg-red-500/15 text-danger",
  major: "bg-amber-500/15 text-warning",
  minor: "bg-yellow-500/10 text-warning",
  maintenance: "bg-blue-500/10 text-info",
};

/**
 * The Changes-page half of "is it me or is it them?": provider incidents
 * (active, or resolved within the last day) correlated with the drift feed —
 * "these N changes happened during an incident". Renders nothing when no
 * incident overlaps the org, so the page stays clean in the common case.
 */
export function ProviderIncidentChangesSection({
  client,
  onOpenUrl,
}: ProviderIncidentChangesSectionProps) {
  const gt = useGT();
  const [incidents, setIncidents] = useState<OrgStatusIncident[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await client.listStatusIncidents();
        if (!cancelled) setIncidents(response.incidents);
      } catch {
        // Advisory — the change feed itself is unaffected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const relevant = incidents.filter(
    (i) => i.affectedResourceCount > 0 || i.overlappingChangeCount > 0,
  );
  if (relevant.length === 0) return null;

  return (
    <section aria-label={gt("Provider incidents")} className="mb-6">
      <h2 className="text-sm font-semibold mb-1">{gt("Is it you, or is it them?")}</h2>
      <p className="text-xs text-on-surface-muted mb-3">
        {gt(
          "Provider status pages report incidents overlapping your resources. Changes recorded during an incident window may be the provider, not you.",
        )}
      </p>
      <ul className="border border-border rounded-xl overflow-hidden">
        {relevant.map((incident) => (
          <li
            key={incident.id}
            className="border-b border-border/50 last:border-b-0 px-4 py-3 flex items-center gap-3"
          >
            <span
              className={`text-[11px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide shrink-0 ${IMPACT_TONE[incident.impact] ?? IMPACT_TONE["minor"]}`}
            >
              {incident.resolvedAt ? gt("resolved") : incident.impact}
            </span>
            <span className="min-w-0">
              <span className="text-sm text-on-surface-secondary block truncate">
                {summarizeStatusIncident(incident)}
              </span>
              <span className="text-xs text-on-surface-muted block truncate">
                {incident.title}
                {incident.overlappingChangeCount > 0 && (
                  <>
                    {" · "}
                    <span className="font-medium">
                      {gt("{count} {changeLabel} during this incident", {
                        count: incident.overlappingChangeCount,
                        changeLabel:
                          incident.overlappingChangeCount === 1 ? gt("change") : gt("changes"),
                      })}
                    </span>
                  </>
                )}
              </span>
            </span>
            {onOpenUrl && incident.url && (
              <button
                type="button"
                onClick={() => onOpenUrl(incident.url as string)}
                className="ml-auto text-xs underline underline-offset-2 text-on-surface-tertiary hover:text-on-surface-secondary shrink-0"
              >
                {gt("Provider status")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
