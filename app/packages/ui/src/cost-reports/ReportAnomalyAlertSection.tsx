import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  COST_REPORT_ANOMALY_ALERT_LIMITS,
  DEFAULT_COST_REPORT_ANOMALY_ALERT,
  costReportAnomalyAlertProblem,
  type AlertDestination,
  type CostReportAnomalyAlert,
  type CostReportAnomalyAlertInput,
} from "@infrawrench/client-core";
import {
  DestinationPicker,
  type DestinationCatalog,
} from "../settings/alert-routing/DestinationPicker.js";
import { formatMoney } from "../cost/transform.js";
import type { CostReportsClient } from "./types.js";

/**
 * "Anomaly alert" on a report page: the report's own anomaly detection, with
 * its own sensitivity, floor and destinations.
 *
 * The org-wide detector watches providers and services and routes through the
 * alert rules; this watches *this report's* filtered total and sends where the
 * report's owner says. Destinations use the alert routing picker, so a
 * channel, a rotation, a member or an address is chosen by name exactly as in
 * a routing rule. Renders nothing when the host provides no client for it.
 */
export function ReportAnomalyAlertSection({
  reportId,
  client,
}: {
  reportId: string;
  client: CostReportsClient;
}) {
  const gt = useGT();
  const getAlert = client.getReportAnomalyAlert;
  const [alert, setAlert] = useState<CostReportAnomalyAlert | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getAlert) return;
    setError(null);
    try {
      setAlert(await getAlert(reportId));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load the anomaly alert"));
    } finally {
      setLoading(false);
    }
  }, [getAlert, reportId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!getAlert) return null;
  const canEdit = Boolean(client.saveReportAnomalyAlert && client.listReportAnomalyAlertTargets);

  return (
    <section className="border-t border-border pt-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-on-surface">{gt("Anomaly alert")}</h3>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-on-surface-secondary hover:text-on-surface underline"
          >
            {alert ? gt("Edit") : gt("Set up")}
          </button>
        )}
      </div>
      <T>
        <p className="text-xs text-on-surface-muted">
          Watches this report&rsquo;s own scope, its filters and saved filter, and tells the people
          you pick when a day&rsquo;s spend spikes against the previous four weeks. It runs beside
          the organization&rsquo;s anomaly alerts, not instead of them.
        </p>
      </T>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-xs text-on-surface-faint">{gt("Loading…")}</p>
      ) : editing ? (
        <AnomalyAlertEditor
          reportId={reportId}
          client={client}
          alert={alert}
          onSaved={(next) => {
            setAlert(next);
            setEditing(false);
          }}
          onDeleted={() => {
            setAlert(null);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : alert ? (
        <AnomalyAlertSummary alert={alert} />
      ) : (
        <p className="text-xs text-on-surface-faint">
          {canEdit
            ? gt("No anomaly alert on this report yet.")
            : gt("No anomaly alert on this report.")}
        </p>
      )}
    </section>
  );
}

