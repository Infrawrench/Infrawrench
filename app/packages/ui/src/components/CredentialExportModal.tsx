import { useState, useMemo } from "react";
import type { CredentialExport, CredentialFormat } from "@infrawrench/plugin-base";
import { Modal } from "./Modal.js";
import { formatErrorMessage } from "../utils.js";

export interface CredentialExportModalProps {
  resourceDisplayName: string;
  formats: CredentialFormat[];
  /** Called when the user picks a format and clicks "Generate". */
  generate: (formatId: string) => Promise<CredentialExport>;
  onClose: () => void;
  /**
   * Optional host-provided download handler. Defaults to the browser's anchor-click pattern
   * — supply on desktop if you want to route the save through a native dialog.
   */
  onDownload?: (file: { filename: string; mimeType: string; content: string }) => void;
}

export function CredentialExportModal({
  resourceDisplayName,
  formats,
  generate,
  onClose,
  onDownload,
}: CredentialExportModalProps) {
  const [selectedFormatId, setSelectedFormatId] = useState<string>(formats[0]?.id ?? "");
  const [result, setResult] = useState<CredentialExport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | "all" | null>(null);

  const selectedFormat = useMemo(
    () => formats.find((f) => f.id === selectedFormatId) ?? formats[0],
    [formats, selectedFormatId],
  );

  async function handleGenerate() {
    if (!selectedFormat) return;
    setLoading(true);
    setError(null);
    try {
      const res = await generate(selectedFormat.id);
      setResult(res);
      const initial = new Set<number>();
      res.fields?.forEach((f, i) => {
        if (!f.sensitive) initial.add(i);
      });
      setRevealed(initial);
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  function toggleReveal(idx: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function copy(value: string, marker: number | "all") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(marker);
      setTimeout(() => setCopied((m) => (m === marker ? null : m)), 1500);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  function download() {
    if (!result) return;
    if (onDownload) {
      onDownload({
        filename: result.filename,
        mimeType: result.mimeType,
        content: result.content,
      });
      return;
    }
    // Browser fallback
    const isBase64 = selectedFormat?.mediaType === "binary-base64";
    let blob: Blob;
    if (isBase64) {
      const binary = atob(result.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: result.mimeType });
    } else {
      blob = new Blob([result.content], { type: result.mimeType });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-on-surface">Get credentials</h2>
            <p className="text-xs text-on-surface-faint mt-0.5 truncate max-w-[440px]">
              {resourceDisplayName}
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

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {!result && (
            <>
              {formats.length > 1 && (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-on-surface-tertiary">
                    Format
                  </label>
                  <div className="space-y-2">
                    {formats.map((f) => (
                      <label
                        key={f.id}
                        className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                          selectedFormatId === f.id
                            ? "border-blue-500 bg-accent-muted"
                            : "border-border-strong hover:border-border-strong/80 hover:bg-surface-overlay/50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="cred-format"
                          value={f.id}
                          checked={selectedFormatId === f.id}
                          onChange={() => setSelectedFormatId(f.id)}
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-on-surface">{f.label}</div>
                          {f.description && (
                            <div className="text-xs text-on-surface-faint mt-0.5">
                              {f.description}
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {formats.length === 1 && selectedFormat?.description && (
                <p className="text-xs text-on-surface-faint">{selectedFormat.description}</p>
              )}
              {error && (
                <div className="rounded-lg bg-red-100 dark:bg-red-900/20 border border-red-500/30 px-3 py-2 text-xs text-red-700 dark:text-red-200 leading-relaxed break-words">
                  {error}
                </div>
              )}
            </>
          )}

          {result && (
            <>
              {result.warning && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2 flex gap-2">
                  <span className="text-amber-500 font-bold leading-none mt-0.5">!</span>
                  <p className="text-xs text-amber-700 dark:text-amber-200 leading-relaxed">
                    {result.warning}
                  </p>
                </div>
              )}

              {result.fields && result.fields.length > 0 && (
                <div className="border border-border-strong rounded-lg divide-y divide-border-strong/40">
                  {result.fields.map((f, i) => {
                    const shown = revealed.has(i) || !f.sensitive;
                    return (
                      <div key={`${f.label}-${i}`} className="px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-on-surface-tertiary uppercase tracking-wide">
                            {f.label}
                          </span>
                          {f.hint && (
                            <span className="text-[10px] text-on-surface-faint">{f.hint}</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <code className="flex-1 text-xs font-mono text-on-surface-secondary break-all select-all">
                            {shown ? f.value : "•".repeat(Math.min(f.value.length, 32))}
                          </code>
                          {f.sensitive && (
                            <button
                              type="button"
                              onClick={() => toggleReveal(i)}
                              aria-label={`${revealed.has(i) ? "Hide" : "Reveal"} credential for ${f.label}`}
                              className="text-[10px] uppercase tracking-wide text-on-surface-faint hover:text-on-surface-secondary px-2 py-1 rounded hover:bg-surface-overlay flex-shrink-0"
                            >
                              {revealed.has(i) ? "Hide" : "Reveal"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => copy(f.value, i)}
                            aria-label={`Copy ${f.label}`}
                            className="text-[10px] uppercase tracking-wide text-on-surface-faint hover:text-on-surface-secondary px-2 py-1 rounded hover:bg-surface-overlay flex-shrink-0"
                          >
                            {copied === i ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedFormat?.mediaType !== "binary-base64" && (
                <details className="group">
                  <summary className="text-xs text-on-surface-faint hover:text-on-surface-tertiary cursor-pointer select-none">
                    Show full file
                  </summary>
                  <pre className="mt-2 max-h-60 overflow-auto text-[11px] font-mono bg-surface-sunken border border-border-strong rounded-lg p-3 text-on-surface-secondary whitespace-pre-wrap break-all">
                    {result.content}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-3">
          {!result ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={loading || !selectedFormat}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
              >
                {loading ? "Generating…" : "Generate"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void copy(result.content, "all")}
                className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
              >
                {copied === "all" ? "Copied" : "Copy file"}
              </button>
              <button
                type="button"
                onClick={download}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
              >
                Download {result.filename}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
