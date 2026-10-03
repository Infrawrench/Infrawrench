/**
 * Monthly cost estimates for an existing resource, in both desktop modes.
 *
 * Local mode calls the plugin client in-process; cloud mode goes through the
 * `cloud_get_cost_estimate` IPC channel to the web API, which runs the same
 * plugin method server-side. Both merge the caller's field overrides over the
 * resource's stored fields, so the resource detail page (no overrides) and
 * the edit modal (only the changed keys) share one code path, which is what
 * keeps the standing figure and the "+$340/month" delta consistent with each
 * other.
 */
import type { CostEstimate, PluginClient, ResourceInstance } from "@infrawrench/plugin-base";
import {
  effectiveCarbonDeclaration,
  readCarbonInputs,
  resourceCarbonEstimate,
  type ResourceCarbonEstimate,
} from "@infrawrench/client-core";

import { getCloudCarbonEstimate, getCloudCostEstimate } from "./cloud-resources";
import { getPlugin } from "../plugins/loader";
import type { CloudCtx } from "../routes/_resource-detail/-types";

/** Stored fields are `unknown`-valued; `estimateCost` takes strings. */
function stringifyFields(fields: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

export interface ResourceCostEstimatorOptions {
  resource: ResourceInstance | null;
  accountId: string;
  resourceId: string;
  getLocalClient: () => PluginClient | null;
  getCloudCtx: () => CloudCtx | null;
}

/**
 * Build the `loadCostEstimate` callback the detail view and the edit modal
 * both take, or `null` when there is nothing to price yet (no resource
 * loaded). Never throws: an unpriceable configuration and a failed request
 * both resolve to `null`, because an estimate is an extra on top of whatever
 * the caller was already showing.
 */
export function makeResourceCostEstimator(
  options: ResourceCostEstimatorOptions,
): ((changedFields: Record<string, string>) => Promise<CostEstimate | null>) | null {
  const { resource, accountId, resourceId, getLocalClient, getCloudCtx } = options;
  if (!resource) return null;

  return async (changedFields: Record<string, string>) => {
    const cloud = getCloudCtx();
    if (cloud) {
      return getCloudCostEstimate(cloud.orgId, accountId, cloud.resourceTypeId, {
        resourceId,
        ...(Object.keys(changedFields).length > 0 ? { fields: changedFields } : {}),
        pluginId: cloud.pluginId,
        ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
      }).catch(() => null);
    }

    const client = getLocalClient();
    if (!client?.estimateCost) return null;
    return client
      .estimateCost(resource.resourceTypeId, {
        ...stringifyFields(resource.fields),
        ...changedFields,
      })
      .catch(() => null);
  };
}

/**
 * The carbon counterpart of {@link makeResourceCostEstimator}, same contract.
 *
 * Cloud mode reads the `carbon` half of the same `cost-estimate` response.
 * Local mode reads the type's carbon declaration in-process and resolves its
 * size through the local plugin client's create form, exactly as the server
 * does, so the two modes quote the same figure.
 */
export function makeResourceCarbonEstimator(
  options: ResourceCostEstimatorOptions,
): ((changedFields: Record<string, string>) => Promise<ResourceCarbonEstimate | null>) | null {
  const { resource, accountId, resourceId, getLocalClient, getCloudCtx } = options;
  if (!resource) return null;

  return async (changedFields: Record<string, string>) => {
    const cloud = getCloudCtx();
    if (cloud) {
      return getCloudCarbonEstimate(cloud.orgId, accountId, cloud.resourceTypeId, {
        resourceId,
        ...(Object.keys(changedFields).length > 0 ? { fields: changedFields } : {}),
        pluginId: cloud.pluginId,
        ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
      }).catch(() => null);
    }

    try {
      const loaded = await getPlugin(resource.pluginId);
      const type = loaded?.plugin.resourceTypes.find((t) => t.id === resource.resourceTypeId);
      const declaration = type ? effectiveCarbonDeclaration(type) : null;
      if (!declaration) return resourceCarbonEstimate(null);
      const client = getLocalClient();
      const configs = new Map<string, ReturnType<NonNullable<PluginClient["getCreateConfig"]>>>();
      const inputs = await readCarbonInputs(
        declaration,
        { ...(resource.fields ?? {}), ...changedFields },
        {
          pluginId: resource.pluginId,
          resourceTypeId: resource.resourceTypeId,
          loadCatalogue: async (typeId, fieldKey) => {
            if (!client?.getCreateConfig) return null;
            let config = configs.get(typeId);
            if (!config) {
              config = client.getCreateConfig(typeId);
              configs.set(typeId, config);
            }
            const field = (await config).fields.find(
              (f) => f.key === fieldKey && f.kind === "size-picker",
            );
            return field?.sizes ?? null;
          },
        },
      );
      return resourceCarbonEstimate(inputs);
    } catch {
      return null;
    }
  };
}
