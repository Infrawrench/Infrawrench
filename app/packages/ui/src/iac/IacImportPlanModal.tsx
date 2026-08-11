import { useEffect, useState } from "react";
import { Modal } from "../components/Modal.js";
import { formatErrorMessage } from "../utils.js";
import type { IacImportPlanResponse } from "./types.js";

export interface IacImportPlanModalProps {
  /** How many resources the plan was asked for, for the header line. */
  requestedCount: number;
  generate: () => Promise<IacImportPlanResponse>;
  onClose: () => void;
  filename?: string;
  /** Host download handler; defaults to the browser anchor-click. */
  onDownload?: (file: { filename: string; mimeType: string; content: string }) => void;
}

/**
 * The payoff of IaC reconciliation: Terraform `import` blocks plus the
 * matching resource stanzas for resources somebody made by hand.
 *
 * Deliberately a sibling of `TerraformExportModal` rather than a variant of
 * it — that modal exports one resource or one account's inventory, this one
 * adopts a selection into an existing configuration, and the copy differs
 * because the next action differs (`terraform plan` here, not `terraform
 * import` by hand).
 */
export function IacImportPlanModal({
  requestedCount,
  generate,
  onClose,
  filename = "imports.tf",
  onDownload,
}: IacImportPlanModalProps) {
  const [result, setResult] = useState<IacImportPlanResponse | null>(null);
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
    if (!result?.hcl) return;
    try {
      await navigator.clipboard.writeText(result.hcl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  function download() {
    if (!result?.hcl) return;
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
    <Modal onClose={onClose} ariaLabel="Terraform import blocks">
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[min(860px,92vw)] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-on-surface">Adopt into Terraform</h2>
            <p className="text-xs text-on-surface-faint mt-0.5">
              {requestedCount} unmanaged resource{requestedCount === 1 ? "" : "s"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-secondary text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-100 dark:bg-red-900/20 border border-red-500/30 px-3 py-2 text-xs text-red-700 dark:text-red-200 leading-relaxed break-words">
              {error}
            </div>
          )}
          {!result && !error && <p className="text-xs text-on-surface-faint">Generating…</p>}

          {result && result.unsupported.length > 0 && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2.5">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-200">
                {result.unsupported.length} resource
                {result.unsupported.length === 1 ? " has" : "s have"} no Terraform mapping yet and{" "}
                {result.unsupported.length === 1 ? "was" : "were"} left out:
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {result.unsupported.map((u) => (
                  <li
                    key={u.resourceId}
                    className="text-[11px] text-amber-700/90 dark:text-amber-200/90"
                  >
                    <span className="font-mono">{u.displayName}</span>{" "}
                    <span className="text-amber-700/60 dark:text-amber-200/60">— {u.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result &&
            (hasHcl ? (
              <>
                <p className="text-xs text-on-surface-faint">
                  {result.exported.length} resource{result.exported.length === 1 ? "" : "s"}. Put
                  this in your Terraform configuration and run <code>terraform plan</code>: the{" "}
                  <code>import</code> blocks adopt the live resources on the next apply, with no{" "}
                  <code>terraform import</code> commands to run by hand. Secrets are referenced as{" "}
                  <code>var.*</code> input variables and are never inlined.
                </p>
                <pre className="max-h-[45vh] overflow-auto text-[11px] font-mono bg-surface-sunken border border-border-strong rounded-lg p-3 text-on-surface-secondary whitespace-pre">
                  {result.hcl}
                </pre>
              </>
            ) : (
              <p className="text-xs text-on-surface-faint">
                Nothing to adopt — none of the selected resources have a Terraform mapping yet.
              </p>
            ))}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!hasHcl}
            className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken disabled:opacity-50 rounded-lg transition-colors"
          >
            {copied ? "Copied" : "Copy HCL"}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!hasHcl}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
          >
            Download {filename}
          </button>
        </div>
      </div>
    </Modal>
  );
}
