import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";

import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  BUSINESS_METRIC_IMPORT_AGGREGATIONS,
  BUSINESS_METRIC_IMPORT_AGGREGATION_LABELS,
  BUSINESS_METRIC_IMPORT_LIMITS,
  BUSINESS_METRIC_IMPORT_SCHEDULES,
  BUSINESS_METRIC_IMPORT_SCHEDULE_LABELS,
  type BusinessMetric,
  type BusinessMetricImportAggregation,
  type BusinessMetricImporter,
  type BusinessMetricImporterInput,
  type BusinessMetricImportPreview,
  type BusinessMetricImportRun,
  type BusinessMetricImportSchedule,
  type BusinessMetricSourceAccount,
  type BusinessMetricSourceOption,
} from "./config.js";
import type { CostsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
const buttonClass =
  "rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50";

type SourceField = BusinessMetricSourceAccount["source"]["fields"][number];

/** IANA zones when the runtime can list them; the field falls back to free text. */
function knownTimeZones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf !== "function") return [];
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

/** The default params for a source: each field's `defaultValue`. */
function defaultParams(source: BusinessMetricSourceAccount["source"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of source.fields) {
    if (field.defaultValue !== undefined) out[field.key] = field.defaultValue;
  }
  return out;
}

/**
 * The scheduled importer for one business metric: pick a connected account
 * whose plugin can feed metrics, fill the plugin's form (pickers load their
 * choices from the provider, so nobody types a namespace or a dataset id),
 * preview what a run would write, then save. Below the form, "run now" with an
 * optional backfill window and the run history with each failure's message.
 *
 * Everything provider-specific comes from the plugin's declaration; this
 * component only knows field types.
 */
