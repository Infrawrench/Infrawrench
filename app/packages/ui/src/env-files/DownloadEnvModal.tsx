import { useState } from "react";
import { useGT } from "gt-react";
import type { InfraenvProblem } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { downloadBlob } from "../delivery/download.js";
import { dialogClass, inputClass, labelClass, primaryButton, secondaryButton } from "./styles.js";
import type { EnvFilesClient } from "./types.js";

export interface DownloadEnvModalProps {
  client: EnvFilesClient;
  source: string;
  /** The file's path, named in the generated header. */
  sourceName: string;
  environments: readonly string[];
  /** Preselected: the environment the panel is showing; null for shared only. */
  initialEnvironment: string | null;
  onClose: () => void;
}

const SHARED = "";

/**
 * Resolve one environment and save the result as `.env`. The values go
 * straight into the downloaded file and are never put on screen; only the
 * variables that did not resolve are listed.
 */
export function DownloadEnvModal({
  client,
  source,
  sourceName,
  environments,
  initialEnvironment,
  onClose,
}: DownloadEnvModalProps) {
  const gt = useGT();
  const [environment, setEnvironment] = useState(initialEnvironment ?? SHARED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    count: number;
    problems: readonly InfraenvProblem[];
  } | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await client.resolve({
        source,
        environment: environment === SHARED ? null : environment,
        sourceName,
      });
      downloadBlob(new Blob([res.dotenv], { type: "text/plain" }), ".env");
      setOutcome({ count: res.values.length, problems: res.problems });
      if (res.problems.length === 0) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to resolve the file"));
    } finally {
      setBusy(false);
    }
  }

  const heading = gt("Download .env");
  return (
    <Modal onClose={() => !busy && onClose()} ariaLabel={heading}>
      <div className={dialogClass}>
        <h2 className="text-sm font-semibold text-on-surface">{heading}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor="env-files-download-environment">
              {gt("Environment")}
            </label>
            <select
              id="env-files-download-environment"
              className={inputClass}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              <option value={SHARED}>{gt("Shared only")}</option>
              {environments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {outcome && outcome.problems.length > 0 && (
            <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="text-sm text-on-surface">
                {gt("Downloaded {count} variables. These were left out:", {
                  count: outcome.count,
                })}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-on-surface-secondary">
                {outcome.problems.map((p, i) => (
                  <li key={`${p.line}:${p.key ?? ""}:${i}`}>
                    {p.key ? <span className="font-mono">{p.key}</span> : null}
                    {p.key ? ": " : ""}
                    {p.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={onClose} disabled={busy}>
              {outcome ? gt("Close") : gt("Cancel")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => void download()}
            >
              {busy ? gt("Resolving…") : gt("Download")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
