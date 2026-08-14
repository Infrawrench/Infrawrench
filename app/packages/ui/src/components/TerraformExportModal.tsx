import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import type { TerraformExportOutcome } from "@infrawrench/plugin-base";
import { Modal } from "./Modal.js";
import { formatErrorMessage } from "../utils.js";

export interface TerraformExportModalProps {
  /** What is being exported — resource or account display name. */
  subjectDisplayName: string;
  /** Fetch the generated Terraform export from the host. Called on open. */
  generate: () => Promise<TerraformExportOutcome>;
  onClose: () => void;
  /** Suggested download filename. Defaults to "main.tf". */
  filename?: string;
  /**
   * Optional host-provided download handler. Defaults to the browser's
   * anchor-click pattern — supply on desktop to use a native save dialog.
   */
  onDownload?: (file: { filename: string; mimeType: string; content: string }) => void;
}

/**
 * Shows generated Terraform HCL for a resource or an account inventory in a
 * copyable/downloadable view, and clearly lists resources that have no
 * Terraform mapping yet.
 */
export function TerraformExportModal({
  subjectDisplayName,
  generate,
  onClose,
  filename = "main.tf",
  onDownload,
}: TerraformExportModalProps) {
  const gt = useGT();
  const [result, setResult] = useState<TerraformExportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    generate()
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(formatErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on open
  }, []);

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.hcl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  function download() {
    if (!result) return;
    if (onDownload) {
      onDownload({ filename, mimeType: "text/plain", content: result.hcl });
      return;
    }
    const blob = new Blob([result.hcl], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const hasHcl = !!result && result.hcl.length > 0;

  return (
    <Modal onClose={onClose} ariaLabel={gt("Export to Terraform")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[min(860px,92vw)] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-on-surface">{gt("Export to Terraform")}</h2>
            <p className="text-xs text-on-surface-faint mt-0.5 truncate max-w-[640px]">
              {subjectDisplayName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-secondary text-xl leading-none"
            aria-label={gt("Close")}
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-100 dark:bg-red-900/20 border border-red-500/30 px-3 py-2 text-xs text-danger leading-relaxed break-words">
              {error}
            </div>
          )}
          {!result && !error && (
            <p className="text-xs text-on-surface-faint">{gt("Generating…")}</p>
          )}

          {result && (
            <>
              {result.unsupported.length > 0 && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2.5">
                  <p className="text-xs font-medium text-warning">
                    {gt("{count} resource", { count: result.unsupported.length })}
                    {result.unsupported.length === 1 ? gt(" has") : gt("s have")}{" "}
                    {gt("no Terraform mapping yet and")}{" "}
                    {result.unsupported.length === 1 ? gt("was") : gt("were")} {gt("left out:")}
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {result.unsupported.map((u) => (
                      <li key={u.id} className="text-[11px] text-warning/90">
                        <span className="font-mono">{u.displayName}</span>{" "}
                        <span className="text-warning/60">
                          ({u.pluginId}/{u.resourceTypeId}) — {u.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {hasHcl ? (
                <>
                  <p className="text-xs text-on-surface-faint">
                    <T>
                      <Var>{result.exported.length}</Var> resource
                      <Var>{result.exported.length === 1 ? "" : "s"}</Var> exported. Secrets are
                      referenced as <code>var.*</code> input variables — fill them in locally (e.g.
                      via a <code>terraform.tfvars</code> you keep out of git), then use the{" "}
                      <code>terraform import</code> hints to adopt the live resources into state.
                    </T>
                  </p>
                  <pre className="max-h-[45vh] overflow-auto text-[11px] font-mono bg-surface-sunken border border-border-strong rounded-lg p-3 text-on-surface-secondary whitespace-pre">
                    {result.hcl}
                  </pre>
                </>
              ) : (
                <p className="text-xs text-on-surface-faint">
                  {gt("Nothing to export — none of these resources have a Terraform mapping yet.")}
                </p>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
          >
            {gt("Close")}
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!hasHcl}
            className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken disabled:opacity-50 rounded-lg transition-colors"
          >
            {copied ? gt("Copied") : gt("Copy HCL")}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!hasHcl}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
          >
            {gt("Download {filename}", { filename })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
