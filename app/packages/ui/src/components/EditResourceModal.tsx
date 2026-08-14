import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { CostEstimate, FieldDefinition } from "@infrawrench/plugin-base";
import { costEstimateDelta, isFieldEditable } from "@infrawrench/plugin-base";
import { describeMonthlyDelta } from "@infrawrench/client-core";
import { Modal } from "./Modal.js";
import { CostEstimateBreakdown } from "./CostEstimateChip.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { useDataString } from "../i18n/data-strings.js";

export interface EditResourceModalProps {
  /** Title shown in the modal header — typically the resource type display name (e.g. "Project"). */
  displayName: string;
  /**
   * Field schema for the resource. Fields with `editable === false` are omitted;
   * `secret`/`association` kinds are also omitted because the inline edit form
   * doesn't have the wiring to manage external references.
   */
  fields: FieldDefinition[];
  /** Current field values, keyed by field key. Used to seed the form. */
  initialValues: Record<string, string>;
  /**
   * Submit handler. Receives only the keys that changed from `initialValues`.
   * Throw to surface an error message in the modal; return normally on success.
   */
  onSubmit: (changedFields: Record<string, string>) => Promise<void>;
  onClose: () => void;
  /**
   * Price a proposed set of field values. Receives only the changed keys —
   * the host merges them over the resource's stored fields — and is called on
   * a debounce, so a host that goes over the network makes one request per
   * pause rather than one per keystroke.
   *
   * When supplied, the modal shows what the pending change does to the
   * monthly bill before the user commits to it. Omit it and the modal behaves
   * exactly as it did before.
   */
  loadCostEstimate?: (changedFields: Record<string, string>) => Promise<CostEstimate | null>;
}

/**
 * How long the form must be still before the modal prices it. Long enough
 * that typing through a numeric field doesn't fire a request per digit, short
 * enough that the figure feels like it belongs to what is on screen.
 */
const ESTIMATE_DEBOUNCE_MS = 300;

