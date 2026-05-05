import { useState } from "react";
import type { ProviderResource, RerollSelection } from "./detail-types.js";
import { Modal } from "../Modal.js";
import { camelToTitle } from "@infrawrench/plugin-base";

interface AssociationPickerProps {
  fieldKey: string;
  providerResources: ProviderResource[];
  onConfirm: (selection: RerollSelection | { kind: "literal"; value: string }) => void;
  onCancel: () => void;
}

/**
 * Modal for reassigning ("rerolling") a secret/association field.
 *
 * Two modes:
 * 1. Pick a provider resource (output-ref)
 * 2. Paste a literal value
 */
export function AssociationPicker({
  fieldKey,
  providerResources,
  onConfirm,
  onCancel,
}: AssociationPickerProps) {
  const [mode, setMode] = useState<"provider" | "literal">("provider");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [literalValue, setLiteralValue] = useState("");

  const handleConfirm = () => {
    if (mode === "literal") {
      if (!literalValue.trim()) return;
      onConfirm({ kind: "literal", value: literalValue });
      return;
    }

    const provider = providerResources.find((r) => r.resourceId === selectedProviderId);
    if (!provider) return;

    onConfirm({
      kind: "output-ref",
      providerResourceId: provider.resourceId,
      providerPluginId: provider.pluginId,
      providerResourceTypeId: provider.resourceTypeId,
      providerAccountId: provider.accountId,
      providerOutputKey: provider.outputKey,
    });
  };

  return (
    <Modal onClose={onCancel}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface">
            Reroll <code className="text-accent">{fieldKey}</code>
          </h2>
          <button
            onClick={onCancel}
            className="text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setMode("provider")}
            className={`flex-1 py-2.5 text-sm transition-colors ${
              mode === "provider"
                ? "text-accent border-b-2 border-blue-400"
                : "text-on-surface-muted hover:text-on-surface-secondary"
            }`}
          >
            From resource
          </button>
          <button
            onClick={() => setMode("literal")}
            className={`flex-1 py-2.5 text-sm transition-colors ${
              mode === "literal"
                ? "text-accent border-b-2 border-blue-400"
                : "text-on-surface-muted hover:text-on-surface-secondary"
            }`}
          >
            Paste literal value
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {mode === "provider" && (
            <div className="space-y-2">
              {providerResources.length === 0 ? (
                <p className="text-sm text-on-surface-faint text-center py-4">
                  No compatible resources found.
                </p>
              ) : (
                providerResources.map((resource) => (
                  <button
                    key={resource.resourceId}
                    onClick={() => setSelectedProviderId(resource.resourceId)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                      selectedProviderId === resource.resourceId
                        ? "border-blue-500 bg-accent-muted"
                        : "border-border hover:border-border-strong"
                    }`}
                  >
                    <span
                      className="w-6 h-6 flex-shrink-0"
                      dangerouslySetInnerHTML={{ __html: resource.pluginLogoSvg }}
                      aria-hidden
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-on-surface-secondary truncate">
                        {resource.displayName}
                      </p>
                      <p className="text-xs text-on-surface-muted">
                        {camelToTitle(resource.resourceTypeId)} · {camelToTitle(resource.outputKey)}
                      </p>
                    </div>
                    {selectedProviderId === resource.resourceId && (
                      <span className="text-accent flex-shrink-0">✓</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}

          {mode === "literal" && (
            <textarea
              value={literalValue}
              onChange={(e) => setLiteralValue(e.target.value)}
              placeholder={`Paste ${fieldKey} value...`}
              className="w-full h-40 bg-surface-overlay border border-border-strong rounded-lg p-3 text-sm font-mono text-on-surface-secondary placeholder:text-on-surface-faint resize-none focus:outline-none focus:border-blue-500"
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-4 border-t border-border">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg border border-border-strong text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={mode === "provider" ? !selectedProviderId : !literalValue.trim()}
            className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm text-white transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </Modal>
  );
}
