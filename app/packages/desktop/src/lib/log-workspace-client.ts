import type { LogsFetchParams, LogsFetchResult, PluginClient } from "@infrawrench/plugin-base";
import {
  discoverSidecarLogStreams,
  type LogStreamSelector,
  type LogWorkspaceQuery,
  type LogWorkspaceQueryCreate,
  type LogWorkspaceQueryListResponse,
  type LogWorkspaceQueryPatch,
  type SidecarLogParent,
} from "@infrawrench/client-core";
import type {
  LogResourceOption,
  LogWorkspaceClient,
  LogWorkspaceSavedQueriesClient,
} from "@infrawrench/ui";
import { invoke } from "./invoke";
import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { createPeerPluginClient, createPluginClient } from "./plugin-client";

/**
 * Desktop log workspace client — dual-mode, fixed at creation time: the org
 * (or local mode) is captured when the client is built, and org switches are
 * handled by DesktopWorkspaceTabsViewport remounting the panel via its
 * active-organization key (`key={activeCloudOrgId ?? "local"}`), which picks
 * up the cached client for the new mode.
 *
 * - **Cloud mode**: discovery and saved queries over the cloud API via IPC;
 *   stream fetches ride the existing `cloud_get_logs` path.
 * - **Local mode**: discovery scans the local resource table and asks each
 *   account's in-renderer plugin client (`getLogs` + `renderDetail`, never a
 *   hardcoded provider list); stream fetches call `client.getLogs` directly.
 *   Saved queries are cloud rows evaluated by the cloud poller, so local mode
 *   has no saved-query storage and the panel hides that bar.
 */

interface LocalResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  external_id: string | null;
  parent_resource_id: string | null;
  fields_json: string;
  created_at: string;
  updated_at: string;
}

const localClients = new Map<string, Promise<PluginClient>>();

function getLocalClient(accountId: string, pluginId: string): Promise<PluginClient> {
  let client = localClients.get(accountId);
  if (!client) {
    client = createPluginClient(accountId, pluginId);
    client.catch(() => localClients.delete(accountId));
    localClients.set(accountId, client);
  }
  return client;
}

/** Cap matching the cloud discovery's, so both pickers stay bounded alike. */
const MAX_RESULTS = 500;

