import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPluginClient } from "../lib/plugin-client";
import { invoke } from "../lib/invoke";
import {
  CreateResourceModal as SharedCreateResourceModal,
  toast,
  useCreateResourceForm,
} from "@infrawrench/ui";
import { ErrorNotice } from "./ErrorNotice";
import { FieldRenderer } from "./create-resource/FieldRenderer";
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
import { normalizeResourceCreateResult, parseOutputRef } from "@infrawrench/plugin-base";
import type { OutputRefValue } from "@infrawrench/plugin-base";
import { getDb } from "../db/client";
import { persistPlaintextSecret, persistOutputRef } from "../lib/sql-drivers";

/**
 * Persist a freshly-created resource + its plaintext secret states into the
 * local SQLite. The web server does this inline after `createResource`; on
 * desktop we have to do it from the renderer because the create flow doesn't
 * round-trip through a server. Without this, peer panes can't resolve secrets
 * the plugin returned at create time (e.g. Cloud SQL `rootPassword`).
 *
 * The `resources` row is required by the FK on `secret_field_states`, so we
 * UPSERT it first even if no other code path will need it (peer-pane checks
 * read in-memory parent fields, not this row).
 */
async function persistCreatedResource(resource: ResourceInstance): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO resources
     (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      resource.id,
      resource.pluginId,
      resource.resourceTypeId,
      resource.accountId,
      resource.displayName,
      resource.externalId ?? resource.id,
      JSON.stringify(resource.fields ?? {}),
      JSON.stringify(resource.resolvedOutputs ?? {}),
    ],
  );
  for (const state of resource.secretStates ?? []) {
    if (state.resolution.kind !== "plaintext") continue;
    await persistPlaintextSecret(resource.id, state.fieldKey, state.resolution.value);
  }
}

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
        opts?: { regionHint?: string; crossAccount?: boolean },
      ): Promise<ResourcePickerOption[]> => {
        const results: ResourcePickerOption[] = [];

        // In cross-account mode, search every local account whose plugin
        // matches a source (a DNS record usually points at a resource in a
        // different account/provider). Otherwise only the creating account.
        let accountsByPlugin: Map<string, Array<{ id: string; name: string }>> | null = null;
        if (opts?.crossAccount) {
          accountsByPlugin = new Map();
          try {
            const db = await getDb();
            const rows = await db.select<
              Array<{ id: string; plugin_id: string; display_name: string }>
            >("SELECT id, plugin_id, display_name FROM accounts ORDER BY display_name");
            for (const row of rows) {
              const list = accountsByPlugin.get(row.plugin_id) ?? [];
              list.push({ id: row.id, name: row.display_name });
              accountsByPlugin.set(row.plugin_id, list);
            }
          } catch {
            accountsByPlugin = null;
          }
        }

        for (const source of sources) {
          const targets = accountsByPlugin
            ? (accountsByPlugin.get(source.pluginId) ?? [])
            : [{ id: acctId, name: "" }];
          for (const target of targets) {
            try {
              const client = await getLocalClient(target.id, source.pluginId);
              const resources = await client.listResources(
                source.resourceTypeId,
                target.id,
                opts?.regionHint ? { regionHint: opts.regionHint } : undefined,
              );
              for (const resource of resources) {
                try {
                  const outputValue = client.resolveOutput
                    ? await client.resolveOutput(
                        source.resourceTypeId,
                        resource.id,
                        source.outputKey,
                        target.id,
                      )
                    : String(resource.resolvedOutputs[source.outputKey] ?? "");
                  if (!outputValue) continue;
                  results.push({
                    id: resource.id,
                    label: target.name
                      ? `${resource.displayName} · ${target.name}`
                      : resource.displayName,
                    pluginId: source.pluginId,
                    resourceTypeId: source.resourceTypeId,
                    accountId: target.id,
                    outputKey: source.outputKey,
                    outputValue,
                  });
                } catch {
                  /* skip resources that can't be resolved */
                }
              }
            } catch {
              /* skip accounts/sources that fail */
            }
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
        // Flatten reference-mode picker values to their pick-time literal for
        // the plugin, remembering the identity to persist as a live output ref.
        const resolvedFields: Record<string, string> = {};
        const refFields: Array<{ fieldKey: string; ref: OutputRefValue }> = [];
        for (const [fieldKey, value] of Object.entries(fields)) {
          const ref = parseOutputRef(value);
          if (ref) {
            resolvedFields[fieldKey] = ref.value;
            refFields.push({ fieldKey, ref });
          } else {
            resolvedFields[fieldKey] = value;
          }
        }
        const createReturn = await client.createResource(
          resourceType.id,
          accountId,
          resolvedFields,
          parentResourceId,
        );
        const { resource, warnings, credentialUpdates } =
          normalizeResourceCreateResult(createReturn);
        // Merge auto-minted account credentials (e.g. DO Spaces keys
        // created on first bucket-create) into the saved account row
        // before persisting the resource. If this fails the resource
        // still got created upstream, but subsequent ops that rely on
        // these creds will error until the user re-runs — surface as a
        // warning rather than swallowing.
        if (credentialUpdates && Object.keys(credentialUpdates).length > 0) {
          try {
            const existing = await invoke<Record<string, string>>("account_get_credentials", {
              accountId,
            });
            await invoke<void>("account_save_credentials", {
              accountId,
              credentials: { ...existing, ...credentialUpdates },
            });
            // Drop the cached plugin client so the next operation
            // picks up the new credentials.
            clientRef.current = null;
          } catch (err) {
            toast.warning(
              `Created ${resource.displayName} but couldn't save the new credentials to the account: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        await persistCreatedResource(resource);
        for (const { fieldKey, ref } of refFields) {
          try {
            await persistOutputRef(resource.id, fieldKey, ref);
          } catch (err) {
            console.error("[create] Failed to persist output reference:", err);
          }
        }
        for (const w of warnings) {
          toast.warning(w.message);
        }
        onCreated(resource);
      },
      executeFieldAction: async (
        fieldKey: string,
        actionId: string,
        fields: Record<string, string>,
        actionFields?: Record<string, string>,
      ) => {
        const client =
          clientRef.current ??
          (clientFactory ? await clientFactory() : await createPluginClient(accountId, pluginId));
        if (!client.executeFieldAction) {
          throw new Error("Plugin does not support field actions");
        }
        return client.executeFieldAction(
          resourceType.id,
          fieldKey,
          actionId,
          accountId,
          fields,
          actionFields,
        );
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
    (
      sources: AssociationSource[],
      acctId: string,
      opts?: { regionHint?: string },
    ): Promise<ResourcePickerOption[]> => {
      if (activeCloudOrgId) {
        return loadCloudPickerResources(activeCloudOrgId, sources, acctId, opts);
      }
      return callbacksRef.current.loadResources
        ? callbacksRef.current.loadResources(sources, acctId, opts)
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
          formValues={form.fields}
          resourcePickerProps={resourcePickerProps}
          fieldActionProps={{
            runAction: form.runFieldAction,
            runningByKey: form.fieldActionRunning,
            errorByKey: form.fieldActionError,
            refreshKeyByKey: form.fieldRefreshKey,
          }}
        />
      )}
      renderError={(message, props) => <ErrorNotice message={message} {...props} />}
    />
  );
}
