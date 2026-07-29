/**
 * A plugin client for one ORG (cloud) account, backed entirely by the org's
 * HTTP API. The counterpart of `infrafile/plugin-host.ts`: that one decrypts
 * local credentials and calls the provider directly, this one never sees a
 * credential — the server holds them, and every operation is an `orgFetch`
 * against a route the web app already exposes.
 *
 * The surface implemented here is exactly what `buildWorkflowHost` dispatches
 * to (list/get/outputs/create/update/delete). Capabilities with no org route
 * from the CLI (sql, kv, storage, logs, manifests, …) throw a clear error
 * rather than silently no-op — the resource may well support them in the web
 * app, and the message should say where to go.
 */
import type {
  PluginClient,
  ResourceCreateReturn,
  ResourceInstance,
} from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import {
  CliError,
  listCloudResources,
  orgFetch,
  syncCloudAccount,
  type ResourceRow,
} from "./context";
import { createPluginClientFromCredentials } from "../infrafile/plugin-host";
import { c, printErr } from "./output";

/**
 * Preferred path for an org account: fetch its credentials over the org API
 * (audited server-side, needs `secrets:read`) and run the plugin RIGHT HERE —
 * the same listers and creates a local account gets, live against the
 * provider, including resource types the cloud deployment may not know yet.
 *
 * One credential fetch per account per process; a failure (no permission,
 * offline) falls back to the HTTP-backed client below with a dim note, so a
 * viewer-role operator still gets the cached-rows experience.
 */
const credentialedClients = new Map<string, Promise<PluginClient>>();

export function createOrgClient(
  orgId: string,
  accountId: string,
  pluginId: string,
): Promise<PluginClient> {
  let client = credentialedClients.get(accountId);
  if (!client) {
    client = (async () => {
      try {
        const credentials = await orgFetch<Record<string, string>>(
          orgId,
          `/accounts/${encodeURIComponent(accountId)}/credentials`,
        );
        return await createPluginClientFromCredentials(pluginId, credentials);
      } catch (e) {
        printErr(
          c.dim(
            `could not fetch credentials for the org account (${
              e instanceof Error ? e.message : e
            }) — using the org's cached rows instead`,
          ),
        );
        return createOrgPluginClient(orgId, accountId, pluginId);
      }
    })();
    credentialedClients.set(accountId, client);
  }
  return client;
}

/** How long a pre-list sync may hold up the deploy before cached rows win. */
const SYNC_WAIT_MS = 60_000;

/**
 * One best-effort sync per account per process. The poller keeps the org's
 * cache warm on its own schedule, but a deploy about to act on the rows wants
 * them fresh — while never *failing* (or stalling forever) because of it.
 */
const syncWaits = new Map<string, Promise<void>>();

function ensureSynced(orgId: string, accountId: string): Promise<void> {
  let wait = syncWaits.get(accountId);
  if (!wait) {
    wait = (async () => {
      const sync = syncCloudAccount(orgId, accountId).then(() => true as const);
      // The sync may outlive the race below; a late failure must not surface
      // as an unhandled rejection.
      sync.catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      try {
        const finished = await Promise.race([
          sync,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), SYNC_WAIT_MS);
          }),
        ]);
        if (!finished) {
          printErr(
            c.dim(
              `sync of cloud account ${accountId} is still running after ${Math.round(SYNC_WAIT_MS / 1000)}s — using cached resources`,
            ),
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        printErr(
          c.dim(`could not sync cloud account ${accountId}: ${msg} — using cached resources`),
        );
      } finally {
        clearTimeout(timer);
      }
    })();
    syncWaits.set(accountId, wait);
  }
  return wait;
}

/** Stringify one cached output value; objects keep their JSON shape. */
function outputString(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** A cached org row as the `ResourceInstance` plugin clients trade in. */
function toInstance(row: ResourceRow): ResourceInstance {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(row.fields)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    } else if (value != null) {
      fields[key] = JSON.stringify(value);
    }
  }
  const resolvedOutputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.outputs)) {
    if (value != null) resolvedOutputs[key] = outputString(value);
  }
  return {
    id: row.id,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    accountId: row.accountId,
    displayName: row.displayName,
    fields,
    resolvedOutputs,
    // Secret states live server-side; the routes used here never return them.
    secretStates: [],
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.parentResourceId ? { parentResourceId: row.parentResourceId } : {}),
    // The resources route carries no timestamps; nothing downstream of the
    // workflow host reads these.
    createdAt: "",
    updatedAt: "",
  };
}

/** The shape POST /accounts/:id/sync-type/:typeId answers with. */
interface SyncTypeRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: unknown;
  outputsJson: unknown;
  parentResourceId: string | null;
}

function notAvailable(what: string): CliError {
  return new CliError(
    `${what} is not available for cloud accounts from the CLI — use the web app, or a local account.`,
    2,
  );
}

