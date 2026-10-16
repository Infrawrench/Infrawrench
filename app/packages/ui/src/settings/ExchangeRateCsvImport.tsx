import { useRef, useState } from "react";
import { T, useGT } from "gt-react";
import {
  EXCHANGE_RATE_CSV_TEMPLATE,
  EXCHANGE_RATE_CSV_TEMPLATE_FILENAME,
  type ExchangeRateImportAction,
  type ExchangeRateImportResult,
} from "@infrawrench/client-core";
import { downloadBlob } from "../delivery/download.js";
import { useSettingsHost } from "./host.js";

/**
 * Upload many stated rates at once from a CSV, with a server-side preview.
 *
 * The flow is preview, then apply: picking a file sends it as a dry run, which
 * classifies every row against the stored table (new, replacing a stored rate,
 * identical, or invalid with its reason) and writes nothing. Only the second
 * click writes, and an upload with an invalid row writes nothing unless the
 * user ticks "skip invalid rows", so a half-fixed file never lands half-way by
 * accident. The preview is the server's, not a local parse, because only the
 * server knows which rows already exist.
 *
 * Uploaded rates are ordinary stated rates; the copy says so, because the
 * question a finance user has at this point is "will these beat the automatic
 * rates?" (yes, for the days they cover).
 */
export function ExchangeRateCsvImport({ onImported }: { onImported: () => Promise<void> }) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const fileInput = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ExchangeRateImportResult | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setCsv(null);
    setFileName("");
    setPreview(null);
    setSkipInvalid(false);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function pick(file: File) {
    setError(null);
    setDone(null);
    setPreview(null);
    setBusy(true);
    try {
      const text = await file.text();
      setCsv(text);
      setFileName(file.name);
      const result = await api.post<ExchangeRateImportResult>(
        `/api/org/${orgId}/currency/rates/import`,
        { csv: text, dryRun: true },
      );
      setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Couldn’t read the file"));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!csv || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<ExchangeRateImportResult>(
        `/api/org/${orgId}/currency/rates/import`,
        { csv, skipInvalid },
      );
      if (!result.applied) {
        // The table changed between preview and apply (someone else saved a
        // rate): show the fresh classification instead of guessing.
        setPreview(result);
        return;
      }
      setDone(
        gt("Imported: {created} new, {updated} replaced, {unchanged} unchanged.", {
          created: result.counts.create,
          updated: result.counts.update,
          unchanged: result.counts.unchanged,
        }),
      );
      reset();
      await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to import rates"));
    } finally {
      setBusy(false);
    }
  }

  const counts = preview?.counts;
  const writable = counts ? counts.create + counts.update : 0;
  const canApply = !!preview && writable > 0 && (counts!.error === 0 || skipInvalid) && !busy;

  const actionLabel: Record<ExchangeRateImportAction, string> = {
    create: gt("New"),
    update: gt("Replaces"),
    unchanged: gt("Unchanged"),
    error: gt("Error"),
  };
  const actionClass: Record<ExchangeRateImportAction, string> = {
    create: "text-success",
    update: "text-warning",
    unchanged: "text-on-surface-faint",
    error: "text-danger",
  };

  return (
    <div className="pt-3 border-t border-border/50 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,.tsv,text/tab-separated-values,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pick(file);
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {busy && !preview ? gt("Checking…") : gt("Upload CSV…")}
        </button>
        <button
          type="button"
          onClick={() =>
            downloadBlob(
              new Blob([EXCHANGE_RATE_CSV_TEMPLATE], { type: "text/csv;charset=utf-8" }),
              EXCHANGE_RATE_CSV_TEMPLATE_FILENAME,
            )
          }
          className="text-xs text-on-surface-secondary hover:text-on-surface underline"
        >
          {gt("Download template")}
        </button>
      </div>
      <T>
        <p className="text-xs text-on-surface-faint">
          Columns: from, to, rate, and either effective_from (with an optional effective_to) or
          billing_period as YYYY-MM for one month. Rows matching a stored pair and start date
          replace it; nothing else is touched. Uploaded rates are stated rates, so they win over
          automatic rates for the days they cover.
        </p>
      </T>

      {done && (
        <p role="status" className="text-xs text-success">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {preview && counts && (
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-b border-border bg-surface-raised/50 text-xs">
            <span className="font-medium text-on-surface-secondary">{fileName}</span>
            <span className="text-success">{gt("{n} new", { n: counts.create })}</span>
            <span className="text-warning">
              {gt("{n} replace a stored rate", { n: counts.update })}
            </span>
            <span className="text-on-surface-faint">
              {gt("{n} unchanged", { n: counts.unchanged })}
            </span>
            {counts.error > 0 && (
              <span className="text-danger">{gt("{n} with errors", { n: counts.error })}</span>
            )}
          </div>
          <div className="max-h-72 overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs text-on-surface-muted">
                  <th scope="col" className="text-left px-4 py-1.5 font-medium">
                    {gt("Line")}
                  </th>
                  <th scope="col" className="text-left px-4 py-1.5 font-medium">
                    {gt("Rate")}
                  </th>
                  <th scope="col" className="text-left px-4 py-1.5 font-medium">
                    {gt("Effective")}
                  </th>
                  <th scope="col" className="text-left px-4 py-1.5 font-medium">
                    {gt("Result")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line} className="border-b border-border/50 text-xs">
                    <td className="px-4 py-1.5 tabular-nums text-on-surface-faint">{row.line}</td>
                    <td className="px-4 py-1.5 tabular-nums text-on-surface-secondary">
                      {row.rate
                        ? gt("1 {from} = {rate} {to}", {
                            from: row.rate.fromCurrency,
                            rate: row.rate.rate,
                            to: row.rate.toCurrency,
                          })
                        : "–"}
                    </td>
                    <td className="px-4 py-1.5 text-on-surface-tertiary">
                      {row.rate
                        ? row.rate.effectiveTo
                          ? gt("{from} to {to}", {
                              from: row.rate.effectiveFrom,
                              to: row.rate.effectiveTo,
                            })
                          : gt("from {from}", { from: row.rate.effectiveFrom })
                        : "–"}
                    </td>
                    <td className={`px-4 py-1.5 ${actionClass[row.action]}`}>
                      {actionLabel[row.action]}
                      {row.action === "update" && row.previousRate !== undefined && (
                        <span className="ml-1 text-on-surface-faint">
                          {gt("(was {rate})", { rate: row.previousRate.replace(/\.?0+$/, "") })}
                        </span>
                      )}
                      {row.error && <span className="ml-1">{row.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-t border-border">
            {counts.error > 0 && (
              <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
                <input
                  type="checkbox"
                  checked={skipInvalid}
                  onChange={(e) => setSkipInvalid(e.target.checked)}
                />
                {gt("Skip the rows with errors")}
              </label>
            )}
            <button
              type="button"
              onClick={() => void apply()}
              disabled={!canApply}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {busy ? gt("Importing…") : gt("Import {n} rates", { n: writable })}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
            >
              {gt("Cancel")}
            </button>
            {writable === 0 && counts.error === 0 && (
              <span className="text-xs text-on-surface-faint">
                {gt("Every rate in this file is already stored.")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