export function BusinessMetricImporterModal({
  metric,
  client,
  onClose,
  onChanged,
}: {
  metric: BusinessMetric;
  client: CostsClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();
  const zones = useMemo(knownTimeZones, []);

  const [sources, setSources] = useState<BusinessMetricSourceAccount[] | null>(null);
  const [importer, setImporter] = useState<BusinessMetricImporter | null>(null);
  const [runs, setRuns] = useState<BusinessMetricImportRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [accountId, setAccountId] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<BusinessMetricImportSchedule>("daily");
  const [backfillDays, setBackfillDays] = useState<number>(
    BUSINESS_METRIC_IMPORT_LIMITS.defaultBackfillDays,
  );
  const [timezone, setTimezone] = useState("UTC");
  const [aggregation, setAggregation] = useState<BusinessMetricImportAggregation>("sum");
  const [enabled, setEnabled] = useState(true);

  const [options, setOptions] = useState<Record<string, BusinessMetricSourceOption[]>>({});
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<BusinessMetricImportPreview | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "dry" | "save" | "run" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backfillFrom, setBackfillFrom] = useState("");
  const [backfillTo, setBackfillTo] = useState("");

  const source = sources?.find((s) => s.accountId === accountId) ?? null;

  const loadRuns = useCallback(async () => {
    if (!client.listBusinessMetricImportRuns) return;
    try {
      setRuns(await client.listBusinessMetricImportRuns(metric.id, 20));
    } catch {
      // The history is secondary; the form still works without it.
    }
  }, [client, metric.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, current] = await Promise.all([
          client.listBusinessMetricSources?.() ?? Promise.resolve([]),
          client.getBusinessMetricImporter?.(metric.id) ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSources(list);
        setImporter(current);
        if (current) {
          setAccountId(current.accountId);
          setParams(current.params);
          setSchedule(current.schedule);
          setBackfillDays(current.backfillDays);
          setTimezone(current.timezone);
          setAggregation(current.aggregation);
          setEnabled(current.enabled);
        } else if (list[0]) {
          setAccountId(list[0].accountId);
          setParams(defaultParams(list[0].source));
        }
      } catch (e: unknown) {
        if (!cancelled) setLoadError(errorMessage(e));
      }
    })();
    void loadRuns();
    return () => {
      cancelled = true;
    };
  }, [client, metric.id, loadRuns]);

  // Load each select field's choices once its dependencies are set, and again
  // whenever one of them changes. Static options need no call.
  const loadOptions = client.listBusinessMetricSourceOptions;
  const dependencyKey = source
    ? source.source.fields
        .filter((f) => f.type === "select" && !f.options)
        .map((f) => `${f.key}=${(f.dependsOn ?? []).map((d) => params[d] ?? "").join("|")}`)
        .join(";")
    : "";
  useEffect(() => {
    if (!source || !loadOptions) return;
    let cancelled = false;
    for (const field of source.source.fields) {
      if (field.type !== "select" || field.options) continue;
      if ((field.dependsOn ?? []).some((dep) => !params[dep])) {
        setOptions((prev) => ({ ...prev, [field.key]: [] }));
        continue;
      }
      void loadOptions({ accountId: source.accountId, fieldKey: field.key, params })
        .then((choices) => {
          if (cancelled) return;
          setOptions((prev) => ({ ...prev, [field.key]: choices }));
          setOptionErrors((prev) => {
            const next = { ...prev };
            delete next[field.key];
            return next;
          });
        })
        .catch((e: unknown) => {
          if (!cancelled) setOptionErrors((prev) => ({ ...prev, [field.key]: errorMessage(e) }));
        });
    }
    return () => {
      cancelled = true;
    };
    // `params` is read through `dependencyKey`, which changes exactly when a
    // dependency does; listing `params` would refetch on every keystroke in
    // the SQL editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.accountId, dependencyKey, loadOptions]);

  function pickAccount(id: string) {
    setAccountId(id);
    const next = sources?.find((s) => s.accountId === id);
    setParams(next ? defaultParams(next.source) : {});
    setOptions({});
    setOptionErrors({});
    setPreview(null);
  }

  function setParam(field: SourceField, value: string) {
    setParams((prev) => {
      const next = { ...prev, [field.key]: value };
      // Clear anything that depended on this field: a metric name picked for
      // one namespace means nothing under another.
      if (source) {
        for (const other of source.source.fields) {
          if (other.dependsOn?.includes(field.key)) delete next[other.key];
        }
      }
      return next;
    });
    setPreview(null);
  }

  function input(): BusinessMetricImporterInput {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== "") cleaned[k] = v;
    return { accountId, params: cleaned, schedule, backfillDays, timezone, aggregation, enabled };
  }

  const missingRequired = source
    ? source.source.fields.filter((f) => f.required && !params[f.key]).map((f) => f.label)
    : [];
  const valid = Boolean(source) && missingRequired.length === 0;

  async function runPreview(dryRun: boolean) {
    if (!client.previewBusinessMetricImport || !source) return;
    setBusy(dryRun ? "dry" : "preview");
    setError(null);
    try {
      const i = input();
      setPreview(
        await client.previewBusinessMetricImport({
          accountId: i.accountId,
          params: i.params,
          timezone,
          aggregation,
          ...(dryRun ? { dryRun: true } : {}),
        }),
      );
    } catch (e: unknown) {
      setError(errorMessage(e));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!client.saveBusinessMetricImporter) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await client.saveBusinessMetricImporter(metric.id, input());
      setImporter(saved);
      setNotice(
        saved.enabled
          ? gt("Saved. The first run is due now and will appear in the history below.")
          : gt("Saved. The importer is paused."),
      );
      await onChanged();
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    if (!client.runBusinessMetricImporter) return;
    setBusy("run");
    setError(null);
    setNotice(null);
    try {
      const run = await client.runBusinessMetricImporter(metric.id, {
        ...(backfillFrom ? { from: backfillFrom } : {}),
        ...(backfillTo ? { to: backfillTo } : {}),
      });
      setNotice(
        run.status === "success"
          ? gt("Imported {days} days ({from} → {to}).", {
              days: run.daysWritten,
              from: run.from,
              to: run.to,
            })
          : gt("The run failed: {error}", { error: run.error ?? "" }),
      );
      await loadRuns();
      await onChanged();
      if (client.getBusinessMetricImporter) {
        setImporter(await client.getBusinessMetricImporter(metric.id));
      }
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!client.deleteBusinessMetricImporter) return;
    if (
      !window.confirm(
        gt(
          "Stop importing {name}? Values already imported stay; new days will be gaps unless something else reports them.",
          { name: metric.name },
        ),
      )
    ) {
      return;
    }
    setBusy("delete");
    setError(null);
    try {
      await client.deleteBusinessMetricImporter(metric.id);
      await onChanged();
      onClose();
    } catch (e: unknown) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  function renderField(field: SourceField) {
    const id = `${uid}-${field.key}`;
    const value = params[field.key] ?? "";
    const label = (
      <label className={labelClass} htmlFor={id}>
        {gtData(field.label)}
        {field.required ? " *" : ""}
      </label>
    );
    const help = field.description ? (
      <p className="text-[11px] text-on-surface-faint mt-1">{gtData(field.description)}</p>
    ) : null;

    if (field.type === "sql") {
      return (
        <div key={field.key}>
          {label}
          <textarea
            id={id}
            className={`${inputClass} font-mono text-xs min-h-[140px]`}
            value={value}
            spellCheck={false}
            onChange={(e) => setParam(field, e.target.value)}
            placeholder={field.placeholder ?? ""}
          />
          {help}
        </div>
      );
    }

    if (field.type === "select") {
      const choices = field.options ?? options[field.key] ?? [];
      const blocked = (field.dependsOn ?? []).some((dep) => !params[dep]);
      const known = choices.some((c) => c.id === value);
      const listId = `${id}-list`;
      return (
        <div key={field.key}>
          {label}
          {field.allowCustom ? (
            <>
              <input
                id={id}
                className={inputClass}
                list={listId}
                value={value}
                disabled={blocked}
                onChange={(e) => setParam(field, e.target.value)}
                placeholder={field.placeholder ?? gt("Pick or type a value")}
              />
              <datalist id={listId}>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <select
              id={id}
              className={inputClass}
              value={value}
              disabled={blocked}
              onChange={(e) => setParam(field, e.target.value)}
            >
              <option value="">
                {blocked ? gt("Choose the fields above first") : gt("Choose…")}
              </option>
              {value && !known && <option value={value}>{value}</option>}
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.description ? `${c.label} (${c.description})` : c.label}
                </option>
              ))}
            </select>
          )}
          {optionErrors[field.key] && (
            <p role="alert" className="text-[11px] text-danger mt-1">
              {gt("Couldn’t load choices: {error}", { error: optionErrors[field.key] ?? "" })}
            </p>
          )}
          {help}
        </div>
      );
    }

    return (
      <div key={field.key}>
        {label}
        <input
          id={id}
          className={inputClass}
          inputMode={field.type === "number" ? "decimal" : undefined}
          value={value}
          onChange={(e) => setParam(field, e.target.value)}
          placeholder={field.placeholder ?? ""}
        />
        {help}
      </div>
    );
  }

  const canSave = Boolean(client.saveBusinessMetricImporter);

  return (
    <Modal onClose={onClose} ariaLabel={gt("Importer for {name}", { name: metric.name })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[680px] max-h-[88vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {gt("Import {name} on a schedule", { name: metric.name })}
        </h2>
        <T>
          <p className="text-xs text-on-surface-faint mb-4">
            Each run re-reads recent days from a connected account and replaces them; days with no
            data stay gaps. Queries are read only, with a row limit and timeout.
          </p>
        </T>

        {loadError !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {loadError}
          </div>
        )}
        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger whitespace-pre-wrap">
            {error}
          </div>
        )}
        {notice !== null && (
          <div role="status" className="mb-3 text-sm text-on-surface-secondary">
            {notice}
          </div>
        )}

        {sources === null && loadError === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            {gt("Loading sources…")}
          </p>
        )}

        {sources?.length === 0 && (
          <T>
            <p className="text-sm text-on-surface-faint">
              No connected account can feed a business metric yet. Connect AWS, GCP, Snowflake,
              ClickHouse, PostgreSQL, MySQL or Metronome, or report values by API, workflow or CSV.
            </p>
          </T>
        )}

        {sources && sources.length > 0 && (
          <div className="flex flex-col gap-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-account`}>
                {gt("Source account")}
              </label>
              <select
                id={`${uid}-account`}
                className={inputClass}
                value={accountId}
                onChange={(e) => pickAccount(e.target.value)}
              >
                {!source && accountId && <option value={accountId}>{gt("Removed account")}</option>}
                {sources.map((s) => (
                  <option key={s.accountId} value={s.accountId}>
                    {s.accountName} · {gtData(s.source.label)}
                  </option>
                ))}
              </select>
              {source && (
                <p className="text-[11px] text-on-surface-faint mt-1">
                  {source.source.description ? gtData(source.source.description) + " " : ""}
                  {source.source.readOnly === "enforced"
                    ? gt("Read-only access is enforced by the provider.")
                    : source.source.readOnly === "validated"
                      ? gt(
                          "Only single SELECT or WITH statements are accepted. Use a read-only role as well.",
                        )
                      : ""}
                </p>
              )}
            </div>

            {source?.source.kind === "sql" && (
              <T>
                <p className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-[11px] text-on-surface-secondary">
                  Return one row per day with a{" "}
                  <Var>
                    <code>day</code>
                  </Var>{" "}
                  column and a{" "}
                  <Var>
                    <code>value</code>
                  </Var>{" "}
                  column, plus an optional{" "}
                  <Var>
                    <code>label</code>
                  </Var>{" "}
                  for a breakdown. Use{" "}
                  <Var>
                    <code>{"{{from}}"}</code>
                  </Var>
                  ,{" "}
                  <Var>
                    <code>{"{{to}}"}</code>
                  </Var>
                  ,{" "}
                  <Var>
                    <code>{"{{to_exclusive}}"}</code>
                  </Var>{" "}
                  and{" "}
                  <Var>
                    <code>{"{{timezone}}"}</code>
                  </Var>{" "}
                  for the window; they are replaced with quoted literals.
                </p>
              </T>
            )}

            {source?.source.fields.map(renderField)}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass} htmlFor={`${uid}-schedule`}>
                  {gt("Schedule")}
                </label>
                <select
                  id={`${uid}-schedule`}
                  className={inputClass}
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value as BusinessMetricImportSchedule)}
                >
                  {BUSINESS_METRIC_IMPORT_SCHEDULES.map((s) => (
                    <option key={s} value={s}>
                      {gtData(BUSINESS_METRIC_IMPORT_SCHEDULE_LABELS[s])}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-backfill`}>
                  {gt("Days restated each run")}
                </label>
                <input
                  id={`${uid}-backfill`}
                  type="number"
                  className={inputClass}
                  min={BUSINESS_METRIC_IMPORT_LIMITS.minBackfillDays}
                  max={BUSINESS_METRIC_IMPORT_LIMITS.maxBackfillDays}
                  value={backfillDays}
                  onChange={(e) => setBackfillDays(Math.round(Number(e.target.value) || 1))}
                />
                <T>
                  <p className="text-[11px] text-on-surface-faint mt-1">
                    Closed days ending yesterday. Raise it if the source revises recent days.
                  </p>
                </T>
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-timezone`}>
                  {gt("Timezone")}
                </label>
                {zones.length > 0 ? (
                  <select
                    id={`${uid}-timezone`}
                    className={inputClass}
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  >
                    {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`${uid}-timezone`}
                    className={inputClass}
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    placeholder="UTC"
                  />
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-aggregation`}>
                  {gt("Several points on one day")}
                </label>
                <select
                  id={`${uid}-aggregation`}
                  className={inputClass}
                  value={aggregation}
                  onChange={(e) =>
                    setAggregation(e.target.value as BusinessMetricImportAggregation)
                  }
                >
                  {BUSINESS_METRIC_IMPORT_AGGREGATIONS.map((a) => (
                    <option key={a} value={a}>
                      {gtData(BUSINESS_METRIC_IMPORT_AGGREGATION_LABELS[a])}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {gt("Run on the schedule")}
            </label>

            {missingRequired.length > 0 && (
              <p className="text-[11px] text-on-surface-faint">
                {gt("Still needed: {fields}", {
                  fields: missingRequired.map((l) => gtData(l)).join(", "),
                })}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {client.previewBusinessMetricImport && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!valid || busy !== null}
                  onClick={() => void runPreview(false)}
                >
                  {busy === "preview" ? gt("Running…") : gt("Preview last 14 days")}
                </button>
              )}
              {client.previewBusinessMetricImport && source?.source.supportsDryRun && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!valid || busy !== null}
                  onClick={() => void runPreview(true)}
                >
                  {busy === "dry" ? gt("Checking…") : gt("Dry run")}
                </button>
              )}
            </div>

            {preview?.dryRun && (
              <div
                role="status"
                className={`rounded-lg border px-3 py-2 text-xs ${preview.dryRun.valid ? "border-border text-on-surface-secondary" : "border-danger text-danger"}`}
              >
                {preview.dryRun.message}
                {preview.dryRun.bytesProcessed !== undefined
                  ? " " +
                    gt("Would scan {bytes}.", { bytes: formatBytes(preview.dryRun.bytesProcessed) })
                  : ""}
              </div>
            )}

            {preview && !preview.dryRun && (
              <div className="rounded-lg border border-border">
                <p className="px-3 py-2 text-xs text-on-surface-secondary border-b border-border">
                  {gt(
                    "{days} days from {points} points, {from} → {to}, in {ms} ms. Nothing was written.",
                    {
                      days: preview.days,
                      points: preview.pointsRead,
                      from: preview.from,
                      to: preview.to,
                      ms: preview.durationMs,
                    },
                  )}
                </p>
                {preview.notes.map((note) => (
                  <p key={note} className="px-3 py-1 text-[11px] text-on-surface-faint">
                    {note}
                  </p>
                ))}
                {preview.values.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-warning">
                    {gt(
                      "The source returned nothing for this window. Check the query or the picked series; a run would leave these days as gaps.",
                    )}
                  </p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-on-surface-faint">
                        <th className="px-3 py-1 font-medium">{gt("Day")}</th>
                        <th className="px-3 py-1 font-medium">{gt("Label")}</th>
                        <th className="px-3 py-1 font-medium text-right">{gt("Value")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.values
                        .slice()
                        .reverse()
                        .slice(0, 60)
                        .map((v) => (
                          <tr key={`${v.date}-${v.label ?? ""}`} className="border-t border-border">
                            <td className="px-3 py-1 text-on-surface-secondary">{v.date}</td>
                            <td className="px-3 py-1 text-on-surface-faint">{v.label ?? ""}</td>
                            <td className="px-3 py-1 text-right tabular-nums text-on-surface">
                              {v.value}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {importer && (
              <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
                <span className="text-xs font-medium text-on-surface-secondary">
                  {gt("Run now")}
                </span>
                <T>
                  <p className="text-[11px] text-on-surface-faint">
                    Leave dates empty to run the saved window, or set them to backfill up to 730
                    days. Runs use the saved configuration, so save first.
                  </p>
                </T>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className={labelClass} htmlFor={`${uid}-from`}>
                      {gt("From")}
                    </label>
                    <input
                      id={`${uid}-from`}
                      type="date"
                      className={inputClass}
                      value={backfillFrom}
                      onChange={(e) => setBackfillFrom(e.target.value)}
                    />
                  </div>
                  <div className="flex-1">
                    <label className={labelClass} htmlFor={`${uid}-to`}>
                      {gt("To")}
                    </label>
                    <input
                      id={`${uid}-to`}
                      type="date"
                      className={inputClass}
                      value={backfillTo}
                      onChange={(e) => setBackfillTo(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className={primaryClass}
                    disabled={busy !== null || !client.runBusinessMetricImporter}
                    onClick={() => void runNow()}
                  >
                    {busy === "run" ? gt("Running…") : gt("Run now")}
                  </button>
                </div>
              </div>
            )}

            {runs.length > 0 && (
              <div>
                <span className={labelClass}>{gt("Recent runs")}</span>
                <ul className="flex flex-col">
                  {runs.map((run) => (
                    <li
                      key={run.id}
                      className="border-b border-border py-1.5 text-xs last:border-0"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={
                            run.status === "error"
                              ? "text-danger"
                              : run.status === "running"
                                ? "text-on-surface-faint"
                                : "text-on-surface-secondary"
                          }
                        >
                          {run.status === "error"
                            ? gt("Failed")
                            : run.status === "running"
                              ? gt("Running")
                              : gt("{days} days written", { days: run.daysWritten })}
                        </span>
                        <span className="text-on-surface-faint">
                          {run.from} → {run.to} ·{" "}
                          {run.trigger === "manual" ? gt("manual") : gt("scheduled")} ·{" "}
                          {new Date(run.startedAt).toLocaleString()}
                        </span>
                      </div>
                      {run.error && (
                        <p className="mt-0.5 text-danger whitespace-pre-wrap break-words">
                          {run.error}
                        </p>
                      )}
                      {run.notes.map((note) => (
                        <p key={note} className="mt-0.5 text-on-surface-faint">
                          {note}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-between gap-2">
          <div>
            {importer && client.deleteBusinessMetricImporter && (
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm text-on-surface-faint hover:text-danger disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void remove()}
              >
                {gt("Stop importing")}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass}>
              {gt("Close")}
            </button>
            {canSave && sources && sources.length > 0 && (
              <button
                type="button"
                disabled={!valid || busy !== null}
                onClick={() => void save()}
                className={primaryClass}
              >
                {busy === "save" ? gt("Saving…") : gt("Save importer")}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