export function createOrgPluginClient(
  orgId: string,
  accountId: string,
  pluginId: string,
): PluginClient {
  const rowsForType = async (typeId: string): Promise<ResourceRow[]> => {
    await ensureSynced(orgId, accountId);
    const rows = await listCloudResources(orgId, accountId);
    return rows.filter((r) => r.resourceTypeId === typeId);
  };

  return {
    async listResources(typeId: string): Promise<ResourceInstance[]> {
      return (await rowsForType(typeId)).map(toInstance);
    },

    async getResource(typeId: string, resourceId: string): Promise<ResourceInstance> {
      const row = (await rowsForType(typeId)).find((r) => r.id === resourceId);
      if (!row) {
        throw new CliError(`Resource "${resourceId}" not found on cloud account ${accountId}.`, 2);
      }
      return toInstance(row);
    },

    async resolveOutput(typeId: string, resourceId: string, outputKey: string): Promise<string> {
      // The cached row first — sync merges every output the provider's lister
      // has ever populated, so most keys are already here.
      const cached = (await rowsForType(typeId)).find((r) => r.id === resourceId);
      const cachedValue = cached?.outputs[outputKey];
      if (cachedValue != null && cachedValue !== "") return outputString(cachedValue);

      // Not cached — re-list just this type live through the server, which
      // also refreshes the org's rows as a side effect.
      const fresh = await orgFetch<SyncTypeRow[]>(
        orgId,
        `/accounts/${encodeURIComponent(accountId)}/sync-type/${encodeURIComponent(typeId)}`,
        { method: "POST" },
      );
      const row = fresh.find((r) => r.id === resourceId);
      const outputs =
        row && typeof row.outputsJson === "object" && row.outputsJson !== null
          ? (row.outputsJson as Record<string, unknown>)
          : {};
      const value = outputs[outputKey];
      if (value != null && value !== "") return outputString(value);
      throw new CliError(
        `Output "${outputKey}" of ${resourceId} is not resolvable through the org API — ` +
          `the provider's lister does not populate it.`,
        2,
      );
    },

    async createResource(
      typeId: string,
      _accountId: string,
      fields: Record<string, string>,
      parentResourceId?: string,
    ): Promise<ResourceCreateReturn> {
      const created = await orgFetch<{
        id: string;
        displayName: string;
        warnings?: Array<{ code: string; message: string }>;
        error?: string;
      }>(orgId, "/resources/create", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          pluginId,
          resourceTypeId: typeId,
          fields,
          ...(parentResourceId ? { parentResourceId } : {}),
        }),
      });

      // The route persists the new row before answering, so a plain re-read
      // usually yields the full instance (externalId, outputs). If it does
      // not, the id and display name from the response still carry the deploy.
      const row = (await listCloudResources(orgId, accountId)).find((r) => r.id === created.id);
      const prefix = `${accountId}:${typeId}:`;
      const resource: ResourceInstance = row
        ? toInstance(row)
        : {
            id: created.id,
            pluginId,
            resourceTypeId: typeId,
            accountId,
            displayName: created.displayName,
            fields,
            resolvedOutputs: {},
            secretStates: [],
            ...(created.id.startsWith(prefix)
              ? { externalId: created.id.slice(prefix.length) }
              : {}),
            ...(parentResourceId ? { parentResourceId } : {}),
            createdAt: "",
            updatedAt: "",
          };
      return { resource, warnings: created.warnings ?? [] };
    },

    async updateResource(
      typeId: string,
      resourceId: string,
      _accountId: string,
      fields: Record<string, string>,
    ): Promise<ResourceInstance> {
      const updated = await orgFetch<{
        id: string;
        displayName: string;
        fields: Record<string, unknown>;
      }>(orgId, "/resources/update", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          pluginId,
          resourceTypeId: typeId,
          resourceId,
          fields,
        }),
      });
      const row = (await listCloudResources(orgId, accountId)).find((r) => r.id === updated.id);
      if (row) return toInstance({ ...row, displayName: updated.displayName });
      return toInstance({
        id: updated.id,
        pluginId,
        resourceTypeId: typeId,
        accountId,
        displayName: updated.displayName,
        externalId: "",
        fields: updated.fields ?? {},
        outputs: {},
        parentResourceId: null,
      });
    },

    async deleteResource(typeId: string, resourceId: string): Promise<void> {
      const query = new URLSearchParams({ resourceId, accountId });
      await orgFetch(
        orgId,
        `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(typeId)}?${query}`,
        { method: "DELETE" },
      );
    },

    // The rendering surface exists for the GUI; nothing in a deploy calls it.
    renderDetail(): never {
      throw notAvailable("Rendering a detail view");
    },
    renderSidebarItem(): never {
      throw notAvailable("Rendering a sidebar item");
    },

    // Capabilities the workflow host would dispatch to when present. Each one
    // needs server-side driver plumbing the CLI cannot reach over these
    // routes, so they exist only to fail with a message that names the way out.
    async executeQuery(): Promise<never> {
      throw notAvailable("query()");
    },
    async listStorageObjects(): Promise<never> {
      throw notAvailable("The storage browser");
    },
    async listKvKeys(): Promise<never> {
      throw notAvailable("The key-value browser");
    },
    async getKvValue(): Promise<never> {
      throw notAvailable("The key-value browser");
    },
    async putKvValue(): Promise<never> {
      throw notAvailable("Key-value writes");
    },
    async deleteKvKey(): Promise<never> {
      throw notAvailable("Key-value deletes");
    },
    async executeNoSqlCommand(): Promise<never> {
      throw notAvailable("NoSQL commands");
    },
    async getLogs(): Promise<never> {
      throw notAvailable("Reading logs");
    },
    async describeResource(): Promise<never> {
      throw notAvailable("describe()");
    },
    async getManifest(): Promise<never> {
      throw notAvailable("Reading manifests");
    },
    async applyManifest(): Promise<never> {
      throw notAvailable("Applying manifests");
    },
    async importYaml(): Promise<never> {
      throw notAvailable("importYaml()");
    },
    async publishMessage(): Promise<never> {
      throw notAvailable("Publishing messages");
    },
    async fetchMetricSeries(): Promise<never> {
      throw notAvailable("Fetching metrics");
    },
  };
}
