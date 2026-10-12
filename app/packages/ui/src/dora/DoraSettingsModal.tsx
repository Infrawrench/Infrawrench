import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  DORA_FAILURE_WINDOW_MAX_HOURS,
  DORA_FAILURE_WINDOW_MIN_HOURS,
  normalizeDoraPatterns,
  validateDoraSettings,
  type DoraSettings,
  type DoraSettingsView,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { DoraClient } from "./types.js";

export interface DoraSettingsModalProps {
  client: DoraClient;
  onClose: () => void;
  onSaved: () => void;
}

/** One pattern per line or comma; blanks and duplicates dropped. */
function parsePatterns(text: string): string[] {
  return normalizeDoraPatterns(text.split(/[\n,]/));
}

/**
 * The org's DORA settings: what counts as production, which pipelines are
 * deploys, the failure window, and what else counts. Read-only when the host
 * gives no `updateSettings` (the writer needs `org:settings:write`).
 */
export function DoraSettingsModal({ client, onClose, onSaved }: DoraSettingsModalProps) {
  const gt = useGT();
  const canWrite = Boolean(client.updateSettings);
  const [loaded, setLoaded] = useState<DoraSettingsView | null>(null);
  const [windowHours, setWindowHours] = useState("24");
  const [production, setProduction] = useState("");
  const [pipelines, setPipelines] = useState("");
  const [countFailed, setCountFailed] = useState(false);
  const [includeChanges, setIncludeChanges] = useState(false);
  const [digest, setDigest] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client
      .getSettings()
      .then((s) => {
        setLoaded(s);
        setWindowHours(String(s.failureWindowHours));
        setProduction(s.productionEnvironments.join("\n"));
        setPipelines(s.pipelinePatterns.join("\n"));
        setCountFailed(s.countFailedDeploys);
        setIncludeChanges(s.includeResourceChanges);
        setDigest(s.digestEnabled);
      })
      .catch((e) => setError(e instanceof Error ? e.message : gt("Failed to load the settings")));
  }, [client, gt]);

  const save = async () => {
    if (!client.updateSettings) return;
    const patch: DoraSettings = {
      failureWindowHours: Number(windowHours),
      productionEnvironments: parsePatterns(production),
      pipelinePatterns: parsePatterns(pipelines),
      countFailedDeploys: countFailed,
      includeResourceChanges: includeChanges,
      digestEnabled: digest,
    };
    const problem = validateDoraSettings(patch);
    if (problem) {
      // The validator's sentence names the API field; say it in the form's terms.
      setError(
        problem.startsWith("failureWindowHours")
          ? gt("The failure window must be a whole number of hours from {min} to {max}.", {
              min: DORA_FAILURE_WINDOW_MIN_HOURS,
              max: DORA_FAILURE_WINDOW_MAX_HOURS,
            })
          : problem.startsWith("productionEnvironments needs")
            ? gt("Name at least one production environment.")
            : gt("Check the patterns: at most 50, each at most 100 characters."),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await client.updateSettings(patch);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the settings"));
    } finally {
      setSaving(false);
    }
  };

  const field =
    "w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-60";

  return (
    <Modal onClose={() => (saving ? undefined : onClose())} ariaLabel={gt("Delivery settings")}>
      <div className="w-[32rem] max-w-[92vw] rounded-2xl border border-border bg-surface p-5 shadow-xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Delivery settings")}</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            {gt("How the DORA metrics decide what is production and what counts as a failure.")}
          </p>
          {!canWrite && (
            <p className="mt-1 text-xs text-on-surface-faint">
              {gt(
                "You can view these settings; changing them needs permission to edit organization settings.",
              )}
            </p>
          )}
        </div>
        {loaded === null && !error ? (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-on-surface">
                {gt("Production environments")}
              </span>
              <textarea
                rows={3}
                value={production}
                disabled={!canWrite}
                onChange={(e) => setProduction(e.target.value)}
                className={field}
              />
              <span className="block text-[11px] text-on-surface-faint">
                {gt("One name per line. * matches anything, so prod* covers prod-eu and prod-us.")}
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-on-surface">{gt("Deploy pipelines")}</span>
              <textarea
                rows={2}
                value={pipelines}
                disabled={!canWrite}
                onChange={(e) => setPipelines(e.target.value)}
                className={field}
              />
              <span className="block text-[11px] text-on-surface-faint">
                {gt(
                  "CI pipelines whose runs are deploys, by name (Buildkite, CircleCI, GitLab and Bitbucket runs are only counted when they match).",
                )}
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-on-surface">
                {gt("Failure window (hours)")}
              </span>
              <input
                type="number"
                min={DORA_FAILURE_WINDOW_MIN_HOURS}
                max={DORA_FAILURE_WINDOW_MAX_HOURS}
                value={windowHours}
                disabled={!canWrite}
                onChange={(e) => setWindowHours(e.target.value)}
                className={field}
              />
              <span className="block text-[11px] text-on-surface-faint">
                {gt(
                  "An incident or rollback this soon after a production change counts the change as failed.",
                )}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={countFailed}
                disabled={!canWrite}
                onChange={(e) => setCountFailed(e.target.checked)}
                className="mt-1"
              />
              <span>{gt("Count a production deploy that itself failed as a failed change")}</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeChanges}
                disabled={!canWrite}
                onChange={(e) => setIncludeChanges(e.target.checked)}
                className="mt-1"
              />
              <span>
                {gt(
                  "Count resource changes from the change timeline as changes too (console edits, drift); a reverted one counts as failed",
                )}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={digest}
                disabled={!canWrite}
                onChange={(e) => setDigest(e.target.checked)}
                className="mt-1"
              />
              <span>{gt("Include a Delivery line in the weekly digest")}</span>
            </label>
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-surface-sunken"
          >
            {canWrite ? gt("Cancel") : gt("Close")}
          </button>
          {canWrite && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loaded === null}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-60"
            >
              {saving ? gt("Saving…") : gt("Save")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
