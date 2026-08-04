import { useEffect, useMemo, useState } from "react";
import {
  PROBE_DEFAULTS,
  PROBE_LIMITS,
  PROBE_METHODS,
  normalizeProbeUrl,
  type ProbeSuggestion,
  type SyntheticProbe,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { ProbesClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

export interface ProbeEditorModalProps {
  client: ProbesClient;
  /** Existing probe to edit, or null to create one. */
  existing: SyntheticProbe | null;
  onSaved: (probe: SyntheticProbe | null) => void;
  onClose: () => void;
}

/** The `<select>` value marking "type a URL yourself". */
const CUSTOM = "__custom__";

/**
 * A numeric field's string as a whole number, or null when empty/partial —
 * `Number("")` is 0 and `Number("1e")` is NaN, and neither belongs in state
 * or a request body.
 */
function parseFieldInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

/**
 * The probe editor. The endpoint field is a *picker* first: it lists every
 * URL mined from the org's synced resource outputs (`GET /probes/suggestions`)
 * so nobody has to remember what their load balancer's hostname is — with a
 * custom-URL option for endpoints Infrawrench doesn't know about.
 */
export function ProbeEditorModal({ client, existing, onSaved, onClose }: ProbeEditorModalProps) {
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [method, setMethod] = useState(existing?.method ?? PROBE_DEFAULTS.method);
  // The numeric fields hold the input's raw string — parsing happens at the
  // edge (parseFieldInt) so a cleared or half-typed field can't leak 0/NaN
  // into state or the request body.
  const [intervalSeconds, setIntervalSeconds] = useState(
    String(existing?.intervalSeconds ?? PROBE_DEFAULTS.intervalSeconds),
  );
  const [timeoutMs, setTimeoutMs] = useState(
    String(existing?.timeoutMs ?? PROBE_DEFAULTS.timeoutMs),
  );
  const [failureThreshold, setFailureThreshold] = useState(
    String(existing?.failureThreshold ?? PROBE_DEFAULTS.failureThreshold),
  );
  // null = loading; [] = loaded, nothing to suggest.
  const [suggestions, setSuggestions] = useState<ProbeSuggestion[] | null>(null);
  const [picked, setPicked] = useState<string>(existing ? CUSTOM : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listSuggestions()
      .then((list) => {
        if (!cancelled) setSuggestions(list);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const pickedSuggestion = useMemo(
    () => suggestions?.find((s) => s.url === picked) ?? null,
    [suggestions, picked],
  );

  const pick = (value: string) => {
    setPicked(value);
    if (value !== CUSTOM && value !== "") {
      setUrl(value);
      const suggestion = suggestions?.find((s) => s.url === value);
      if (suggestion && !name.trim()) setName(suggestion.displayName);
    }
  };

  const urlProblem = url.trim()
    ? (() => {
        const parsed = normalizeProbeUrl(url);
        return "error" in parsed ? parsed.error : null;
      })()
    : null;

  const intervalNum = parseFieldInt(intervalSeconds);
  const timeoutNum = parseFieldInt(timeoutMs);
  const thresholdNum = parseFieldInt(failureThreshold);
  const numbersProblem =
    intervalNum === null || timeoutNum === null || thresholdNum === null
      ? "Interval, timeout and failure threshold must be whole numbers."
      : null;
  const thresholdForCopy = thresholdNum ?? PROBE_DEFAULTS.failureThreshold;

  const save = async () => {
    if (!name.trim()) {
      setError("A name is required.");
      return;
    }
    const parsed = normalizeProbeUrl(url);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (intervalNum === null || timeoutNum === null || thresholdNum === null) {
      setError(numbersProblem);
      return;
    }
    const mutate = existing ? client.updateProbe : client.createProbe;
    if (!mutate) {
      // A read-only host opened the editor by mistake — fail loudly instead
      // of "saving" nothing and closing as if it worked.
      setError("Probe editing isn't available here.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // The suggestion's resource attribution only holds while the URL still
      // IS that suggestion — a hand-edited URL is not the resource's output.
      const attribution =
        pickedSuggestion && pickedSuggestion.url === parsed.url
          ? { resourceId: pickedSuggestion.resourceId, outputKey: pickedSuggestion.outputKey }
          : {};
      const saved = existing
        ? await client.updateProbe!(existing.id, {
            name: name.trim(),
            url: parsed.url,
            method,
            intervalSeconds: intervalNum,
            timeoutMs: timeoutNum,
            failureThreshold: thresholdNum,
          })
        : await client.createProbe!({
            name: name.trim(),
            url: parsed.url,
            method,
            intervalSeconds: intervalNum,
            timeoutMs: timeoutNum,
            failureThreshold: thresholdNum,
            ...attribution,
          });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save probe");
    } finally {
      setSaving(false);
    }
  };

  // A dismissal mid-save would leave the request in flight with no surface
  // for its outcome — the modal stays up until the save settles.
  const dismiss = () => {
    if (!saving) onClose();
  };

  return (
    <Modal onClose={dismiss} ariaLabel={existing ? "Edit probe" : "New probe"}>
      <div className="w-[28rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? "Edit probe" : "New probe"}
        </h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          The endpoint is checked every interval from outside your infrastructure, so latency and
          reachability reflect what your users see. {thresholdForCopy} consecutive failure
          {thresholdForCopy === 1 ? "" : "s"} raise{thresholdForCopy === 1 ? "s" : ""} an alert.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          {!existing && (
            <div>
              <label className={labelClass} htmlFor="probe-endpoint">
                Endpoint
              </label>
              <select
                id="probe-endpoint"
                className={inputClass}
                value={picked}
                onChange={(e) => pick(e.target.value)}
              >
                <option value="" disabled>
                  {suggestions === null
                    ? "Loading endpoints…"
                    : suggestions.length > 0
                      ? "Pick an endpoint from your resources…"
                      : "No endpoints found in synced resources"}
                </option>
                {(suggestions ?? []).map((s) => (
                  <option key={s.url} value={s.url}>
                    {s.displayName} — {s.url}
                  </option>
                ))}
                <option value={CUSTOM}>Custom URL…</option>
              </select>
            </div>
          )}

          {(existing !== null || picked === CUSTOM || pickedSuggestion !== null) && (
            <div>
              <label className={labelClass} htmlFor="probe-url">
                URL
              </label>
              <input
                id="probe-url"
                type="url"
                className={inputClass}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/health"
              />
              {urlProblem !== null && <p className="mt-1 text-xs text-red-400">{urlProblem}</p>}
            </div>
          )}

          <div>
            <label className={labelClass} htmlFor="probe-name">
              Name
            </label>
            <input
              id="probe-name"
              type="text"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="API health"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="probe-method">
                Method
              </label>
              <select
                id="probe-method"
                className={inputClass}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                {PROBE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="probe-interval">
                Interval (seconds)
              </label>
              <input
                id="probe-interval"
                type="number"
                min={PROBE_LIMITS.minIntervalSeconds}
                max={PROBE_LIMITS.maxIntervalSeconds}
                className={inputClass}
                value={intervalSeconds}
                onChange={(e) => setIntervalSeconds(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="probe-timeout">
                Timeout (ms)
              </label>
              <input
                id="probe-timeout"
                type="number"
                min={PROBE_LIMITS.minTimeoutMs}
                max={PROBE_LIMITS.maxTimeoutMs}
                step={500}
                className={inputClass}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="probe-threshold">
                Failures before alert
              </label>
              <input
                id="probe-threshold"
                type="number"
                min={PROBE_LIMITS.minFailureThreshold}
                max={PROBE_LIMITS.maxFailureThreshold}
                className={inputClass}
                value={failureThreshold}
                onChange={(e) => setFailureThreshold(e.target.value)}
              />
            </div>
          </div>

          {error !== null && (
            <div role="alert" className="text-sm text-red-500">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={dismiss}
              disabled={saving}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                !url.trim() ||
                urlProblem !== null ||
                !name.trim() ||
                numbersProblem !== null
              }
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : existing ? "Save changes" : "Create probe"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