async function listLocalLogResources(): Promise<LogResourceOption[]> {
  const db = await getDb();
  const [accountRows, resourceRows] = await Promise.all([
    db.select<{ id: string; display_name: string; plugin_id: string }[]>(
      "SELECT id, display_name, plugin_id FROM accounts WHERE deleted_at IS NULL",
    ),
    db.select<LocalResourceRow[]>(
      `SELECT id, plugin_id, resource_type_id, account_id, display_name, external_id,
              parent_resource_id, fields_json, created_at, updated_at
       FROM resources
       WHERE deleted_at IS NULL AND resource_type_id != '__account__'
       ORDER BY display_name ASC`,
    ),
  ]);

  const out: LogResourceOption[] = [];
  const sidecarParents: (SidecarLogParent & { parentPluginId: string })[] = [];
  for (const account of accountRows) {
    const rows = resourceRows.filter((r) => r.account_id === account.id);
    if (rows.length === 0) continue;
    const loaded = await getPlugin(account.plugin_id).catch(() => undefined);
    const peerTypeDefs = (loaded?.plugin.resourceTypes ?? []).filter(
      (t) => (t.peerIntegrations?.length ?? 0) > 0,
    );
    let client: PluginClient | null = null;
    try {
      client = await getLocalClient(account.id, account.plugin_id);
    } catch {
      client = null; // Broken credentials never break the picker for other accounts.
    }
    if ((client === null || !client.getLogs) && peerTypeDefs.length === 0) continue;
    for (const row of rows) {
      const fields = (() => {
        try {
          return JSON.parse(row.fields_json) as Record<string, string | number | boolean>;
        } catch {
          return {};
        }
      })();
      const peerTypeDef = peerTypeDefs.find((t) => t.id === row.resource_type_id);
      if (peerTypeDef) {
        sidecarParents.push({
          accountId: account.id,
          accountName: account.display_name,
          resourceId: row.id,
          displayName: row.display_name,
          fields,
          integrations: peerTypeDef.peerIntegrations ?? [],
          parentPluginId: account.plugin_id,
        });
      }
      if (!client?.getLogs || out.length >= MAX_RESULTS) continue;
      try {
        const schema = client.renderDetail({
          id: row.id,
          pluginId: row.plugin_id,
          resourceTypeId: row.resource_type_id,
          accountId: row.account_id,
          displayName: row.display_name,
          fields,
          resolvedOutputs: {},
          secretStates: [],
          ...(row.external_id ? { externalId: row.external_id } : {}),
          ...(row.parent_resource_id ? { parentResourceId: row.parent_resource_id } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        if (!schema.logs) continue;
      } catch {
        continue;
      }
      out.push({
        resourceId: row.id,
        accountId: account.id,
        accountName: account.display_name,
        pluginId: row.plugin_id,
        resourceTypeId: row.resource_type_id,
        displayName: row.display_name,
      });
    }
  }

  // Sidecar streams (pods inside a managed cluster) — same shared walk as the
  // cloud discovery, over in-renderer peer clients.
  if (out.length < MAX_RESULTS && sidecarParents.length > 0) {
    const byParentId = new Map(sidecarParents.map((p) => [p.resourceId, p]));
    const sidecars = await discoverSidecarLogStreams(sidecarParents, {
      async getPeerClient(parent, pluginId) {
        const parentPluginId = byParentId.get(parent.resourceId)?.parentPluginId;
        if (!parentPluginId) return null;
        return createPeerPluginClient(
          parent.accountId,
          parentPluginId,
          parent.resourceId,
          pluginId,
        );
      },
      async peerResourceTypeIds(pluginId) {
        const loaded = await getPlugin(pluginId);
        return loaded ? loaded.plugin.resourceTypes.map((t) => t.id) : [];
      },
      warn: (message) => console.warn(`[log-workspaces] ${message}`),
      maxResults: MAX_RESULTS - out.length,
    });
    out.push(...sidecars);
  }
  return out;
}

function cloudSavedQueries(orgId: string): LogWorkspaceSavedQueriesClient {
  return {
    async list(): Promise<LogWorkspaceQuery[]> {
      const res = await invoke<LogWorkspaceQueryListResponse>("cloud_log_workspaces_list", {
        orgId,
      });
      return res.queries;
    },
    create(input: LogWorkspaceQueryCreate): Promise<LogWorkspaceQuery> {
      return invoke<LogWorkspaceQuery>("cloud_log_workspaces_create", { orgId, body: input });
    },
    update(queryId: string, patch: LogWorkspaceQueryPatch): Promise<LogWorkspaceQuery> {
      return invoke<LogWorkspaceQuery>("cloud_log_workspaces_update", { orgId, queryId, patch });
    },
    async remove(queryId: string): Promise<void> {
      await invoke("cloud_log_workspaces_delete", { orgId, queryId });
    },
  };
}

/**
 * Build the client for the current mode. Called from renderPanel with the
 * active org (the panel remounts on mode/org switches via its key).
 */
export function createDesktopLogWorkspaceClient(orgId: string | null): LogWorkspaceClient {
  if (!orgId) {
    return {
      listLogResources: listLocalLogResources,
      async fetchLogs(
        selector: LogStreamSelector,
        params: LogsFetchParams,
      ): Promise<LogsFetchResult> {
        let client: PluginClient;
        if (selector.parentResourceId) {
          // Sidecar stream: the peer client is minted from the parent's
          // outputs; the account's own plugin is looked up from the row.
          const db = await getDb();
          const accountRows = await db.select<{ plugin_id: string }[]>(
            "SELECT plugin_id FROM accounts WHERE id = ? AND deleted_at IS NULL",
            [selector.accountId],
          );
          const parentPluginId = accountRows[0]?.plugin_id;
          if (!parentPluginId) throw new Error("Account not found");
          client = await createPeerPluginClient(
            selector.accountId,
            parentPluginId,
            selector.parentResourceId,
            selector.pluginId,
          );
        } else {
          client = await getLocalClient(selector.accountId, selector.pluginId);
        }
        if (!client.getLogs) throw new Error("Plugin does not support logs");
        return client.getLogs(
          selector.resourceTypeId,
          selector.resourceId,
          selector.accountId,
          params,
        );
      },
    };
  }
  return {
    async listLogResources(): Promise<LogResourceOption[]> {
      const res = await invoke<{ resources: LogResourceOption[] }>(
        "cloud_log_workspaces_resources",
        { orgId },
      );
      return res.resources;
    },
    fetchLogs(selector: LogStreamSelector, params: LogsFetchParams): Promise<LogsFetchResult> {
      return invoke<LogsFetchResult>("cloud_get_logs", {
        orgId,
        pluginId: selector.pluginId,
        resourceTypeId: selector.resourceTypeId,
        resourceId: selector.resourceId,
        accountId: selector.accountId,
        // Sidecar streams route the cloud logs endpoint through the peer
        // client built from this parent (the IPC already forwards it).
        ...(selector.parentResourceId ? { parentResourceId: selector.parentResourceId } : {}),
        ...params,
      });
    },
    savedQueries: cloudSavedQueries(orgId),
  };
}
