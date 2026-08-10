/**
 * Local-mode environment diff. Mirrors the server's `/environment-diff`
 * endpoint against the desktop's local accounts: the same shared
 * `computeEnvironmentDiff` from client-core (imported through
 * `@infrawrench/ui`, the renderer convention), so a comparison reads
 * identically wherever it is run.
 *
 * Where it differs from the cloud path is the *source* of the two
 * inventories. The cloud compares rows the poller synced; local mode has no
 * such store — the desktop's `resources` table only holds what the app itself
 * created or pinned — so it enumerates both accounts through the plugin, the
 * way the account pages do. That means real provider calls, and it means a
 * resource type whose list fails is excluded rather than reported as absent:
 * "we couldn't ask" and "prod doesn't have one" are opposite answers.
 *
 * The CLI's `--local` twin lives in electron/local-environment-diff.ts, which
 * has no renderer to call into.
 */
import {
  computeEnvironmentDiff,
  type EnvironmentDiffResource,
  type EnvironmentDiffResponse,
  type EnvironmentDiffUnavailableType,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";
import { createPluginClient } from "./plugin-client";

interface AccountRow {
  id: string;
  display_name: string;
  plugin_id: string;
}

/** Thrown for an account id that isn't in this workspace (or was deleted). */
export class LocalAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`No account ${accountId} in this workspace.`);
    this.name = "LocalAccountNotFoundError";
  }
}

export async function loadLocalEnvironmentDiff(
  accountIdA: string,
  accountIdB: string,
  options: { includeIdentityFields?: boolean } = {},
): Promise<EnvironmentDiffResponse> {
  const db = await getDb();
  const accountRows = await db.select<AccountRow[]>(
    `SELECT id, display_name, plugin_id FROM accounts
     WHERE deleted_at IS NULL AND id IN ($1, $2)`,
    [accountIdA, accountIdB],
  );
  const byId = new Map(accountRows.map((r) => [r.id, r]));
  const accountA = byId.get(accountIdA);
  const accountB = byId.get(accountIdB);
  if (!accountA) throw new LocalAccountNotFoundError(accountIdA);
  if (!accountB) throw new LocalAccountNotFoundError(accountIdB);
  if (accountA.plugin_id !== accountB.plugin_id) {
    // computeEnvironmentDiff refuses this too; failing before the provider
    // calls saves a round of listing that could never be compared.
    throw new Error(
      `"${accountA.display_name}" and "${accountB.display_name}" use different providers — ` +
        `an environment diff compares two accounts of the same provider.`,
    );
  }

  const plugins = await loadPlugins();
  const loaded = plugins.find(({ plugin }) => plugin.manifest.id === accountA.plugin_id);
  if (!loaded) throw new Error(`Plugin "${accountA.plugin_id}" is not loaded.`);
  const resourceTypes = loaded.plugin.resourceTypes;
  const resourceTypeNames: Record<string, string> = {};
  for (const type of resourceTypes) resourceTypeNames[type.id] = type.displayName;

  const [listedA, listedB] = await Promise.all([
    listAccount(accountA, resourceTypes),
    listAccount(accountB, resourceTypes),
  ]);

  // A type that failed on *either* side can't be compared on either.
  const unavailableTypes: EnvironmentDiffUnavailableType[] = [];
  const seen = new Set<string>();
  for (const failure of [...listedA.failures, ...listedB.failures]) {
    if (seen.has(failure.resourceTypeId)) continue;
    seen.add(failure.resourceTypeId);
    unavailableTypes.push(failure);
  }

  return computeEnvironmentDiff({
    a: {
      accountId: accountA.id,
      accountName: accountA.display_name,
      pluginId: accountA.plugin_id,
      resources: listedA.resources,
    },
    b: {
      accountId: accountB.id,
      accountName: accountB.display_name,
      pluginId: accountB.plugin_id,
      resources: listedB.resources,
    },
    pluginName: loaded.plugin.manifest.displayName,
    resourceTypeNames,
    unavailableTypes,
    ...(options.includeIdentityFields ? { includeIdentityFields: true } : {}),
  });
}

/**
 * Every resource type of one account, listed through the provider.
 *
 * `listResources` leaves `resolvedOutputs` empty by contract, so a local diff
 * compares stored fields only — resolving outputs would mean a call per
 * resource on both sides.
 */
async function listAccount(
  account: AccountRow,
  resourceTypes: readonly { id: string; displayName: string }[],
): Promise<{ resources: EnvironmentDiffResource[]; failures: EnvironmentDiffUnavailableType[] }> {
  const client = await createPluginClient(account.id, account.plugin_id);
  const resources: EnvironmentDiffResource[] = [];
  const failures: EnvironmentDiffUnavailableType[] = [];

  const results = await Promise.all(
    resourceTypes.map(async (type) => {
      try {
        return { type, instances: await client.listResources(type.id, account.id) };
      } catch (e) {
        return { type, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  for (const result of results) {
    if ("error" in result) {
      failures.push({
        resourceTypeId: result.type.id,
        resourceTypeName: result.type.displayName,
        message: result.error,
      });
      continue;
    }
    for (const instance of result.instances) {
      resources.push({
        id: instance.id,
        resourceTypeId: instance.resourceTypeId,
        displayName: instance.displayName,
        externalId: instance.externalId ?? null,
        fields: instance.fields,
      });
    }
  }

  return { resources, failures };
}
