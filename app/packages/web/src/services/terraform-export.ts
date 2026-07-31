import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportOutcome,
} from "@infrawrench/plugin-base";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { getPlugin } from "../plugins/loader";

/**
 * Bridge between stored `resources` rows and the shared plugin-base
 * "eject to Terraform" pipeline. Mapping runs entirely from persisted state —
 * no plugin client, credentials, or provider API calls are involved.
 */

export interface StoredResourceRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  parentResourceId: string | null;
}

function primitiveFields(json: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function toResourceInstance(row: StoredResourceRow): ResourceInstance {
  const outputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.outputsJson)) {
    if (typeof value === "string") outputs[key] = value;
  }
  return {
    id: row.id,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    accountId: row.accountId,
    displayName: row.displayName,
    fields: primitiveFields(row.fieldsJson),
    resolvedOutputs: outputs,
    secretStates: [],
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.parentResourceId ? { parentResourceId: row.parentResourceId } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

/** Map + render a set of stored resource rows into one Terraform document. */
export async function exportStoredResourcesToTerraform(
  rows: StoredResourceRow[],
): Promise<TerraformExportOutcome> {
  const capabilities = new Map<string, TerraformExportCapability | undefined>();
  for (const row of rows) {
    if (!capabilities.has(row.pluginId)) {
      const loaded = await getPlugin(row.pluginId);
      capabilities.set(row.pluginId, loaded?.plugin.terraformExport);
    }
  }
  return exportResourcesToTerraform(rows.map(toResourceInstance), (pluginId) =>
    capabilities.get(pluginId),
  );
}
