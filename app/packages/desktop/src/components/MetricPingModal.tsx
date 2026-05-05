import { useEffect, useState } from "react";
import type { MetricSeries } from "@infrawrench/plugin-base";
import { Modal, formatErrorMessage } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getPlugin } from "../plugins/loader";
import { getDb } from "../db/client";
import type { AccountCredsRow } from "../db/rows";
import { buildPluginHostServices } from "../lib/sql-drivers";
import { notifyMetricPingsChanged } from "../lib/metric-pings";

interface ExistingPingRow {
  id: string;
  metric_label: string;
  min_value: number | null;
  max_value: number | null;
}

interface MetricPingModalProps {
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceDisplayName: string;
  onClose: () => void;
}

export function MetricPingModal({
  resourceId,
  accountId,
  pluginId,
  resourceTypeId,
  resourceDisplayName,
  onClose,
}: MetricPingModalProps) {
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string>("");
  const [minStr, setMinStr] = useState("");
  const [maxStr, setMaxStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingPingRow[]>([]);

  async function refreshExisting() {
    const db = await getDb();
    const rows = await db.select<ExistingPingRow[]>(
      "SELECT id, metric_label, min_value, max_value FROM metric_pings WHERE resource_id = $1 ORDER BY metric_label",
      [resourceId],
    );
    setExisting(rows);
  }

  async function handleRemove(id: string) {
    const db = await getDb();
    await db.execute("DELETE FROM metric_pings WHERE id = $1", [id]);
    notifyMetricPingsChanged();
    await refreshExisting();
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const db = await getDb();
        const rows = await db.select<AccountCredsRow[]>(
          "SELECT id, encrypted_credentials, credentials_iv FROM accounts WHERE id = $1 LIMIT 1",
          [accountId],
        );
        const account = rows[0];
        if (!account) throw new Error("Account not found");
        const plaintext = await invoke<string>("decrypt_value", {
          ciphertext: account.encrypted_credentials,
          iv: account.credentials_iv,
        });
        const credentials = JSON.parse(plaintext) as Record<string, string>;
        const loaded = await getPlugin(pluginId);
        if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
        const services = buildPluginHostServices(loaded.plugin.manifest, credentials);
        const client = loaded.plugin.createClient(credentials, services);
        if (!client.fetchMetricSeries) {
          throw new Error("This plugin does not expose metric series");
        }
        const result = await client.fetchMetricSeries(resourceTypeId, resourceId, accountId);
        if (cancelled) return;
        setSeries(result);
        if (result[0]) setSelectedLabel(result[0].label);
      } catch (e) {
        if (!cancelled) setLoadError(formatErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    void refreshExisting();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, pluginId, resourceId, resourceTypeId]);

  async function handleSave() {
    setError(null);
    if (!selectedLabel) {
      setError("Pick a metric");
      return;
    }
    const min = minStr === "" ? null : Number(minStr);
    const max = maxStr === "" ? null : Number(maxStr);
    if (min === null && max === null) {
      setError("Set at least one of min or max");
      return;
    }
    if (min !== null && Number.isNaN(min)) {
      setError("Min must be a number");
      return;
    }
    if (max !== null && Number.isNaN(max)) {
      setError("Max must be a number");
      return;
    }
    setSaving(true);
    try {
      const db = await getDb();
      const id = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await db.execute(
        `INSERT INTO metric_pings
          (id, resource_id, account_id, plugin_id, resource_type_id, resource_display_name, metric_label, min_value, max_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(resource_id, metric_label) DO UPDATE SET
           min_value = excluded.min_value,
           max_value = excluded.max_value,
           last_alert_at = NULL,
           last_alert_state = NULL`,
        [
          id,
          resourceId,
          accountId,
          pluginId,
          resourceTypeId,
          resourceDisplayName,
          selectedLabel,
          min,
          max,
        ],
      );
      notifyMetricPingsChanged();
      await refreshExisting();
      setMinStr("");
      setMaxStr("");
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const selected = series.find((s) => s.label === selectedLabel);
  const latestPoint = selected?.points.at(-1);

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-overlay border border-border rounded-xl shadow-2xl p-5 w-[28rem] max-w-[90vw]">
        <h2 className="text-sm font-semibold text-on-surface mb-3">
          Ping when out of range — {resourceDisplayName}
        </h2>
        {existing.length > 0 && (
          <div className="flex flex-col gap-1 mb-3">
            <span className="text-xs text-on-surface-muted">Active pings</span>
            <ul className="flex flex-col gap-1">
              {existing.map((p) => {
                const range =
                  p.min_value !== null && p.max_value !== null
                    ? `${p.min_value}–${p.max_value}`
                    : p.min_value !== null
                      ? `≥ ${p.min_value}`
                      : `≤ ${p.max_value}`;
                return (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 bg-surface-sunken border border-border rounded px-2 py-1.5 text-sm"
                  >
                    <span className="text-on-surface truncate">
                      {p.metric_label} <span className="text-on-surface-faint">({range})</span>
                    </span>
                    <button
                      onClick={() => void handleRemove(p.id)}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-surface-overlay"
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {loading && <div className="text-sm text-on-surface-muted px-1 py-2">Loading metrics…</div>}
        {loadError && <div className="text-sm text-red-400 px-1 py-2">{loadError}</div>}
        {!loading && !loadError && series.length === 0 && (
          <div className="text-sm text-on-surface-muted px-1 py-2">
            No metrics available for this resource.
          </div>
        )}
        {!loading && !loadError && series.length > 0 && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-muted">Metric</span>
              <select
                value={selectedLabel}
                onChange={(e) => setSelectedLabel(e.target.value)}
                className="bg-surface-sunken border border-border rounded px-2 py-1.5 text-sm text-on-surface"
              >
                {series.map((s) => (
                  <option key={s.label} value={s.label}>
                    {s.label}
                    {s.unit ? ` (${s.unit})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {latestPoint && (
              <div className="text-xs text-on-surface-faint">
                Latest value: {latestPoint.value}
                {selected?.unit ? ` ${selected.unit}` : ""}
              </div>
            )}
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 flex-1">
                <span className="text-xs text-on-surface-muted">Min (alert when below)</span>
                <input
                  type="number"
                  value={minStr}
                  onChange={(e) => setMinStr(e.target.value)}
                  placeholder="—"
                  className="bg-surface-sunken border border-border rounded px-2 py-1.5 text-sm text-on-surface"
                />
              </label>
              <label className="flex flex-col gap-1 flex-1">
                <span className="text-xs text-on-surface-muted">Max (alert when above)</span>
                <input
                  type="number"
                  value={maxStr}
                  onChange={(e) => setMaxStr(e.target.value)}
                  placeholder="—"
                  className="bg-surface-sunken border border-border rounded px-2 py-1.5 text-sm text-on-surface"
                />
              </label>
            </div>
            {error && <div className="text-sm text-red-400">{error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-on-surface-secondary rounded hover:bg-surface-sunken transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save ping"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
