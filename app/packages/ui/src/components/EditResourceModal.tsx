import { useCallback, useMemo, useState } from "react";
import type { FieldDefinition } from "@infrawrench/plugin-base";
import { Modal } from "./Modal.js";
import { ErrorNotice } from "./ErrorNotice.js";

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
}

function isFieldEditable(field: FieldDefinition): boolean {
  if (field.editable === false) return false;
  if (field.kind === "secret" || field.kind === "association") return false;
  return true;
}

export function EditResourceModal({
  displayName,
  fields,
  initialValues,
  onSubmit,
  onClose,
}: EditResourceModalProps) {
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

  const handleSubmit = useCallback(async () => {
    if (!hasChanges || !isValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(changed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [changed, hasChanges, isValid, onClose, onSubmit, saving]);

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl flex flex-col w-[520px] max-h-[72vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-on-surface">Edit {displayName}</h2>
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
          {editableFields.length === 0 ? (
            <p className="text-sm text-on-surface-muted">This resource has no editable fields.</p>
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
          {error && (
            <ErrorNotice
              message={error}
              className="mb-3 rounded bg-red-100 dark:bg-red-900/20 px-3 py-2 max-h-40 overflow-y-auto"
              textClassName="text-xs text-red-500 dark:text-red-300 leading-relaxed break-words"
            />
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={saving || !hasChanges || !isValid}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {saving ? "Saving..." : "Save changes"}
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
  const labelEl = (
    <label className="block text-xs font-medium text-on-surface-secondary mb-1.5">
      {field.label}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
  const descriptionEl = field.description ? (
    <p className="mt-1 text-xs text-on-surface-faint">{field.description}</p>
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
            aria-label={field.label}
          />
          <span>{field.label}</span>
        </label>
        {descriptionEl}
      </div>
    );
  }

  if (field.kind === "enum" && field.enumValues) {
    return (
      <div>
        {labelEl}
        <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          {!field.required && <option value="">(none)</option>}
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
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          aria-label={field.label}
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
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
        aria-label={field.label}
      />
      {descriptionEl}
    </div>
  );
}
