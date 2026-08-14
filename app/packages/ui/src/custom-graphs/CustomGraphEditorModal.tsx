import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";

import { Modal } from "../components/Modal.js";
import { WorkflowEditorView } from "../workflows/WorkflowEditorView.js";
import { CustomGraphChart } from "./CustomGraphChart.js";
import { CustomGraphControls, controlStateOf } from "./CustomGraphControls.js";
import type {
  CustomGraphControlState,
  CustomGraphDiagnostic,
  CustomGraphRenderResult,
  CustomGraphsClient,
} from "./types.js";

export interface CustomGraphEditorModalProps {
  client: CustomGraphsClient;
  graphId: string;
  onClose: () => void;
  /** Called after a successful save so open cards can re-render. */
  onSaved?: (() => void) | undefined;
}

/**
 * Script editor for a custom graph: Monaco with the ambient `graph.d.ts`, a
 * type-check-on-save gate (mirroring write_custom_graph), and a live preview
 * pane that runs the SAVED script — the preview is exactly what the dashboard
 * card will do, controls included.
 */
export function CustomGraphEditorModal({
  client,
  graphId,
  onClose,
  onSaved,
}: CustomGraphEditorModalProps) {
  const gt = useGT();
  const [name, setName] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [dts, setDts] = useState("");
  const [diagnostics, setDiagnostics] = useState<CustomGraphDiagnostic[] | null>(null);
  const [preview, setPreview] = useState<CustomGraphRenderResult | null>(null);
  const [previewState, setPreviewState] = useState<CustomGraphControlState | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.get(graphId), client.typings?.() ?? Promise.resolve("")])
      .then(([graph, typings]) => {
        if (cancelled) return;
        setName(graph.name);
        setSource(graph.source);
        setDts(typings);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, graphId]);

  const runPreview = useCallback(
    async (
      state?: CustomGraphControlState,
      button?: string,
      trigger: "manual" | "interaction" = "manual",
    ) => {
      setBusy(true);
      try {
        const result = await client.render(graphId, {
          ...(state ? { controls: state } : {}),
          ...(button ? { button } : {}),
          trigger,
        });
        setPreview(result);
        if (result.spec) setPreviewState(controlStateOf(result.spec.controls));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client, graphId],
  );

  async function save(): Promise<boolean> {
    if (!client.update || source === null) return false;
    setBusy(true);
    setError(null);
    setDiagnostics(null);
    try {
      // Same gate as write_custom_graph: refuse to save source with errors.
      if (client.check && source.trim()) {
        const check = await client.check(source);
        if (check.hasErrors) {
          setDiagnostics(check.diagnostics);
          return false;
        }
      }
      await client.update(graphId, { name: name.trim() || gt("Untitled graph"), source });
      setDirty(false);
      onSaved?.();
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndPreview() {
    if (await save()) await runPreview(previewState);
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Edit custom graph")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[min(96vw,1100px)] h-[min(90vh,720px)] flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            aria-label={gt("Graph name")}
            className="flex-1 bg-transparent text-base font-semibold text-on-surface focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void saveAndPreview()}
            disabled={busy || source === null || !client.update}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-sunken disabled:opacity-50"
          >
            {busy ? gt("Working…") : dirty ? gt("Save & preview") : gt("Preview")}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close editor")}
            className="size-7 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-sm"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col border-r border-border">
            {source === null ? (
              <div role="status" className="flex-1 p-4 text-sm text-on-surface-faint">
                {gt("Loading…")}
              </div>
            ) : (
              <WorkflowEditorView
                value={source}
                onChange={(v) => {
                  setSource(v);
                  setDirty(true);
                }}
                dts={dts}
                onSave={() => void saveAndPreview()}
              />
            )}
            {diagnostics && diagnostics.length > 0 && (
              <div
                role="alert"
                className="max-h-32 overflow-y-auto border-t border-border px-4 py-2 text-xs text-danger font-mono whitespace-pre-wrap"
              >
                {diagnostics
                  .map((d) => `${d.line}:${d.column} TS${d.code} ${d.message}`)
                  .join("\n")}
              </div>
            )}
          </div>

          <div className="w-[42%] min-w-[320px] flex flex-col">
            {error && (
              <p role="alert" className="px-4 pt-3 text-xs text-danger">
                {error}
              </p>
            )}
            {preview?.spec ? (
              <>
                <div className="px-5 pt-3 text-sm font-medium text-on-surface truncate">
                  {preview.spec.title ?? name}
                </div>
                <CustomGraphControls
                  controls={preview.spec.controls}
                  disabled={busy}
                  onChange={(state) => {
                    setPreviewState(state);
                    void runPreview(state, undefined, "interaction");
                  }}
                  onButton={(id) => void runPreview(previewState, id, "interaction")}
                />
                <div className="flex-1 min-h-0 px-2 pb-2 flex flex-col">
                  <CustomGraphChart spec={preview.spec.chart} />
                </div>
              </>
            ) : preview && !preview.ok ? (
              <div
                role="alert"
                className="flex-1 flex items-center justify-center text-sm text-danger px-6 text-center whitespace-pre-wrap"
              >
                {preview.error}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-on-surface-faint px-6 text-center">
                {busy
                  ? gt("Running…")
                  : gt("Save & preview runs the saved script and shows it here.")}
              </div>
            )}
            {preview && preview.logs.length > 0 && (
              <div className="max-h-28 overflow-y-auto border-t border-border px-4 py-2 text-[11px] font-mono">
                {preview.logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.level === "error"
                        ? "text-danger"
                        : l.level === "warn"
                          ? "text-warning"
                          : "text-on-surface-faint"
                    }
                  >
                    {l.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
