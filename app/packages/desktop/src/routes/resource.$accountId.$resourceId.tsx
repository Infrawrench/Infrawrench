import { useState, useEffect, useCallback, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type {
  ResourceInstance,
  DetailViewSchema,
  FieldDefinition,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  ResourceTypeDefinition,
  ArtifactEntry,
  QueryCostEstimate,
  CredentialFormat,
  SecretVersionMutation,
} from "@infrawrench/plugin-base";
import {
  queryResultSchema,
  queryExecuteResultSchema,
  queryCostEstimateSchema,
  evaluatePeerIntegrationUnreachable,
} from "@infrawrench/plugin-base";
import {
  getCloudManifest,
  applyCloudManifest,
  invokeCloudAction,
  runCloudNoSqlCommand,
  getCloudDescribe,
  getCloudLogs,
  deleteCloudResource,
  fetchCloudPeerPanes,
  cloudSqlQuery,
  cloudSqlExecute,
  cloudSqlEstimate,
  cloudListArtifacts,
  cloudKvBrowserList,
  cloudKvBrowserGet,
  cloudKvBrowserPut,
  cloudKvBrowserDelete,
  listCloudSecretVersions,
  accessCloudSecretVersion,
  addCloudSecretVersion,
  modifyCloudSecretVersion,
} from "../lib/cloud-api";
import {
  REFRESH_RESOURCE_EVENT,
  NAVIGATE_TO_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
  REROLL_PARENT_OUTPUT_EVENT,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  resourceTabTitle,
  formatErrorMessage,
  toast,
  type QueryResult,
  type ChildResourceGroup,
  type NavigateToResourceDetail,
  type InvokePluginActionDetail,
  type PromptNoSqlCommandDetail,
  type RerollParentOutputDetail,
  type ResourcePickerOption,
  type RerollSelection,
  useUIStore,
  useTabId,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import type { AccountRow } from "../db/rows";
import { getPlugin } from "../plugins/loader";
import {
  sqlQuery,
  sqlExecute,
  buildPluginHostServices,
  persistPlaintextSecret,
} from "../lib/sql-drivers";
import { createPluginClient } from "../lib/plugin-client";
import { applyCredentialRewriters } from "../lib/credential-rewriters";
import type {
  PluginClient,
  PeerPaneContext,
  AssociationSource,
  ChatMessage,
  ChatStreamEvent,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";
import type { PeerPaneData } from "@infrawrench/ui";
import {
  accountTabTarget,
  navigateToWorkspaceTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  resourceTabTarget,
} from "../lib/workspace-tabs";
import { SftpViewPane } from "./_resource-detail/-SftpViewPane";
import { SshViewPane } from "./_resource-detail/-SshViewPane";
import { ResourceActionBar } from "./_resource-detail/-ResourceActionBar";
import { ResourceFooterBar } from "./_resource-detail/-ResourceFooterBar";
import { SshConnectionBar } from "./_resource-detail/-SshConnectionBar";
import { DataPanels } from "./_resource-detail/-DataPanels";
import { K8sConsoleModal } from "./_resource-detail/-K8sConsoleModal";
import { DetailViewContainer } from "./_resource-detail/-DetailViewContainer";
import { StorageBrowserContainer } from "./_resource-detail/-StorageBrowserContainer";
import { ResourceModals } from "./_resource-detail/-ResourceModals";
import {
  loadCloudResource,
  loadLocalPeerResource,
  loadLocalResource,
  type LoaderParams,
  type LoaderRefs,
  type LoaderSetters,
} from "./_resource-detail/-loader";
import type { CloudCtx, QuickSshConnection, SshConfig } from "./_resource-detail/-types";

/** A one-event async iterable that yields a chat-stream `error` and stops. */
function errorChatIterable(message: string): AsyncIterable<ChatStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { kind: "error", message };
    },
  };
}

export const Route = createFileRoute("/resource/$accountId/$resourceId")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  component: () => null,
  validateSearch: (
    search: Record<string, unknown>,
  ): { plugin?: string; type?: string; parent?: string } => ({
    ...(typeof search["plugin"] === "string" ? { plugin: search["plugin"] } : {}),
    ...(typeof search["type"] === "string" ? { type: search["type"] } : {}),
    ...(typeof search["parent"] === "string" ? { parent: search["parent"] } : {}),
  }),
});

