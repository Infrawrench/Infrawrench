import { useMemo, useRef } from "react";
import { formatErrorMessage } from "../lib/errors";
import { createPluginClient } from "../lib/plugin-client";
import { Modal, useCreateResourceForm } from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { FieldRenderer } from "./create-resource";
import type { PluginClient, ResourceTypeDefinition } from "@infrawrench/plugin-base";

interface CreateResourceModalProps {
  accountId: string;
  pluginId: string;
  resourceType: ResourceTypeDefinition;
  clientFactory?: () => PluginClient | Promise<PluginClient>;
  onClose: () => void;
  onCreated: (resource: import("@infrawrench/plugin-base").ResourceInstance) => void;
}

export function CreateResourceModal({
  accountId,
  pluginId,
  resourceType,
  clientFactory,
  onClose,
  onCreated,
}: CreateResourceModalProps) {
  const clientRef = useRef<PluginClient | null>(null);

  const callbacks = useMemo(() => ({
    loadConfig: async () => {
      const client = clientFactory
        ? await clientFactory()
        : await createPluginClient(accountId, pluginId);
      clientRef.current = client;
      if (!client.getCreateConfig) throw new Error("Plugin does not support dynamic create config");
      return client.getCreateConfig(resourceType.id);
    },
    loadSizePricing: (request: { regionId?: string; sizes: Array<{ id: string; vcpus: number; memoryMb: number }> }) => {
      const client = clientRef.current;
      if (!client?.getCreateSizePricing) return Promise.resolve({});
      return client.getCreateSizePricing(resourceType.id, request);
    },
    loadCostEstimate: (fields: Record<string, string>) => {
      const client = clientRef.current;
      if (!client?.getCreateCostEstimate) return Promise.resolve(null);
      return client.getCreateCostEstimate(resourceType.id, fields);
    },
    create: async (fields: Record<string, string>) => {
      const client = clientRef.current
        ?? (clientFactory
          ? await clientFactory()
          : await createPluginClient(accountId, pluginId));
      if (!client.createResource) throw new Error("Plugin does not support resource creation");
      const created = await client.createResource(resourceType.id, accountId, fields);
      onCreated(created);
    },
  }), [accountId, clientFactory, pluginId, resourceType.id, onCreated]);

  const form = useCreateResourceForm(callbacks, [accountId, clientFactory, pluginId, resourceType.id]);

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[72vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-100">
            Create {resourceType.displayName}
          </h2>
          <div className="flex items-center gap-3">
            {form.estimatedMonthlyPriceLabel && (
              <div className="text-right px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <p className="text-[10px] uppercase tracking-wide text-emerald-300/80">Estimated cost</p>
                <p className="text-sm font-semibold text-emerald-200">{form.estimatedMonthlyPriceLabel}/mo</p>
              </div>
            )}
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 text-xl leading-none">&times;</button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {form.loadingConfig ? (
            <div className="flex items-center gap-3 text-sm text-gray-500 py-8 justify-center">
              <span className="animate-spin inline-block w-4 h-4 rounded-full border-2 border-gray-600 border-t-gray-300" />
              Fetching available options...
            </div>
          ) : form.configError ? (
            <ErrorNotice
              message={form.configError}
              textClassName="text-sm text-red-400"
            />
          ) : form.configWithPricing ? (
            <div className="space-y-6">
              {form.visibleFields.map((f) => (
                <FieldRenderer key={f.key} field={f} value={form.fields[f.key] ?? ""} onChange={(v) => form.setField(f.key, v)} />
              ))}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0">
          {form.error && (
            <ErrorNotice
              message={form.error}
              className="mb-3 rounded bg-red-900/20 px-3 py-2"
              textClassName="text-xs text-red-400"
            />
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void form.handleCreate()}
              disabled={form.creating || form.loadingConfig || !!form.configError}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {form.creating ? "Creating..." : `Create ${resourceType.displayName}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
