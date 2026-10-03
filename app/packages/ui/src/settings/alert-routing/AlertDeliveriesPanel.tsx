import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { alertTriggerDef, type AlertSeverity, type AlertTrigger } from "@infrawrench/client-core";
import { useDataString } from "../../i18n/data-strings.js";
import { useSettingsHost } from "../host.js";

/* -------------------------------------------------------------------------- */
/* Recent deliveries                                                          */
/* -------------------------------------------------------------------------- */

interface DeliveryRow {
  id: string;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  title: string;
  ruleName: string | null;
  state: string;
  createdAt: string;
  deliverAfter: string | null;
  escalateAt: string | null;
}

/**
 * What the rules actually did. Only ever shows rows a rule created follow-up
 * work for — an alert that went straight out with no quiet hours and no
 * escalation leaves no row, which keeps this list about the things somebody may
 * still need to act on.
 */
export function AlertDeliveriesPanel({ orgId }: { orgId: string }) {
  const gt = useGT();
  const gtData = useDataString();
  const { api } = useSettingsHost();
  // See the note in `AlertRoutingSection`: the stable method, not the container.
  const apiGet = api.get;
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);

  const stateLabels: Record<string, string> = {
    held: gt("Held for quiet hours"),
    awaiting_ack: gt("Waiting for acknowledgement"),
    sent: gt("Sent"),
    acknowledged: gt("Acknowledged"),
    escalated: gt("Escalated"),
    expired: gt("Given up"),
  };

  useEffect(() => {
    apiGet<DeliveryRow[]>(`/api/org/${orgId}/alert-rules/deliveries?limit=20`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [apiGet, orgId]);

  if (!rows || rows.length === 0) return null;

  return (
    <div className="pt-3 border-t border-border/50 space-y-2">
      <h3 className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
        {gt("Recent held and escalating alerts")}
      </h3>
      <ul className="divide-y divide-border/50">
        {rows.map((r) => (
          <li key={r.id} className="py-2 text-sm">
            <p className="text-on-surface-secondary truncate">{r.title}</p>
            <p className="text-xs text-on-surface-tertiary">
              {gtData(alertTriggerDef(r.trigger).label)} · {stateLabels[r.state] ?? r.state}
              {r.ruleName ? ` · ${r.ruleName}` : ""}
              {r.state === "held" && r.deliverAfter
                ? gt(" · sends {date}", { date: new Date(r.deliverAfter).toLocaleString() })
                : ""}
              {r.state === "awaiting_ack" && r.escalateAt
                ? gt(" · escalates {date}", { date: new Date(r.escalateAt).toLocaleString() })
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
