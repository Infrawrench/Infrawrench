import { useEffect, useRef, useState } from "react";
import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import { FieldRenderer, type ResourcePickerCallbacks } from "./create-resource/FieldRenderer.js";
import { buildDefaultFields, evaluateShowWhen } from "../utils.js";
import { Modal } from "./Modal.js";

export interface PromptNoSqlCommandModalProps {
  title: string;
  /** Optional descriptive text shown above the fields (e.g. destructive action warning). */
  description?: string;
  /** Field definitions — same shape as the standard create modal. */
  fields: CreateFieldConfig[];
  /** Submit button label. Defaults to "Submit". */
  submitLabel?: string;
  /** Render the submit button in a danger (red) style — use for destructive actions. */
  danger?: boolean;
  /** Required if any field is `kind: "resource-picker"`. Same shape as create modal. */
  resourcePickerProps?: ResourcePickerCallbacks;
  /** Called with the form values keyed by `field.key`. */
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Modal that renders a `CreateFieldConfig[]` form — the same component the
 * standard create-resource modal uses. Replaces `window.prompt` and
 * `window.confirm` for plugin-action commands: one modal per action, no
 * stacked native dialogs.
 *
 * Intentionally does NOT wrap the fields in a `<form>` element — several of
 * the create-resource pickers use plain `<button>` elements that would
 * otherwise default to `type="submit"` and trigger premature submission when
 * selecting an option.
 */
export function PromptNoSqlCommandModal({
  title,
  description,
  fields,
  submitLabel = "Submit",
  danger = false,
  resourcePickerProps,
  onSubmit,
  onCancel,
}: PromptNoSqlCommandModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => buildDefaultFields(fields));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = cardRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    );
    first?.focus();
    first?.select?.();
  }, []);

  // Fields that render in the form. Hidden fields still participate in the
  // submit payload — they're typically context values (resource name to
  // delete, etc.) pre-filled by the plugin.
  const visibleFields = fields.filter((f) => evaluateShowWhen(f, values) && !f.hidden);
  const submittedFields = fields.filter((f) => evaluateShowWhen(f, values));
  // Mirror CreateResourceModal: if any visible field is a code editor, switch
  // to a split-pane layout (form on the left, code editor(s) on the right at
  // full pane height). Otherwise the code field's edge-to-edge `h-full`
  // styling collapses inside the regular max-w-xl modal.
  const codeFields = visibleFields.filter((f) => f.kind === "code");
  const regularFields = visibleFields.filter((f) => f.kind !== "code");
  const splitPane = codeFields.length > 0;

  async function handleSubmit() {
    setError(null);

    for (const f of visibleFields) {
      if (f.required && !(values[f.key] ?? "").trim()) {
        setError(`${f.label} is required`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload: Record<string, string> = {};
      for (const f of submittedFields) payload[f.key] = values[f.key] ?? "";
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setSubmitting(false);
    }
  }

  const submitClasses = danger
    ? "px-3 py-1.5 rounded bg-red-600 text-xs text-white hover:bg-red-500 transition-colors disabled:opacity-50"
    : "px-3 py-1.5 rounded bg-blue-600 text-xs text-white hover:bg-blue-500 transition-colors disabled:opacity-50";

  return (
    <Modal onClose={onCancel}>
      <div
        ref={cardRef}
        className={`bg-surface border border-border-strong rounded-lg shadow-xl flex flex-col ${
          splitPane ? "w-[1100px] h-[80vh]" : "max-w-xl w-full max-h-[90vh]"
        }`}
      >
        <div
          className={`px-5 py-4 flex-shrink-0 ${visibleFields.length > 0 ? "border-b border-border/60" : ""}`}
        >
          <h2 className="text-sm font-semibold text-on-surface">{title}</h2>
          {description && <p className="text-xs text-on-surface-muted mt-1.5">{description}</p>}
        </div>
        {splitPane ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="w-[440px] flex-shrink-0 overflow-y-auto px-5 py-4 border-r border-border space-y-4">
              {regularFields.map((f) => (
                <FieldRenderer
                  key={f.key}
                  field={f}
                  value={values[f.key] ?? ""}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                  {...(resourcePickerProps ? { resourcePickerProps } : {})}
                />
              ))}
              {error && <div className="text-xs text-red-400">{error}</div>}
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              {codeFields.map((f) => (
                <div key={f.key} className="flex-1 min-h-0">
                  <FieldRenderer
                    field={f}
                    value={values[f.key] ?? ""}
                    onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                    {...(resourcePickerProps ? { resourcePickerProps } : {})}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          (visibleFields.length > 0 || error) && (
            <div className="px-5 py-4 space-y-4 overflow-y-auto">
              {visibleFields.map((f) => (
                <FieldRenderer
                  key={f.key}
                  field={f}
                  value={values[f.key] ?? ""}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                  {...(resourcePickerProps ? { resourcePickerProps } : {})}
                />
              ))}
              {error && <div className="text-xs text-red-400">{error}</div>}
            </div>
          )
        )}
        <div className="px-5 py-3 border-t border-border/60 flex justify-end gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 rounded text-xs text-on-surface-secondary hover:bg-surface-overlay transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className={submitClasses}
          >
            {submitting ? "Working…" : submitLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
