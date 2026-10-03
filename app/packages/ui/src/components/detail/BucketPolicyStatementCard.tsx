import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";

import {
  type BucketPolicyStatement,
  type PolicyPrincipal,
  editableToPrincipal,
  normalizeStringList,
  principalToEditable,
  S3_ACTION_CATALOG,
  summarizeStatement,
} from "../../bucket-policy.js";

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

export function StatementCard({
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
  const gt = useGT();
  const effectColor =
    statement.Effect === "Deny" ? "text-danger bg-red-500/10" : "text-success bg-green-500/10";

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface">
      <div className="relative flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-overlay/40">
        {/* Full-row toggle target. The action buttons are positioned (relative)
            so they paint above this overlay and stay independently clickable. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? gt("Collapse statement {number}", { number: index + 1 })
              : gt("Expand statement {number}", { number: index + 1 })
          }
          className="absolute inset-0 cursor-pointer"
        />
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
            className="relative text-on-surface-faint hover:text-on-surface-secondary disabled:opacity-30 px-1 text-xs"
            title={gt("Move up")}
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
            className="relative text-on-surface-faint hover:text-on-surface-secondary disabled:opacity-30 px-1 text-xs"
            title={gt("Move down")}
          >
            ↓
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="relative text-on-surface-faint hover:text-danger px-1 text-xs"
            title={gt("Delete")}
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
  const gt = useGT();
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
      <Row label={gt("Sid (optional)")}>
        <input
          value={statement.Sid ?? ""}
          onChange={(e) => patch("Sid", e.target.value || undefined)}
          // i18n-ignore: example IAM statement id
          placeholder="MyStatement"
          aria-label={gt("Statement ID (Sid)")}
          className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
        />
      </Row>

      <Row label={gt("Effect")}>
        <div className="flex items-center rounded border border-border-strong overflow-hidden w-fit">
          {(["Allow", "Deny"] as const).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => patch("Effect", e)}
              className={`px-2 py-1 ${
                statement.Effect === e
                  ? e === "Deny"
                    ? "bg-red-500/20 text-danger"
                    : "bg-green-500/20 text-success"
                  : "text-on-surface-tertiary hover:text-on-surface-secondary"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      </Row>

      <Row label={gt("Principal")}>
        <div className="space-y-1.5">
          <select
            value={editablePrincipal.mode}
            onChange={(e) =>
              setPrincipal(
                e.target.value as typeof editablePrincipal.mode,
                editablePrincipal.values,
              )
            }
            aria-label={gt("Principal type")}
            className="bg-surface border border-border-strong rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
          >
            <option value="everyone">{gt("Everyone (*)")}</option>
            <option value="aws">{gt("Specific AWS principal(s)")}</option>
            <option value="service">{gt("AWS service principal(s)")}</option>
            <option value="federated">{gt("Federated identity provider(s)")}</option>
            <option value="canonical">{gt("Canonical user ID(s)")}</option>
          </select>
          {editablePrincipal.mode !== "everyone" && (
            <textarea
              value={editablePrincipal.values}
              onChange={(e) => setPrincipal(editablePrincipal.mode, e.target.value)}
              aria-label={gt("Principal ARNs")}
              placeholder={
                editablePrincipal.mode === "aws"
                  ? "arn:aws:iam::123456789012:root\narn:aws:iam::123456789012:role/MyRole"
                  : gt("one ARN per line")
              }
              rows={3}
              className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
            />
          )}
        </div>
      </Row>

      <Row label={gt("Action")}>
        <ActionPicker
          values={actions}
          onChange={(arr) => patch("Action", arr.length === 1 ? arr[0]! : arr)}
        />
      </Row>

      <Row label={gt("Resource")}>
        <ResourceEditor
          values={resources}
          bucketArn={bucketArn}
          onChange={(arr) => patch("Resource", arr.length === 1 ? arr[0]! : arr)}
        />
      </Row>

      <Row label={gt("Condition")}>
        <ConditionEditor
          condition={statement.Condition}
          onChange={(cond) => patch("Condition", cond)}
        />
      </Row>
    </div>
  );
}

// The caption is a <span>, not a <label>: rows hold composite widgets (button
// groups, pickers, multiple inputs), so each control carries its own aria-label.
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
      <span className="text-on-surface-tertiary text-xs pt-1.5">{label}</span>
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
  const gt = useGT();
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
              className="text-on-surface-faint hover:text-danger"
              title={gt("Remove")}
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
          // i18n-ignore: IAM action syntax example
          placeholder="s3:GetObject…"
          aria-label={gt("Add an action")}
          className="w-full bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
        />
        {open && suggestions.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 top-full mt-0.5 bg-surface border border-border-strong rounded shadow-lg max-h-56 overflow-y-auto">
            {suggestions.map((s) => (
              <li
                key={s.id}
                role="option"
                aria-selected={false}
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
  const gt = useGT();
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
              ? "bg-blue-500/20 border-blue-500/50 text-info"
              : "border-border-strong text-on-surface-tertiary hover:text-white"
          }`}
        >
          <T>
            Bucket (`<Var>{bucketArn.split(":::").pop()}</Var>`)
          </T>
        </button>
        <button
          type="button"
          onClick={() => toggle(objectArn)}
          className={`text-xs px-2 py-0.5 rounded border ${
            values.includes(objectArn)
              ? "bg-blue-500/20 border-blue-500/50 text-info"
              : "border-border-strong text-on-surface-tertiary hover:text-white"
          }`}
        >
          {gt("All objects (`/*`)")}
        </button>
      </div>
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={v}
            onChange={(e) => updateAt(i, e.target.value)}
            placeholder={`${bucketArn}/some/prefix/*`}
            aria-label={gt("Resource ARN")}
            className="flex-1 bg-surface border border-border-strong rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            className="text-on-surface-faint hover:text-danger text-xs px-1"
            title={gt("Remove")}
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
        {gt("+ Add resource ARN")}
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
    const vals = r.value.split(",").flatMap((s) => {
      const trimmed = s.trim();
      return trimmed ? [trimmed] : [];
    });
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
  condition?: Record<string, Record<string, string | string[]>> | undefined;
  onChange: (cond?: Record<string, Record<string, string | string[]>>) => void;
}) {
  const gt = useGT();
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
        <div className="text-on-surface-faint italic text-xs">{gt("No conditions.")}</div>
      )}
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[140px_1fr_1fr_auto] gap-1 items-center">
          <select
            value={row.op}
            onChange={(e) => update(i, { op: e.target.value })}
            aria-label={gt("Condition operator")}
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
            // i18n-ignore: IAM condition key example
            placeholder="aws:SecureTransport"
            aria-label={gt("Condition key")}
            className="bg-surface border border-border-strong rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
          />
          <input
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={gt("false  (comma-separated for multiple values)")}
            aria-label={gt("Condition value")}
            className="bg-surface border border-border-strong rounded px-1.5 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-on-surface-faint hover:text-danger text-xs px-1"
            title={gt("Remove")}
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
        {gt("+ Add condition")}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary text renderer with **bold** support                                */
/* -------------------------------------------------------------------------- */

export function SummaryText({ text, denyish }: { text: string; denyish: boolean }) {
  // Cheap inline markdown: split on `**...**` and render bold chunks.
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <p className={denyish ? "text-danger" : "text-on-surface-secondary"}>
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
