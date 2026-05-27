import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { BucketPolicyEditorCapability } from "@infrawrench/plugin-base";
import {
  type BucketPolicyDoc,
  type BucketPolicyStatement,
  type LintFinding,
  type PolicyPrincipal,
  type PolicyTemplate,
  blankStatement,
  editableToPrincipal,
  lintPolicy,
  normalizeStringList,
  parsePolicy,
  principalToEditable,
  S3_ACTION_CATALOG,
  serializePolicy,
  summarizeStatement,
  templatesForVendor,
} from "../../bucket-policy.js";

interface Props {
  capability: BucketPolicyEditorCapability;
  onGetManifest: () => Promise<string>;
  onApplyManifest?: (manifest: string) => Promise<void>;
}

type Mode = "visual" | "json";

export function BucketPolicyEditor({ capability, onGetManifest, onApplyManifest }: Props) {
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
        setApplyError("JSON has parse errors — fix them before applying.");
        return;
      }
      payload = serializePolicy(parsed.doc);
    } else {
      payload = serializePolicy(doc);
    }
    if (lintErrors.length > 0) {
      setApplyError(`Fix ${lintErrors.length} validation error(s) before applying.`);
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
        Loading bucket policy…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="text-red-400 text-sm font-mono whitespace-pre-wrap max-w-lg">
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => void fetchPolicy()}
          className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          Bucket Policy
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
            Visual
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
          {dirty && <span className="text-xs text-yellow-500">Unsaved changes</span>}
          {applySuccess && <span className="text-xs text-green-400">Applied</span>}
          {applyError && (
            <span className="text-xs text-red-400 max-w-xs truncate" title={applyError}>
              {applyError}
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchPolicy()}
            disabled={applying}
            className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded transition-colors disabled:opacity-50"
          >
            Reload
          </button>
          {onApplyManifest && (
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={applying || !dirty || lintErrors.length > 0}
              className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors whitespace-nowrap"
            >
              {applying ? "Applying…" : "Apply"}
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
                    ? "text-red-400"
                    : f.severity === "warning"
                      ? "text-yellow-400"
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
                <div className="text-on-surface-faint text-sm border border-dashed border-border rounded-lg p-6 text-center">
                  No statements yet. Click <strong>+ Add statement</strong> or pick a template.
                </div>
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
                  + Add statement
                </button>
                <button
                  type="button"
                  onClick={() => setTemplatePickerOpen(true)}
                  className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded transition-colors"
                >
                  + From template…
                </button>
              </div>
            </div>

            {/* Summary side panel */}
            <div className="w-80 border-l border-border bg-surface flex flex-col overflow-hidden shrink-0">
              <div className="px-3 py-2 border-b border-border text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
                Plain English
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
                {doc.Statement.length === 0 ? (
                  <div className="text-on-surface-faint italic">No effect: no policy is set.</div>
                ) : (
                  doc.Statement.map((stmt, i) => (
                    <div
                      key={i}
                      className="border border-border/60 rounded p-2 bg-surface-overlay/40"
                    >
                      <div className="text-on-surface-faint text-[10px] font-mono mb-1">
                        Statement #{i + 1}
                        {stmt.Sid ? ` · ${stmt.Sid}` : ""}
                      </div>
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
              <div className="px-3 py-1.5 text-xs text-red-400 border-b border-border bg-red-500/10">
                JSON parse error: {jsonParseError}
              </div>
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
/* Statement card                                                             */
/* -------------------------------------------------------------------------- */

interface StatementCardProps {
  index: number;
  total: number;
  statement: BucketPolicyStatement;
  bucketName: string;
  bucketArn: string;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: BucketPolicyStatement) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function StatementCard({
  index,
  total,
  statement,
  bucketName,
  bucketArn,
  expanded,
  onToggle,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
}: StatementCardProps) {
  const effectColor =
    statement.Effect === "Deny" ? "text-red-400 bg-red-500/10" : "text-green-400 bg-green-500/10";

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-overlay/40"
        onClick={onToggle}
      >
        <span className="text-on-surface-faint text-xs font-mono">#{index + 1}</span>
        <span
          className={`px-1.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${effectColor}`}
        >
          {statement.Effect}
        </span>
        {statement.Sid && (
          <span className="text-on-surface-secondary text-xs font-mono">{statement.Sid}</span>
        )}
        <span className="text-on-surface-tertiary text-xs truncate flex-1">
          {summarizeStatement(statement, bucketName)}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
            disabled={index === 0}
            className="text-on-surface-faint hover:text-on-surface-secondary disabled:opacity-30 px-1 text-xs"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
            disabled={index === total - 1}
            className="text-on-surface-faint hover:text-on-surface-secondary disabled:opacity-30 px-1 text-xs"
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-on-surface-faint hover:text-red-400 px-1 text-xs"
            title="Delete"
          >
            ✕
          </button>
          <span className="text-on-surface-faint text-xs">{expanded ? "▾" : "▸"}</span>
        </span>
      </div>

      {expanded && (
        <StatementForm statement={statement} bucketArn={bucketArn} onChange={onChange} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Statement form                                                             */
/* -------------------------------------------------------------------------- */

interface StatementFormProps {
  statement: BucketPolicyStatement;
  bucketArn: string;
  onChange: (next: BucketPolicyStatement) => void;
}

function StatementForm({ statement, bucketArn, onChange }: StatementFormProps) {
  const editablePrincipal = principalToEditable(statement.Principal);
  const actions = normalizeStringList(statement.Action);
  const resources = normalizeStringList(statement.Resource);

  function patch<K extends keyof BucketPolicyStatement>(key: K, value: BucketPolicyStatement[K]) {
    onChange({ ...statement, [key]: value });
  }

  function setPrincipal(mode: typeof editablePrincipal.mode, values: string) {
    const p = editableToPrincipal(mode, values) as PolicyPrincipal;
    onChange({ ...statement, Principal: p });
  }

  return (
    <div className="border-t border-border bg-surface-overlay/30 p-3 space-y-3 text-xs">
      <Row label="Sid (optional)">
        <input
          value={statement.Sid ?? ""}
          onChange={(e) => patch("Sid", e.target.value || undefined)}
          placeholder="MyStatement"
          aria-label="Statement ID (Sid)"
          className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
        />
      </Row>

      <Row label="Effect">
        <div className="flex items-center rounded border border-border-strong overflow-hidden w-fit">
          {(["Allow", "Deny"] as const).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => patch("Effect", e)}
              className={`px-2 py-1 ${
                statement.Effect === e
                  ? e === "Deny"
                    ? "bg-red-500/20 text-red-300"
                    : "bg-green-500/20 text-green-300"
                  : "text-on-surface-tertiary hover:text-on-surface-secondary"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Principal">
        <div className="space-y-1.5">
          <select
            value={editablePrincipal.mode}
            onChange={(e) =>
              setPrincipal(
                e.target.value as typeof editablePrincipal.mode,
                editablePrincipal.values,
              )
            }
            className="bg-surface border border-border-strong rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
          >
            <option value="everyone">Everyone (*)</option>
            <option value="aws">Specific AWS principal(s)</option>
            <option value="service">AWS service principal(s)</option>
            <option value="federated">Federated identity provider(s)</option>
            <option value="canonical">Canonical user ID(s)</option>
          </select>
          {editablePrincipal.mode !== "everyone" && (
            <textarea
              value={editablePrincipal.values}
              onChange={(e) => setPrincipal(editablePrincipal.mode, e.target.value)}
              aria-label="Principal ARNs"
              placeholder={
                editablePrincipal.mode === "aws"
                  ? "arn:aws:iam::123456789012:root\narn:aws:iam::123456789012:role/MyRole"
                  : "one ARN per line"
              }
              rows={3}
              className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
            />
          )}
        </div>
      </Row>

      <Row label="Action">
        <ActionPicker
          values={actions}
          onChange={(arr) => patch("Action", arr.length === 1 ? arr[0]! : arr)}
        />
      </Row>

      <Row label="Resource">
        <ResourceEditor
          values={resources}
          bucketArn={bucketArn}
          onChange={(arr) => patch("Resource", arr.length === 1 ? arr[0]! : arr)}
        />
      </Row>

      <Row label="Condition">
        <ConditionEditor
          condition={statement.Condition}
          onChange={(cond) => patch("Condition", cond)}
        />
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
      <label className="text-on-surface-tertiary text-xs pt-1.5">{label}</label>
      <div>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Action picker with autocomplete                                            */
/* -------------------------------------------------------------------------- */

function ActionPicker({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q) return S3_ACTION_CATALOG.slice(0, 8);
    return S3_ACTION_CATALOG.filter((a) => a.id.toLowerCase().includes(q)).slice(0, 10);
  }, [input]);

  function add(action: string) {
    if (!action.trim() || values.includes(action)) {
      setInput("");
      return;
    }
    onChange([...values, action.trim()]);
    setInput("");
  }

  function remove(action: string) {
    onChange(values.filter((a) => a !== action));
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {values.map((a) => (
          <span
            key={a}
            className="inline-flex items-center gap-1 bg-surface border border-border-strong rounded px-1.5 py-0.5 text-xs font-mono"
          >
            {a}
            <button
              type="button"
              onClick={() => remove(a)}
              className="text-on-surface-faint hover:text-red-400"
              title="Remove"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              e.preventDefault();
              add(input.trim());
            }
          }}
          placeholder="s3:GetObject…"
          aria-label="Add an action"
          className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
        />
        {open && suggestions.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 top-full mt-0.5 bg-surface border border-border-strong rounded shadow-lg max-h-56 overflow-y-auto">
            {suggestions.map((s) => (
              <li
                key={s.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(s.id);
                }}
                className="px-2 py-1 cursor-pointer hover:bg-surface-overlay flex items-center gap-2"
              >
                <span className="font-mono text-xs">{s.id}</span>
                <span className="text-on-surface-faint text-[10px]">{s.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Resource editor                                                            */
/* -------------------------------------------------------------------------- */

function ResourceEditor({
  values,
  bucketArn,
  onChange,
}: {
  values: string[];
  bucketArn: string;
  onChange: (next: string[]) => void;
}) {
  function toggle(arn: string) {
    if (values.includes(arn)) onChange(values.filter((v) => v !== arn));
    else onChange([...values, arn]);
  }

  function updateAt(idx: number, value: string) {
    const next = values.slice();
    next[idx] = value;
    onChange(next);
  }

  function removeAt(idx: number) {
    onChange(values.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...values, ""]);
  }

  const objectArn = `${bucketArn}/*`;

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => toggle(bucketArn)}
          className={`text-xs px-2 py-0.5 rounded border ${
            values.includes(bucketArn)
              ? "bg-blue-500/20 border-blue-500/50 text-blue-300"
              : "border-border-strong text-on-surface-tertiary hover:text-white"
          }`}
        >
          Bucket (`{bucketArn.split(":::").pop()}`)
        </button>
        <button
          type="button"
          onClick={() => toggle(objectArn)}
          className={`text-xs px-2 py-0.5 rounded border ${
            values.includes(objectArn)
              ? "bg-blue-500/20 border-blue-500/50 text-blue-300"
              : "border-border-strong text-on-surface-tertiary hover:text-white"
          }`}
        >
          All objects (`/*`)
        </button>
      </div>
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={v}
            onChange={(e) => updateAt(i, e.target.value)}
            placeholder={`${bucketArn}/some/prefix/*`}
            aria-label="Resource ARN"
            className="flex-1 bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            className="text-on-surface-faint hover:text-red-400 text-xs px-1"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
      >
        + Add resource ARN
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Condition editor                                                           */
/* -------------------------------------------------------------------------- */

interface ConditionRow {
  op: string;
  key: string;
  value: string;
}

function flattenCondition(
  cond?: Record<string, Record<string, string | string[]>>,
): ConditionRow[] {
  if (!cond) return [];
  const rows: ConditionRow[] = [];
  for (const [op, kvs] of Object.entries(cond)) {
    for (const [key, value] of Object.entries(kvs)) {
      rows.push({
        op,
        key,
        value: Array.isArray(value) ? value.join(",") : value,
      });
    }
  }
  return rows;
}

function rebuildCondition(
  rows: ConditionRow[],
): Record<string, Record<string, string | string[]>> | undefined {
  if (rows.length === 0) return undefined;
  const out: Record<string, Record<string, string | string[]>> = {};
  for (const r of rows) {
    if (!r.op || !r.key) continue;
    if (!out[r.op]) out[r.op] = {};
    const vals = r.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out[r.op]![r.key] = vals.length <= 1 ? (vals[0] ?? "") : vals;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const CONDITION_OPS = [
  "StringEquals",
  "StringNotEquals",
  "StringLike",
  "StringNotLike",
  "NumericEquals",
  "NumericLessThan",
  "DateGreaterThan",
  "Bool",
  "IpAddress",
  "NotIpAddress",
  "ArnEquals",
  "ArnLike",
];

function ConditionEditor({
  condition,
  onChange,
}: {
  condition?: Record<string, Record<string, string | string[]>>;
  onChange: (cond?: Record<string, Record<string, string | string[]>>) => void;
}) {
  const rows = flattenCondition(condition);

  function update(idx: number, patch: Partial<ConditionRow>) {
    const next = rows.slice();
    next[idx] = { ...next[idx]!, ...patch };
    onChange(rebuildCondition(next));
  }

  function remove(idx: number) {
    onChange(rebuildCondition(rows.filter((_, i) => i !== idx)));
  }

  function add() {
    onChange(rebuildCondition([...rows, { op: "StringEquals", key: "", value: "" }]));
  }

  return (
    <div className="space-y-1">
      {rows.length === 0 && (
        <div className="text-on-surface-faint italic text-xs">No conditions.</div>
      )}
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[140px_1fr_1fr_auto] gap-1 items-center">
          <select
            value={row.op}
            onChange={(e) => update(i, { op: e.target.value })}
            className="bg-surface border border-border-strong rounded px-1.5 py-1 text-xs focus:outline-none focus:border-blue-500"
          >
            {CONDITION_OPS.includes(row.op) ? null : <option value={row.op}>{row.op}</option>}
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="aws:SecureTransport"
            aria-label="Condition key"
            className="bg-surface border border-border-strong rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
          />
          <input
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="false  (comma-separated for multiple values)"
            aria-label="Condition value"
            className="bg-surface border border-border-strong rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-on-surface-faint hover:text-red-400 text-xs px-1"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
      >
        + Add condition
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Template picker                                                            */
/* -------------------------------------------------------------------------- */

function TemplatePickerModal({
  vendor,
  pending,
  onPendingChange,
  onClose,
  onApply,
}: {
  vendor: "aws-s3" | "do-spaces" | "scaleway-os";
  pending: { template: PolicyTemplate; inputs: Record<string, string> } | null;
  onPendingChange: (
    next: { template: PolicyTemplate; inputs: Record<string, string> } | null,
  ) => void;
  onClose: () => void;
  onApply: (t: PolicyTemplate, inputs: Record<string, string>) => void;
}) {
  const templates = templatesForVendor(vendor);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <h2 className="text-sm font-semibold">Choose a template</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-secondary text-sm"
          >
            ✕
          </button>
        </div>

        {!pending ? (
          <ul className="flex-1 overflow-y-auto divide-y divide-border/40">
            {templates.map((t) => (
              <li
                key={t.id}
                className="px-4 py-3 hover:bg-surface-overlay/40 cursor-pointer"
                onClick={() => {
                  if (t.inputs && t.inputs.length > 0) {
                    onPendingChange({
                      template: t,
                      inputs: Object.fromEntries(t.inputs.map((i) => [i.key, ""])),
                    });
                  } else {
                    onApply(t, {});
                  }
                }}
              >
                <div className="text-sm font-medium text-on-surface-secondary">{t.label}</div>
                <div className="text-xs text-on-surface-faint mt-1">{t.description}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <div className="text-sm font-medium text-on-surface-secondary">
                {pending.template.label}
              </div>
              <div className="text-xs text-on-surface-faint mt-1">
                {pending.template.description}
              </div>
            </div>
            {pending.template.inputs?.map((field) => (
              <div key={field.key} className="space-y-1">
                <label className="text-xs text-on-surface-tertiary">{field.label}</label>
                <input
                  value={pending.inputs[field.key] ?? ""}
                  onChange={(e) =>
                    onPendingChange({
                      ...pending,
                      inputs: { ...pending.inputs, [field.key]: e.target.value },
                    })
                  }
                  placeholder={field.placeholder}
                  aria-label={field.label}
                  className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => onPendingChange(null)}
                className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => onApply(pending.template, pending.inputs)}
                className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                Add statement
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary text renderer with **bold** support                                */
/* -------------------------------------------------------------------------- */

function SummaryText({ text, denyish }: { text: string; denyish: boolean }) {
  // Cheap inline markdown: split on `**...**` and render bold chunks.
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <p className={denyish ? "text-red-300" : "text-on-surface-secondary"}>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-mono">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </p>
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
