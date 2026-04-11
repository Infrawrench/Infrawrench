import { useMemo, useRef } from "react";
import { createPluginClient } from "../lib/plugin-client";
import { CreateResourceModal as SharedCreateResourceModal, useCreateResourceForm } from "@infrawrench/ui";
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
    <SharedCreateResourceModal
      displayName={resourceType.displayName}
      form={form}
      onClose={onClose}
      renderField={(f, value, onChange) => (
        <FieldRenderer key={f.key} field={f} value={value} onChange={onChange} />
      )}
      renderError={(message, props) => (
        <ErrorNotice message={message} {...props} />
      )}
    />
  );
}
