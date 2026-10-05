import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { T, Var, useGT } from "gt-react";
import {
  CUSTOM_COST_FIELDS,
  CUSTOM_COST_LIMITS,
  buildCustomCostRows,
  detectCsvMapping,
  isFocusHeader,
  overlappingCustomCostUploads,
  parseCsv,
  uploadCustomCostRows,
  type CsvColumnMapping,
  type CustomCostField,
  type CustomCostSource,
  type CustomCostUpload,
  type CustomCostUploadMode,
  type DateFormat,
  type ParsedTable,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * Custom cost sources: named providers for spend Infrawrench has no plugin for
 * (a colo bill, a SaaS invoice, another tool's FOCUS export), filled by
 * uploading files.
 *
 * The file never leaves the browser as a file: it is parsed and aggregated to
 * daily rows here by the same `client-core` code the CLI uses, previewed, and
 * only then sent in chunks. Each source then shows up as its own provider in
 * every cost report and filter.
 */
export function CustomCostSourcesSection() {
  const gt = useGT();
  const { orgId, api, has, cloudOrigin } = useSettingsHost();
  const canEdit = has("costs:write");

  const [sources, setSources] = useState<CustomCostSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSources(await api.get<CustomCostSource[]>(`/api/org/${orgId}/custom-cost-sources`));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load custom cost sources"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  async function removeSource(source: CustomCostSource) {
    const ok = window.confirm(
      gt(
        'Delete "{name}" and all of its spend? Its {count} upload(s) are removed from every cost report, budget and export. This cannot be undone.',
        { name: source.name, count: source.uploadCount },
      ),
    );
    if (!ok) return;
    try {
      await api.delete(`/api/org/${orgId}/custom-cost-sources/${source.id}`);
      if (openId === source.id) setOpenId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete the source"));
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Custom Cost Sources")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Spend Infrawrench has no integration for: a colo bill, a SaaS invoice, another
            tool&rsquo;s export. Upload a CSV (you map its columns) or a FinOps FOCUS file (mapped
            automatically) into a named source, and the source appears as its own provider in every
            cost report, filter and budget.
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
        <div className="space-y-4">
          {sources.length === 0 && (
            <p className="text-sm text-on-surface-muted">
              {gt("No custom cost sources yet. Add one below, then upload a file into it.")}
            </p>
          )}
          {sources.map((source) => (
            <div key={source.id} className="border border-border rounded-xl">
              {editingId === source.id ? (
                <SourceForm
                  initial={source}
                  onCancel={() => setEditingId(null)}
                  onSave={async (input) => {
                    await api.put(`/api/org/${orgId}/custom-cost-sources/${source.id}`, input);
                    setEditingId(null);
                    await load();
                  }}
                />
              ) : (
                <div className="flex items-start gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-on-surface-secondary">
                      {source.name}
                    </div>
                    {source.description && (
                      <div className="text-xs text-on-surface-muted mt-0.5">
                        {source.description}
                      </div>
                    )}
                    <div className="text-xs text-on-surface-faint mt-1">
                      {gt("{count} upload(s)", { count: source.uploadCount })}
                      {source.lastUploadAt &&
                        ` · ${gt("last {when}", { when: new Date(source.lastUploadAt).toLocaleString() })}`}
                      {source.defaultCurrency &&
                        ` · ${gt("default currency {currency}", { currency: source.defaultCurrency })}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === source.id ? null : source.id)}
                      className="text-xs text-info hover:text-info-strong"
                    >
                      {openId === source.id
                        ? gt("Close")
                        : canEdit
                          ? gt("Upload & history")
                          : gt("History")}
                    </button>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditingId(source.id)}
                          className="text-xs text-on-surface-muted hover:text-on-surface-secondary"
                        >
                          {gt("Edit")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeSource(source)}
                          className="text-xs text-danger hover:text-danger-strong"
                        >
                          {gt("Delete")}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {openId === source.id && (
                <SourceDetail
                  source={source}
                  canEdit={canEdit}
                  via={cloudOrigin ? "desktop" : "web"}
                  onChanged={load}
                />
              )}
            </div>
          ))}

          {canEdit && (
            <div className="border border-border rounded-xl bg-surface-raised/50">
              <h2 className="text-sm font-semibold px-4 pt-4">{gt("Add a custom cost source")}</h2>
              <SourceForm
                onSave={async (input) => {
                  await api.post(`/api/org/${orgId}/custom-cost-sources`, input);
                  await load();
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const inputClass =
  "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";
const primaryButton =
  "px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors";

interface SourceInput {
  name: string;
  description: string | null;
  defaultCurrency: string | null;
}

/** Create and edit share one form; a create clears itself on success. */
function SourceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CustomCostSource;
  onSave: (input: SourceInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [currency, setCurrency] = useState(initial?.defaultCurrency ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        defaultCurrency: currency.trim().toUpperCase() || null,
      });
      if (!initial) {
        setName("");
        setDescription("");
        setCurrency("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the source"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          maxLength={CUSTOM_COST_LIMITS.maxNameLength}
          onChange={(e) => setName(e.target.value)}
          placeholder={gt("e.g. Colo invoices")}
          aria-label={gt("Source name")}
          className={`${inputClass} w-56`}
        />
        <input
          type="text"
          value={currency}
          maxLength={3}
          onChange={(e) => setCurrency(e.target.value)}
          placeholder={gt("Default currency (optional)")}
          aria-label={gt("Default currency")}
          title={gt("Used for files with no currency column")}
          className={`${inputClass} w-52`}
        />
      </div>
      <input
        type="text"
        value={description}
        maxLength={CUSTOM_COST_LIMITS.maxDescriptionLength}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={gt("Description (optional)")}
        aria-label={gt("Description")}
        className={`${inputClass} w-full`}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
          className={primaryButton}
        >
          {initial ? gt("Save") : gt("Add")}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-on-surface-muted hover:text-on-surface-secondary"
          >
            {gt("Cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

function formatTotals(totals: Record<string, number>): string {
  const parts = Object.entries(totals).map(([currency, amount]) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency}`;
    }
  });
  return parts.length > 0 ? parts.join(" + ") : "-";
}

/** One source's upload panel and history. */
function SourceDetail({
  source,
  canEdit,
  via,
  onChanged,
}: {
  source: CustomCostSource;
  canEdit: boolean;
  via: "web" | "desktop";
  onChanged: () => Promise<void>;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [uploads, setUploads] = useState<CustomCostUpload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/org/${orgId}/custom-cost-sources/${source.id}`;

  const loadUploads = useCallback(async () => {
    try {
      setUploads(await api.get<CustomCostUpload[]>(`${base}/uploads`));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load uploads"));
    }
  }, [api, base, gt]);

  useEffect(() => {
    void loadUploads();
  }, [loadUploads]);

  async function removeUpload(upload: CustomCostUpload) {
    const ok = window.confirm(
      gt(
        "Delete this upload? The {rows} row(s) it still holds ({from} to {to}) are removed from every cost report.",
        { rows: upload.rowCount, from: upload.fromDate, to: upload.toDate },
      ),
    );
    if (!ok) return;
    try {
      await api.delete(`${base}/uploads/${upload.id}`);
      await Promise.all([loadUploads(), onChanged()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete the upload"));
    }
  }

  const statusLabel = (status: CustomCostUpload["status"]) =>
    status === "uploading"
      ? gt("Incomplete")
      : status === "replaced"
        ? gt("Replaced")
        : gt("Complete");

  return (
    <div className="border-t border-border/60 px-4 py-3 space-y-4">
      {error && <p className="text-xs text-danger">{error}</p>}
      {canEdit && uploads && (
        <UploadWizard
          source={source}
          uploads={uploads}
          via={via}
          onUploaded={async () => {
            await Promise.all([loadUploads(), onChanged()]);
          }}
        />
      )}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted mb-2">
          {gt("Upload history")}
        </h3>
        {uploads === null ? (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        ) : uploads.length === 0 ? (
          <p className="text-sm text-on-surface-muted">{gt("Nothing uploaded yet.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-on-surface-muted text-left">
                <tr>
                  <th className="py-1 pr-3 font-medium">{gt("File")}</th>
                  <th className="py-1 pr-3 font-medium">{gt("Uploaded")}</th>
                  <th className="py-1 pr-3 font-medium">{gt("Dates")}</th>
                  <th className="py-1 pr-3 font-medium">{gt("Rows")}</th>
                  <th className="py-1 pr-3 font-medium">{gt("Total")}</th>
                  <th className="py-1 pr-3 font-medium">{gt("Status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {uploads.map((u) => (
                  <tr key={u.id} className="border-t border-border/40 align-top">
                    <td className="py-1.5 pr-3">
                      <div className="text-on-surface-secondary">{u.fileName ?? "-"}</div>
                      <div className="text-on-surface-faint">
                        {u.format.toUpperCase()} · {u.via} · {u.mode}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">
                      <div>{new Date(u.createdAt).toLocaleString()}</div>
                      <div className="text-on-surface-faint">
                        {u.uploadedBy?.name ?? u.uploadedBy?.email ?? gt("Unknown")}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {u.fromDate} → {u.toDate}
                    </td>
                    <td className="py-1.5 pr-3">{u.rowCount.toLocaleString()}</td>
                    <td className="py-1.5 pr-3">{formatTotals(u.totals)}</td>
                    <td className="py-1.5 pr-3">{statusLabel(u.status)}</td>
                    <td className="py-1.5 text-right">
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => void removeUpload(u)}
                          className="text-danger hover:text-danger-strong"
                        >
                          {gt("Delete")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const PREVIEW_ROWS = 15;

/**
 * Choose a file → (map columns, for a generic CSV) → preview → resolve any
 * overlap explicitly → upload. Every step re-derives from the parsed table, so
 * changing a picker updates the preview immediately.
 */
function UploadWizard({
  source,
  uploads,
  via,
  onUploaded,
}: {
  source: CustomCostSource;
  uploads: CustomCostUpload[];
  via: "web" | "desktop";
  onUploaded: () => Promise<void>;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [format, setFormat] = useState<"csv" | "focus">("csv");
  const [mapping, setMapping] = useState<CsvColumnMapping | null>(null);
  const [dateFormat, setDateFormat] = useState<DateFormat>("auto");
  const [currency, setCurrency] = useState(source.defaultCurrency ?? "");
  const [mode, setMode] = useState<CustomCostUploadMode | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setFileName(null);
    setTable(null);
    setMapping(null);
    setMode(null);
    setProgress(null);
    setDateFormat("auto");
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setDone(null);
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError(gt("That file has no header row or no data rows."));
        return;
      }
      setFileName(file.name);
      setTable(parsed);
      setFormat(isFocusHeader(parsed.headers) ? "focus" : "csv");
      setMapping(detectCsvMapping(parsed.headers));
      setMode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Could not read the file"));
    }
  }

  const result = useMemo(() => {
    if (!table || !mapping) return null;
    return buildCustomCostRows(
      table,
      format === "focus" ? { format: "focus" } : { format: "csv", mapping, dateFormat },
      { defaultCurrency: currency.trim() || null },
    );
  }, [table, mapping, format, dateFormat, currency]);

  const overlapping = useMemo(
    () =>
      result?.fromDate && result.toDate
        ? overlappingCustomCostUploads(uploads, result.fromDate, result.toDate)
        : [],
    [uploads, result],
  );

  const fieldLabel = (field: CustomCostField): string => {
    switch (field) {
      case "date":
        return gt("Date");
      case "cost":
        return gt("Cost");
      case "currency":
        return gt("Currency");
      case "service":
        return gt("Service");
      case "account":
        return gt("Account");
      case "region":
        return gt("Region");
      case "resource":
        return gt("Resource");
      case "usageQuantity":
        return gt("Usage quantity");
      case "usageUnit":
        return gt("Usage unit");
      case "tags":
        return gt("Tags (JSON or key=value)");
    }
  };

  async function upload() {
    if (!result || result.rows.length === 0) return;
    if (overlapping.length > 0 && !mode) return;
    setError(null);
    setProgress({ sent: 0, total: result.rows.length });
    try {
      const finished = await uploadCustomCostRows({
        transport: { post: (path, body) => api.post(path, body) },
        basePath: `/api/org/${orgId}/custom-cost-sources/${source.id}`,
        rows: result.rows,
        format,
        fileName,
        mode: mode ?? (overlapping.length === 0 ? "append" : undefined),
        via,
        onProgress: (sent, total) => setProgress({ sent, total }),
      });
      setDone(
        gt("Uploaded {rows} daily row(s) covering {from} to {to}.", {
          rows: finished.rowCount,
          from: finished.fromDate,
          to: finished.toDate,
        }),
      );
      reset();
      await onUploaded();
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : gt("Upload failed"));
    }
  }

  const mappedColumns = new Set(
    mapping ? CUSTOM_COST_FIELDS.map((f) => mapping[f]).filter((i) => i !== null) : [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className={`${primaryButton} cursor-pointer`}>
          {table ? gt("Choose a different file") : gt("Upload a file")}
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="hidden"
            onChange={(e) => void onFile(e)}
          />
        </label>
        <span className="text-xs text-on-surface-muted">
          {gt("CSV with a header row, or a FinOps FOCUS export.")}
        </span>
      </div>
      {done && <p className="text-xs text-success">{done}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}

      {table && mapping && result && (
        <div className="border border-border rounded-lg p-3 space-y-3 bg-surface-raised/40">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-on-surface-secondary font-medium">{fileName}</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as "csv" | "focus")}
              aria-label={gt("File format")}
              className={inputClass}
            >
              <option value="csv">{gt("Generic CSV (map columns)")}</option>
              <option value="focus" disabled={!isFocusHeader(table.headers)}>
                {gt("FOCUS (mapped automatically)")}
              </option>
            </select>
            {format === "focus" && (
              <span className="text-on-surface-muted">
                {gt(
                  "Recognised as FOCUS: BilledCost is the cost, EffectiveCost the amortized cost, ChargeCategory the charge type.",
                )}
              </span>
            )}
          </div>

          {format === "csv" && (
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {CUSTOM_COST_FIELDS.map((field) => (
                  <label key={field} className="flex items-center gap-2 text-xs">
                    <span className="w-40 shrink-0 text-on-surface-muted">
                      {fieldLabel(field)}
                      {(field === "date" || field === "cost") && " *"}
                    </span>
                    <select
                      value={mapping[field] ?? ""}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          [field]: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      className={`${inputClass} flex-1 min-w-0`}
                    >
                      <option value="">{gt("Not mapped")}</option>
                      {table.headers.map((header, index) => (
                        <option key={index} value={index}>
                          {header || gt("Column {n}", { n: index + 1 })}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-on-surface-muted">{gt("Date order")}</span>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value as DateFormat)}
                  aria-label={gt("Date order")}
                  className={`${inputClass} ${result.ambiguousDates && dateFormat === "auto" ? "border-warning" : ""}`}
                >
                  <option value="auto">{gt("Detect automatically")}</option>
                  {/* i18n-ignore: date format patterns */}
                  <option value="ymd">YYYY-MM-DD</option>
                  {/* i18n-ignore: date format patterns */}
                  <option value="mdy">MM/DD/YYYY</option>
                  {/* i18n-ignore: date format patterns */}
                  <option value="dmy">DD/MM/YYYY</option>
                </select>
                {result.ambiguousDates && dateFormat === "auto" && (
                  <span className="text-warning">
                    {gt("These dates could be month-first or day-first: pick one.")}
                  </span>
                )}
                {mapping.currency === null && (
                  <>
                    <span className="text-on-surface-muted ml-2">{gt("Currency")}</span>
                    <input
                      type="text"
                      value={currency}
                      maxLength={3}
                      onChange={(e) => setCurrency(e.target.value)}
                      placeholder="USD"
                      aria-label={gt("Currency for every row")}
                      className={`${inputClass} w-20`}
                    />
                  </>
                )}
              </div>
              {table.headers.some((_, i) => !mappedColumns.has(i)) && (
                <div className="text-xs">
                  <div className="text-on-surface-muted mb-1">
                    {gt("Also keep these columns as tags:")}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {table.headers.map((header, index) =>
                      mappedColumns.has(index) || !header ? null : (
                        <label key={index} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={mapping.tagColumns.includes(index)}
                            onChange={(e) =>
                              setMapping({
                                ...mapping,
                                tagColumns: e.target.checked
                                  ? [...mapping.tagColumns, index]
                                  : mapping.tagColumns.filter((i) => i !== index),
                              })
                            }
                          />
                          {header}
                        </label>
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-on-surface-muted">
            {gt(
              "{lines} line(s) read → {rows} daily row(s), {from} to {to}, total {total}. {errors} line(s) skipped.",
              {
                lines: result.lineCount,
                rows: result.rows.length,
                from: result.fromDate ?? "-",
                to: result.toDate ?? "-",
                total: formatTotals(result.totals),
                errors: result.errorCount,
              },
            )}
          </div>

          {result.rows.length > 0 && (
            <div className="overflow-x-auto max-h-72 border border-border/50 rounded">
              <table className="w-full text-xs">
                <thead className="text-on-surface-muted text-left sticky top-0 bg-surface">
                  <tr>
                    <th className="px-2 py-1 font-medium">{gt("Date")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Cost")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Service")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Account")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Region")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Resource")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Usage")}</th>
                    <th className="px-2 py-1 font-medium">{gt("Tags")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                    <tr key={i} className="border-t border-border/40">
                      <td className="px-2 py-1 whitespace-nowrap">{row.date}</td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {formatTotals({ [row.currency]: row.amount })}
                        {row.chargeType && (
                          <span className="text-on-surface-faint"> · {row.chargeType}</span>
                        )}
                      </td>
                      <td className="px-2 py-1">{row.service ?? ""}</td>
                      <td className="px-2 py-1">{row.subAccount ?? ""}</td>
                      <td className="px-2 py-1">{row.region ?? ""}</td>
                      <td className="px-2 py-1 max-w-48 truncate">{row.resourceId ?? ""}</td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {row.usageAmount !== undefined
                          ? `${row.usageAmount} ${row.usageUnit ?? ""}`
                          : ""}
                      </td>
                      <td className="px-2 py-1 max-w-56 truncate">
                        {Object.entries(row.tags ?? {})
                          .map(([k, v]) => `${k}=${v}`)
                          .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.errors.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-warning">
                {gt("{count} line(s) could not be read and will be skipped", {
                  count: result.errorCount,
                })}
              </summary>
              <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
                {result.errors.map((err) => (
                  <li key={err.line} className="text-on-surface-muted">
                    {gt("Line {line}:", { line: err.line })} {err.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {overlapping.length > 0 && (
            <div className="border border-warning/50 rounded-lg p-3 text-xs space-y-2">
              <div className="text-warning">
                {gt(
                  "These dates overlap {count} earlier upload(s) of this source. Choose what happens to that spend:",
                  { count: overlapping.length },
                )}
              </div>
              <ul className="text-on-surface-muted">
                {overlapping.map((u) => (
                  <li key={u.id}>
                    {u.fileName ?? "-"} ({u.fromDate} → {u.toDate}, {formatTotals(u.totals)})
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`mode-${source.id}`}
                  checked={mode === "replace"}
                  onChange={() => setMode("replace")}
                />
                <span>
                  {gt(
                    "Replace: remove everything this source holds from {from} to {to}, then add this file (for a corrected re-export).",
                    { from: result.fromDate ?? "", to: result.toDate ?? "" },
                  )}
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`mode-${source.id}`}
                  checked={mode === "append"}
                  onChange={() => setMode("append")}
                />
                <span>
                  {gt(
                    "Append: keep the earlier spend and add this file to it (for a file covering different charges).",
                  )}
                </span>
              </label>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void upload()}
              disabled={
                progress !== null ||
                result.rows.length === 0 ||
                (overlapping.length > 0 && mode === null)
              }
              className={primaryButton}
            >
              {progress
                ? gt("Uploading {sent} / {total}…", { sent: progress.sent, total: progress.total })
                : gt("Upload {rows} row(s)", { rows: result.rows.length })}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={progress !== null}
              className="text-xs text-on-surface-muted hover:text-on-surface-secondary"
            >
              {gt("Cancel")}
            </button>
          </div>
        </div>
      )}
      <T>
        <p className="text-xs text-on-surface-faint">
          Uploads go to <Var>{source.name}</Var>; rows are aggregated to one per day before they are
          sent.
        </p>
      </T>
    </div>
  );
}
