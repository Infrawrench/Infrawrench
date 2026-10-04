import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  AI_DEFAULT_LOOKBACK_DAYS,
  AI_MAX_DIMENSIONS,
  AI_MAX_LOOKBACK_DAYS,
  AI_SUGGESTED_DIMENSIONS,
  aiCallerTagKey,
  aiMatchRate,
  formatAiCoverage,
  formatMoney,
  type AiAttributionDimension,
  type AiAttributionDimensionInput,
  type AiAttributionStats,
  type AiRequestLogLocationOption,
  type AiRequestSource,
  type AiRequestSourceInput,
  type AiRequestSourceKindOption,
  type AiSpendBreakdown,
} from "@infrawrench/client-core";
import { parseNumericInputValue } from "../form-values.js";
import { useDataString } from "../i18n/data-strings.js";
import { useSettingsHost } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/**
 * AI request attribution: where request logs come from, which metadata keys
 * become caller dimensions, and how well the logs explain the bill.
 *
 * Three things this page must make obvious:
 *
 *  - **Billed totals never move.** Attribution only relabels money that was
 *    already billed; whatever the logs do not explain is shown as
 *    `(unattributed)`, never spread across the callers that were seen.
 *  - **Match rate is the honesty check.** A source whose requests do not land
 *    on a billed line (a provider that is not connected, a model the bill does
 *    not name) is counted, not hidden.
 *  - **Caller dimensions are ordinary tag keys** (`caller:team`) everywhere
 *    else: cost reports, budgets, allocation rules. This page says so, so
 *    nobody looks for a separate report.
 */

const RANGES = [7, 30, 90] as const;

