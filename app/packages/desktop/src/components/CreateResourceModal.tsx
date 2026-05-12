import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPluginClient } from "../lib/plugin-client";
import {
  CreateResourceModal as SharedCreateResourceModal,
  toast,
  useCreateResourceForm,
} from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { FieldRenderer } from "./create-resource";
import { useUIStore } from "@infrawrench/ui";
import {
  getCloudCreateConfig,
  getCloudCreatePricing,
  getCloudCreateCostEstimate,
  createCloudResource,
  loadCloudPickerResources,
} from "../lib/cloud-api";
import type { ResourcePickerOption } from "@infrawrench/ui";
import type {
  AssociationSource,
  CreateResourceConfig,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";

interface CreateResourceModalProps {
  accountId: string;
  pluginId: string;
  resourceType: ResourceTypeDefinition;
  clientFactory?: () => PluginClient | Promise<PluginClient>;
  parentResourceId?: string;
  onClose: () => void;
  onCreated: (resource: ResourceInstance) => void;
}

export function CreateResourceModal({
  accountId,
  pluginId,
  resourceType,
  clientFactory,
  parentResourceId,
  onClose,
  onCreated,
}: CreateResourceModalProps) {
  const clientRef = useRef<PluginClient | null>(null);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  const callbacks = useMemo(() => {
    if (activeCloudOrgId) {
      const orgId = activeCloudOrgId;
      return {
        loadConfig: async () =>
          (await getCloudCreateConfig(
            orgId,
            accountId,
            resourceType.id,
            pluginId,
            parentResourceId,
          )) as CreateResourceConfig,
        loadSizePricing: async (request: {
          regionId?: string;
          sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
        }) => {
          const res = await getCloudCreatePricing(
            orgId,
            accountId,
            resourceType.id,
            request,
            pluginId,
            parentResourceId,
          );
          return (res ?? {}) as Record<string, number>;
        },
        loadCostEstimate: async (fields: Record<string, string>) => {
          const res = await getCloudCreateCostEstimate(
            orgId,
            accountId,
            resourceType.id,
            fields,
            pluginId,
            parentResourceId,
          );
          return (res?.estimate ?? null) as number | null;
        },
        create: async (fields: Record<string, string>) => {
          const created = await createCloudResource(orgId, {
            accountId,
            pluginId,
            resourceTypeId: resourceType.id,
            fields,
            ...(parentResourceId ? { parentResourceId } : {}),
          });
          const now = new Date().toISOString();
          const stub: ResourceInstance = {
            id: created.id,
            pluginId,
            resourceTypeId: resourceType.id,
            accountId,
            displayName: created.displayName,
            fields: {},
            resolvedOutputs: {},
            secretStates: [],
            createdAt: now,
            updatedAt: now,
          };
          onCreated(stub);
        },
      };
    }

    const localClients = new Map<string, Promise<PluginClient>>();
    const getLocalClient = (acctId: string, plugId: string) => {
      const key = `${acctId}:${plugId}`;
      let existing = localClients.get(key);
      if (!existing) {
        existing = createPluginClient(acctId, plugId);
        localClients.set(key, existing);
      }
      return existing;
    };

    return {
      loadConfig: async () => {
        const client = clientFactory
          ? await clientFactory()
          : await createPluginClient(accountId, pluginId);
        clientRef.current = client;
        localClients.set(`${accountId}:${pluginId}`, Promise.resolve(client));
        if (!client.getCreateConfig)
          throw new Error("Plugin does not support dynamic create config");
        return client.getCreateConfig(resourceType.id, parentResourceId);
      },
      loadResources: async (
        sources: AssociationSource[],
        acctId: string,
      ): Promise<ResourcePickerOption[]> => {
        const results: ResourcePickerOption[] = [];
        for (const source of sources) {
          try {
            const client = await getLocalClient(acctId, source.pluginId);
            const resources = await client.listResources(source.resourceTypeId, acctId);
            for (const resource of resources) {
              try {
                const outputValue = client.resolveOutput
                  ? await client.resolveOutput(
                      source.resourceTypeId,
                      resource.id,
                      source.outputKey,
                      acctId,
                    )
                  : String(resource.resolvedOutputs[source.outputKey] ?? "");
                results.push({
                  id: resource.id,
                  label: resource.displayName,
                  pluginId: source.pluginId,
                  resourceTypeId: source.resourceTypeId,
                  accountId: acctId,
                  outputKey: source.outputKey,
                  outputValue,
                });
              } catch {
                /* skip resources that can't be resolved */
              }
            }
          } catch {
            /* skip sources that fail (e.g. different plugin not loaded for this account) */
          }
        }
        return results;
      },
      loadSizePricing: (request: {
        regionId?: string;
        sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
      }) => {
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
        const client =
          clientRef.current ??
          (clientFactory ? await clientFactory() : await createPluginClient(accountId, pluginId));
        if (!client.createResource) throw new Error("Plugin does not support resource creation");
        const createReturn = await client.createResource(
          resourceType.id,
          accountId,
          fields,
          parentResourceId,
        );
        const { resource, warnings } = normalizeResourceCreateResult(createReturn);
        for (const w of warnings) {
          toast.warning(w.message);
        }
        onCreated(resource);
      },
    };
  }, [
    activeCloudOrgId,
    accountId,
    clientFactory,
    parentResourceId,
    pluginId,
    resourceType.id,
    onCreated,
  ]);

  const form = useCreateResourceForm(callbacks, [
    activeCloudOrgId,
    accountId,
    clientFactory,
    pluginId,
    resourceType.id,
  ]);

  // Hold `callbacks` in a ref so `loadResources` stays referentially stable
  // across rerenders. Without this, every fresh `onCreated` arrow from a
  // parent regenerates `callbacks`, which regenerates `loadResources`, which
  // fires ResourcePickerResolver's effect — the resource picker flickers and
  // refetches on every parent render.
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const loadResources = useCallback(
    (sources: AssociationSource[], acctId: string): Promise<ResourcePickerOption[]> => {
      if (activeCloudOrgId) {
        return loadCloudPickerResources(activeCloudOrgId, sources, acctId);
      }
      return callbacksRef.current.loadResources
        ? callbacksRef.current.loadResources(sources, acctId)
        : Promise.resolve([]);
    },
    [activeCloudOrgId],
  );

  const resourcePickerProps = useMemo(
    () => ({ loadResources, accountId }),
    [loadResources, accountId],
  );

  return (
    <SharedCreateResourceModal
      displayName={resourceType.displayName}
      form={form}
      onClose={onClose}
      renderField={(f, value, onChange) => (
        <FieldRenderer
          key={f.key}
          field={f}
          value={value}
          onChange={onChange}
          resourcePickerProps={resourcePickerProps}
        />
      )}
      renderError={(message, props) => <ErrorNotice message={message} {...props} />}
    />
  );
}
