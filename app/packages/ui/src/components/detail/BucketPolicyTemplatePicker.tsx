import { useId } from "react";
import { useGT } from "gt-react";
import type { BucketPolicyEditorCapability } from "@infrawrench/plugin-base";
import { useDataString } from "../../i18n/data-strings.js";

import { type PolicyTemplate, templatesForVendor } from "../../bucket-policy.js";
import { Modal } from "../Modal.js";

/* -------------------------------------------------------------------------- */
/* Template picker                                                            */
/* -------------------------------------------------------------------------- */

export function TemplatePickerModal({
  vendor,
  pending,
  onPendingChange,
  onClose,
  onApply,
}: {
  vendor: BucketPolicyEditorCapability["vendor"];
  pending: { template: PolicyTemplate; inputs: Record<string, string> } | null;
  onPendingChange: (
    next: { template: PolicyTemplate; inputs: Record<string, string> } | null,
  ) => void;
  onClose: () => void;
  onApply: (t: PolicyTemplate, inputs: Record<string, string>) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const templates = templatesForVendor(vendor);
  const fieldIdPrefix = useId();

  return (
    <Modal onClose={onClose} ariaLabel={gt("Choose a policy template")}>
      <div className="bg-surface border border-border rounded-lg shadow-2xl w-[42rem] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <h2 className="text-sm font-semibold">{gt("Choose a template")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={gt("Close")}
            className="text-on-surface-faint hover:text-on-surface-secondary text-sm"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {!pending ? (
          <ul className="flex-1 overflow-y-auto divide-y divide-border/40">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="w-full px-4 py-3 text-left hover:bg-surface-overlay/40 cursor-pointer"
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
                  <span className="block text-sm font-medium text-on-surface-secondary">
                    {gtData(t.label)}
                  </span>
                  <span className="block text-xs text-on-surface-faint mt-1">
                    {gtData(t.description)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <div className="text-sm font-medium text-on-surface-secondary">
                {gtData(pending.template.label)}
              </div>
              <div className="text-xs text-on-surface-faint mt-1">
                {gtData(pending.template.description)}
              </div>
            </div>
            {pending.template.inputs?.map((field) => (
              <div key={field.key} className="space-y-1">
                <label
                  htmlFor={`${fieldIdPrefix}-${field.key}`}
                  className="text-xs text-on-surface-tertiary"
                >
                  {gtData(field.label)}
                </label>
                <input
                  id={`${fieldIdPrefix}-${field.key}`}
                  value={pending.inputs[field.key] ?? ""}
                  onChange={(e) =>
                    onPendingChange({
                      ...pending,
                      inputs: { ...pending.inputs, [field.key]: e.target.value },
                    })
                  }
                  placeholder={field.placeholder ? gtData(field.placeholder) : field.placeholder}
                  aria-label={gtData(field.label)}
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
                {gt("Back")}
              </button>
              <button
                type="button"
                onClick={() => onApply(pending.template, pending.inputs)}
                className="px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                {gt("Add statement")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
