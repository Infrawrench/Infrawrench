import { useCallback } from "react";
import type {
  ArtifactEntry,
  ChatMessage,
  ChatStreamEvent,
  LogsFetchParams,
  LogsFetchResult,
  PluginClient,
  PublishMessagePayload,
  PublishMessageResult,
  QueryCostEstimate,
  ResourceInstance,
  SecretVersionMutation,
} from "@infrawrench/plugin-base";
import {
  queryCostEstimateSchema,
  queryExecuteResultSchema,
  queryResultSchema,
} from "@infrawrench/plugin-base";
import { dispatchRefreshResource, type QueryResult } from "@infrawrench/ui";
import {
  accessCloudSecretVersion,
  addCloudSecretVersion,
  applyCloudManifest,
  cloudKvBrowserDelete,
  cloudKvBrowserGet,
  cloudKvBrowserList,
  cloudKvBrowserPut,
  cloudListArtifacts,
  cloudSqlEstimate,
  cloudSqlExecute,
  cloudSqlQuery,
  getCloudDescribe,
  getCloudLogs,
  getCloudManifest,
  listCloudSecretVersions,
  modifyCloudSecretVersion,
} from "../../lib/cloud-api";
import { sqlExecute, sqlQuery } from "../../lib/sql-drivers";
import type { CloudCtx } from "./-types";

/** A one-event async iterable that yields a chat-stream `error` and stops. */
function errorChatIterable(message: string): AsyncIterable<ChatStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { kind: "error", message };
    },
  };
}

/**
 * Everything the operations need in order to decide *where* to run. A resource
 * tab is either cloud-backed (`cloudCtxRef` set — the work happens server-side
 * over the cloud API) or local (`clientRef` holds a plugin client running in
 * this Electron process, with the SQL refs holding the live connection).
 */
export interface ResourceOperationsDeps {
  accountId: string;
  decodedResourceId: string;
  resource: ResourceInstance | null;
  cloudCtxRef: { current: CloudCtx | null };
  clientRef: { current: PluginClient | null };
  connectionStringRef: { current: string };
  sqlDriverIdRef: { current: string };
}

/**
 * The resource detail panel's data-access layer: SQL query/execute/estimate, KV
 * browsing, manifest get/apply, describe, logs, chat, publish, artifacts and
 * the secret-version verbs.
 *
 * Every one of these is the same shape — run against the cloud API when the tab
 * is cloud-backed, otherwise against the local plugin client — so they live
 * together here rather than in the panel component. Pulled out of
 * `resource.$accountId.$resourceId.tsx` verbatim; the hook is called
 * unconditionally from one place, so hook order is unchanged.
 */