function AnomalyAlertSummary({ alert }: { alert: CostReportAnomalyAlert }) {
  const gt = useGT();
  return (
    <div className="space-y-2 text-xs">
      <p className="text-on-surface-secondary">
        {alert.enabled ? (
          <span className="text-success">{gt("On")}</span>
        ) : (
          <span className="text-on-surface-faint">{gt("Off")}</span>
        )}
        {" · "}
        {gt("{sigmas} standard deviations, and at least {floor} a day over the baseline", {
          sigmas: alert.sigmas,
          floor: (alert.minDeltaCents / 100).toLocaleString(),
        })}
        {" · "}
        {gt("{count} destinations", { count: alert.destinations.length })}
      </p>
      {alert.lastError && (
        <p className="text-danger">
          {gt("The last check failed: {error}", { error: alert.lastError })}
        </p>
      )}
      {alert.recent.length > 0 ? (
        <ul className="space-y-1">
          {alert.recent.slice(0, 5).map((f) => (
            <li key={f.id} className="flex flex-wrap gap-x-2 text-on-surface-tertiary">
              <span className="tabular-nums">{f.day}</span>
              <span>
                {gt("{actual} against {baseline} a day", {
                  actual: formatMoney(f.actual, f.currency),
                  baseline: formatMoney(f.baseline, f.currency),
                })}
              </span>
              <span className="text-on-surface-faint">
                {f.notifiedAt ? gt("sent") : gt("not sent (cooldown or no destination reached)")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-on-surface-faint">
          {alert.lastEvaluatedAt
            ? gt("No anomalies found so far. Last checked {when}.", {
                when: new Date(alert.lastEvaluatedAt).toLocaleString(),
              })
            : gt("Not checked yet: it runs after the next cost collection.")}
        </p>
      )}
    </div>
  );
}

function AnomalyAlertEditor({
  reportId,
  client,
  alert,
  onSaved,
  onDeleted,
  onCancel,
}: {
  reportId: string;
  client: CostReportsClient;
  alert: CostReportAnomalyAlert | null;
  onSaved: (alert: CostReportAnomalyAlert) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const gt = useGT();
  const [catalog, setCatalog] = useState<DestinationCatalog | null>(null);
  const [enabled, setEnabled] = useState(alert?.enabled ?? true);
  const [sigmas, setSigmas] = useState(
    String(alert?.sigmas ?? DEFAULT_COST_REPORT_ANOMALY_ALERT.sigmas),
  );
  const [floor, setFloor] = useState(
    String((alert?.minDeltaCents ?? DEFAULT_COST_REPORT_ANOMALY_ALERT.minDeltaCents) / 100),
  );
  const [destinations, setDestinations] = useState<AlertDestination[]>(alert?.destinations ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listTargets = client.listReportAnomalyAlertTargets;

  useEffect(() => {
    if (!listTargets) return;
    let cancelled = false;
    listTargets(reportId)
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [listTargets, reportId]);

  const input: CostReportAnomalyAlertInput = {
    enabled,
    sigmas: Number(sigmas),
    minDeltaCents: Math.round(Number(floor) * 100),
    destinations,
  };
  const problem = costReportAnomalyAlertProblem(input);

  async function save() {
    if (!client.saveReportAnomalyAlert || problem) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await client.saveReportAnomalyAlert(reportId, input));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!client.deleteReportAnomalyAlert) return;
    if (!window.confirm(gt("Delete this report's anomaly alert and its history?"))) return;
    setBusy(true);
    try {
      await client.deleteReportAnomalyAlert(reportId);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong";
  const L = COST_REPORT_ANOMALY_ALERT_LIMITS;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-raised/50 p-3">
      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {gt("Alert on anomalies in this report")}
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-tertiary">
            {gt("Sensitivity (standard deviations)")}
          </span>
          <input
            type="number"
            min={L.sigmasMin}
            max={L.sigmasMax}
            step={0.5}
            value={sigmas}
            onChange={(e) => setSigmas(e.target.value)}
            className={`${inputClass} w-28 tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-tertiary">{gt("Minimum rise per day")}</span>
          <input
            type="number"
            min={L.minDeltaCentsMin / 100}
            step={1}
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            className={`${inputClass} w-32 tabular-nums`}
          />
        </label>
      </div>
      <p className="text-xs text-on-surface-faint">
        {gt(
          "Lower is more sensitive. A day fires when it is that many standard deviations above the 28-day average and at least the minimum rise above it, in the spend's own currency.",
        )}
      </p>
      <div>
        <p className="text-xs text-on-surface-tertiary mb-1">{gt("Send to")}</p>
        {catalog ? (
          <DestinationPicker
            value={destinations}
            catalog={catalog}
            onChange={setDestinations}
            emptyLabel={gt("Connect a Slack or Teams channel in Settings to send alerts to it.")}
          />
        ) : (
          <p className="text-xs text-on-surface-faint">{gt("Loading destinations…")}</p>
        )}
      </div>
      {(error || problem) && (
        <p role="alert" className="text-xs text-danger">
          {error ?? problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || Boolean(problem)}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {busy ? gt("Saving…") : gt("Save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg transition-colors"
        >
          {gt("Cancel")}
        </button>
        {alert && client.deleteReportAnomalyAlert && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="ml-auto px-3 py-1.5 text-sm font-medium text-danger hover:underline"
          >
            {gt("Delete alert")}
          </button>
        )}
      </div>
    </div>
  );
}
