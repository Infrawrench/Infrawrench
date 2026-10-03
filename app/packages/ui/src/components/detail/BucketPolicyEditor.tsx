import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";

const Editor = lazy(() => import("@monaco-editor/react"));
import type { BucketPolicyEditorCapability } from "@infrawrench/plugin-base";
import {
  type BucketPolicyDoc,
  type BucketPolicyStatement,
  type PolicyTemplate,
  blankStatement,
  lintPolicy,
  parsePolicy,
  serializePolicy,
  summarizeStatement,
} from "../../bucket-policy.js";

import { TemplatePickerModal } from "./BucketPolicyTemplatePicker.js";
import { StatementCard, SummaryText } from "./BucketPolicyStatementCard.js";

interface Props {
  capability: BucketPolicyEditorCapability;
  onGetManifest: () => Promise<string>;
  onApplyManifest?: ((manifest: string) => Promise<void>) | undefined;
}

type Mode = "visual" | "json";

export function BucketPolicyEditor({ capability, onGetManifest, onApplyManifest }: Props) {
  const gt = useGT();
  const [doc, setDoc] = useState<BucketPolicyDoc>({ Version: "2012-10-17", Statement: [] });
  const [mode, setMode] = useState<Mode>("visual");
  const [jsonText, setJsonText] = useState<string>("");
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<{
    template: PolicyTemplate;
    inputs: Record<string, string>;
  } | null>(null);
  const originalRef = useRef<string>("");

  const dirty = useMemo(() => serializePolicy(doc).trim() !== originalRef.current.trim(), [doc]);

  const lint = useMemo(
    () => (capability.bucketArn ? lintPolicy(doc, capability.bucketArn) : []),
    [doc, capability.bucketArn],
  );
  const lintErrors = lint.filter((f) => f.severity === "error");

  const fetchPolicy = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const raw = await onGetManifest();
      originalRef.current = raw;
      const parsed = parsePolicy(raw);
      setDoc(parsed.doc);
      setJsonText(raw || pretty(parsed.doc));
      setJsonParseError(parsed.parseError ?? null);
    } catch (e) {
      setLoadError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [onGetManifest]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  // Keep the JSON view in sync when the visual editor mutates the doc, but
  // only when the user isn't actively typing in the JSON pane.
  useEffect(() => {
    if (mode === "visual") setJsonText(serializePolicy(doc) || pretty(doc));
  }, [doc, mode]);

  function switchToJson() {
    setJsonText(serializePolicy(doc) || pretty(doc));
    setJsonParseError(null);
    setMode("json");
  }

  function switchToVisual() {
    const parsed = parsePolicy(jsonText);
    if (parsed.parseError) {
      setJsonParseError(parsed.parseError);
      return;
    }
    setDoc(parsed.doc);
    setMode("visual");
  }

  function updateStatement(idx: number, next: BucketPolicyStatement) {
    setDoc((d) => {
      const stmts = d.Statement.slice();
      stmts[idx] = next;
      return { ...d, Statement: stmts };
    });
  }

  function deleteStatement(idx: number) {
    setDoc((d) => ({ ...d, Statement: d.Statement.filter((_, i) => i !== idx) }));
    setExpandedIdx(null);
  }

  function moveStatement(idx: number, direction: -1 | 1) {
    setDoc((d) => {
      const stmts = d.Statement.slice();
      const target = idx + direction;
      if (target < 0 || target >= stmts.length) return d;
      const [moved] = stmts.splice(idx, 1);
      stmts.splice(target, 0, moved!);
      return { ...d, Statement: stmts };
    });
  }

  function addBlankStatement() {
    setDoc((d) => ({
      ...d,
      Statement: [...d.Statement, blankStatement(capability.bucketArn)],
    }));
    setExpandedIdx(doc.Statement.length);
  }

  function applyTemplate(template: PolicyTemplate, inputs: Record<string, string>) {
    const ctx = {
      bucketArn: capability.bucketArn,
      bucketName: capability.bucketName,
      vendor: capability.vendor,
    };
    const stmts = template.buildWithInputs
      ? template.buildWithInputs(ctx, inputs)
      : template.build(ctx);
    setDoc((d) => ({ ...d, Statement: [...d.Statement, ...stmts] }));
    setTemplatePickerOpen(false);
    setPendingTemplate(null);
    setExpandedIdx(doc.Statement.length + stmts.length - 1);
  }

  async function handleApply() {
    if (!onApplyManifest) return;
    setApplyError(null);
    setApplySuccess(false);

    let payload: string;
    if (mode === "json") {
      const parsed = parsePolicy(jsonText);
      if (parsed.parseError) {
        setJsonParseError(parsed.parseError);
        setApplyError(gt("JSON has parse errors — fix them before applying."));
        return;
      }
      payload = serializePolicy(parsed.doc);
    } else {
      payload = serializePolicy(doc);
    }
    if (lintErrors.length > 0) {
      setApplyError(
        gt("Fix {count} validation error(s) before applying.", { count: lintErrors.length }),
      );
      return;
    }

    setApplying(true);
    try {
      await onApplyManifest(payload);
      originalRef.current = payload;
      setApplySuccess(true);
      setTimeout(() => setApplySuccess(false), 3000);
    } catch (e) {
      setApplyError(formatError(e));
    } finally {
      setApplying(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
        {gt("Loading bucket policy…")}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="text-danger text-sm font-mono whitespace-pre-wrap max-w-lg">
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => void fetchPolicy()}
          className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
        >
          {gt("Retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {gt("Bucket Policy")}
        </span>
        <span
          className="text-xs text-on-surface-faint font-mono ml-2 truncate"
          title={capability.bucketArn}
        >
          {capability.bucketArn}
        </span>

        <div className="flex items-center ml-3 rounded border border-border-strong overflow-hidden">
          <button
            type="button"
            onClick={() => (mode === "json" ? switchToVisual() : undefined)}
            className={`px-2 py-1 text-xs ${
              mode === "visual"
                ? "bg-accent-muted text-accent-on-muted"
                : "text-on-surface-tertiary hover:text-on-surface-secondary"
            }`}
          >
            {gt("Visual")}
          </button>
          <button
            type="button"
            onClick={() => (mode === "visual" ? switchToJson() : undefined)}
            className={`px-2 py-1 text-xs ${
              mode === "json"
                ? "bg-accent-muted text-accent-on-muted"
                : "text-on-surface-tertiary hover:text-on-surface-secondary"
            }`}
          >
            JSON
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-warning">{gt("Unsaved changes")}</span>}
          {applySuccess && <span className="text-xs text-success">{gt("Applied")}</span>}
          {applyError && (
            <span className="text-xs text-danger max-w-xs truncate" title={applyError}>
              {applyError}
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchPolicy()}
            disabled={applying}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded transition-colors disabled:opacity-50"
          >
            {gt("Reload")}
          </button>
          {onApplyManifest && (
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={applying || !dirty || lintErrors.length > 0}
              className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors whitespace-nowrap"
            >
              {applying ? gt("Applying…") : gt("Apply")}
            </button>
          )}
        </div>
      </div>

      {/* Lint banner */}
      {lint.length > 0 && (
        <div className="border-b border-border bg-surface-overlay px-3 py-1.5 shrink-0">
          <ul className="text-xs space-y-0.5">
            {lint.map((f, i) => (
              <li
                key={i}
                className={
                  f.severity === "error"
                    ? "text-danger"
                    : f.severity === "warning"
                      ? "text-warning"
                      : "text-on-surface-tertiary"
                }
              >
                <span className="font-mono mr-1">
                  {f.statementIndex >= 0 ? `[#${f.statementIndex + 1}]` : "[policy]"}
                </span>
                {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Main body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {mode === "visual" ? (
          <>
            <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-2">
              {doc.Statement.length === 0 && (
                <T>
                  <div className="text-on-surface-faint text-sm border border-dashed border-border rounded-lg p-6 text-center">
                    No statements yet. Click <strong>+ Add statement</strong> or pick a template.
                  </div>
                </T>
              )}
              {doc.Statement.map((stmt, i) => (
                <StatementCard
                  key={i}
                  index={i}
                  total={doc.Statement.length}
                  statement={stmt}
                  bucketName={capability.bucketName}
                  bucketArn={capability.bucketArn}
                  expanded={expandedIdx === i}
                  onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
                  onChange={(next) => updateStatement(i, next)}
                  onDelete={() => deleteStatement(i)}
                  onMoveUp={() => moveStatement(i, -1)}
                  onMoveDown={() => moveStatement(i, 1)}
                />
              ))}

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={addBlankStatement}
                  className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded transition-colors"
                >
                  {gt("+ Add statement")}
                </button>
                <button
                  type="button"
                  onClick={() => setTemplatePickerOpen(true)}
                  className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded transition-colors"
                >
                  {gt("+ From template…")}
                </button>
              </div>
            </div>

            {/* Summary side panel */}
            <div className="w-80 border-l border-border bg-surface flex flex-col overflow-hidden shrink-0">
              <div className="px-3 py-2 border-b border-border text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
                {gt("Plain English")}
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
                {doc.Statement.length === 0 ? (
                  <div className="text-on-surface-faint italic">
                    {gt("No effect: no policy is set.")}
                  </div>
                ) : (
                  doc.Statement.map((stmt, i) => (
                    <div
                      key={i}
                      className="border border-border/60 rounded p-2 bg-surface-overlay/40"
                    >
                      <T>
                        <div className="text-on-surface-faint text-[10px] font-mono mb-1">
                          Statement #<Var>{i + 1}</Var>
                          <Var>{stmt.Sid ? ` · ${stmt.Sid}` : null}</Var>
                        </div>
                      </T>
                      <SummaryText
                        text={summarizeStatement(stmt, capability.bucketName)}
                        denyish={stmt.Effect === "Deny"}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {jsonParseError && (
              <T>
                <div className="px-3 py-1.5 text-xs text-danger border-b border-border bg-red-500/10">
                  JSON parse error: <Var>{jsonParseError}</Var>
                </div>
              </T>
            )}
            <Editor
              defaultLanguage="json"
              value={jsonText}
              theme="vs-dark"
              onChange={(value) => {
                const text = value ?? "";
                setJsonText(text);
                const parsed = parsePolicy(text);
                setJsonParseError(parsed.parseError ?? null);
                if (!parsed.parseError) setDoc(parsed.doc);
              }}
              options={{
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
          </div>
        )}
      </div>

      {/* Template picker modal */}
      {templatePickerOpen && (
        <TemplatePickerModal
          vendor={capability.vendor}
          pending={pendingTemplate}
          onPendingChange={setPendingTemplate}
          onClose={() => {
            setTemplatePickerOpen(false);
            setPendingTemplate(null);
          }}
          onApply={(t, inputs) => applyTemplate(t, inputs)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc helpers                                                               */
/* -------------------------------------------------------------------------- */

function pretty(doc: BucketPolicyDoc): string {
  return JSON.stringify(doc, null, 2);
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
