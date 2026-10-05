import { useId, useMemo, useState } from "react";
import { T, useGT } from "gt-react";

import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  BUSINESS_METRIC_LIMITS,
  CSV_DATE_FORMATS,
  CSV_DATE_FORMAT_LABELS,
  csvLabelColumnKey,
  csvRowsToMetricValues,
  formatBusinessMetricLabels,
  guessCsvMapping,
  parseMetricCsv,
  type BusinessMetric,
  type MetricCsvColumnMapping,
  type CsvDateFormat,
} from "./config.js";
import type { CostsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/** Largest file the browser parses: past this it belongs in an importer. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A mapping with `column` no longer a named label (it was just picked for another role). */
function withoutLabelColumn(
  mapping: MetricCsvColumnMapping,
  column: number | undefined,
): MetricCsvColumnMapping {
  if (column === undefined || !mapping.labelColumns) return mapping;
  const labelColumns = mapping.labelColumns.filter((c) => c.column !== column);
  return { ...mapping, labelColumns: labelColumns.length > 0 ? labelColumns : undefined };
}

/**
 * Upload a CSV of daily values: map the columns, preview what will be written
 * and every row that will not, then write through the ordinary values
 * endpoint in batches. Re-uploading restates the same days rather than adding
 * to them, so correcting a file and uploading it again is safe.
 */
export function MetricCsvImportModal({
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
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<MetricCsvColumnMapping>({ date: 0, value: 1 });
  const [format, setFormat] = useState<CsvDateFormat>("auto");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const header = rows && hasHeader ? (rows[0] ?? []) : null;
  const body = useMemo(() => (rows ? (hasHeader ? rows.slice(1) : rows) : []), [rows, hasHeader]);
  const columnCount = rows ? Math.max(0, ...rows.slice(0, 50).map((r) => r.length)) : 0;
  const columns = Array.from({ length: columnCount }, (_, i) =>
    header?.[i]?.trim() ? header[i]!.trim() : gt("Column {n}", { n: i + 1 }),
  );

  // Named label columns need a header to name them; without one they are off.
  const effectiveMapping = useMemo(
    () => (hasHeader ? mapping : { ...mapping, labelColumns: undefined }),
    [mapping, hasHeader],
  );
  const result = useMemo(
    () => (rows ? csvRowsToMetricValues(body, effectiveMapping, format, hasHeader ? 2 : 1) : null),
    [rows, body, effectiveMapping, format, hasHeader],
  );
  /** Columns that could be named labels: not the day, value or unnamed label column. */
  const labelCandidates = header
    ? header
        .map((h, column) => ({ column, name: h.trim(), key: csvLabelColumnKey(h) }))
        .filter(
          (c) =>
            c.column !== mapping.date && c.column !== mapping.value && c.column !== mapping.label,
        )
    : [];
  const checkedLabels = new Set((mapping.labelColumns ?? []).map((c) => c.column));
  const labelLimitReached = checkedLabels.size >= BUSINESS_METRIC_LIMITS.maxLabelsPerValue;

  function toggleLabelColumn(column: number, key: string, on: boolean) {
    setMapping((m) => {
      const rest = (m.labelColumns ?? []).filter((c) => c.column !== column);
      const labelColumns = on
        ? [...rest, { column, key }].sort((a, b) => a.column - b.column)
        : rest;
      return { ...m, labelColumns: labelColumns.length > 0 ? labelColumns : undefined };
    });
  }
  const days = result ? new Set(result.values.map((v) => v.date)).size : 0;

  async function pickFile(file: File | undefined) {
    setError(null);
    setProgress(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(gt("That file is larger than 10 MB. Use a scheduled importer or the API instead."));
      return;
    }
    const parsed = parseMetricCsv(await file.text());
    if (parsed.length === 0) {
      setError(gt("The file has no rows."));
      return;
    }
    setFileName(file.name);
    setRows(parsed);
    const guessed = guessCsvMapping(parsed[0] ?? []);
    setHasHeader(Boolean(guessed) || (parsed[0] ?? []).some((c) => Number.isNaN(Number(c))));
    setMapping(guessed ?? { date: 0, value: Math.min(1, (parsed[0]?.length ?? 1) - 1) });
  }

  async function upload() {
    const write = client.writeBusinessMetricValues;
    if (!write || !result || result.values.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const batch = BUSINESS_METRIC_LIMITS.maxValuesPerCall;
      let written = 0;
      for (let i = 0; i < result.values.length; i += batch) {
        const chunk = result.values.slice(i, i + batch);
        const res = await write(metric.id, chunk);
        written += res.written;
        setProgress(gt("Written {written} of {total}…", { written, total: result.values.length }));
      }
      setProgress(gt("Done: {written} values written across {days} days.", { written, days }));
      await onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const columnSelect = (
    id: string,
    value: number | undefined,
    onChange: (v: number | undefined) => void,
    optional: boolean,
  ) => (
    <select
      id={id}
      className={inputClass}
      value={value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
    >
      {optional && <option value="">{gt("None")}</option>}
      {columns.map((name, i) => (
        <option key={i} value={String(i)}>
          {name}
        </option>
      ))}
    </select>
  );

  return (
    <Modal onClose={onClose} ariaLabel={gt("Upload values for {name}", { name: metric.name })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[600px] max-h-[88vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {gt("Upload a CSV for {name}", { name: metric.name })}
        </h2>
        <T>
          <p className="text-xs text-on-surface-faint mb-4">
            One row per day (or per day and label). Uploading a day again replaces it rather than
            adding to it, so a corrected file can simply be uploaded again.
          </p>
        </T>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor={`${uid}-file`}>
              {gt("CSV file")}
            </label>
            <input
              id={`${uid}-file`}
              type="file"
              accept=".csv,text/csv,.tsv,text/tab-separated-values"
              className="text-sm text-on-surface"
              onChange={(e) => void pickFile(e.target.files?.[0])}
            />
            {fileName && (
              <p className="text-[11px] text-on-surface-faint mt-1">
                {gt("{file}: {rows} rows", { file: fileName, rows: rows?.length ?? 0 })}
              </p>
            )}
          </div>

          {rows && (
            <>
              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                />
                {gt("The first row is a header")}
              </label>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass} htmlFor={`${uid}-date`}>
                    {gt("Day column")}
                  </label>
                  {columnSelect(
                    `${uid}-date`,
                    mapping.date,
                    (v) => setMapping((m) => withoutLabelColumn({ ...m, date: v ?? 0 }, v)),
                    false,
                  )}
                </div>
                <div>
                  <label className={labelClass} htmlFor={`${uid}-format`}>
                    {gt("Date format")}
                  </label>
                  <select
                    id={`${uid}-format`}
                    className={inputClass}
                    value={format}
                    onChange={(e) => setFormat(e.target.value as CsvDateFormat)}
                  >
                    {CSV_DATE_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {gtData(CSV_DATE_FORMAT_LABELS[f])}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor={`${uid}-value`}>
                    {gt("Value column")}
                  </label>
                  {columnSelect(
                    `${uid}-value`,
                    mapping.value,
                    (v) => setMapping((m) => withoutLabelColumn({ ...m, value: v ?? 0 }, v)),
                    false,
                  )}
                </div>
                <div>
                  <label className={labelClass} htmlFor={`${uid}-label`}>
                    {gt("Label column (optional)")}
                  </label>
                  {columnSelect(
                    `${uid}-label`,
                    mapping.label,
                    (v) =>
                      setMapping((m) =>
                        v === undefined
                          ? { date: m.date, value: m.value, labelColumns: m.labelColumns }
                          : withoutLabelColumn({ ...m, label: v }, v),
                      ),
                    true,
                  )}
                </div>
              </div>

              {labelCandidates.length > 0 && (
                <fieldset>
                  <legend className={labelClass}>{gt("Label columns")}</legend>
                  <p className="text-[11px] text-on-surface-faint mb-1.5">
                    {gt(
                      "Each checked column becomes a label named after its header, so values can be split and filtered by it. An empty cell leaves that label off the row.",
                    )}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {labelCandidates.map((c) => (
                      <label
                        key={c.column}
                        className="flex items-center gap-1.5 text-sm text-on-surface"
                        title={
                          c.key === null
                            ? gt(
                                "This header cannot be a label name: use letters, digits, - and _.",
                              )
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          disabled={
                            c.key === null || (labelLimitReached && !checkedLabels.has(c.column))
                          }
                          checked={checkedLabels.has(c.column)}
                          onChange={(e) =>
                            c.key && toggleLabelColumn(c.column, c.key, e.target.checked)
                          }
                        />
                        {c.name || columns[c.column]}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {result && (
                <div className="rounded-lg border border-border">
                  <p className="px-3 py-2 text-xs text-on-surface-secondary border-b border-border">
                    {gt("{values} values across {days} days will be written.", {
                      values: result.values.length,
                      days,
                    })}
                    {result.errors.length > 0
                      ? " " +
                        gt("{count} rows cannot be read and will be skipped.", {
                          count: result.errors.length,
                        })
                      : ""}
                  </p>
                  {result.errors.slice(0, 5).map((e) => (
                    <p key={e.row} className="px-3 py-1 text-[11px] text-danger">
                      {gt("Line {row}: {message}", { row: e.row, message: e.message })}
                    </p>
                  ))}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-on-surface-faint">
                        <th className="px-3 py-1 font-medium">{gt("Day")}</th>
                        <th className="px-3 py-1 font-medium">{gt("Label")}</th>
                        <th className="px-3 py-1 font-medium text-right">{gt("Value")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.values.slice(0, 15).map((v, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-3 py-1 text-on-surface-secondary">{v.date}</td>
                          <td className="px-3 py-1 text-on-surface-faint">
                            {v.labels ? formatBusinessMetricLabels(v.labels) : (v.label ?? "")}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums text-on-surface">
                            {v.value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {progress && (
            <p role="status" className="text-sm text-on-surface-secondary">
              {progress}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Close")}
          </button>
          <button
            type="button"
            disabled={busy || !result || result.values.length === 0}
            onClick={() => void upload()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? gt("Uploading…") : gt("Upload values")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