export function EditResourceModal({
  displayName,
  fields,
  initialValues,
  onSubmit,
  onClose,
  loadCostEstimate,
}: EditResourceModalProps) {
  const gt = useGT();
  const editableFields = useMemo(() => fields.filter(isFieldEditable), [fields]);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of editableFields) seed[f.key] = initialValues[f.key] ?? "";
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = useMemo(() => {
    const diff: Record<string, string> = {};
    for (const f of editableFields) {
      const next = values[f.key] ?? "";
      const prev = initialValues[f.key] ?? "";
      if (next !== prev) diff[f.key] = next;
    }
    return diff;
  }, [editableFields, initialValues, values]);

  const isValid = useMemo(() => {
    for (const f of editableFields) {
      if (f.required && !(values[f.key] ?? "").trim()) return false;
    }
    return true;
  }, [editableFields, values]);

  const hasChanges = Object.keys(changed).length > 0;

  const setField = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  // What the resource costs now, and what it would cost after the pending
  // change. Both come from the same `estimateCost` call the create form uses,
  // so the number quoted here and the one quoted on the resource's detail
  // page cannot disagree.
  const [baseline, setBaseline] = useState<CostEstimate | null>(null);
  const [projected, setProjected] = useState<CostEstimate | null>(null);

  useEffect(() => {
    if (!loadCostEstimate) return;
    let cancelled = false;
    void loadCostEstimate({})
      .then((estimate) => {
        if (!cancelled) setBaseline(estimate);
      })
      .catch(() => {
        if (!cancelled) setBaseline(null);
      });
    return () => {
      cancelled = true;
    };
  }, [loadCostEstimate]);

  // `changed` is a fresh object on every render, so the effect keys off its
  // serialization rather than its identity — otherwise every keystroke's
  // re-render would restart the debounce even when nothing actually changed.
  const changedKey = JSON.stringify(changed);
  useEffect(() => {
    if (!loadCostEstimate) return;
    if (!hasChanges) {
      setProjected(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadCostEstimate(JSON.parse(changedKey) as Record<string, string>)
        .then((estimate) => {
          if (!cancelled) setProjected(estimate);
        })
        .catch(() => {
          if (!cancelled) setProjected(null);
        });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [changedKey, hasChanges, loadCostEstimate]);

  const deltaLabel = useMemo(
    () => describeMonthlyDelta(costEstimateDelta(baseline, projected), projected?.currency),
    [baseline, projected],
  );

  const handleSubmit = useCallback(async () => {
    if (!hasChanges || !isValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(changed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save"));
    } finally {
      setSaving(false);
    }
  }, [changed, hasChanges, isValid, onClose, onSubmit, saving]);

  return (
    <Modal onClose={onClose} ariaLabel={gt("Edit {name}", { name: displayName })}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl flex flex-col w-[520px] max-h-[72vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-on-surface">
            {gt("Edit {name}", { name: displayName })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-secondary text-xl leading-none"
            aria-label={gt("Close")}
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {editableFields.length === 0 ? (
            <p className="text-sm text-on-surface-muted">
              {gt("This resource has no editable fields.")}
            </p>
          ) : (
            editableFields.map((field) => (
              <EditField
                key={field.key}
                field={field}
                value={values[field.key] ?? ""}
                onChange={(v) => setField(field.key, v)}
              />
            ))
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex-shrink-0">
          {deltaLabel && projected && (
            <details className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-success">
                {deltaLabel}
              </summary>
              <div className="mt-2 border-t border-emerald-500/20 pt-2 text-xs">
                <CostEstimateBreakdown estimate={projected} />
              </div>
            </details>
          )}
          {error && (
            <ErrorNotice
              message={error}
              className="mb-3 rounded bg-red-100 dark:bg-red-900/20 px-3 py-2 max-h-40 overflow-y-auto"
              textClassName="text-xs text-danger leading-relaxed break-words"
            />
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={saving || !hasChanges || !isValid}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {saving ? gt("Saving...") : gt("Save changes")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

interface EditFieldProps {
  field: FieldDefinition;
  value: string;
  onChange: (v: string) => void;
}

function EditField({ field, value, onChange }: EditFieldProps) {
  const gt = useGT();
  const gtData = useDataString();
  const inputId = useId();
  const labelEl = (
    <label htmlFor={inputId} className="block text-xs font-medium text-on-surface-secondary mb-1.5">
      {gtData(field.label)}
      {field.required && <span className="text-danger ml-0.5">*</span>}
    </label>
  );
  const descriptionEl = field.description ? (
    <p className="mt-1 text-xs text-on-surface-faint">{gtData(field.description)}</p>
  ) : null;

  const inputClass =
    "w-full px-3 py-2 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500";

  if (field.kind === "boolean") {
    const checked = value === "true";
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
            aria-label={gtData(field.label)}
          />
          <span>{gtData(field.label)}</span>
        </label>
        {descriptionEl}
      </div>
    );
  }

  if (field.kind === "enum" && field.enumValues) {
    return (
      <div>
        {labelEl}
        <select
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          {!field.required && <option value="">{gt("(none)")}</option>}
          {field.enumValues.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {descriptionEl}
      </div>
    );
  }

  if (field.kind === "number") {
    return (
      <div>
        {labelEl}
        <input
          id={inputId}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          aria-label={gtData(field.label)}
        />
        {descriptionEl}
      </div>
    );
  }

  if (field.kind === "password") {
    return (
      <div>
        {labelEl}
        <input
          id={inputId}
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          aria-label={gtData(field.label)}
          autoComplete="new-password"
          placeholder={gt("Leave blank to keep current")}
        />
        {descriptionEl}
      </div>
    );
  }

  // string (and any future fall-through kinds the modal can handle as text)
  return (
    <div>
      {labelEl}
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
        aria-label={gtData(field.label)}
      />
      {descriptionEl}
    </div>
  );
}
