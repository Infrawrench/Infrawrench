import { useState } from "react";
import type { ProviderResource, RerollSelection } from "./DetailView.js";
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
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">
            Reroll <code className="text-blue-400">{fieldKey}</code>
          </h2>
          <button
            onClick={onCancel}
            className="text-gray-600 hover:text-gray-400 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-gray-800">
          <button
            onClick={() => setMode("provider")}
            className={`flex-1 py-2.5 text-sm transition-colors ${
              mode === "provider"
                ? "text-blue-400 border-b-2 border-blue-400"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            From resource
          </button>
          <button
            onClick={() => setMode("literal")}
            className={`flex-1 py-2.5 text-sm transition-colors ${
              mode === "literal"
                ? "text-blue-400 border-b-2 border-blue-400"
                : "text-gray-500 hover:text-gray-300"
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
                <p className="text-sm text-gray-600 text-center py-4">
                  No compatible resources found.
                </p>
              ) : (
                providerResources.map((resource) => (
                  <button
                    key={resource.resourceId}
                    onClick={() => setSelectedProviderId(resource.resourceId)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                      selectedProviderId === resource.resourceId
                        ? "border-blue-500 bg-blue-950"
                        : "border-gray-800 hover:border-gray-600"
                    }`}
                  >
                    <span
                      className="w-6 h-6 flex-shrink-0"
                      dangerouslySetInnerHTML={{ __html: resource.pluginLogoSvg }}
                      aria-hidden
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 truncate">{resource.displayName}</p>
                      <p className="text-xs text-gray-500">
                        {camelToTitle(resource.resourceTypeId)} · {camelToTitle(resource.outputKey)}
                      </p>
                    </div>
                    {selectedProviderId === resource.resourceId && (
                      <span className="text-blue-400 flex-shrink-0">✓</span>
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
              className="w-full h-40 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm font-mono text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500"
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-4 border-t border-gray-800">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg border border-gray-700 text-sm text-gray-400 hover:text-gray-200 transition-colors"
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
