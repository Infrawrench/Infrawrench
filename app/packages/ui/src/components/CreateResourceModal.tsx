import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import type { RequiredTag } from "@infrawrench/client-core";
import type { CreateResourceFormState } from "../hooks/useCreateResourceForm.js";
import { Modal } from "./Modal.js";
import { CostEstimateChip } from "./CostEstimateChip.js";
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
  /**
   * The org tag policy's required tags, when the host knows them. If the
   * plugin's create form declares a `tags`/`labels` field, the modal shows a
   * policy notice and pre-fills the field with `key=` stubs so the required
   * keys are in front of the user. The server is the real gate — it rejects
   * non-compliant creates with a 422 when enforcement is on.
   */
  requiredTags?: RequiredTag[] | undefined;
}

/** The generic tag-field convention, same as the server's enforcement. */
function isTagField(field: CreateFieldConfig): boolean {
  const key = field.key.toLowerCase();
  return key === "tags" || key === "labels";
}

export function CreateResourceModal({
  displayName,
  form,
  onClose,
  renderField,
  renderError,
  requiredTags,
}: CreateResourceModalProps) {
  const tagField = useMemo(
    () => (requiredTags?.length ? form.visibleFields.find(isTagField) : undefined),
    [form.visibleFields, requiredTags],
  );

  // Pre-fill an empty comma-list tag field with `key=` stubs. Only for the
  // kinds whose value is a comma-separated list — a structured editor
  // (key-value-list) keeps its own shape and just gets the notice.
  const { setField } = form;
  const tagFieldKey =
    tagField && (tagField.kind === "string-list" || tagField.kind === "text") ? tagField.key : null;
  const currentTagValue = tagFieldKey ? (form.fields[tagFieldKey] ?? "") : "";
  useEffect(() => {
    if (!tagFieldKey || !requiredTags?.length) return;
    if (currentTagValue.trim() !== "") return;
    setField(tagFieldKey, requiredTags.map((t) => `${t.key}=`).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagFieldKey]);
  const errorEl = (message: string, props?: { className?: string; textClassName?: string }) =>
    renderError ? renderError(message, props) : <ErrorNotice message={message} {...props} />;

  // If any visible field is a code editor, switch to split-pane: form on the
  // left, code editor(s) on the right at full pane height.
  const codeFields = form.visibleFields.filter((f) => f.kind === "code");
  const regularFields = form.visibleFields.filter((f) => f.kind !== "code");
  const splitPane = codeFields.length > 0;

  return (
    <Modal onClose={onClose} ariaLabel={`Create ${displayName}`}>
      <div
        className={`bg-surface-raised border border-border-strong rounded-xl shadow-2xl flex flex-col ${
          splitPane ? "w-[1100px] h-[80vh]" : "w-[560px] max-h-[72vh]"
        }`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-on-surface">Create {displayName}</h2>
          <div className="flex items-center gap-3">
            {form.estimatedMonthlyPriceLabel && (
              <CostEstimateChip
                label={form.estimatedMonthlyPriceLabel}
                estimate={form.costEstimate}
              />
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-on-surface-faint hover:text-on-surface-secondary text-xl leading-none"
              aria-label="Close"
            >
              &times;
            </button>
          </div>
        </div>

        {tagField && requiredTags && requiredTags.length > 0 && !form.loadingConfig && (
          <div className="px-6 pt-3 flex-shrink-0">
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Org policy requires tags:{" "}
              {requiredTags
                .map((t) =>
                  t.allowedValues?.length ? `${t.key} (${t.allowedValues.join(" | ")})` : t.key,
                )
                .join(", ")}
            </p>
          </div>
        )}

        {splitPane ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="w-[440px] flex-shrink-0 overflow-y-auto px-6 py-5 border-r border-border">
              {form.loadingConfig ? (
                <div className="flex items-center gap-3 text-sm text-on-surface-muted py-8 justify-center">
                  <span
                    aria-hidden="true"
                    className="animate-spin inline-block size-4 rounded-full border-2 border-border-strong border-t-gray-300"
                  />
                  Fetching available options…
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
                <span
                  aria-hidden="true"
                  className="animate-spin inline-block size-4 rounded-full border-2 border-border-strong border-t-gray-300"
                />
                Fetching available options…
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
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary bg-surface-overlay hover:bg-surface-sunken rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
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
