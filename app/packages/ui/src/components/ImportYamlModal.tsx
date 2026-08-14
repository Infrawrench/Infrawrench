import { useRef, useState } from "react";
import { T, useGT } from "gt-react";
import { formatErrorMessage } from "../utils.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { Modal } from "./Modal.js";

export interface ImportYamlModalProps {
  title?: string;
  onClose: () => void;
  onSubmit: (yaml: string) => Promise<{ applied: number }>;
  onApplied?: () => void;
}

export function ImportYamlModal({ title, onClose, onSubmit, onApplied }: ImportYamlModalProps) {
  const gt = useGT();
  const [yamlText, setYamlText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setYamlText(await file.text());
  }

  async function handleApply() {
    if (!yamlText.trim()) {
      setError(gt("YAML is empty"));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await onSubmit(yamlText);
      setResult(r);
      onApplied?.();
    } catch (err) {
      setError(formatErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      onClose={() => {
        if (!busy) onClose();
      }}
      ariaLabel={title ?? gt("Import YAML")}
    >
      <div className="w-[min(900px,92vw)] h-[min(700px,85vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-on-surface">{title ?? gt("Import YAML")}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={gt("Close")}
            className="text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-50 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <input
            ref={fileInputRef}
            type="file"
            aria-label={gt("Load YAML file")}
            accept=".yaml,.yml,text/yaml,application/x-yaml"
            className="hidden"
            onChange={handleFilePick}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-2.5 py-1 rounded-lg border border-border-strong bg-surface-overlay text-xs text-on-surface-secondary hover:bg-surface-sunken transition-colors"
          >
            {gt("Load from file")}
          </button>
          <T>
            <p className="text-xs text-on-surface-muted">
              Multi-document YAML supported (separate with <code>---</code>).
            </p>
          </T>
        </div>

        <textarea
          aria-label={gt("YAML content")}
          value={yamlText}
          onChange={(e) => setYamlText(e.target.value)}
          disabled={busy}
          placeholder={`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n  namespace: default\ndata:\n  key: value`}
          className="flex-1 min-h-0 w-full resize-none bg-surface-sunken text-on-surface font-mono text-xs px-4 py-3 outline-none focus:bg-surface disabled:opacity-50"
          spellCheck={false}
        />

        {(error || result) && (
          <div className="px-4 py-2 border-t border-border space-y-2">
            {error && <ErrorNotice message={error} />}
            {result && (
              <p className="text-xs text-success">
                {gt("Applied {count} document{plural}.", {
                  count: result.applied,
                  plural: result.applied === 1 ? "" : "s",
                })}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-border-strong bg-surface-overlay text-sm text-on-surface-secondary hover:bg-surface-sunken disabled:opacity-50 transition-colors"
          >
            {result ? gt("Close") : gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={busy || !yamlText.trim()}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-surface-overlay disabled:text-on-surface-tertiary text-sm font-medium text-white transition-colors"
          >
            {busy ? gt("Applying…") : gt("Apply")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
