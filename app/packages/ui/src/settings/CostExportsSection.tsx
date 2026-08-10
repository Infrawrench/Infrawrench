import { useCallback, useEffect, useState } from "react";
import {
  COST_DIMENSIONS,
  COST_DIMENSION_LABELS,
  COST_EXPORT_CADENCES,
  COST_EXPORT_CADENCE_LABELS,
  COST_EXPORT_FORMATS,
  COST_EXPORT_FORMAT_LABELS,
  DEFAULT_COST_EXPORT_INPUT,
  type CostDimensionId,
  type CostExport,
  type CostExportHttpDestination,
  type CostExportInput,
  type CostExportQuery,
  type CostExportRunResult,
  type CostExportS3Destination,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { parseNumericInputValue } from "../form-values.js";
import { useSettingsHost } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/**
 * Scheduled cost exports — a recurring dump of the org's raw cost rows into a
 * warehouse or object store.
 *
 * Three things this page has to get across, because getting them wrong is
 * expensive and silent:
 *
 *  - **Failures are loud.** A nightly export that stopped working three weeks
 *    ago is worse than never having had one, so `lastStatus`/`lastError` are on
 *    every row, in red, with the destination's own wording — the same way cost
 *    collection failures surface on the Costs panel.
 *  - **Restatements are explained where the knob is**, not only in the docs.
 *    Somebody setting this up for a finance system needs to know on the spot
 *    that yesterday's object is not final.
 *  - **Credentials only go in.** The stored secret is never shown; the field
 *    stays blank on return and blank means "keep what is stored".
 */

/** Which dimensions the column picker offers. `tag` is handled by the tag-key list. */
const PICKABLE_DIMENSIONS = COST_DIMENSIONS.filter((d) => d !== "tag");

function statusTone(exp: CostExport): string {
  if (exp.lastStatus === "failed") return "text-red-400";
  if (exp.lastStatus === "succeeded") return "text-emerald-400";
  return "text-on-surface-muted";
}

function statusLabel(exp: CostExport): string {
  if (exp.lastStatus === "pending") return "Not run yet";
  const when = exp.lastRunAt ? new Date(exp.lastRunAt).toLocaleString() : "";
  if (exp.lastStatus === "succeeded") {
    const objects = exp.lastObjectCount ?? 0;
    const rows = exp.lastRowCount ?? 0;
    return `Wrote ${objects} object${objects === 1 ? "" : "s"} · ${rows.toLocaleString()} rows · ${when}`;
  }
  return `Failed ${when}`;
}

function describeDestination(exp: CostExport): string {
  return exp.destination.kind === "s3"
    ? `s3://${exp.destination.bucket}/${exp.destination.prefix}`
    : `${exp.destination.method} ${exp.destination.urlHint}`;
}

function describeSchedule(exp: CostExport): string {
  const hour = String(exp.hour).padStart(2, "0");
  return `${COST_EXPORT_CADENCE_LABELS[exp.cadence]} · ${hour}:00 ${exp.timezone}`;
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
  const { orgId, api, has } = useSettingsHost();
  const canWrite = has("org:settings:write");

  const [exports, setExports] = useState<CostExport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ export: CostExport | null } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setExports(await api.get<CostExport[]>(`/api/org/${orgId}/cost-exports`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cost exports");
      setExports([]);
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(exp: CostExport) {
    if (
      !window.confirm(
        `Delete "${exp.name}"? Objects already written to the destination are left alone.`,
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/org/${orgId}/cost-exports/${exp.id}`);
      setNotice(`Deleted "${exp.name}".`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the export");
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
        setError(`"${exp.name}" failed: ${result.error ?? "unknown error"}`);
      } else {
        setNotice(
          `"${exp.name}" wrote ${result.objects.length} object${
            result.objects.length === 1 ? "" : "s"
          } (${result.rowCount.toLocaleString()} rows).`,
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run the export");
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold">Cost exports</h1>
          <p className="text-sm text-on-surface-muted mt-1">
            Ship the organization&rsquo;s raw cost rows to a warehouse or object store on a
            schedule. Each run writes <strong>one object per period</strong> at a deterministic key,
            so re-exporting a period replaces the file rather than adding a second copy of the same
            days.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ export: null })}
            className={`${PRIMARY_BUTTON} shrink-0`}
          >
            New export
          </button>
        )}
      </div>

      <div className="mb-6 px-3 py-2 text-xs text-amber-300/90 border border-amber-900/40 bg-amber-950/20 rounded-lg">
        <strong>Providers restate spend for days after the fact.</strong> The object written for
        yesterday is not final — credits land late, tax lines are recomputed, and amortization
        shifts. Every run therefore re-writes the periods inside its restatement window, and every
        row carries a <code>collection_watermark</code> column: the newest day every collecting
        account had reported. Hold back periods ending after the watermark if your reconciliation
        needs certainty.
      </div>

      {error !== null && (
        <div className="mb-4 px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}
      {notice !== null && (
        <div className="mb-4 px-3 py-2 text-sm text-emerald-400 border border-emerald-900/50 bg-emerald-950/20 rounded-lg">
          {notice}
        </div>
      )}

      {exports === null ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : exports.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No exports yet. Create one to have Infrawrench write CSV or NDJSON cost rows to an
          S3-compatible bucket (AWS S3, R2, Spaces, MinIO) or POST them to an HTTPS endpoint.
        </p>
      ) : (
        <ul className="space-y-3">
          {exports.map((exp) => (
            <li key={exp.id} className={CARD}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{exp.name}</span>
                    <span className="text-xs text-on-surface-muted uppercase">{exp.format}</span>
                    {!exp.enabled && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-muted">
                        paused
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-tertiary mt-1 truncate">
                    {describeDestination(exp)}
                  </p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    {describeSchedule(exp)} · {exp.restatementDays}-day restatement window
                    {exp.credentialHint ? ` · credential ${exp.credentialHint}` : ""}
                  </p>
                  <p className={`text-xs mt-1 ${statusTone(exp)}`}>{statusLabel(exp)}</p>
                  {exp.lastStatus === "failed" && exp.lastError && (
                    <p className="text-xs text-red-400/80 mt-0.5 break-words">{exp.lastError}</p>
                  )}
                  {exp.enabled && exp.nextRunAt && (
                    <p className="text-xs text-on-surface-faint mt-0.5">
                      Next run {new Date(exp.nextRunAt).toLocaleString()}
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
                      {runningId === exp.id ? "Running…" : "Run now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing({ export: exp })}
                      className={SECONDARY_BUTTON}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(exp)}
                      className="px-3 py-1.5 text-sm font-medium text-red-400 hover:text-red-500"
                    >
                      Delete
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
  onClose,
  onSaved,
}: {
  existing: CostExport | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { orgId, api } = useSettingsHost();
  const [form, setForm] = useState<CostExportInput>(() => formFromExport(existing));
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isS3 = form.destination.kind === "s3";

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
        // Omit rather than send "" — the server reads an absent credential as
        // "keep the stored one", which is what a blank field means here.
        ...(isS3 && accessKeyId ? { accessKeyId } : {}),
        ...(isS3 && secretAccessKey ? { secretAccessKey } : {}),
        ...(!isS3 && url ? { url } : {}),
      };
      if (existing) {
        await api.put(`/api/org/${orgId}/cost-exports/${existing.id}`, body);
        onSaved(`Saved "${form.name}".`);
      } else {
        await api.post(`/api/org/${orgId}/cost-exports`, body);
        onSaved(`Created "${form.name}".`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the export");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={existing ? "Edit cost export" : "New cost export"}
      className="w-[42rem] max-w-[92vw]"
    >
      <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">
          {existing ? "Edit cost export" : "New cost export"}
        </h2>

        {error !== null && (
          <div className="px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block sm:col-span-2">
            <span className={LABEL}>Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Finance warehouse (daily)"
              className={INPUT}
            />
          </label>

          <label className="block">
            <span className={LABEL}>Format</span>
            <select
              value={form.format}
              onChange={(e) =>
                setForm({ ...form, format: e.target.value as CostExportInput["format"] })
              }
              className={INPUT}
            >
              {COST_EXPORT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {COST_EXPORT_FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className={LABEL}>Cadence (also the period per object)</span>
            <select
              value={form.cadence}
              onChange={(e) =>
                setForm({ ...form, cadence: e.target.value as CostExportInput["cadence"] })
              }
              className={INPUT}
            >
              {COST_EXPORT_CADENCES.map((cadence) => (
                <option key={cadence} value={cadence}>
                  {COST_EXPORT_CADENCE_LABELS[cadence]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className={LABEL}>Hour (local)</span>
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
            <span className={LABEL}>Timezone</span>
            <input
              type="text"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Europe/Berlin"
              className={INPUT}
            />
          </label>
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Restatement window</h3>
          <p className="text-xs text-on-surface-muted">
            Days of already-written history each run rebuilds. Every period overlapping the window
            is re-exported <em>in full</em> at the key it already occupies, so the destination ends
            up with a better copy of the same file — never a duplicate. Seven days covers how far
            back the providers we collect from normally revise; set 0 only if yours never do.
          </p>
          <label className="block max-w-[12rem]">
            <span className={LABEL}>Days</span>
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

        <ColumnPicker query={form.query} onChange={(query) => setForm((f) => ({ ...f, query }))} />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Destination</h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDestinationKind("s3")}
              className={isS3 ? PRIMARY_BUTTON : SECONDARY_BUTTON}
            >
              S3-compatible
            </button>
            <button
              type="button"
              onClick={() => setDestinationKind("http")}
              className={!isS3 ? PRIMARY_BUTTON : SECONDARY_BUTTON}
            >
              HTTPS endpoint
            </button>
          </div>

          {form.destination.kind === "s3" ? (
            <S3DestinationFields
              destination={form.destination}
              onChange={(destination) => setForm((f) => ({ ...f, destination }))}
              existing={existing}
              accessKeyId={accessKeyId}
              onAccessKeyIdChange={setAccessKeyId}
              secretAccessKey={secretAccessKey}
              onSecretAccessKeyChange={setSecretAccessKey}
            />
          ) : (
            <HttpDestinationFields
              destination={form.destination}
              onChange={(destination) => setForm((f) => ({ ...f, destination }))}
              existing={existing}
              url={url}
              onUrlChange={setUrl}
            />
          )}
        </section>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span className="text-on-surface-secondary">
            Run on schedule (uncheck to pause without deleting)
          </span>
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !form.name.trim()}
            className={PRIMARY_BUTTON}
          >
            {saving ? "Saving…" : existing ? "Save changes" : "Create export"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * "Which columns survive into the output" — the dimension toggles and the tag
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
  const [tagKeyDraft, setTagKeyDraft] = useState("");

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
      <h3 className="text-sm font-semibold">Columns</h3>
      <p className="text-xs text-on-surface-muted">
        Which identity columns survive into the output. Leaving one out aggregates over it — a
        provider + service export is a fraction of the size of a per-resource one. Day, currency,
        amount and usage always come along.
      </p>
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
              {COST_DIMENSION_LABELS[dimension]}
            </button>
          );
        })}
      </div>

      <div className="pt-2">
        <span className={LABEL}>Tag columns</span>
        <div className="flex flex-wrap gap-2 mb-2">
          {query.tagKeys.map((key) => (
            <span
              key={key}
              className="px-2 py-0.5 text-xs rounded bg-surface-overlay text-on-surface-secondary"
            >
              {key}
              <button
                type="button"
                aria-label={`Remove tag column ${key}`}
                onClick={() =>
                  onChange({ ...query, tagKeys: query.tagKeys.filter((k) => k !== key) })
                }
                className="ml-1.5 text-on-surface-faint hover:text-red-400"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <label className="block flex-1">
            <span className={LABEL}>Tag key</span>
            <input
              type="text"
              value={tagKeyDraft}
              onChange={(e) => setTagKeyDraft(e.target.value)}
              placeholder="team"
              className={INPUT}
            />
          </label>
          <button type="button" className={SECONDARY_BUTTON} onClick={addTagKey}>
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Everything about writing to an S3-compatible bucket, including the
 * write-only credential pair. One implementation covers AWS S3, R2, Spaces,
 * Scaleway, B2 and MinIO — see `CostExportS3Destination`.
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
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <p className="sm:col-span-2 text-xs text-on-surface-muted">
        One setting covers AWS S3, Cloudflare R2, DigitalOcean Spaces, Scaleway, Backblaze B2 and
        MinIO — leave the endpoint blank for AWS, otherwise paste the provider&rsquo;s S3 API
        origin.
      </p>
      <label className="block">
        <span className={LABEL}>Bucket</span>
        <input
          type="text"
          value={destination.bucket}
          onChange={(e) => onChange({ ...destination, bucket: e.target.value })}
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>Key prefix</span>
        <input
          type="text"
          value={destination.prefix}
          onChange={(e) => onChange({ ...destination, prefix: e.target.value })}
          placeholder="infrawrench"
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>Region</span>
        <input
          type="text"
          value={destination.region}
          onChange={(e) => onChange({ ...destination, region: e.target.value })}
          placeholder="us-east-1 (R2: auto)"
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>Endpoint (blank = AWS S3)</span>
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
          Path-style addressing (needed by MinIO and most self-hosted gateways)
        </span>
      </label>
      <label className="block">
        <span className={LABEL}>Access key id</span>
        <input
          type="text"
          value={accessKeyId}
          onChange={(e) => onAccessKeyIdChange(e.target.value)}
          autoComplete="off"
          placeholder={
            existing?.hasCredentials ? `Stored: ${existing.credentialHint ?? "…"}` : "AKIA…"
          }
          className={INPUT}
        />
      </label>
      <label className="block">
        <span className={LABEL}>Secret access key</span>
        <input
          type="password"
          value={secretAccessKey}
          onChange={(e) => onSecretAccessKeyChange(e.target.value)}
          autoComplete="new-password"
          placeholder={existing?.hasCredentials ? "Leave blank to keep the stored key" : "Secret"}
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
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <p className="sm:col-span-2 text-xs text-on-surface-muted">
        Each object is sent as the request body, with the object key in the
        <code> X-Infrawrench-Object-Key</code> header. The URL is treated as a credential — a
        pre-signed URL carries its own signature — so it is encrypted and never shown again.
      </p>
      <label className="block">
        <span className={LABEL}>Method</span>
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
        <span className={LABEL}>URL</span>
        <input
          type="password"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          autoComplete="new-password"
          placeholder={
            existing?.hasCredentials ? `Stored: ${existing.credentialHint ?? "…"}` : "https://…"
          }
          className={INPUT}
        />
      </label>
    </div>
  );
}
