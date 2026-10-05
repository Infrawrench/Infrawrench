import { useCallback, useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  COST_DIMENSIONS,
  COST_DIMENSION_LABELS,
  COST_EXPORT_CADENCES,
  COST_EXPORT_CADENCE_LABELS,
  COST_EXPORT_FORMATS,
  COST_EXPORT_FORMAT_LABELS,
  COST_EXPORT_SCHEMAS,
  COST_EXPORT_SCHEMA_LABELS,
  DEFAULT_COST_EXPORT_INPUT,
  costExportWarehouseTable,
  describeCostExportDestination,
  type CostDimensionId,
  type CostExport,
  type CostExportHttpDestination,
  type CostExportInput,
  type CostExportQuery,
  type CostExportRunResult,
  type CostExportS3Destination,
  type CostExportWarehouseSink,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { parseNumericInputValue } from "../form-values.js";
import { useDataString } from "../i18n/data-strings.js";
import { useSettingsHost } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";
import { WarehouseDestinationFields } from "./CostExportWarehouseFields.js";

/**
 * Scheduled cost exports: a recurring dump of the org's raw cost rows into a
 * warehouse or object store.
 *
 * Three things this page has to get across, because getting them wrong is
 * expensive and silent:
 *
 *  - **Failures are loud.** A nightly export that stopped working three weeks
 *    ago is worse than never having had one, so `lastStatus`/`lastError` are on
 *    every row, in red, with the destination's own wording: the same way cost
 *    collection failures surface on the Costs panel.
 *  - **Restatements are explained where the knob is**, not only in the docs.
 *    Somebody setting this up for a finance system needs to know on the spot
 *    that yesterday's object is not final.
 *  - **Credentials only go in.** The stored secret is never shown; the field
 *    stays blank on return and blank means "keep what is stored".
 */

/** Which dimensions the column picker offers. `tag` is handled by the tag-key list. */
// Keyed dimensions are columns per key, picked below, not one column.
const PICKABLE_DIMENSIONS = COST_DIMENSIONS.filter((d) => d !== "tag" && d !== "virtual_tag");

function statusTone(exp: CostExport): string {
  if (exp.lastStatus === "failed") return "text-danger";
  if (exp.lastStatus === "succeeded") return "text-success";
  return "text-on-surface-muted";
}

function statusLabel(exp: CostExport, gt: ReturnType<typeof useGT>): string {
  if (exp.lastStatus === "pending") return gt("Not run yet");
  const when = exp.lastRunAt ? new Date(exp.lastRunAt).toLocaleString() : "";
  if (exp.lastStatus === "succeeded") {
    const objects = exp.lastObjectCount ?? 0;
    const rows = exp.lastRowCount ?? 0;
    return objects === 1
      ? gt("Wrote {objects} object · {rows} rows · {when}", {
          objects,
          rows: rows.toLocaleString(),
          when,
        })
      : gt("Wrote {objects} objects · {rows} rows · {when}", {
          objects,
          rows: rows.toLocaleString(),
          when,
        });
  }
  return gt("Failed {when}", { when });
}

function describeDestination(exp: CostExport, sinks: CostExportWarehouseSink[]): string {
  const d = exp.destination;
  if (d.kind === "s3") return `s3://${d.bucket}/${d.prefix}`;
  if (d.kind === "http") return `${d.method} ${d.urlHint}`;
  const sink = sinks.find((s) => s.pluginId === d.pluginId);
  if (!sink) return describeCostExportDestination(d);
  const account = sink.accounts.find((a) => a.id === d.accountId)?.name;
  return `${sink.displayName}${account ? ` (${account})` : ""}: ${costExportWarehouseTable(d)}`;
}

/** Warehouse destination types, loaded once for editors. Empty for read-only viewers. */
function useWarehouseSinks(enabled: boolean): CostExportWarehouseSink[] {
  const { orgId, api } = useSettingsHost();
  const [sinks, setSinks] = useState<CostExportWarehouseSink[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<{ sinks: CostExportWarehouseSink[] }>(`/api/org/${orgId}/cost-exports/warehouse-sinks`)
      .then((res) => {
        if (!cancelled) setSinks(Array.isArray(res?.sinks) ? res.sinks : []);
      })
      .catch(() => {
        // An older server without warehouse sinks: offer S3 and HTTPS only.
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId, enabled]);
  return sinks;
}

function describeSchedule(exp: CostExport, gtData: (value: string) => string): string {
  const hour = String(exp.hour).padStart(2, "0");
  return `${gtData(COST_EXPORT_CADENCE_LABELS[exp.cadence])} · ${hour}:00 ${exp.timezone}`;
}

/** Everything a saved export needs, as the form holds it before submitting. */
function formFromExport(exp: CostExport | null): CostExportInput {
  if (!exp) {
    return {
      ...DEFAULT_COST_EXPORT_INPUT,
      // The browser knows the operator's zone; defaulting to it is one fewer
      // thing to get wrong on a schedule whose whole point is "overnight".
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
  }
  return {
    name: exp.name,
    format: exp.format,
    schema: exp.schema,
    query: exp.query,
    cadence: exp.cadence,
    hour: exp.hour,
    timezone: exp.timezone,
    restatementDays: exp.restatementDays,
    enabled: exp.enabled,
    destination: exp.destination,
  };
}

export function CostExportsSection() {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api, has } = useSettingsHost();
  const canWrite = has("org:settings:write");

  const [exports, setExports] = useState<CostExport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ export: CostExport | null } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const sinks = useWarehouseSinks(canWrite);

  const load = useCallback(async () => {
    setError(null);
    try {
      setExports(await api.get<CostExport[]>(`/api/org/${orgId}/cost-exports`));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load cost exports"));
      setExports([]);
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(exp: CostExport) {
    if (
      !window.confirm(
        gt('Delete "{name}"? Objects already written to the destination are left alone.', {
          name: exp.name,
        }),
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/org/${orgId}/cost-exports/${exp.id}`);
      setNotice(gt('Deleted "{name}".', { name: exp.name }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete the export"));
    }
  }

  async function runNow(exp: CostExport) {
    setRunningId(exp.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<CostExportRunResult>(
        `/api/org/${orgId}/cost-exports/${exp.id}/run`,
      );
      if (result.status === "failed") {
        setError(
          gt('"{name}" failed: {error}', {
            name: exp.name,
            error: result.error ?? gt("unknown error"),
          }),
        );
      } else if (exp.destination.kind === "warehouse") {
        setNotice(
          gt('"{name}" loaded {rows} rows into {periods} period(s).', {
            name: exp.name,
            rows: result.rowCount.toLocaleString(),
            periods: result.objects.length,
          }),
        );
      } else if (result.objects.length === 1) {
        setNotice(
          gt('"{name}" wrote {objects} object ({rows} rows).', {
            name: exp.name,
            objects: result.objects.length,
            rows: result.rowCount.toLocaleString(),
          }),
        );
      } else {
        setNotice(
          gt('"{name}" wrote {objects} objects ({rows} rows).', {
            name: exp.name,
            objects: result.objects.length,
            rows: result.rowCount.toLocaleString(),
          }),
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to run the export"));
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold">{gt("Cost exports")}</h1>
          <T>
            <p className="text-sm text-on-surface-muted mt-1">
              Ship the organization&rsquo;s raw cost rows to a warehouse or object store on a
              schedule. Each run writes <strong>one object per period</strong> at a deterministic
              key, or replaces the period&rsquo;s rows in a Snowflake or Databricks table, so
              re-exporting a period replaces it rather than adding a second copy of the same days.
            </p>
          </T>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ export: null })}
            className={`${PRIMARY_BUTTON} shrink-0`}
          >
            {gt("New export")}
          </button>
        )}
      </div>

      <T>
        <div className="mb-6 px-3 py-2 text-xs text-warning/90 border border-amber-900/40 bg-amber-950/20 rounded-lg">
          <strong>Providers restate spend for days after the fact.</strong> The object written for
          yesterday is not final — credits land late, tax lines are recomputed, and amortization
          shifts. Every run therefore re-writes the periods inside its restatement window, and every
          row carries a <code>collection_watermark</code> column: the newest day every collecting
          account had reported. Hold back periods ending after the watermark if your reconciliation
          needs certainty.
        </div>
      </T>

      {error !== null && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}
      {notice !== null && (
        <div className="mb-4 px-3 py-2 text-sm text-success border border-emerald-900/50 bg-emerald-950/20 rounded-lg">
          {notice}
        </div>
      )}

      {exports === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : exports.length === 0 ? (
        <T>
          <p className="text-sm text-on-surface-muted">
            No exports yet. Create one to have Infrawrench write CSV or NDJSON cost rows to an
            S3-compatible bucket (AWS S3, R2, Spaces, MinIO), POST them to an HTTPS endpoint, or
            load them into a Snowflake or Databricks table through a connected account.
          </p>
        </T>
      ) : (
        <ul className="space-y-3">
          {exports.map((exp) => (
            <li key={exp.id} className={CARD}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{exp.name}</span>
                    {exp.destination.kind !== "warehouse" && (
                      <span className="text-xs text-on-surface-muted uppercase">{exp.format}</span>
                    )}
                    {exp.schema === "focus-1.3" && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-secondary">
                        {gtData(COST_EXPORT_SCHEMA_LABELS[exp.schema])}
                      </span>
                    )}
                    {!exp.enabled && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-muted">
                        {gt("paused")}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-tertiary mt-1 truncate">
                    {describeDestination(exp, sinks)}
                  </p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    {exp.credentialHint
                      ? gt("{schedule} · {days}-day restatement window · credential {hint}", {
                          schedule: describeSchedule(exp, gtData),
                          days: exp.restatementDays,
                          hint: exp.credentialHint,
                        })
                      : gt("{schedule} · {days}-day restatement window", {
                          schedule: describeSchedule(exp, gtData),
                          days: exp.restatementDays,
                        })}
                  </p>
                  <p className={`text-xs mt-1 ${statusTone(exp)}`}>{statusLabel(exp, gt)}</p>
                  {exp.lastStatus === "failed" && exp.lastError && (
                    <p className="text-xs text-danger/80 mt-0.5 break-words">{exp.lastError}</p>
                  )}
                  {exp.enabled && exp.nextRunAt && (
                    <p className="text-xs text-on-surface-faint mt-0.5">
                      {gt("Next run {when}", { when: new Date(exp.nextRunAt).toLocaleString() })}
                    </p>
                  )}
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void runNow(exp)}
                      disabled={runningId !== null}
                      className={SECONDARY_BUTTON}
                    >
                      {runningId === exp.id ? gt("Running…") : gt("Run now")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing({ export: exp })}
                      className={SECONDARY_BUTTON}
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(exp)}
                      className="px-3 py-1.5 text-sm font-medium text-danger hover:text-danger-strong"
                    >
                      {gt("Delete")}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <CostExportEditor
          existing={editing.export}
          sinks={sinks}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CostExportEditor({
  existing,
  sinks,
  onClose,
  onSaved,
}: {
  existing: CostExport | null;
  sinks: CostExportWarehouseSink[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api } = useSettingsHost();
  const [form, setForm] = useState<CostExportInput>(() => formFromExport(existing));
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isS3 = form.destination.kind === "s3";
  const isHttp = form.destination.kind === "http";
  const warehouseDestination = form.destination.kind === "warehouse" ? form.destination : null;
  const activeSink = warehouseDestination
    ? sinks.find((s) => s.pluginId === warehouseDestination.pluginId)
    : undefined;

  function setWarehouseSink(sink: CostExportWarehouseSink) {
    setForm((f) => ({
      ...f,
      destination: {
        kind: "warehouse",
        pluginId: sink.pluginId,
        // One connected account is the common case; pick it rather than make
        // the user choose from a list of one.
        accountId: sink.accounts.length === 1 ? sink.accounts[0]!.id : "",
        target: {},
      },
    }));
  }

  function setDestinationKind(kind: "s3" | "http") {
    setForm((f) =>
      kind === "s3"
        ? {
            ...f,
            destination: {
              kind: "s3",
              bucket: "",
              prefix: "infrawrench",
              region: "us-east-1",
              endpoint: "",
              forcePathStyle: false,
            },
          }
        : { ...f, destination: { kind: "http", method: "POST", urlHint: "" } },
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: CostExportInput = {
        ...form,
        // Omit rather than send "": the server reads an absent credential as
        // "keep the stored one", which is what a blank field means here.
        ...(isS3 && accessKeyId ? { accessKeyId } : {}),
        ...(isS3 && secretAccessKey ? { secretAccessKey } : {}),
        ...(isHttp && url ? { url } : {}),
        // A table takes the native layout only (the server refuses FOCUS
        // there), so a FOCUS choice left over from a file destination is dropped.
        ...(warehouseDestination ? { schema: "native" as const } : {}),
      };
      if (existing) {
        await api.put(`/api/org/${orgId}/cost-exports/${existing.id}`, body);
        onSaved(gt('Saved "{name}".', { name: form.name }));
      } else {
        await api.post(`/api/org/${orgId}/cost-exports`, body);
        onSaved(gt('Created "{name}".', { name: form.name }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the export"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={existing ? gt("Edit cost export") : gt("New cost export")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-[42rem] max-w-[92vw] shadow-2xl">
        <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
          <h2 className="text-lg font-semibold">
            {existing ? gt("Edit cost export") : gt("New cost export")}
          </h2>

          {error !== null && (
            <div className="px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block sm:col-span-2">
              <span className={LABEL}>{gt("Name")}</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={gt("Finance warehouse (daily)")}
                className={INPUT}
              />
            </label>

            <label className={`block ${warehouseDestination ? "hidden" : ""}`}>
              <span className={LABEL}>{gt("Format")}</span>
              <select
                value={form.format}
                onChange={(e) =>
                  setForm({ ...form, format: e.target.value as CostExportInput["format"] })
                }
                className={INPUT}
              >
                {COST_EXPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {gtData(COST_EXPORT_FORMAT_LABELS[f])}
                  </option>
                ))}
              </select>
            </label>

            <label className={`block ${warehouseDestination ? "hidden" : ""}`}>
              <span className={LABEL}>{gt("Column layout")}</span>
              <select
                value={form.schema ?? "native"}
                onChange={(e) =>
                  setForm({ ...form, schema: e.target.value as CostExportInput["schema"] })
                }
                className={INPUT}
              >
                {COST_EXPORT_SCHEMAS.map((schema) => (
                  <option key={schema} value={schema}>
                    {gtData(COST_EXPORT_SCHEMA_LABELS[schema])}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={LABEL}>{gt("Cadence (also the period per object)")}</span>
              <select
                value={form.cadence}
                onChange={(e) =>
                  setForm({ ...form, cadence: e.target.value as CostExportInput["cadence"] })
                }
                className={INPUT}
              >
                {COST_EXPORT_CADENCES.map((cadence) => (
                  <option key={cadence} value={cadence}>
                    {gtData(COST_EXPORT_CADENCE_LABELS[cadence])}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={LABEL}>{gt("Hour (local)")}</span>
              <select
                value={form.hour}
                onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}
                className={INPUT}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={LABEL}>{gt("Timezone")}</span>
              <input
                type="text"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                // i18n-ignore: IANA timezone identifier
                placeholder="Europe/Berlin"
                className={INPUT}
              />
            </label>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{gt("Restatement window")}</h3>
            <T>
              <p className="text-xs text-on-surface-muted">
                Days of already-written history each run rebuilds. Every period overlapping the
                window is re-exported <em>in full</em> at the key it already occupies, so the
                destination ends up with a better copy of the same file — never a duplicate. Seven
                days covers how far back the providers we collect from normally revise; set 0 only
                if yours never do.
              </p>
            </T>
            <label className="block max-w-[12rem]">
              <span className={LABEL}>{gt("Days")}</span>
              <input
                type="number"
                min={0}
                max={90}
                value={form.restatementDays}
                onChange={(e) => {
                  // Empty or half-typed keeps the stored window; 0 is a real
                  // setting ("never restate") and must be chosen, not fallen into.
                  const days = parseNumericInputValue(e.target.value);
                  if (days === null) return;
                  setForm({ ...form, restatementDays: days });
                }}
                className={INPUT}
              />
            </label>
          </section>

          {form.schema === "focus-1.3" && !warehouseDestination ? (
            <FocusColumnsNote />
          ) : (
            <ColumnPicker
              query={form.query}
              onChange={(query) => setForm((f) => ({ ...f, query }))}
            />
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{gt("Destination")}</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setDestinationKind("s3")}
                className={isS3 ? PRIMARY_BUTTON : SECONDARY_BUTTON}
              >
                {gt("S3-compatible")}
              </button>
              <button
                type="button"
                onClick={() => setDestinationKind("http")}
                className={isHttp ? PRIMARY_BUTTON : SECONDARY_BUTTON}
              >
                {gt("HTTPS endpoint")}
              </button>
              {sinks.map((sink) => (
                <button
                  key={sink.pluginId}
                  type="button"
                  onClick={() => setWarehouseSink(sink)}
                  className={
                    warehouseDestination?.pluginId === sink.pluginId
                      ? PRIMARY_BUTTON
                      : SECONDARY_BUTTON
                  }
                >
                  {gtData(sink.label)}
                </button>
              ))}
            </div>

            {warehouseDestination ? (
              activeSink ? (
                <WarehouseDestinationFields
                  sink={activeSink}
                  destination={warehouseDestination}
                  onChange={(destination) => setForm((f) => ({ ...f, destination }))}
                />
              ) : (
                <p className="text-xs text-on-surface-muted">{gt("Loading…")}</p>
              )
            ) : form.destination.kind === "s3" ? (
              <S3DestinationFields
                destination={form.destination}
                onChange={(destination) => setForm((f) => ({ ...f, destination }))}
                existing={existing}
                accessKeyId={accessKeyId}
                onAccessKeyIdChange={setAccessKeyId}
                secretAccessKey={secretAccessKey}
                onSecretAccessKeyChange={setSecretAccessKey}
              />
            ) : form.destination.kind === "http" ? (
              <HttpDestinationFields
                destination={form.destination}
                onChange={(destination) => setForm((f) => ({ ...f, destination }))}
                existing={existing}
                url={url}
                onUrlChange={setUrl}
              />
            ) : null}
          </section>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span className="text-on-surface-secondary">
              {gt("Run on schedule (uncheck to pause without deleting)")}
            </span>
          </label>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !form.name.trim()}
              className={PRIMARY_BUTTON}
            >
              {saving ? gt("Saving…") : existing ? gt("Save changes") : gt("Create export")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * What a FOCUS export writes, in place of the column picker: FOCUS fixes its
 * own columns and grain, so the toggles would be settings that do nothing.
 * The stored `dimensions`/`tagKeys` are kept untouched, so switching back to
 * native columns restores the previous choice.
 */
function FocusColumnsNote() {
  return (
    <section className="space-y-2">
      <T>
        <h3 className="text-sm font-semibold">FOCUS 1.3 columns</h3>
      </T>
      <T>
        <p className="text-xs text-on-surface-muted">
          Every object follows the FinOps Open Cost and Usage Specification 1.3: one row per
          account, service, region, resource, tag set, charge type and commitment per day, with
          billed cost (cash) and effective cost (amortized) side by side, the FOCUS charge and
          service categories, and all tags as one JSON column. Infrawrench extras such as the usage
          quantity and the collection watermark come last, prefixed <code>x_</code>. The
          export&apos;s filters and charge types still apply.
        </p>
      </T>
    </section>
  );
}

/**
 * "Which columns survive into the output": the dimension toggles and the tag
 * key list, the only part of the editor that touches `query` and nothing else.
 *
 * The half-typed tag key lives here rather than in the editor: it is a draft
 * that never reaches the request body, and keeping it next to the field that
 * owns it is one fewer piece of state the save path has to ignore.
 */
function ColumnPicker({
  query,
  onChange,
}: {
  query: CostExportQuery;
  onChange: (query: CostExportQuery) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api } = useSettingsHost();
  const [tagKeyDraft, setTagKeyDraft] = useState("");
  // The org's virtual tags, offered as toggles: a key picked from a list
  // rather than typed, because a mistyped key would fail every run.
  const [virtualTags, setVirtualTags] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ values: Array<{ value: string; label: string }> }>(
        `/api/org/${orgId}/costs/dimensions?dimension=virtual-tag-keys`,
      )
      .then((res) => {
        if (!cancelled) setVirtualTags(Array.isArray(res?.values) ? res.values : []);
      })
      .catch(() => {
        if (!cancelled) setVirtualTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);
  const selectedVirtualTags = query.virtualTagKeys ?? [];

  function toggleVirtualTag(key: string) {
    const next = selectedVirtualTags.includes(key)
      ? selectedVirtualTags.filter((k) => k !== key)
      : [...selectedVirtualTags, key];
    const { virtualTagKeys: _drop, ...rest } = query;
    onChange(next.length > 0 ? { ...rest, virtualTagKeys: next } : rest);
  }

  function toggleDimension(dimension: CostDimensionId) {
    const selected = query.dimensions.includes(dimension);
    onChange({
      ...query,
      dimensions: selected
        ? query.dimensions.filter((d) => d !== dimension)
        : [...query.dimensions, dimension],
    });
  }

  function addTagKey() {
    const key = tagKeyDraft.trim();
    if (!key || query.tagKeys.includes(key)) return;
    onChange({ ...query, tagKeys: [...query.tagKeys, key] });
    setTagKeyDraft("");
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{gt("Columns")}</h3>
      <T>
        <p className="text-xs text-on-surface-muted">
          Which identity columns survive into the output. Leaving one out aggregates over it — a
          provider + service export is a fraction of the size of a per-resource one. Day, currency,
          amount and usage always come along.
        </p>
      </T>
      <div className="flex flex-wrap gap-2">
        {PICKABLE_DIMENSIONS.map((dimension) => {
          const selected = query.dimensions.includes(dimension);
          return (
            <button
              key={dimension}
              type="button"
              onClick={() => toggleDimension(dimension)}
              className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                selected
                  ? "border-blue-500 bg-blue-600/20 text-on-surface"
                  : "border-border text-on-surface-muted hover:bg-surface-overlay"
              }`}
            >
              {gtData(COST_DIMENSION_LABELS[dimension])}
            </button>
          );
        })}
      </div>

      <div className="pt-2">
        <span className={LABEL}>{gt("Tag columns")}</span>
        <div className="flex flex-wrap gap-2 mb-2">
          {query.tagKeys.map((key) => (
            <span
              key={key}
              className="px-2 py-0.5 text-xs rounded bg-surface-overlay text-on-surface-secondary"
            >
              {key}
              <button
                type="button"
                aria-label={gt("Remove tag column {key}", { key })}
                onClick={() =>
                  onChange({ ...query, tagKeys: query.tagKeys.filter((k) => k !== key) })
                }
                className="ml-1.5 text-on-surface-faint hover:text-danger"
              >
                <CloseIcon size={12} />
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <label className="block flex-1">
            <span className={LABEL}>{gt("Tag key")}</span>
            <input
              type="text"
              value={tagKeyDraft}
              onChange={(e) => setTagKeyDraft(e.target.value)}
              placeholder="team"
              className={INPUT}
            />
          </label>
          <button type="button" className={SECONDARY_BUTTON} onClick={addTagKey}>
            {gt("Add")}
          </button>
        </div>
      </div>

      {(virtualTags.length > 0 || selectedVirtualTags.length > 0) && (
        <div className="pt-2">
          <span className={LABEL}>{gt("Virtual tag columns")}</span>
          <T>
            <p className="text-xs text-on-surface-muted mb-2">
              One column per virtual tag. A row a split rule divides is written once per share, with
              its amounts weighted, so the file still adds up to the collected total.
            </p>
          </T>
          <div className="flex flex-wrap gap-2">
            {[
              ...virtualTags,
              ...selectedVirtualTags
                .filter((k) => !virtualTags.some((t) => t.value === k))
                .map((k) => ({ value: k, label: k })),
            ].map((tag) => {
              const selected = selectedVirtualTags.includes(tag.value);
              return (
                <button
                  key={tag.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleVirtualTag(tag.value)}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                    selected
                      ? "border-blue-500 bg-blue-600/20 text-on-surface"
                      : "border-border text-on-surface-muted hover:bg-surface-overlay"
                  }`}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Everything about writing to an S3-compatible bucket, including the
 * write-only credential pair. One implementation covers AWS S3, R2, Spaces,
 * Scaleway, B2 and MinIO: see `CostExportS3Destination`.
 */
function S3DestinationFields({
  destination,
  onChange,
  existing,
  accessKeyId,
  onAccessKeyIdChange,
  secretAccessKey,
  onSecretAccessKeyChange,
}: {
  destination: CostExportS3Destination;
  onChange: (destination: CostExportS3Destination) => void;
  existing: CostExport | null;
  accessKeyId: string;
  onAccessKeyIdChange: (value: string) => void;
  secretAccessKey: string;
  onSecretAccessKeyChange: (value: string) => void;
}) {
  const gt = useGT();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <T>
        <p className="sm:col-span-2 text-xs text-on-surface-muted">
          One setting covers AWS S3, Cloudflare R2, DigitalOcean Spaces, Scaleway, Backblaze B2 and
          MinIO — leave the endpoint blank for AWS, otherwise paste the provider&rsquo;s S3 API
          origin.
        </p>
      </T>
      <label className="block">
        <span className={LABEL}>{gt("Bucket")}</span>
        <input
          type="text"
          value={destination.bucket}
          onChange={(e) => onChange({ ...destination, bucket: e.target.value })}
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>{gt("Key prefix")}</span>
        <input
          type="text"
          value={destination.prefix}
          onChange={(e) => onChange({ ...destination, prefix: e.target.value })}
          placeholder="infrawrench"
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>{gt("Region")}</span>
        <input
          type="text"
          value={destination.region}
          onChange={(e) => onChange({ ...destination, region: e.target.value })}
          // i18n-ignore: provider region code example
          placeholder="us-east-1 (R2: auto)"
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>{gt("Endpoint (blank = AWS S3)")}</span>
        <input
          type="text"
          value={destination.endpoint}
          onChange={(e) => onChange({ ...destination, endpoint: e.target.value })}
          placeholder="https://<account>.r2.cloudflarestorage.com"
          className={INPUT}
        />
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={destination.forcePathStyle}
          onChange={(e) => onChange({ ...destination, forcePathStyle: e.target.checked })}
        />
        <span className="text-on-surface-secondary">
          {gt("Path-style addressing (needed by MinIO and most self-hosted gateways)")}
        </span>
      </label>
      <label className="block">
        <span className={LABEL}>{gt("Access key id")}</span>
        <input
          type="text"
          value={accessKeyId}
          onChange={(e) => onAccessKeyIdChange(e.target.value)}
          autoComplete="off"
          placeholder={
            existing?.hasCredentials
              ? gt("Stored: {hint}", { hint: existing.credentialHint ?? "…" })
              : "AKIA…"
          }
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>{gt("Secret access key")}</span>
        <input
          type="password"
          value={secretAccessKey}
          onChange={(e) => onSecretAccessKeyChange(e.target.value)}
          autoComplete="new-password"
          placeholder={
            existing?.hasCredentials ? gt("Leave blank to keep the stored key") : gt("Secret")
          }
          className={INPUT}
        />
      </label>
    </div>
  );
}

/** Everything about POSTing each object to an HTTPS endpoint. */
function HttpDestinationFields({
  destination,
  onChange,
  existing,
  url,
  onUrlChange,
}: {
  destination: CostExportHttpDestination;
  onChange: (destination: CostExportHttpDestination) => void;
  existing: CostExport | null;
  url: string;
  onUrlChange: (value: string) => void;
}) {
  const gt = useGT();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <T>
        <p className="sm:col-span-2 text-xs text-on-surface-muted">
          Each object is sent as the request body, with the object key in the
          <code> X-Infrawrench-Object-Key</code> header. The URL is treated as a credential — a
          pre-signed URL carries its own signature — so it is encrypted and never shown again.
        </p>
      </T>
      <label className="block">
        <span className={LABEL}>{gt("Method")}</span>
        <select
          value={destination.method}
          onChange={(e) => onChange({ ...destination, method: e.target.value as "POST" | "PUT" })}
          className={INPUT}
        >
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
        </select>
      </label>
      <label className="block">
        <span className={LABEL}>{gt("URL")}</span>
        <input
          type="password"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          autoComplete="new-password"
          placeholder={
            existing?.hasCredentials
              ? gt("Stored: {hint}", { hint: existing.credentialHint ?? "…" })
              : "https://…"
          }
          className={INPUT}
        />
      </label>
    </div>
  );
}