function sourceKindKey(k: { kind: string; pluginId: string | null; sourceKindId: string }): string {
  return `${k.kind}:${k.pluginId ?? ""}:${k.sourceKindId}`;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export function AiAttributionSection() {
  const gt = useGT();
  const { orgId, api, has } = useSettingsHost();
  const canWriteSources = has("org:settings:write");
  const canWriteDimensions = has("costs:write");
  const base = `/api/org/${orgId}/ai-attribution`;

  const [kinds, setKinds] = useState<AiRequestSourceKindOption[]>([]);
  const [sources, setSources] = useState<AiRequestSource[]>([]);
  const [dimensions, setDimensions] = useState<AiAttributionDimension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<AiRequestSource | "new" | null>(null);
  const [editingDimension, setEditingDimension] = useState<AiAttributionDimension | "new" | null>(
    null,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [k, s, d] = await Promise.all([
        api.get<{ sourceKinds: AiRequestSourceKindOption[] }>(`${base}/source-kinds`),
        api.get<{ sources: AiRequestSource[] }>(`${base}/sources`),
        api.get<{ dimensions: AiAttributionDimension[] }>(`${base}/dimensions`),
      ]);
      setKinds(k.sourceKinds);
      setSources(s.sources);
      setDimensions(d.dimensions);
    } catch (e) {
      setError(errorMessage(e, gt("Failed to load AI attribution settings")));
    } finally {
      setLoading(false);
    }
  }, [api, base, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  const observedKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) {
      for (const [k, n] of Object.entries(s.observedMetadataKeys)) {
        counts.set(k, (counts.get(k) ?? 0) + n);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }, [sources]);

  async function removeSource(id: string) {
    setError(null);
    try {
      await api.delete(`${base}/sources/${id}`);
      await load();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to delete source")));
    }
  }

  async function recollect(source: AiRequestSource) {
    setError(null);
    try {
      await api.post(`${base}/sources/${source.id}/recollect`, {
        from: isoDaysAgo(source.lookbackDays),
      });
      await load();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to schedule re-collection")));
    }
  }

  async function removeDimension(id: string) {
    setError(null);
    try {
      await api.delete(`${base}/dimensions/${id}`);
      await load();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to delete dimension")));
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("AI Attribution")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Split AI spend by team, user, feature or customer by joining per-request logs to the
            bills your AI providers already report. Each request is priced at list rates and scaled
            so the split adds up to what was billed; whatever the logs do not explain stays as
            (unattributed). Billed totals never change.
          </p>
        </T>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-6">
          <section className={CARD}>
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-semibold">{gt("Request-log sources")}</h2>
                <T>
                  <p className="text-xs text-on-surface-muted mt-1">
                    Where per-request logs live. Each closed day is read once and folded into daily
                    totals per model and mapped metadata; raw requests are never stored.
                  </p>
                </T>
              </div>
              {canWriteSources && (
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  onClick={() => setEditingSource(editingSource === "new" ? null : "new")}
                >
                  {editingSource === "new" ? gt("Cancel") : gt("Add source")}
                </button>
              )}
            </div>

            {editingSource !== null && (
              <SourceForm
                key={editingSource === "new" ? "new" : editingSource.id}
                kinds={kinds}
                existing={editingSource === "new" ? null : editingSource}
                base={base}
                onCancel={() => setEditingSource(null)}
                onSaved={() => {
                  setEditingSource(null);
                  void load();
                }}
              />
            )}

            {sources.length === 0 ? (
              <T>
                <p className="text-sm text-on-surface-muted">
                  No sources yet. Add Bedrock invocation logs, a Cloudflare AI Gateway, a LiteLLM
                  proxy, or JSONL request logs in S3.
                </p>
              </T>
            ) : (
              <ul className="divide-y divide-border">
                {sources.map((s) => (
                  <SourceRow
                    key={s.id}
                    source={s}
                    kinds={kinds}
                    canWrite={canWriteSources}
                    onEdit={() => setEditingSource(s)}
                    onDelete={() => void removeSource(s.id)}
                    onRecollect={() => void recollect(s)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className={CARD}>
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-semibold">{gt("Caller dimensions")}</h2>
                <T>
                  <p className="text-xs text-on-surface-muted mt-1">
                    Map request-metadata keys to a dimension; the first key a request carries wins.
                    Each dimension appears in cost reports, budgets and allocation rules as the tag
                    key <code>caller:&lt;key&gt;</code>. New mappings apply from the next
                    collection; re-collect a source to apply them to past days.
                  </p>
                </T>
              </div>
              {canWriteDimensions && dimensions.length < AI_MAX_DIMENSIONS && (
                <button
                  type="button"
                  className={PRIMARY_BUTTON}
                  onClick={() => setEditingDimension(editingDimension === "new" ? null : "new")}
                >
                  {editingDimension === "new" ? gt("Cancel") : gt("Add dimension")}
                </button>
              )}
            </div>

            {editingDimension !== null && (
              <DimensionForm
                key={editingDimension === "new" ? "new" : editingDimension.id}
                existing={editingDimension === "new" ? null : editingDimension}
                taken={dimensions.map((d) => d.key)}
                observedKeys={observedKeys}
                base={base}
                onCancel={() => setEditingDimension(null)}
                onSaved={() => {
                  setEditingDimension(null);
                  void load();
                }}
              />
            )}

            {dimensions.length === 0 ? (
              <T>
                <p className="text-sm text-on-surface-muted">
                  No dimensions yet. Without one, attribution still reports match rates and coverage
                  but splits nothing by caller.
                </p>
              </T>
            ) : (
              <ul className="divide-y divide-border">
                {dimensions.map((d) => (
                  <li key={d.id} className="py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-on-surface-secondary">
                        {d.label}{" "}
                        <code className="text-xs text-on-surface-muted">
                          {aiCallerTagKey(d.key)}
                        </code>
                      </div>
                      <div className="text-xs text-on-surface-muted truncate">
                        {gt("Metadata keys: {keys}", { keys: d.metadataKeys.join(", ") })}
                      </div>
                    </div>
                    {canWriteDimensions && (
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          onClick={() => setEditingDimension(d)}
                        >
                          {gt("Edit")}
                        </button>
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          onClick={() => void removeDimension(d.id)}
                        >
                          {gt("Delete")}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <StatsCard base={base} dimensions={dimensions} />
        </div>
      )}
    </div>
  );
}

function SourceRow({
  source,
  kinds,
  canWrite,
  onEdit,
  onDelete,
  onRecollect,
}: {
  source: AiRequestSource;
  kinds: AiRequestSourceKindOption[];
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRecollect: () => void;
}) {
  const gt = useGT();
  const ds = useDataString();
  const { openExternal } = useSettingsHost();
  const kind = kinds.find((k) => sourceKindKey(k) === sourceKindKey(source));
  const where =
    source.kind === "litellm"
      ? (source.baseUrl ?? "")
      : Object.entries(source.location)
          .filter(([k, v]) => v && k !== "region")
          .map(([, v]) => v)
          .join("/");
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-on-surface-secondary">
            {source.name}
            {!source.enabled && (
              <span className="ml-2 text-xs text-on-surface-faint">{gt("Paused")}</span>
            )}
          </div>
          <div className="text-xs text-on-surface-muted truncate">
            {kind ? ds(kind.label) : source.sourceKindId}
            {source.accountName ? ` · ${source.accountName}` : ""}
            {where ? ` · ${where}` : ""}
          </div>
          <div className="text-xs text-on-surface-faint mt-0.5">
            {source.collectedThrough
              ? gt("Collected through {day}", { day: source.collectedThrough })
              : gt("Not collected yet")}
            {kind?.queriesBillable ? ` · ${gt("Queries are billed to this account")}` : ""}
          </div>
          {source.lastError && (
            <div className="text-xs text-danger mt-1">
              {source.lastError}
              {source.lastErrorHelpUrl && (
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => openExternal(source.lastErrorHelpUrl!)}
                >
                  {gt("How to fix")}
                </button>
              )}
            </div>
          )}
        </div>
        {canWrite && (
          <div className="flex gap-2 shrink-0">
            <button type="button" className={SECONDARY_BUTTON} onClick={onRecollect}>
              {gt("Re-collect")}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={onEdit}>
              {gt("Edit")}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={onDelete}>
              {gt("Delete")}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function SourceForm({
  kinds,
  existing,
  base,
  onCancel,
  onSaved,
}: {
  kinds: AiRequestSourceKindOption[];
  existing: AiRequestSource | null;
  base: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const gt = useGT();
  const ds = useDataString();
  const { api, openExternal } = useSettingsHost();
  const [kindKey, setKindKey] = useState(existing ? sourceKindKey(existing) : "");
  const kind = kinds.find((k) => sourceKindKey(k) === kindKey) ?? null;
  const [name, setName] = useState(existing?.name ?? "");
  const [accountId, setAccountId] = useState(existing?.accountId ?? "");
  const [location, setLocation] = useState<Record<string, string>>(existing?.location ?? {});
  const [locations, setLocations] = useState<AiRequestLogLocationOption[] | null>(null);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [lookbackDays, setLookbackDays] = useState(
    existing?.lookbackDays ?? AI_DEFAULT_LOOKBACK_DAYS,
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the account to the only one, and the name to the kind's label.
  useEffect(() => {
    if (!kind || existing) return;
    if (kind.kind === "plugin" && kind.accounts.length === 1) setAccountId(kind.accounts[0]!.id);
  }, [kind, existing]);

  useEffect(() => {
    if (!kind || kind.kind !== "plugin" || !accountId) {
      setLocations(null);
      return;
    }
    let cancelled = false;
    setLocations(null);
    setLocationsError(null);
    const params = new URLSearchParams({ accountId, sourceKindId: kind.sourceKindId });
    api
      .get<{ locations: AiRequestLogLocationOption[] }>(`${base}/locations?${params}`)
      .then((r) => {
        if (cancelled) return;
        const sorted = [...r.locations].sort(
          (a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false),
        );
        setLocations(sorted);
        if (!existing && sorted[0]?.recommended) setLocation(sorted[0].location);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLocationsError(errorMessage(e, gt("Could not list locations")));
      });
    return () => {
      cancelled = true;
    };
  }, [api, base, kind, accountId, existing, gt]);

  const selectedLocationId =
    locations?.find((l) =>
      Object.entries(l.location).every(([k, v]) => k === "prefix" || location[k] === v),
    )?.id ?? "";

  async function save() {
    if (!kind) return;
    setSaving(true);
    setError(null);
    const body: AiRequestSourceInput = {
      name: name.trim() || ds(kind.label),
      kind: kind.kind,
      accountId: kind.kind === "plugin" ? accountId : null,
      sourceKindId: kind.sourceKindId,
      location: kind.kind === "plugin" ? location : {},
      enabled,
      lookbackDays,
      ...(kind.kind === "litellm" ? { baseUrl } : {}),
      ...(kind.kind === "litellm" && apiKey ? { apiKey } : {}),
    };
    try {
      if (existing) await api.put(`${base}/sources/${existing.id}`, body);
      else await api.post(`${base}/sources`, body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to save source")));
    } finally {
      setSaving(false);
    }
  }

  const ready =
    !!kind &&
    (kind.kind === "litellm"
      ? baseUrl.trim() !== "" && (apiKey.trim() !== "" || !!existing?.hasApiKey)
      : !!accountId && Object.keys(location).length > 0);

  return (
    <div className="mb-4 p-4 border border-border rounded-lg space-y-3">
      <div>
        <label className={LABEL} htmlFor="ai-source-kind">
          {gt("Source")}
        </label>
        <select
          id="ai-source-kind"
          className={INPUT}
          value={kindKey}
          disabled={!!existing}
          onChange={(e) => {
            setKindKey(e.target.value);
            setLocation({});
            setAccountId("");
          }}
        >
          <option value="">{gt("Choose a source…")}</option>
          {kinds.map((k) => (
            <option key={sourceKindKey(k)} value={sourceKindKey(k)}>
              {k.pluginName ? `${ds(k.pluginName)}: ${ds(k.label)}` : ds(k.label)}
            </option>
          ))}
        </select>
        {kind && (
          <p className="text-xs text-on-surface-muted mt-1">
            {ds(kind.description)}{" "}
            {kind.helpUrl && (
              <button
                type="button"
                className="underline"
                onClick={() => openExternal(kind.helpUrl!)}
              >
                {gt("Setup guide")}
              </button>
            )}
          </p>
        )}
        {kind?.queriesBillable && (
          <p className="text-xs text-warning mt-1">
            {gt(
              "Reading this source runs a daily query that the provider bills to this account per GB scanned.",
            )}
          </p>
        )}
      </div>

      {kind?.kind === "plugin" && (
        <>
          <div>
            <label className={LABEL} htmlFor="ai-source-account">
              {gt("Account")}
            </label>
            {kind.accounts.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("Connect an account of this provider first.")}
              </p>
            ) : (
              <select
                id="ai-source-account"
                className={INPUT}
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setLocation({});
                }}
              >
                <option value="">{gt("Choose an account…")}</option>
                {kind.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {accountId && (
            <div>
              <label className={LABEL} htmlFor="ai-source-location">
                {ds(kind.locationLabel)}
              </label>
              {locationsError ? (
                <p className="text-xs text-danger">{locationsError}</p>
              ) : locations === null ? (
                <p className="text-xs text-on-surface-faint">{gt("Loading…")}</p>
              ) : locations.length === 0 ? (
                <p className="text-xs text-on-surface-muted">
                  {gt("Nothing to pick from in this account yet.")}
                </p>
              ) : (
                <select
                  id="ai-source-location"
                  className={INPUT}
                  value={selectedLocationId}
                  onChange={(e) => {
                    const picked = locations.find((l) => l.id === e.target.value);
                    setLocation(picked ? { ...picked.location } : {});
                  }}
                >
                  <option value="">{gt("Choose…")}</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.recommended ? gt("{label} (recommended)", { label: l.label }) : l.label}
                      {l.detail ? ` · ${l.detail}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {kind.acceptsPrefix && Object.keys(location).length > 0 && (
            <div>
              <label className={LABEL} htmlFor="ai-source-prefix">
                {gt("Key prefix (optional)")}
              </label>
              <input
                id="ai-source-prefix"
                className={INPUT}
                value={location["prefix"] ?? ""}
                // i18n-ignore: example object key prefix
                placeholder="logs/requests/"
                onChange={(e) => setLocation({ ...location, prefix: e.target.value })}
              />
            </div>
          )}
        </>
      )}

      {kind?.kind === "litellm" && (
        <>
          <div>
            <label className={LABEL} htmlFor="ai-source-url">
              {gt("Proxy URL")}
            </label>
            <input
              id="ai-source-url"
              className={INPUT}
              value={baseUrl}
              placeholder="https://litellm.example.com"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="ai-source-key">
              {gt("Admin key")}
            </label>
            <input
              id="ai-source-key"
              className={INPUT}
              type="password"
              value={apiKey}
              placeholder={existing?.hasApiKey ? gt("Leave blank to keep the stored key") : ""}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </>
      )}

      {kind && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="ai-source-name">
              {gt("Name")}
            </label>
            <input
              id="ai-source-name"
              className={INPUT}
              value={name}
              placeholder={ds(kind.label)}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="ai-source-lookback">
              {gt("First collection reaches back (days)")}
            </label>
            <input
              id="ai-source-lookback"
              className={INPUT}
              type="number"
              min={1}
              max={Math.min(AI_MAX_LOOKBACK_DAYS, kind.maxHistoryDays)}
              value={lookbackDays}
              onChange={(e) =>
                setLookbackDays(parseNumericInputValue(e.target.value) ?? AI_DEFAULT_LOOKBACK_DAYS)
              }
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {gt("Collect daily")}
          </label>
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={!ready || saving}
          onClick={() => void save()}
        >
          {saving ? gt("Saving…") : existing ? gt("Save") : gt("Add source")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </div>
  );
}

function DimensionForm({
  existing,
  taken,
  observedKeys,
  base,
  onCancel,
  onSaved,
}: {
  existing: AiAttributionDimension | null;
  taken: string[];
  observedKeys: string[];
  base: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const gt = useGT();
  const { api } = useSettingsHost();
  const [key, setKey] = useState(existing?.key ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [keys, setKeys] = useState<string[]>(existing?.metadataKeys ?? []);
  const [draftKey, setDraftKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presets = AI_SUGGESTED_DIMENSIONS.filter((p) => !taken.includes(p.key));
  const suggestions = observedKeys.filter((k) => !keys.includes(k)).slice(0, 12);

  function addKey(k: string) {
    const trimmed = k.trim();
    if (trimmed && !keys.includes(trimmed)) setKeys([...keys, trimmed]);
    setDraftKey("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    const body: AiAttributionDimensionInput = { key, label, metadataKeys: keys };
    try {
      if (existing) await api.put(`${base}/dimensions/${existing.id}`, body);
      else await api.post(`${base}/dimensions`, body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to save dimension")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 p-4 border border-border rounded-lg space-y-3">
      {!existing && presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-on-surface-muted">{gt("Start from:")}</span>
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                setKey(p.key);
                setLabel(p.label);
                setKeys(p.metadataKeys);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="ai-dim-label">
            {gt("Label")}
          </label>
          <input
            id="ai-dim-label"
            className={INPUT}
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!existing && !key)
                setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"));
            }}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="ai-dim-key">
            {gt("Key")}
          </label>
          <input
            id="ai-dim-key"
            className={INPUT}
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
          />
          <p className="text-xs text-on-surface-faint mt-1">
            {gt("Reports show it as the tag key {tag}", { tag: aiCallerTagKey(key || "…") })}
          </p>
        </div>
      </div>
      <div>
        <label className={LABEL} htmlFor="ai-dim-metadata">
          {gt("Metadata keys, first present wins")}
        </label>
        <div className="flex flex-wrap gap-2 mb-2">
          {keys.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs border border-border rounded-full"
            >
              {k}
              <button
                type="button"
                aria-label={gt("Remove {key}", { key: k })}
                onClick={() => setKeys(keys.filter((x) => x !== k))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            id="ai-dim-metadata"
            className={INPUT}
            value={draftKey}
            list="ai-dim-observed"
            placeholder={gt("Type a key or pick one seen in your logs")}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKey(draftKey);
              }
            }}
          />
          <datalist id="ai-dim-observed">
            {observedKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => addKey(draftKey)}>
            {gt("Add")}
          </button>
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="text-xs text-on-surface-muted">{gt("Seen in your logs:")}</span>
            {suggestions.map((k) => (
              <button
                key={k}
                type="button"
                className="px-2 py-0.5 text-xs border border-dashed border-border rounded-full"
                onClick={() => addKey(k)}
              >
                {k}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving || !key || !label || keys.length === 0}
          onClick={() => void save()}
        >
          {saving ? gt("Saving…") : gt("Save")}
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
          {gt("Cancel")}
        </button>
      </div>
    </div>
  );
}

function StatsCard({ base, dimensions }: { base: string; dimensions: AiAttributionDimension[] }) {
  const gt = useGT();
  const { api } = useSettingsHost();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [stats, setStats] = useState<AiAttributionStats | null>(null);
  const [dimension, setDimension] = useState(dimensions[0]?.key ?? "");
  const [spend, setSpend] = useState<AiSpendBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dimension && dimensions[0]) setDimension(dimensions[0].key);
  }, [dimensions, dimension]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ from: isoDaysAgo(days - 1), to: isoDaysAgo(0) });
    setError(null);
    api
      .get<AiAttributionStats>(`${base}/stats?${params}`)
      .then((s) => !cancelled && setStats(s))
      .catch(
        (e: unknown) => !cancelled && setError(errorMessage(e, gt("Failed to load statistics"))),
      );
    if (dimension) {
      params.set("dimension", dimension);
      api
        .get<AiSpendBreakdown>(`${base}/spend?${params}`)
        .then((s) => !cancelled && setSpend(s))
        .catch(() => !cancelled && setSpend(null));
    } else {
      setSpend(null);
    }
    return () => {
      cancelled = true;
    };
  }, [api, base, days, dimension, gt]);

  const maxSpend = Math.max(0, ...(spend?.rows ?? []).map((r) => r.amount));

  return (
    <section className={CARD}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-semibold">{gt("Match rate and coverage")}</h2>
          <T>
            <p className="text-xs text-on-surface-muted mt-1">
              Matched requests landed on a billed line; ambiguous ones matched several models and
              were split by billed amount; unmatched ones had nowhere to land (the provider is not
              connected, or its bill does not name the model).
            </p>
          </T>
        </div>
        <select
          className={`${INPUT} w-auto`}
          aria-label={gt("Range")}
          value={days}
          onChange={(e) => setDays(Number(e.target.value) as (typeof RANGES)[number])}
        >
          {RANGES.map((d) => (
            <option key={d} value={d}>
              {gt("Last {days} days", { days: d })}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      {stats && (
        <>
          {stats.sources.length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-on-surface-muted text-left">
                    <th className="py-1 pr-3 font-normal">{gt("Source")}</th>
                    <th className="py-1 pr-3 font-normal text-right">{gt("Requests")}</th>
                    <th className="py-1 pr-3 font-normal text-right">{gt("Matched")}</th>
                    <th className="py-1 pr-3 font-normal text-right">{gt("Ambiguous")}</th>
                    <th className="py-1 pr-3 font-normal text-right">{gt("Unmatched")}</th>
                    <th className="py-1 font-normal text-right">{gt("Bill covered")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.sources.map((s) => (
                    <tr key={s.sourceId} className="border-t border-border">
                      <td className="py-1.5 pr-3">
                        {s.name}
                        {(s.degradedDays > 0 || s.truncatedDays > 0) && (
                          <span className="ml-1 text-xs text-warning">
                            {gt("partial on {n} days", { n: s.degradedDays + s.truncatedDays })}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right">{s.requests.toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-right">{formatAiCoverage(aiMatchRate(s))}</td>
                      <td className="py-1.5 pr-3 text-right">
                        {s.ambiguousRequests.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {s.unmatchedRequests.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right">{formatAiCoverage(s.coveragePercent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stats.providers.length === 0 ? (
            <T>
              <p className="text-sm text-on-surface-muted">
                No AI spend has been attributed in this range yet. Attribution runs after each
                source collection and each cost collection.
              </p>
            </T>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-on-surface-muted text-left">
                    <th className="py-1 pr-3 font-normal">{gt("Provider")}</th>
                    <th className="py-1 pr-3 font-normal text-right">{gt("Billed")}</th>
                    <th className="py-1 pr-3 font-normal text-right">{gt("Attributed")}</th>
                    <th className="py-1 font-normal text-right">{gt("Unattributed")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.providers.map((p) => (
                    <tr key={`${p.provider}:${p.currency}`} className="border-t border-border">
                      <td className="py-1.5 pr-3">{p.provider}</td>
                      <td className="py-1.5 pr-3 text-right">
                        {formatMoney(p.billedAmount, p.currency)}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {formatMoney(p.attributedAmount, p.currency)}
                      </td>
                      <td className="py-1.5 text-right">
                        {formatMoney(p.unattributedAmount, p.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {dimensions.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="text-sm font-semibold">{gt("AI spend by caller")}</h3>
            <select
              className={`${INPUT} w-auto`}
              aria-label={gt("Dimension")}
              value={dimension}
              onChange={(e) => setDimension(e.target.value)}
            >
              {dimensions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          {!spend || spend.rows.length === 0 ? (
            <p className="text-sm text-on-surface-muted">
              {gt("No attributed spend in this range.")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {spend.rows.map((r) => (
                <li key={`${r.value}:${r.currency}`} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="truncate">{r.value || gt("(no value)")}</span>
                    <span className="shrink-0">{formatMoney(r.amount, r.currency)}</span>
                  </div>
                  <div className="h-1.5 bg-surface-overlay rounded">
                    <div
                      className="h-1.5 bg-blue-600 rounded"
                      style={{
                        width: `${maxSpend > 0 ? Math.max(1, (r.amount / maxSpend) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <T>
            <p className="text-xs text-on-surface-faint mt-2">
              For a time series, group a cost report by the tag key{" "}
              <Var>
                <code>{spend?.tagKey ?? ""}</code>
              </Var>
              .
            </p>
          </T>
        </div>
      )}
    </section>
  );
}
