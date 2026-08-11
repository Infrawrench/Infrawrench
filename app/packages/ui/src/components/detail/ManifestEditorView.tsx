import { useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import type { OnMount } from "@monaco-editor/react";
import type { ManifestEditorCapability } from "@infrawrench/plugin-base";

// Monaco is heavy and browser-only; load it lazily so it splits out of the
// main bundle.
const Editor = lazy(() => import("@monaco-editor/react"));

interface Props {
  capability: ManifestEditorCapability;
  /** Fetch the manifest text from the plugin */
  onGetManifest: () => Promise<string>;
  /** Apply the updated manifest text via the plugin */
  onApplyManifest?: ((manifest: string) => Promise<void>) | undefined;
}

export function ManifestEditorView({ capability, onGetManifest, onApplyManifest }: Props) {
  const [manifest, setManifest] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editorValueRef = useRef<string>("");
  const originalRef = useRef<string>("");

  const fetchManifest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await onGetManifest();
      setManifest(text);
      editorValueRef.current = text;
      originalRef.current = text;
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [onGetManifest]);

  useEffect(() => {
    void fetchManifest();
  }, [fetchManifest]);

  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      // Cmd/Ctrl+S to apply
      editor.addAction({
        id: "apply-manifest",
        label: "Apply Manifest",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.KeyS
          2048 | 49, // CtrlCmd + S
        ],
        run: () => {
          if (!applying && !capability.readOnly && onApplyManifest) {
            void handleApply();
          }
        },
      });
    },
    [applying, capability.readOnly, onApplyManifest],
  );

  async function handleApply() {
    if (!onApplyManifest) return;
    const value = editorValueRef.current;
    setApplying(true);
    setApplyError(null);
    setApplySuccess(false);
    try {
      // Basic syntax validation before applying
      if (capability.language === "json") {
        JSON.parse(value);
      }
      // YAML validation is handled by the plugin's applyManifest()
      await onApplyManifest(value);
      setApplySuccess(true);
      originalRef.current = value;
      setDirty(false);
      setTimeout(() => setApplySuccess(false), 3000);
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  }

  const readOnly = capability.readOnly ?? !onApplyManifest;
  const kindLabel = capability.resourceKind ?? "Manifest";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        Loading {kindLabel.toLowerCase()} manifest…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="text-danger text-sm font-mono whitespace-pre-wrap max-w-lg">{error}</div>
        <button
          type="button"
          onClick={() => void fetchManifest()}
          className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {kindLabel}
        </span>
        {readOnly && (
          <span className="text-xs text-on-surface-faint bg-surface-overlay rounded px-1.5 py-0.5">
            Read-only
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty && !readOnly && <span className="text-xs text-warning">Unsaved changes</span>}
          {applySuccess && <span className="text-xs text-success">Applied</span>}
          {applyError && (
            <span className="text-xs text-danger max-w-xs truncate" title={applyError}>
              {applyError}
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchManifest()}
            disabled={applying}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors disabled:opacity-50"
          >
            Reload
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={applying || !dirty}
              className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-md transition-colors whitespace-nowrap"
            >
              {applying ? "Applying..." : "Apply  \u2318S"}
            </button>
          )}
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 min-h-0">
        <Suspense fallback={<p className="text-xs text-on-surface-faint p-3">Loading editor…</p>}>
          <Editor
            defaultLanguage={capability.language}
            defaultValue={manifest ?? ""}
            theme="vs-dark"
            onChange={(value) => {
              editorValueRef.current = value ?? "";
              setDirty(value !== originalRef.current);
              setApplyError(null);
            }}
            onMount={handleEditorMount}
            options={{
              readOnly,
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: "boundary",
              bracketPairColorization: { enabled: true },
              padding: { top: 8 },
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