export function useResourceOperations(deps: ResourceOperationsDeps) {
  const {
    accountId,
    decodedResourceId,
    resource,
    cloudCtxRef,
    clientRef,
    connectionStringRef,
    sqlDriverIdRef,
  } = deps;

  const handleRunQuery = useCallback(
    async (sql: string): Promise<QueryResult> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const raw = await cloudSqlQuery(cloud.orgId, {
          accountId,
          resourceId: decodedResourceId,
          resourceTypeId: cloud.resourceTypeId,
          sql,
        });
        return queryResultSchema.parse(raw);
      }
      const client = clientRef.current;
      if (client?.executeQuery) {
        return client.executeQuery(decodedResourceId, accountId, sql);
      }
      const cs = connectionStringRef.current;
      const driverId = sqlDriverIdRef.current;
      if (!cs) throw new Error("No active SQL connection");
      const start = performance.now();
      const rows = await sqlQuery(driverId, cs, sql);
      return { rows, durationMs: Math.round(performance.now() - start) };
    },
    [decodedResourceId, accountId],
  );

  const handleExecute = useCallback(
    async (sql: string, params: unknown[]): Promise<number> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const result = queryExecuteResultSchema.parse(
          await cloudSqlExecute(cloud.orgId, {
            accountId,
            resourceId: decodedResourceId,
            resourceTypeId: cloud.resourceTypeId,
            sql,
            params,
          }),
        );
        return result.affectedRows ?? 0;
      }
      const client = clientRef.current;
      if (client?.executeQuery) {
        await client.executeQuery(decodedResourceId, accountId, sql);
        return 0;
      }
      const cs = connectionStringRef.current;
      const driverId = sqlDriverIdRef.current;
      if (!cs) throw new Error("No active SQL connection");
      return sqlExecute(driverId, cs, sql, params);
    },
    [decodedResourceId, accountId],
  );

  const handleListKvKeys = useCallback(
    async (params: { prefix?: string; cursor?: string; limit?: number }) => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        return (await cloudKvBrowserList(cloud.orgId, {
          accountId,
          resourceTypeId: res.resourceTypeId,
          resourceId: decodedResourceId,
          ...params,
        })) as Awaited<ReturnType<NonNullable<PluginClient["listKvKeys"]>>>;
      }
      const client = clientRef.current;
      if (!client?.listKvKeys) throw new Error("Plugin does not support KV listing");
      return client.listKvKeys(res.resourceTypeId, decodedResourceId, accountId, params);
    },
    [accountId, decodedResourceId, resource],
  );

  const handleGetKvValue = useCallback(
    async (key: string): Promise<string> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        const r = (await cloudKvBrowserGet(cloud.orgId, {
          accountId,
          resourceTypeId: res.resourceTypeId,
          resourceId: decodedResourceId,
          key,
        })) as { value: string };
        return r.value;
      }
      const client = clientRef.current;
      if (!client?.getKvValue) throw new Error("Plugin does not support KV reads");
      return client.getKvValue(res.resourceTypeId, decodedResourceId, accountId, key);
    },
    [accountId, decodedResourceId, resource],
  );

  const handlePutKvValue = useCallback(
    async (key: string, value: string): Promise<void> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        await cloudKvBrowserPut(cloud.orgId, {
          accountId,
          resourceTypeId: res.resourceTypeId,
          resourceId: decodedResourceId,
          key,
          value,
        });
        return;
      }
      const client = clientRef.current;
      if (!client?.putKvValue) throw new Error("Plugin does not support KV writes");
      return client.putKvValue(res.resourceTypeId, decodedResourceId, accountId, key, value);
    },
    [accountId, decodedResourceId, resource],
  );

  const handleDeleteKvKey = useCallback(
    async (key: string): Promise<void> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        await cloudKvBrowserDelete(cloud.orgId, {
          accountId,
          resourceTypeId: res.resourceTypeId,
          resourceId: decodedResourceId,
          key,
        });
        return;
      }
      const client = clientRef.current;
      if (!client?.deleteKvKey) throw new Error("Plugin does not support KV deletes");
      return client.deleteKvKey(res.resourceTypeId, decodedResourceId, accountId, key);
    },
    [accountId, decodedResourceId, resource],
  );

  const handleEstimateQueryCost = useCallback(
    async (sql: string): Promise<QueryCostEstimate> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        return queryCostEstimateSchema.parse(
          await cloudSqlEstimate(cloud.orgId, {
            accountId,
            resourceId: decodedResourceId,
            sql,
          }),
        ) as QueryCostEstimate;
      }
      const client = clientRef.current;
      if (!client?.estimateQueryCost) {
        throw new Error("Query cost estimation is not supported for this resource");
      }
      return client.estimateQueryCost(decodedResourceId, accountId, sql);
    },
    [decodedResourceId, accountId],
  );

  const handleGetManifest = useCallback(async (): Promise<string> => {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const r = await getCloudManifest(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
        cloud.parentResourceId,
      );
      return r.manifest;
    }
    const client = clientRef.current;
    if (!client?.getManifest) throw new Error("Plugin does not support manifest viewing");
    return client.getManifest(decodedResourceId, accountId);
  }, [decodedResourceId, accountId]);

  const handleApplyManifest = useCallback(
    async (manifest: string): Promise<void> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        await applyCloudManifest(cloud.orgId, cloud.pluginId, cloud.resourceTypeId, {
          accountId,
          resourceId: decodedResourceId,
          manifest,
          ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
        });
        dispatchRefreshResource();
        return;
      }
      const client = clientRef.current;
      if (!client?.applyManifest) throw new Error("Plugin does not support manifest editing");
      await client.applyManifest(decodedResourceId, accountId, manifest);
      dispatchRefreshResource();
    },
    [decodedResourceId, accountId],
  );

  const handleGetDescribe = useCallback(async (): Promise<string> => {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const r = await getCloudDescribe(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
        cloud.parentResourceId,
      );
      return r.text;
    }
    const client = clientRef.current;
    if (!client?.describeResource) throw new Error("Plugin does not support describe");
    return client.describeResource(resource?.resourceTypeId ?? "", decodedResourceId, accountId);
  }, [decodedResourceId, accountId, resource]);

  // Bridge the plugin's `streamChatMessage` async iterable into the
  // ChatPanel's `onStream` callback. Local plugin clients run in-process so
  // we just forward the iterable. Cloud-routed accounts route through the
  // Infrawrench server's NDJSON chat stream endpoint.
  const handleChatStream = useCallback(
    (
      messages: ChatMessage[],
      signal: AbortSignal,
      options?: { model?: string },
    ): AsyncIterable<ChatStreamEvent> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) {
        return errorChatIterable("Resource not loaded");
      }
      if (cloud) {
        // Cloud-synced chat streaming is not wired through the desktop
        // → cloud bridge yet. Locally-added DO accounts work as-is.
        return errorChatIterable(
          "Chat over a cloud-synced account isn't supported yet from the desktop app. Run this agent against a locally-added DigitalOcean account.",
        );
      }
      const client = clientRef.current;
      if (!client?.streamChatMessage) {
        return errorChatIterable("Plugin does not support chat.");
      }
      void signal; // local plugin clients ignore aborts for now
      return client.streamChatMessage(
        res.resourceTypeId,
        decodedResourceId,
        accountId,
        messages,
        options,
      );
    },
    [accountId, decodedResourceId, resource],
  );

  // Forward the Publish tab's send to the plugin's publishMessage. Cloud-
  // synced accounts aren't bridged yet (no `cloud_publish_message` Tauri
  // command) — same constraint as chat, with a clear error.
  const handlePublishMessage = useCallback(
    async (payload: PublishMessagePayload): Promise<PublishMessageResult> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        throw new Error(
          "Publishing over a cloud-synced account isn't supported yet from the desktop app. Run this against a locally-added account.",
        );
      }
      const client = clientRef.current;
      if (!client?.publishMessage) throw new Error("Plugin does not support publishing.");
      return client.publishMessage(res.resourceTypeId, decodedResourceId, accountId, payload);
    },
    [accountId, decodedResourceId, resource],
  );

  const handleGetLogs = useCallback(
    async (params: LogsFetchParams): Promise<LogsFetchResult> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        return getCloudLogs(
          cloud.orgId,
          cloud.pluginId,
          cloud.resourceTypeId,
          decodedResourceId,
          accountId,
          {
            ...params,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          },
        );
      }
      const client = clientRef.current;
      if (!client?.getLogs) throw new Error("Plugin does not support logs");
      return client.getLogs(resource?.resourceTypeId ?? "", decodedResourceId, accountId, params);
    },
    [decodedResourceId, accountId, resource],
  );

  const handleListArtifacts = useCallback(
    async (params: {
      pageToken?: string;
      prefix?: string;
    }): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        return (await cloudListArtifacts(cloud.orgId, {
          accountId,
          resourceId: decodedResourceId,
          resourceTypeId: cloud.resourceTypeId,
          ...params,
        })) as { items: ArtifactEntry[]; nextPageToken?: string };
      }
      const client = clientRef.current;
      if (!client?.listArtifacts) throw new Error("Plugin does not support listing artifacts");
      return client.listArtifacts(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        params,
      );
    },
    [decodedResourceId, accountId, resource],
  );

  const handleListSecretVersions = useCallback(async () => {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const r = await listCloudSecretVersions(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
        cloud.parentResourceId,
      );
      return r.versions;
    }
    const client = clientRef.current;
    if (!client?.listSecretVersions) throw new Error("Plugin does not support secret versions");
    return client.listSecretVersions(resource?.resourceTypeId ?? "", decodedResourceId, accountId);
  }, [decodedResourceId, accountId, resource]);

  const handleAccessSecretVersion = useCallback(
    async (versionId: string) => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const r = await accessCloudSecretVersion(
          cloud.orgId,
          cloud.pluginId,
          cloud.resourceTypeId,
          {
            accountId,
            resourceId: decodedResourceId,
            versionId,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          },
        );
        return r.value;
      }
      const client = clientRef.current;
      if (!client?.accessSecretVersion) throw new Error("Plugin does not support secret versions");
      return client.accessSecretVersion(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        versionId,
      );
    },
    [decodedResourceId, accountId, resource],
  );

  const handleAddSecretVersion = useCallback(
    async (value: string) => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const r = await addCloudSecretVersion(cloud.orgId, cloud.pluginId, cloud.resourceTypeId, {
          accountId,
          resourceId: decodedResourceId,
          value,
          ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
        });
        dispatchRefreshResource();
        return r.version;
      }
      const client = clientRef.current;
      if (!client?.addSecretVersion) throw new Error("Plugin does not support secret versions");
      const v = await client.addSecretVersion(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        value,
      );
      dispatchRefreshResource();
      return v;
    },
    [decodedResourceId, accountId, resource],
  );

  const handleModifySecretVersion = useCallback(
    async (versionId: string, action: SecretVersionMutation) => {
      const cloud = cloudCtxRef.current;
      if (cloud) {
        const r = await modifyCloudSecretVersion(
          cloud.orgId,
          cloud.pluginId,
          cloud.resourceTypeId,
          {
            accountId,
            resourceId: decodedResourceId,
            versionId,
            action,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          },
        );
        return r.version;
      }
      const client = clientRef.current;
      if (!client?.modifySecretVersion) throw new Error("Plugin does not support secret versions");
      return client.modifySecretVersion(
        resource?.resourceTypeId ?? "",
        decodedResourceId,
        accountId,
        versionId,
        action,
      );
    },
    [decodedResourceId, accountId, resource],
  );

  return {
    handleRunQuery,
    handleExecute,
    handleListKvKeys,
    handleGetKvValue,
    handlePutKvValue,
    handleDeleteKvKey,
    handleEstimateQueryCost,
    handleGetManifest,
    handleApplyManifest,
    handleGetDescribe,
    handleChatStream,
    handlePublishMessage,
    handleGetLogs,
    handleListArtifacts,
    handleListSecretVersions,
    handleAccessSecretVersion,
    handleAddSecretVersion,
    handleModifySecretVersion,
  };
}
