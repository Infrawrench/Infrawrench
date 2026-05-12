import type { ReactNode } from "react";
import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import type { CreateResourceFormState } from "../hooks/useCreateResourceForm.js";
import { Modal } from "./Modal.js";
import { ErrorNotice } from "./ErrorNotice.js";

export interface CreateResourceModalProps {
  displayName: string;
  form: CreateResourceFormState;
  onClose: () => void;
  renderField: (
    field: CreateFieldConfig,
    value: string,
    onChange: (v: string) => void,
  ) => ReactNode;
  renderError?: (
    message: string,
    props?: { className?: string; textClassName?: string },
  ) => ReactNode;
}

export function CreateResourceModal({
  displayName,
  form,
  onClose,
  renderField,
  renderError,
}: CreateResourceModalProps) {
  const errorEl = (message: string, props?: { className?: string; textClassName?: string }) =>
    renderError ? renderError(message, props) : <ErrorNotice message={message} {...props} />;

  // If any visible field is a code editor, switch to split-pane: form on the
  // left, code editor(s) on the right at full pane height.
  const codeFields = form.visibleFields.filter((f) => f.kind === "code");
  const regularFields = form.visibleFields.filter((f) => f.kind !== "code");
  const splitPane = codeFields.length > 0;

  return (
    <Modal onClose={onClose}>
      <div
        className={`bg-surface-raised border border-border-strong rounded-xl shadow-2xl flex flex-col ${
          splitPane ? "w-[1100px] h-[80vh]" : "w-[560px] max-h-[72vh]"
        }`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-on-surface">Create {displayName}</h2>
          <div className="flex items-center gap-3">
            {form.estimatedMonthlyPriceLabel && (
              <div className="text-right px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <p className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300/80">
                  Estimated cost
                </p>
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-200">
                  {form.estimatedMonthlyPriceLabel}/mo
                </p>
              </div>
            )}
            <button
              onClick={onClose}
              className="text-on-surface-faint hover:text-on-surface-secondary text-xl leading-none"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
        </div>

        {splitPane ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="w-[440px] flex-shrink-0 overflow-y-auto px-6 py-5 border-r border-border">
              {form.loadingConfig ? (
                <div className="flex items-center gap-3 text-sm text-on-surface-muted py-8 justify-center">
                  <span
                    aria-hidden="true"
                    className="animate-spin inline-block w-4 h-4 rounded-full border-2 border-border-strong border-t-gray-300"
                  />
                  Fetching available options...
                </div>
              ) : form.configError ? (
                errorEl(form.configError, { textClassName: "text-sm text-red-400" })
              ) : form.configWithPricing ? (
                <div className="space-y-6">
                  {regularFields.map((f) =>
                    renderField(f, form.fields[f.key] ?? "", (v) => form.setField(f.key, v)),
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              {codeFields.map((f) => (
                <div key={f.key} className="flex-1 min-h-0">
                  {renderField(f, form.fields[f.key] ?? "", (v) => form.setField(f.key, v))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="overflow-y-auto flex-1 px-6 py-5">
            {form.loadingConfig ? (
              <div className="flex items-center gap-3 text-sm text-on-surface-muted py-8 justify-center">
                <span className="animate-spin inline-block w-4 h-4 rounded-full border-2 border-border-strong border-t-gray-300" />
                Fetching available options...
              </div>
            ) : form.configError ? (
              errorEl(form.configError, { textClassName: "text-sm text-red-400" })
            ) : form.configWithPricing ? (
              <div className="space-y-6">
                {regularFields.map((f) =>
                  renderField(f, form.fields[f.key] ?? "", (v) => form.setField(f.key, v)),
                )}
              </div>
            ) : null}
          </div>
        )}

        <div className="px-6 py-4 border-t border-border flex-shrink-0">
          {form.error &&
            errorEl(form.error, {
              className:
                "mb-3 rounded bg-red-100 dark:bg-red-900/20 px-3 py-2 max-h-40 overflow-y-auto",
              textClassName: "text-xs text-red-500 dark:text-red-300 leading-relaxed break-words",
            })}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void form.handleCreate()}
              disabled={form.creating || form.loadingConfig || !!form.configError || !form.isValid}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {form.creating ? "Creating..." : `Create ${displayName}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