interface ResourcePanelProps {
  accountId: string;
  resourceId: string;
  peerPlugin?: string | undefined;
  peerType?: string | undefined;
  peerParent?: string | undefined;
  /** "" | "ssh" | "sftp" — drives the view selection. */
  view: string;
}

export function ResourcePanel({
  accountId,
  resourceId,
  peerPlugin,
  peerType,
  peerParent,
  view: locationHash,
}: ResourcePanelProps) {
  const tabId = useTabId();
  const decodedResourceId = decodeURIComponent(resourceId);

  const [account, setAccount] = useState<AccountRow | null>(null);
  const [resource, setResource] = useState<ResourceInstance | null>(null);
  const [schema, setSchema] = useState<DetailViewSchema | null>(null);
  const [logoSvg, setLogoSvg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pgConnected, setPgConnected] = useState(false);
  const [pgError, setPgError] = useState<string | null>(null);
  const [kvConnected, setKvConnected] = useState(false);
  const [isKvPlugin, setIsKvPlugin] = useState(false);
  const [kvDriverName, setKvDriverName] = useState<string | null>(null);
  const [isDockerPlugin, setIsDockerPlugin] = useState(false);
  const [dockerDriverName, setDockerDriverName] = useState<string | null>(null);
  const [dockerHostRef] = useState({ current: "" });

  const connectionStringRef = useRef("");
  const sqlDriverIdRef = useRef("");
  const clientRef = useRef<PluginClient | null>(null);
  const cloudCtxRef = useRef<CloudCtx | null>(null);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const [hasStorageToken, setHasStorageToken] = useState(false);
  const [sshConfig, setSshConfig] = useState<SshConfig | null>(null);
  const [sshHost, setSshHost] = useState<string | null>(null);
  const [sshDefaultUsername, setSshDefaultUsername] = useState<string | null>(null);
  const [quickSshConnection, setQuickSshConnection] = useState<QuickSshConnection | null>(null);
  const [showTunnelModal, setShowTunnelModal] = useState(false);
  const [showDockerSetup, setShowDockerSetup] = useState(false);
  const [showDropSpotlight, setShowDropSpotlight] = useState(false);
  const setAccountConnected = useUIStore((s) => s.setAccountConnected);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const [canDelete, setCanDelete] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [editableFields, setEditableFields] = useState<FieldDefinition[]>([]);
  const [credentialFormats, setCredentialFormats] = useState<CredentialFormat[]>([]);
  const [showExportCredential, setShowExportCredential] = useState(false);
  const [resourceTypeLabel, setResourceTypeLabel] = useState<string>("Resource");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [peerPanes, setPeerPanes] = useState<PeerPaneData[]>([]);
  const [childResourceGroups, setChildResourceGroups] = useState<ChildResourceGroup[]>([]);
  const [createChildTarget, setCreateChildTarget] = useState<ResourceTypeDefinition | null>(null);
  const [metricSeries, setMetricSeries] = useState<MetricSeries[] | undefined>(undefined);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const backgroundRefreshRef = useRef(false);
  const loadingRef = useRef(true);
  const peerPanesHydratingRef = useRef(false);
  const peerPanesRef = useRef<PeerPaneData[]>([]);
  const handlePeerPaneOpenRef = useRef<(() => void) | null>(null);
  const localPeerCtxRef = useRef<{
    peerIntegrations: ResourceTypeDefinition["peerIntegrations"];
    parentPluginId: string;
    parentResourceTypeId: string;
    parentResourceId: string;
    parentResourceFields: Record<string, unknown>;
    parentResourceOutputs: Record<string, unknown>;
  } | null>(null);
  const peerParentRerollRef = useRef<((outputKey: string) => Promise<void>) | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const isBackground = backgroundRefreshRef.current;
    backgroundRefreshRef.current = false;
    if (!isBackground) {
      peerPanesHydratingRef.current = false;
      localPeerCtxRef.current = null;
      peerParentRerollRef.current = null;
      cloudCtxRef.current = null;
      clientRef.current = null;
      setLoading(true);
      setError(null);
      setPgError(null);
      setSchema(null);
      setResource(null);
      setAccount(null);
      setLogoSvg("");
      setPeerPanes([]);
      setChildResourceGroups([]);
      setMetricSeries(undefined);
    }

    const refs: LoaderRefs = {
      connectionString: connectionStringRef,
      sqlDriverId: sqlDriverIdRef,
      client: clientRef,
      cloudCtx: cloudCtxRef,
      dockerHost: dockerHostRef,
      localPeerCtx: localPeerCtxRef,
      peerParentReroll: peerParentRerollRef,
    };
    const setters: LoaderSetters = {
      setAccount,
      setResource,
      setSchema,
      setLogoSvg,
      setLoading,
      setError,
      setPgConnected,
      setPgError,
      setKvConnected,
      setIsKvPlugin,
      setKvDriverName,
      setIsDockerPlugin,
      setDockerDriverName,
      setHasStorageToken,
      setSshConfig,
      setSshHost,
      setSshDefaultUsername,
      setCanDelete,
      setCanEdit,
      setEditableFields,
      setCredentialFormats,
      setResourceTypeLabel,
      setPeerPanes,
      setChildResourceGroups,
      setMetricSeries,
    };
    const loaderParams: LoaderParams = {
      accountId,
      decodedResourceId,
      peerPlugin,
      peerType,
      peerParent,
      locationHash,
      isBackground,
      isCancelled: () => cancelled,
      refs,
      setters,
      setAccountConnected,
      tabId,
    };

    async function load() {
      if (!isBackground) {
        setError(null);
        setPgError(null);
      }
      try {
        const orgId = useUIStore.getState().activeCloudOrgId;
        if (orgId) {
          await loadCloudResource(orgId, loaderParams);
          return;
        }
        cloudCtxRef.current = null;
        if (peerPlugin && peerType && peerParent) {
          await loadLocalPeerResource(loaderParams);
          return;
        }
        await loadLocalResource(loaderParams);
      } catch (e) {
        if (!cancelled && !isBackground) {
          setError(formatErrorMessage(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accountId,
    decodedResourceId,
    refreshVersion,
    activeCloudOrgId,
    peerPlugin,
    peerType,
    peerParent,
  ]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    peerPanesRef.current = peerPanes;
  }, [peerPanes]);

  // Background refresh — auto every 30 s and on manual "Refresh" action
  useEffect(() => {
    function bgRefresh() {
      if (loadingRef.current) return; // skip if a navigation is already in flight
      const hasHydratedPanes = peerPanesRef.current.some((p) => !p.loading);
      backgroundRefreshRef.current = true;
      setRefreshVersion((v) => v + 1);
      if (hasHydratedPanes && handlePeerPaneOpenRef.current) {
        peerPanesHydratingRef.current = false;
        handlePeerPaneOpenRef.current();
      }
    }
    const id = setInterval(bgRefresh, 30_000);
    window.addEventListener(REFRESH_RESOURCE_EVENT, bgRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener(REFRESH_RESOURCE_EVENT, bgRefresh);
    };
  }, []);

  // Listen for schema-emitted navigate-to-resource actions. The target account
  // is the first colon-segment of the resource ID (see ListerContext.id).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NavigateToResourceDetail>).detail;
      if (!detail) return;
      const targetAccountId = detail.resourceId.split(":")[0] ?? accountId;
      void navigateToWorkspaceTarget(
        navigate,
        resourceTabTarget(
          targetAccountId,
          detail.resourceId,
          detail.pluginId,
          detail.resourceTypeId,
        ),
      );
    };
    window.addEventListener(NAVIGATE_TO_RESOURCE_EVENT, handler);
    return () => window.removeEventListener(NAVIGATE_TO_RESOURCE_EVENT, handler);
  }, [navigate, accountId]);

  // Listen for schema-emitted plugin-action events and dispatch to either the
  // cloud backend or the local plugin client, then refresh the view.
  useEffect(() => {
    async function handler(e: Event) {
      const detail = (e as CustomEvent<InvokePluginActionDetail>).detail;
      if (!detail) return;
      // Scope to this panel — the workspace mounts every open tab, so an
      // unscoped action would run once per mounted panel (against the wrong
      // resource for non-matching panels).
      if (detail.resourceId && detail.resourceId !== decodedResourceId) return;
      if (detail.confirmMessage && !window.confirm(detail.confirmMessage)) return;
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) return;
      try {
        if (cloud) {
          await invokeCloudAction(cloud.orgId, {
            pluginId: cloud.pluginId,
            accountId,
            resourceTypeId: res.resourceTypeId,
            resourceId: decodedResourceId,
            actionId: detail.actionId,
            ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
          });
        } else {
          const client = clientRef.current;
          if (!client?.invokeAction) {
            throw new Error("Plugin does not support custom actions");
          }
          await client.invokeAction(
            res.resourceTypeId,
            decodedResourceId,
            detail.actionId,
            accountId,
          );
        }
        if (detail.successMessage) {
          window.alert(detail.successMessage);
        }
        dispatchRefreshResource();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Action failed");
      }
    }
    window.addEventListener(INVOKE_PLUGIN_ACTION_EVENT, handler);
    return () => window.removeEventListener(INVOKE_PLUGIN_ACTION_EVENT, handler);
  }, [accountId, decodedResourceId, resource]);

  useEffect(() => {
    async function handler(e: Event) {
      const detail = (e as CustomEvent<RerollParentOutputDetail>).detail;
      if (!detail) return;
      const reroll = peerParentRerollRef.current;
      if (!reroll) {
        toast.error("Reroll has no upstream parent to delegate to.");
        return;
      }
      const message =
        detail.confirmMessage ??
        "Reset the upstream credential? This may invalidate cached connections.";
      if (!window.confirm(message)) return;
      try {
        await reroll(detail.outputKey);
        toast.success("Upstream credential rerolled.");
        dispatchRefreshResource();
      } catch (err) {
        toast.error(`Reroll failed: ${formatErrorMessage(err)}`);
      }
    }
    window.addEventListener(REROLL_PARENT_OUTPUT_EVENT, handler);
    return () => window.removeEventListener(REROLL_PARENT_OUTPUT_EVENT, handler);
  }, []);

  const handleNoSqlCommand = useCallback(
    async (command: string, args: (string | number)[]): Promise<unknown> => {
      const cloud = cloudCtxRef.current;
      const res = resource;
      if (!res) throw new Error("Resource not loaded");
      if (cloud) {
        return runCloudNoSqlCommand(cloud.orgId, {
          pluginId: cloud.pluginId,
          accountId,
          resourceTypeId: res.resourceTypeId,
          resourceId: decodedResourceId,
          command,
          args,
          ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
        });
      }
      const client = clientRef.current;
      if (!client?.executeNoSqlCommand) {
        throw new Error("Plugin does not support NoSQL commands");
      }
      return client.executeNoSqlCommand(
        res.resourceTypeId,
        decodedResourceId,
        accountId,
        command,
        args,
      );
    },
    [accountId, decodedResourceId, resource],
  );

  // Modal state for prompt-nosql-command. Electron renderer doesn't
  // implement window.prompt, so we use an in-app modal for field input.
  const [promptModal, setPromptModal] = useState<PromptNoSqlCommandDetail | null>(null);

  // Resolves resource-picker options for any resource-picker fields used in
  // a prompt-nosql-command form (e.g. picking a Pub/Sub topic when creating
  // an Eventarc trigger).
  const loadPromptResources = useCallback(
    async (sources: AssociationSource[], acctId: string): Promise<ResourcePickerOption[]> => {
      const results: ResourcePickerOption[] = [];
      const localClients = new Map<string, Promise<PluginClient>>();
      const getLocalClient = (a: string, p: string) => {
        const key = `${a}:${p}`;
        let existing = localClients.get(key);
        if (!existing) {
          existing = createPluginClient(a, p);
          localClients.set(key, existing);
        }
        return existing;
      };
      for (const source of sources) {
        try {
          const client = await getLocalClient(acctId, source.pluginId);
          const resources = await client.listResources(source.resourceTypeId, acctId);
          for (const resource of resources) {
            try {
              // Prefer the value the lister already populated — avoids an N+1
              // re-list when resolveOutput would just re-fetch the same data.
              const preResolved = resource.resolvedOutputs[source.outputKey];
              const outputValue =
                preResolved != null && String(preResolved) !== ""
                  ? String(preResolved)
                  : client.resolveOutput
                    ? await client.resolveOutput(
                        source.resourceTypeId,
                        resource.id,
                        source.outputKey,
                        acctId,
                      )
                    : "";
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
              /* skip resources whose output can't be resolved */
            }
          }
        } catch {
          /* skip sources whose plugin isn't loaded for this account */
        }
      }
      return results;
    },
    [],
  );

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<PromptNoSqlCommandDetail>).detail;
      if (!detail) return;
      // The workspace keeps every open tab's panel mounted, so this global
      // event reaches all of them. Only the panel whose resource matches
      // should react — otherwise N panels each open their own modal.
      if (detail.resourceId && detail.resourceId !== decodedResourceId) return;
      setPromptModal(detail);
    }
    window.addEventListener(PROMPT_NOSQL_COMMAND_EVENT, handler);
    return () => window.removeEventListener(PROMPT_NOSQL_COMMAND_EVENT, handler);
  }, [decodedResourceId]);

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
    (messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ChatStreamEvent> => {
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
      return client.streamChatMessage(res.resourceTypeId, decodedResourceId, accountId, messages);
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

  const handlePeerPaneOpen = useCallback(() => {
    if (peerPanesHydratingRef.current) return;
    const cloud = cloudCtxRef.current;
    if (cloud) {
      peerPanesHydratingRef.current = true;
      void (async () => {
        try {
          const result = (await fetchCloudPeerPanes(
            cloud.orgId,
            cloud.pluginId,
            cloud.resourceTypeId,
            {
              accountId,
              resourceId: decodedResourceId,
              ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
            },
          )) as Array<{
            tabLabel: string;
            pluginLogoSvg: string;
            schema: PeerPaneData["schema"];
            peerPluginId: string;
          }>;
          setPeerPanes(
            result.map((p) => ({
              tabLabel: p.tabLabel,
              pluginLogoSvg: p.pluginLogoSvg,
              credentials: {},
              schema: p.schema,
            })),
          );
        } catch {
          peerPanesHydratingRef.current = false;
        }
      })();
      return;
    }

    const localCtx = localPeerCtxRef.current;
    const client = clientRef.current;
    if (!localCtx || !client) return;
    peerPanesHydratingRef.current = true;
    void (async () => {
      const resolved: PeerPaneData[] = [];
      await Promise.allSettled(
        (localCtx.peerIntegrations ?? []).map(async (integration) => {
          // Provider-declared unreachable check (e.g. private-IP-only Cloud
          // SQL). Skip resolving outputs / rewriters / the peer plugin and
          // just render the guidance pane.
          const guidance = evaluatePeerIntegrationUnreachable(
            integration,
            localCtx.parentResourceFields,
          );
          if (guidance) {
            const peerLoaded = await getPlugin(integration.pluginId);
            if (!peerLoaded) return;
            resolved.push({
              tabLabel: integration.tabLabel,
              pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
              credentials: {},
              schema: { resourceGroups: [], guidance },
            });
            return;
          }
          try {
            const peerCredentials: Record<string, string> = {};
            for (const mapping of integration.credentialMappings) {
              const value = await client.resolveOutput(
                localCtx.parentResourceTypeId,
                localCtx.parentResourceId,
                mapping.outputKey,
                accountId,
              );
              peerCredentials[mapping.credentialKey] = value;
            }
            await applyCredentialRewriters(
              {
                accountId,
                resourcePluginId: localCtx.parentPluginId,
                resourceTypeId: localCtx.parentResourceTypeId,
                resourceId: localCtx.parentResourceId,
                resourceFields: localCtx.parentResourceFields,
                resourceOutputs: localCtx.parentResourceOutputs,
              },
              peerCredentials,
            );
            const peerLoaded = await getPlugin(integration.pluginId);
            if (!peerLoaded) return;
            const peerServices = buildPluginHostServices(
              peerLoaded.plugin.manifest,
              peerCredentials,
            );
            const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerServices);
            if (!peerClient.renderPeerPane) return;
            const context: PeerPaneContext = {
              tabLabel: integration.tabLabel,
              parentPluginId: localCtx.parentPluginId,
              parentResourceTypeId: localCtx.parentResourceTypeId,
              parentResourceId: localCtx.parentResourceId,
              accountId,
            };
            const peerSchema = await peerClient.renderPeerPane(context);
            resolved.push({
              tabLabel: integration.tabLabel,
              pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
              credentials: peerCredentials,
              schema: { ...peerSchema, supportsYamlImport: !!peerClient.importYaml },
            });
          } catch (err) {
            const peerLoaded = await getPlugin(integration.pluginId);
            if (!peerLoaded) return;
            const message = err instanceof Error ? err.message : String(err);
            // Credential-setup CTA (e.g. "Make connection user") → guidance +
            // button in-pane instead of a bare error.
            if (integration.credentialSetupAction) {
              resolved.push({
                tabLabel: integration.tabLabel,
                pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
                credentials: {},
                schema: {
                  resourceGroups: [],
                  guidance: {
                    title: message,
                    suggestions: [],
                    action: integration.credentialSetupAction,
                  },
                },
              });
              return;
            }
            resolved.push({
              tabLabel: integration.tabLabel,
              pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
              credentials: {},
              schema: {
                status: { kind: "status-dot", status: "error", label: message },
                resourceGroups: [],
              },
            });
          }
        }),
      );
      setPeerPanes(resolved);
    })();
  }, [accountId, decodedResourceId]);

  useEffect(() => {
    handlePeerPaneOpenRef.current = handlePeerPaneOpen;
  }, [handlePeerPaneOpen]);

  async function handleReroll(
    fieldKey: string,
    selection: RerollSelection | { kind: "literal"; value: string },
  ) {
    if (!resource) return;
    if (selection.kind !== "literal") {
      toast.error("This field only accepts a literal value.");
      return;
    }
    const client = clientRef.current;
    if (!client) {
      toast.error("Plugin client not ready.");
      return;
    }
    try {
      // Push to the upstream provider first so the local store never holds a
      // value the provider hasn't accepted. Plugins that don't implement
      // applySecretReroll skip the upstream call (literal-only persist).
      if (client.applySecretReroll) {
        await client.applySecretReroll(
          resource.resourceTypeId,
          resource.id,
          accountId,
          fieldKey,
          selection.value,
        );
      }
      await persistPlaintextSecret(resource.id, fieldKey, selection.value);
      toast.success(`${fieldKey} updated.`);
      dispatchRefreshResource();
    } catch (err) {
      toast.error(`Reroll failed: ${formatErrorMessage(err)}`);
    }
  }

  async function handleUpdate(changedFields: Record<string, string>): Promise<void> {
    if (!resource) throw new Error("Resource not loaded");
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const { updateCloudResource } = await import("../lib/cloud-api");
      await updateCloudResource(cloud.orgId, {
        accountId,
        pluginId: cloud.pluginId,
        resourceTypeId: cloud.resourceTypeId,
        resourceId: decodedResourceId,
        fields: changedFields,
        ...(cloud.parentResourceId ? { parentResourceId: cloud.parentResourceId } : {}),
      });
      toast.success(`${resourceTypeLabel} updated.`);
      dispatchRefreshResource();
      return;
    }
    const client = clientRef.current;
    if (!client?.updateResource) throw new Error("Plugin does not support updates");
    const updated = await client.updateResource(
      resource.resourceTypeId,
      resource.id,
      accountId,
      changedFields,
    );
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO resources
       (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json, outputs_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        updated.id,
        updated.pluginId,
        updated.resourceTypeId,
        updated.accountId,
        updated.displayName,
        updated.externalId ?? updated.id,
        JSON.stringify(updated.fields ?? {}),
        JSON.stringify(updated.resolvedOutputs ?? {}),
      ],
    );
    toast.success(`${resourceTypeLabel} updated.`);
    dispatchRefreshResource();
  }

  async function handleDelete() {
    if (!resource || !account) return;
    const cloud = cloudCtxRef.current;
    if (cloud) {
      await deleteCloudResource(
        cloud.orgId,
        cloud.pluginId,
        cloud.resourceTypeId,
        decodedResourceId,
        accountId,
      );
      removeWorkspaceTabs([
        `resource:${accountId}:${decodedResourceId}`,
        `resource:${accountId}:${decodedResourceId}:ssh`,
        `resource:${accountId}:${decodedResourceId}:sftp`,
      ]);
      dispatchResourcesChanged({ accountId, resourceTypeId: cloud.resourceTypeId });
      void navigateToWorkspaceTarget(navigate, accountTabTarget(accountId), {
        label: account.display_name,
      });
      return;
    }
    const client = clientRef.current;
    if (!client?.deleteResource) throw new Error("Plugin does not support deletion");
    await client.deleteResource(resource.resourceTypeId, resource.id, accountId);
    const db = await getDb();
    await db.execute("DELETE FROM dashboard_pins WHERE resource_id = $1", [resource.id]);
    await db.execute("DELETE FROM resources WHERE id = $1", [resource.id]);
    removeWorkspaceTabs([
      `resource:${accountId}:${decodedResourceId}`,
      `resource:${accountId}:${decodedResourceId}:ssh`,
      `resource:${accountId}:${decodedResourceId}:sftp`,
    ]);
    dispatchResourcesChanged({ accountId, resourceTypeId: resource.resourceTypeId });
    void navigateToWorkspaceTarget(navigate, accountTabTarget(accountId), {
      label: account.display_name,
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-muted text-sm animate-pulse">
        Loading…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  if (!schema) return null;

  const hasSqlEditor = !!schema?.sqlEditor && pgConnected;
  const hasStorageBrowser = !!schema?.storageBrowser;
  const hasTerminal = !!sshConfig;
  const hasSshPanel = hasTerminal || !!sshHost;
  const currentView = locationHash.replace(/^#/, "");
  const isSshView = currentView === "ssh";
  const isSftpView = currentView === "sftp";
  const hasSftpBrowser = !!sshConfig || !!sshHost;

  function openSshTab() {
    void navigateToWorkspaceTarget(navigate, resourceSshTabTarget(accountId, decodedResourceId), {
      label: resourceTabTitle(resource?.displayName ?? "", "ssh") || "SSH",
      mode: "pin",
    });
  }

  function openSftpTab() {
    void navigateToWorkspaceTarget(navigate, resourceSftpTabTarget(accountId, decodedResourceId), {
      label: resourceTabTitle(resource?.displayName ?? "", "sftp") || "SFTP",
      mode: "pin",
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {isSftpView && (
          <SftpViewPane
            activeCloudOrgId={activeCloudOrgId}
            accountId={accountId}
            decodedResourceId={decodedResourceId}
            sshHost={sshHost}
            sshDefaultUsername={sshDefaultUsername}
            sshConfig={sshConfig}
            quickSshConnection={quickSshConnection}
            onConnect={(config) => setQuickSshConnection(config)}
          />
        )}

        {!isSshView && !isSftpView && (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {(hasSshPanel || hasSftpBrowser || resource) && (
              <ResourceActionBar
                hasSftpBrowser={hasSftpBrowser}
                hasSshPanel={hasSshPanel}
                sshHost={sshHost}
                onOpenSftpTab={openSftpTab}
                onOpenSshTab={openSshTab}
                onShowTunnelModal={() => setShowTunnelModal(true)}
                onShowDockerSetup={() => setShowDockerSetup(true)}
                onShowDropSpotlight={() => setShowDropSpotlight(true)}
              />
            )}
            <DetailViewContainer
              schema={schema}
              decodedResourceId={decodedResourceId}
              accountId={accountId}
              logoSvg={logoSvg}
              resource={resource}
              peerPanes={peerPanes}
              childResourceGroups={childResourceGroups}
              metricSeries={metricSeries}
              hasSqlEditor={hasSqlEditor}
              activeCloudOrgId={activeCloudOrgId}
              cloudParentResourceId={cloudCtxRef.current?.parentResourceId}
              accountPluginId={account?.plugin_id}
              onPeerPaneOpen={handlePeerPaneOpen}
              onRunQuery={handleRunQuery}
              onExecute={handleExecute}
              onEstimateQueryCost={handleEstimateQueryCost}
              onListKvKeys={handleListKvKeys}
              onGetKvValue={handleGetKvValue}
              onPutKvValue={handlePutKvValue}
              onDeleteKvKey={handleDeleteKvKey}
              onGetManifest={handleGetManifest}
              onApplyManifest={handleApplyManifest}
              onGetDescribe={handleGetDescribe}
              onGetLogs={handleGetLogs}
              onListArtifacts={handleListArtifacts}
              onListSecretVersions={handleListSecretVersions}
              onAccessSecretVersion={handleAccessSecretVersion}
              onAddSecretVersion={handleAddSecretVersion}
              onModifySecretVersion={handleModifySecretVersion}
              onOpenConsole={() => setConsoleOpen(true)}
              onNoSqlCommand={handleNoSqlCommand}
              onChatStream={handleChatStream}
              onPublishMessage={handlePublishMessage}
              onChildCreate={(rt) => setCreateChildTarget(rt)}
              onReroll={handleReroll}
              {...(hasStorageBrowser && account
                ? {
                    renderStorageBrowser: () => (
                      <StorageBrowserContainer
                        schema={schema}
                        pluginId={account.plugin_id}
                        hasStorageToken={hasStorageToken}
                        getClient={() => clientRef.current!}
                      />
                    ),
                  }
                : {})}
            />
          </div>
        )}

        {isSshView && (
          <SshViewPane
            accountId={accountId}
            decodedResourceId={decodedResourceId}
            sshConfig={sshConfig}
            sshHost={sshHost}
            sshDefaultUsername={sshDefaultUsername}
            quickSshConnection={quickSshConnection}
            onConnect={(config) => setQuickSshConnection(config)}
          />
        )}
      </div>

      {/* SSH bottom bar — connection info + disconnect */}
      {isSshView && (hasTerminal || quickSshConnection) && (
        <SshConnectionBar
          sshConfig={sshConfig}
          sshHost={sshHost}
          quickSshConnection={quickSshConnection}
          onDisconnect={() => setQuickSshConnection(null)}
        />
      )}

      {/* Non-SSH bottom panels — hidden when in SSH view */}
      {!isSshView && !isSftpView && (canDelete || canEdit || credentialFormats.length > 0) && (
        <ResourceFooterBar
          canDelete={canDelete}
          canEdit={canEdit}
          hasCredentialFormats={credentialFormats.length > 0}
          resourceTypeLabel={resourceTypeLabel}
          onShowExportCredential={() => setShowExportCredential(true)}
          onConfirmDelete={() => setConfirmDelete(true)}
          onEdit={() => setShowEditModal(true)}
        />
      )}

      <ResourceModals
        showExportCredential={showExportCredential}
        resource={resource}
        credentialFormats={credentialFormats}
        accountId={accountId}
        decodedResourceId={decodedResourceId}
        onCloseExportCredential={() => setShowExportCredential(false)}
        getLocalClient={() => clientRef.current}
        getCloudCtx={() => cloudCtxRef.current}
        confirmDelete={confirmDelete}
        resourceTypeLabel={resourceTypeLabel}
        onCloseConfirmDelete={() => setConfirmDelete(false)}
        onConfirmDelete={() => handleDelete()}
        showEditModal={showEditModal}
        editableFields={editableFields}
        onCloseEditModal={() => setShowEditModal(false)}
        onSubmitEdit={(changed) => handleUpdate(changed)}
        promptModal={promptModal}
        onClosePromptModal={() => setPromptModal(null)}
        onSubmitPromptModal={async (values) => {
          // Pass the form values as a single JSON-encoded arg so plugins
          // can read by field key regardless of order or showWhen-hidden
          // fields.
          if (!promptModal) return;
          await handleNoSqlCommand(promptModal.command, [JSON.stringify(values)]);
          // Re-hydrate after a successful command so side effects land in the
          // view. Critical for "Make connection user": the minted credential
          // is persisted during the command, and only a refresh re-runs the
          // peer pane's resolveOutput to pick it up — without this the pane
          // stays stuck on the same "no password" guidance forever.
          dispatchRefreshResource();
        }}
        loadPromptResources={loadPromptResources}
        showTunnelModal={showTunnelModal}
        sshHost={sshHost}
        sshDefaultUsername={sshDefaultUsername}
        onCloseTunnelModal={() => setShowTunnelModal(false)}
        showDockerSetup={showDockerSetup}
        onCloseDockerSetup={() => setShowDockerSetup(false)}
        showDropSpotlight={showDropSpotlight}
        onCloseDropSpotlight={() => setShowDropSpotlight(false)}
        createChildTarget={createChildTarget}
        account={account}
        onCloseCreateChild={() => setCreateChildTarget(null)}
      />

      {!isSshView && !isSftpView && !hasSqlEditor && pgError && (
        <div className="shrink-0 px-4 py-2 border-t border-border bg-surface">
          <span className="text-xs text-red-400 font-mono">SQL connection failed: {pgError}</span>
        </div>
      )}

      {!isSshView && !isSftpView && (
        <DataPanels
          activeCloudOrgId={activeCloudOrgId}
          isKvPlugin={isKvPlugin}
          kvDriverName={kvDriverName}
          kvConnected={kvConnected}
          isDockerPlugin={isDockerPlugin}
          dockerDriverName={dockerDriverName}
          dockerHost={dockerHostRef.current}
          resource={resource}
          connectionString={connectionStringRef.current}
          accountId={accountId}
          peerPlugin={peerPlugin}
          peerParent={peerParent}
        />
      )}

      {consoleOpen && resource && activeCloudOrgId && cloudCtxRef.current?.parentResourceId && (
        <K8sConsoleModal
          resource={resource}
          orgId={activeCloudOrgId}
          accountId={accountId}
          parentResourceId={cloudCtxRef.current.parentResourceId}
          onClose={() => setConsoleOpen(false)}
        />
      )}
    </div>
  );
}
