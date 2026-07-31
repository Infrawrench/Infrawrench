import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  DetailView,
  DraggableChildPill,
  ConfirmDeleteModal,
  CredentialExportModal,
  EditResourceModal,
  dispatchResourcesChanged,
  buildChildResourceGroups,
  useUIStore,
  Modal,
  PeerPaneView,
  NAVIGATE_TO_RESOURCE_EVENT,
  formatErrorMessage,
  toast,
  RESOURCES_CHANGED_EVENT,
  buildDependencyGraph,
  directDependencies,
  type DependencyGraphData,
  type DependencyGraphNode,
  type ResourceDependencies,
  type QueryResult,
  type KvBrowserListParams,
  type ChildResource,
  type ChildResourceGroup,
  type NavigateToResourceDetail,
  type PeerPaneData,
} from "@infrawrench/ui";
import type {
  ArtifactEntry,
  ChatMessage,
  ChatStreamEvent,
  CredentialFormat,
  CredentialExport,
  DetailViewSchema,
  FieldDefinition,
  KvListResult,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PeerPaneResource,
  PeerPaneResourceGroup,
  PeerPaneSchema,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
  SynthesizeSpeechResult,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { createWebAgentClient } from "@/lib/agent-client";
import {
  agentLaunchLookupKey,
  resolveEffectiveAgentLaunch,
  type AgentLaunchDefaults,
} from "@/lib/agent-launch";
import {
  navigateToWorkspaceTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  resourceTabTarget,
} from "@/lib/workspace-tabs";
import { CreateResourceModal } from "./CreateResourceModal";
import { KvConsole } from "@/components/KvConsole";
import { DockerActionsPanel } from "@/components/DockerActionsPanel";
import { MongoDocumentBrowser } from "@/components/MongoDocumentBrowser";
import { FirestoreDocumentBrowser } from "@/components/FirestoreDocumentBrowser";
import { FirestoreMongoPeerBrowser } from "@/components/FirestoreMongoPeerBrowser";
import { StorageBrowser } from "@/components/StorageBrowser";
import { ResourceChangesPanel } from "@/components/ResourceChangesPanel";
import { SftpBrowser } from "@/components/SftpBrowser";
import { WebTerminal } from "@/components/WebTerminal";
import { SshQuickConnectPanel } from "@/components/SshQuickConnectPanel";
import { SpotlightSearch } from "./SpotlightSearch";
import { ConnectResourceModal } from "./ConnectResourceModal";
import { SshTunnelModal } from "./SshTunnelModal";
import { ConnectThroughJumpboxDialog } from "./ConnectThroughJumpboxDialog";
import { DockerSetupModal } from "./DockerSetupModal";
import { K8sExecTerminal } from "./K8sExecTerminal";
import { K9sTerminal } from "./K9sTerminal";
import type { SpotlightResult } from "@infrawrench/ui";

interface ChildResourceData {
  id: string;
  displayName: string;
  resourceTypeId: string;
  pluginId: string;
  accountId: string;
  status?: { kind: "status-dot"; status: string; label?: string } | undefined;
  fields?: Record<string, unknown> | undefined;
}

interface ChildTypeData {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate: boolean;
  fields?: FieldDefinition[];
}

interface PeerPaneServerData {
  tabLabel: string;
  pluginLogoSvg: string;
  schema: PeerPaneSchema;
  peerPluginId: string;
}

interface PeerIntegrationStub {
  tabLabel: string;
  pluginLogoSvg: string;
  peerPluginId: string;
}

interface Props {
  detailSchema: DetailViewSchema;
  childResources: ChildResourceData[];
  childTypes: ChildTypeData[];
  pluginId: string;
  pluginLogoSvg: string;
  resourceId: string;
  accountId: string;
  resourceTypeId: string;
  peerPanes: PeerPaneServerData[];
  peerIntegrationStubs?: PeerIntegrationStub[] | undefined;
  canDelete: boolean;
  canEdit?: boolean | undefined;
  editableFields?: FieldDefinition[] | undefined;
  credentialFormats?: CredentialFormat[] | undefined;
  hasManifestEditor: boolean;
  hasSecretVersions?: boolean | undefined;
  resourceDisplayName: string;
  resourceTypeLabel: string;
  hasSqlEditor?: boolean | undefined;
  hasStorageBrowser?: boolean | undefined;
  hasArtifactRegistry?: boolean | undefined;
  hasKvBrowser?: boolean | undefined;
  hasKvConsole?: boolean | undefined;
  kvDriverName?: string | undefined;
  isMongoDb?: boolean | undefined;
  hasDockerActions?: boolean | undefined;
  hasSshTerminal?: boolean | undefined;
  hasSftpBrowser?: boolean | undefined;
  sshHost?: string | undefined;
  sshPrivateHost?: string | undefined;
  defaultSshUsername?: string | undefined;
  containerId?: string | undefined;
  databaseName?: string | undefined;
  storageBucketName?: string | undefined;
  initialView?: "ssh" | "sftp" | undefined;
  agentSessionId?: string | undefined;
  initialSshKeyId?: string | undefined;
  initialSshKeyName?: string | undefined;
  initialCommand?: string | undefined;
  initialCwd?: string | undefined;
  supportsMetrics?: boolean | undefined;
  resourceFields?: Record<string, string | number | boolean> | undefined;
  parentResourceId?: string | undefined;
}

export function ResourceDetailClient({
  detailSchema,
  childResources,
  childTypes,
  pluginId,
  pluginLogoSvg,
  resourceId,
  accountId,
  resourceTypeId,
  peerPanes: serverPeerPanes,
  peerIntegrationStubs,
  canDelete,
  canEdit,
  editableFields,
  credentialFormats,
  hasManifestEditor,
  hasSecretVersions,
  resourceDisplayName,
  resourceTypeLabel,
  hasSqlEditor,
  hasStorageBrowser,
  hasArtifactRegistry,
  hasKvBrowser,
  hasKvConsole,
  kvDriverName,
  isMongoDb,
  hasDockerActions,
  hasSshTerminal,
  hasSftpBrowser,
  sshHost,
  sshPrivateHost,
  defaultSshUsername,
  containerId,
  databaseName,
  storageBucketName,
  initialView,
  agentSessionId,
  initialSshKeyId,
  initialSshKeyName,
  initialCommand,
  initialCwd,
  supportsMetrics,
  resourceFields,
  parentResourceId,
}: Props) {
  const navigate = useNavigate();
  const router = useRouter();
  const orgId = useOrgId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showExportCredential, setShowExportCredential] = useState(false);
  const [metricSeries, setMetricSeries] = useState<MetricSeries[] | undefined>(undefined);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleToken, setConsoleToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supportsMetrics) return;
    let cancelled = false;
    apiPost<{ series: MetricSeries[] }>(
      `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/metrics`,
      {
        accountId,
        resourceId,
        ...(parentResourceId ? { parentResourceId } : {}),
      },
    )
      .then((r) => {
        if (!cancelled) setMetricSeries(r.series);
      })
      .catch((err) => {
        if (!cancelled) toast.error(`Couldn't load metrics: ${formatErrorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [supportsMetrics, orgId, pluginId, resourceTypeId, accountId, resourceId, parentResourceId]);

  // Direct neighbors in the org's output-reference graph — drives the
  // "Dependencies" tab. Best-effort: on failure the tab simply doesn't show.
  const [dependencies, setDependencies] = useState<ResourceDependencies | null>(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      apiGet<DependencyGraphData>(
        `/api/org/${orgId}/dependency-graph?resourceId=${encodeURIComponent(resourceId)}`,
      )
        .then((graph) => {
          if (cancelled) return;
          const model = buildDependencyGraph(graph.nodes, graph.edges);
          setDependencies(directDependencies(model, resourceId));
        })
        .catch(() => {
          if (!cancelled) setDependencies(null);
        });
    }
    load();
    // Switching a field to (or off) an output reference happens on this very
    // page, so without this the tab keeps showing the pre-change neighbours
    // until the user navigates away and back.
    window.addEventListener(RESOURCES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(RESOURCES_CHANGED_EVENT, load);
    };
  }, [orgId, resourceId]);
  const handleOpenDependency = useCallback(
    (node: DependencyGraphNode) => {
      void navigate({
        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
        params: {
          orgId,
          pluginId: node.pluginId,
          resourceTypeId: node.resourceTypeId,
          resourceId: node.id,
        },
        search: { accountId: node.accountId },
      });
    },
    [navigate, orgId],
  );

  const [wsToken, setWsToken] = useState<string | null>(null);
  const [createTarget, setCreateTarget] = useState<ChildResourceGroup | null>(null);
  const [peerCreateTarget, setPeerCreateTarget] = useState<PeerPaneResourceGroup | null>(null);
  const [k9sPane, setK9sPane] = useState<{ peerPluginId: string; token: string } | null>(null);
  const [sshQuickConnect, setSshQuickConnect] = useState<{
    sshKeyId: string;
    username: string;
  } | null>(null);
  const [showDropSpotlight, setShowDropSpotlight] = useState(false);
  const [dropSource, setDropSource] = useState<SpotlightResult | null>(null);
  const [showSshTunnel, setShowSshTunnel] = useState(false);
  const [showJumpboxDialog, setShowJumpboxDialog] = useState(false);
  const [showDockerSetup, setShowDockerSetup] = useState(false);
  const agentForwardStorageKey = `ssh:agentForward:${accountId}:${resourceId}`;
  const [agentForward, setAgentForward] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(agentForwardStorageKey) === "1";
  });
  const toggleAgentForward = useCallback(() => {
    setAgentForward((prev) => {
      const next = !prev;
      window.localStorage.setItem(agentForwardStorageKey, next ? "1" : "0");
      return next;
    });
  }, [agentForwardStorageKey]);

  const isSshView = initialView === "ssh";
  const isSftpView = initialView === "sftp";
  const hasSshPanel = hasSshTerminal || !!sshHost;

  // Rehydrate launch metadata ONLY for agent tabs (agentSessionId present)
  // that are missing pieces of it (deep link or restored tab — the URL never
  // carries initialCommand/initialCwd). Plain SSH tabs must never look up
  // agent sessions — a VM that once hosted an agent session would otherwise
  // silently attach the agent's screen.
  const launchLookupKey = agentLaunchLookupKey({
    isSshView,
    accountId,
    resourceId,
    agentSessionId,
    sshKeyId: initialSshKeyId,
    sshKeyName: initialSshKeyName,
    initialCommand,
    initialCwd,
  });
  const [agentLaunchDefaults, setAgentLaunchDefaults] = useState<AgentLaunchDefaults>({});
  const [resolvedLaunchLookupKey, setResolvedLaunchLookupKey] = useState<string | null>(null);
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null);
  const [autoConnectPending, setAutoConnectPending] = useState(false);
  const [autoConnectError, setAutoConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!launchLookupKey || !agentSessionId) {
      setAgentLaunchDefaults({});
      setResolvedLaunchLookupKey(null);
      setAgentLaunchError(null);
      return;
    }

    let cancelled = false;
    setAgentLaunchError(null);
    createWebAgentClient(orgId)
      .openSession(agentSessionId)
      .then((opened) => {
        if (cancelled) return;
        const next: AgentLaunchDefaults = {};
        if (!initialSshKeyId && opened.sshKeyId) next.sshKeyId = opened.sshKeyId;
        if (!initialSshKeyName && opened.sshKeyName) next.sshKeyName = opened.sshKeyName;
        if (!initialCommand) next.initialCommand = opened.command;
        if (!initialCwd) next.initialCwd = opened.cwd;
        setAgentLaunchDefaults(next);
        setResolvedLaunchLookupKey(launchLookupKey);
      })
      .catch((err) => {
        console.warn(`Failed to resolve agent SSH launch metadata for ${agentSessionId}`, err);
        if (cancelled) return;
        setAgentLaunchDefaults({});
        setAgentLaunchError(
          `Couldn't prepare the agent SSH session: ${formatErrorMessage(err)}. You can still connect to the VM manually below.`,
        );
        setResolvedLaunchLookupKey(launchLookupKey);
      });

    return () => {
      cancelled = true;
    };
  }, [
    launchLookupKey,
    agentSessionId,
    orgId,
    initialSshKeyId,
    initialSshKeyName,
    initialCommand,
    initialCwd,
  ]);

  const agentLaunch = resolveEffectiveAgentLaunch({
    agentSessionId,
    sshKeyId: initialSshKeyId,
    sshKeyName: initialSshKeyName,
    initialCommand,
    initialCwd,
    defaults: agentLaunchDefaults,
    resolving: Boolean(launchLookupKey && resolvedLaunchLookupKey !== launchLookupKey),
    failed: agentLaunchError !== null,
  });

  useEffect(() => {
    const keyId = agentLaunch.sshKeyId;
    // Auto-connect only applies to the full-screen SSH view — mirrors desktop,
    // where this effect lives in SshViewPane and never mounts for other views.
    if (!isSshView || !sshHost || !keyId || sshQuickConnect || wsToken) return;
    if (!agentLaunch.autoConnectReady) return;
    let cancelled = false;
    setAutoConnectError(null);
    setAutoConnectPending(true);
    apiPost<{ token: string }>(`/api/org/${orgId}/ws-token`)
      .then(({ token }) => {
        if (cancelled) return;
        setSshQuickConnect({
          sshKeyId: keyId,
          username: defaultSshUsername ?? "root",
        });
        setWsToken(token);
      })
      .catch((error) => {
        console.warn(`Failed to auto-connect SSH tab with key ${keyId}`, error);
        if (!cancelled) setAutoConnectError(formatErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setAutoConnectPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isSshView,
    sshHost,
    agentLaunch.sshKeyId,
    agentLaunch.autoConnectReady,
    sshQuickConnect,
    wsToken,
    orgId,
    defaultSshUsername,
  ]);

  const handleRunQuery = useCallback(
    async (sql: string): Promise<QueryResult> => {
      if (!hasSqlEditor) return { rows: [], durationMs: 0 };
      const result = await apiPost<{ rows: Record<string, unknown>[]; durationMs: number }>(
        `/api/org/${orgId}/sql/query`,
        { accountId, resourceId, resourceTypeId, sql },
      );
      return { rows: result.rows, durationMs: result.durationMs };
    },
    [orgId, accountId, resourceId, resourceTypeId, hasSqlEditor],
  );

  const handleExecute = useCallback(
    async (sql: string, params: unknown[]): Promise<number> => {
      const result = await apiPost<{ affectedRows: number }>(`/api/org/${orgId}/sql/execute`, {
        accountId,
        resourceId,
        resourceTypeId,
        sql,
        params,
      });
      return result.affectedRows;
    },
    [orgId, accountId, resourceId, resourceTypeId],
  );

  const handleEstimateQueryCost = useCallback(
    async (sql: string): Promise<QueryCostEstimate> => {
      return apiPost<QueryCostEstimate>(`/api/org/${orgId}/sql/estimate`, {
        accountId,
        resourceId,
        sql,
      });
    },
    [orgId, accountId, resourceId],
  );

  const handleListKvKeys = useCallback(
    async (params: KvBrowserListParams): Promise<KvListResult> => {
      return apiPost<KvListResult>(`/api/org/${orgId}/kv-browser/list`, {
        accountId,
        resourceTypeId,
        resourceId,
        ...params,
      });
    },
    [orgId, accountId, resourceId, resourceTypeId],
  );

  const handleGetKvValue = useCallback(
    async (key: string): Promise<string> => {
      const r = await apiPost<{ value: string }>(`/api/org/${orgId}/kv-browser/get`, {
        accountId,
        resourceTypeId,
        resourceId,
        key,
      });
      return r.value;
    },
    [orgId, accountId, resourceId, resourceTypeId],
  );

  const handlePutKvValue = useCallback(
    async (key: string, value: string): Promise<void> => {
      await apiPost(`/api/org/${orgId}/kv-browser/put`, {
        accountId,
        resourceTypeId,
        resourceId,
        key,
        value,
      });
    },
    [orgId, accountId, resourceId, resourceTypeId],
  );

  const handleDeleteKvKey = useCallback(
    async (key: string): Promise<void> => {
      await apiPost(`/api/org/${orgId}/kv-browser/delete`, {
        accountId,
        resourceTypeId,
        resourceId,
        key,
      });
    },
    [orgId, accountId, resourceId, resourceTypeId],
  );

  const handleChildClick = useCallback(
    (child: ChildResource) => {
      void navigate({
        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
        params: {
          orgId,
          pluginId: child.pluginId,
          resourceTypeId: child.resourceTypeId,
          resourceId: child.id,
        },
        search: {
          accountId: child.accountId,
        },
      });
    },
    [navigate, orgId],
  );

  // Schema-emitted `navigate-to-resource` actions go through a DOM event so the
  // host can do a tanstack client-side nav instead of a full page reload.
  // Target accountId is the first colon-segment of the resource ID (see
  // ListerContext.id() in plugin-base).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NavigateToResourceDetail>).detail;
      if (!detail) return;
      const targetAccountId = detail.resourceId.split(":")[0] ?? accountId;
      void navigate({
        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
        params: {
          orgId,
          pluginId: detail.pluginId,
          resourceTypeId: detail.resourceTypeId,
          resourceId: detail.resourceId,
        },
        search: { accountId: targetAccountId },
      });
    };
    window.addEventListener(NAVIGATE_TO_RESOURCE_EVENT, handler);
    return () => window.removeEventListener(NAVIGATE_TO_RESOURCE_EVENT, handler);
  }, [navigate, orgId, accountId]);

  const handleChildCreate = useCallback((group: ChildResourceGroup) => {
    setCreateTarget(group);
  }, []);

  const handleChildEdit = useCallback(
    async (child: ChildResource, changedFields: Record<string, string>): Promise<void> => {
      await apiPost(`/api/org/${orgId}/resources/update`, {
        accountId: child.accountId || accountId,
        pluginId: child.pluginId,
        resourceTypeId: child.resourceTypeId,
        resourceId: child.id,
        fields: changedFields,
        parentResourceId: resourceId,
      });
      toast.success("Saved.");
      dispatchResourcesChanged({ accountId, resourceTypeId: child.resourceTypeId });
      void router.invalidate();
    },
    [orgId, accountId, resourceId],
  );

  const handleChildDelete = useCallback(
    async (child: ChildResource): Promise<void> => {
      await apiDelete(
        `/api/org/${orgId}/resources/${child.pluginId}/${child.resourceTypeId}?resourceId=${encodeURIComponent(
          child.id,
        )}&accountId=${encodeURIComponent(child.accountId || accountId)}&parentResourceId=${encodeURIComponent(resourceId)}`,
      );
      toast.success("Deleted.");
      dispatchResourcesChanged({ accountId, resourceTypeId: child.resourceTypeId });
      void router.invalidate();
    },
    [orgId, accountId, resourceId],
  );

  const handleGetManifest = useCallback(async (): Promise<string> => {
    const result = await apiGet<{ manifest: string }>(
      `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/manifest?resourceId=${encodeURIComponent(resourceId)}&accountId=${accountId}${parentResourceId ? `&parentResourceId=${encodeURIComponent(parentResourceId)}` : ""}`,
    );
    return result.manifest;
  }, [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId]);

  const handleApplyManifest = useCallback(
    async (manifest: string): Promise<void> => {
      await apiPost(`/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/manifest`, {
        accountId,
        resourceId,
        manifest,
        ...(parentResourceId ? { parentResourceId } : {}),
      });
      dispatchResourcesChanged({ accountId, resourceTypeId });
    },
    [accountId, resourceId, pluginId, resourceTypeId, parentResourceId, orgId],
  );

  const handleGetDescribe = useCallback(async (): Promise<string> => {
    const r = await apiPost<{ text: string }>(
      `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/describe`,
      { accountId, resourceId, ...(parentResourceId ? { parentResourceId } : {}) },
    );
    return r.text;
  }, [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId]);

  const handleGetLogs = useCallback(
    async (params: LogsFetchParams): Promise<LogsFetchResult> => {
      return apiPost<LogsFetchResult>(
        `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/logs`,
        {
          accountId,
          resourceId,
          ...(parentResourceId ? { parentResourceId } : {}),
          ...params,
        },
      );
    },
    [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId],
  );

  // POST + NDJSON streaming chat. Server writes one ChatStreamEvent per
  // line; we read with `ReadableStream.getReader()` and yield each event as
  // it arrives so the ChatPanel can append tokens live.
  const handleChatStream = useCallback(
    (
      messages: ChatMessage[],
      signal: AbortSignal,
      options?: { model?: string },
    ): AsyncIterable<ChatStreamEvent> => {
      const url = `/api/org/${orgId}/resources/chat-stream`;
      const body = JSON.stringify({
        pluginId,
        accountId,
        resourceTypeId,
        resourceId,
        messages,
        ...(parentResourceId ? { parentResourceId } : {}),
        ...(options?.model ? { model: options.model } : {}),
      });
      return {
        async *[Symbol.asyncIterator]() {
          let res: Response;
          try {
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal,
              credentials: "include",
            });
          } catch (err) {
            yield {
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            };
            return;
          }
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            yield {
              kind: "error",
              message: `Server returned ${res.status}: ${text || res.statusText}`,
            };
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                  yield JSON.parse(trimmed) as ChatStreamEvent;
                } catch {
                  // Skip malformed event lines.
                }
              }
            }
            if (buffer.trim()) {
              try {
                yield JSON.parse(buffer.trim()) as ChatStreamEvent;
              } catch {
                /* skip */
              }
            }
          } catch (err) {
            if (signal.aborted) return;
            yield {
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            };
          } finally {
            try {
              reader.releaseLock();
            } catch {
              /* releaseLock can throw if already released */
            }
          }
        },
      };
    },
    [orgId, pluginId, accountId, resourceTypeId, resourceId, parentResourceId],
  );

  const handleListArtifacts = useCallback(
    async (params: { pageToken?: string; prefix?: string }) => {
      return apiPost<{ items: ArtifactEntry[]; nextPageToken?: string }>(
        `/api/org/${orgId}/artifacts/list`,
        {
          accountId,
          resourceId,
          resourceTypeId,
          ...params,
        },
      );
    },
    [orgId, accountId, resourceId, resourceTypeId],
  );

  const handlePublishMessage = useCallback(
    async (payload: { body: string; extras: Record<string, string | Record<string, string>> }) => {
      const res = await apiPost<{ result?: { id?: string; summary?: string } }>(
        `/api/org/${orgId}/resources/publish-message`,
        {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          payload,
          ...(parentResourceId ? { parentResourceId } : {}),
        },
      );
      return res.result ?? {};
    },
    [orgId, pluginId, accountId, resourceTypeId, resourceId, parentResourceId],
  );

  const handleSynthesizeSpeech = useCallback(
    async (payload: { text: string; voiceId?: string; modelId?: string }) => {
      const res = await apiPost<{ result: SynthesizeSpeechResult }>(
        `/api/org/${orgId}/resources/synthesize-speech`,
        {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          payload,
          ...(parentResourceId ? { parentResourceId } : {}),
        },
      );
      return res.result;
    },
    [orgId, pluginId, accountId, resourceTypeId, resourceId, parentResourceId],
  );

  const handleTranscribeAudio = useCallback(
    async (payload: {
      audioBase64: string;
      mimeType: string;
      fileName?: string;
      modelId?: string;
      language?: string;
    }) => {
      const res = await apiPost<{ result: TranscribeAudioResult }>(
        `/api/org/${orgId}/resources/transcribe-audio`,
        {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          payload,
          ...(parentResourceId ? { parentResourceId } : {}),
        },
      );
      return res.result;
    },
    [orgId, pluginId, accountId, resourceTypeId, resourceId, parentResourceId],
  );

  const handleListSecretVersions = useCallback(async (): Promise<SecretVersion[]> => {
    const r = await apiGet<{ versions: SecretVersion[] }>(
      `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/secret-versions?resourceId=${encodeURIComponent(resourceId)}&accountId=${accountId}${parentResourceId ? `&parentResourceId=${encodeURIComponent(parentResourceId)}` : ""}`,
    );
    return r.versions;
  }, [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId]);

  const handleAccessSecretVersion = useCallback(
    async (versionId: string): Promise<string> => {
      const r = await apiPost<{ value: string }>(
        `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/secret-versions/access`,
        {
          accountId,
          resourceId,
          versionId,
          ...(parentResourceId ? { parentResourceId } : {}),
        },
      );
      return r.value;
    },
    [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId],
  );

  const handleAddSecretVersion = useCallback(
    async (value: string): Promise<SecretVersion> => {
      const r = await apiPost<{ version: SecretVersion }>(
        `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/secret-versions/add`,
        {
          accountId,
          resourceId,
          value,
          ...(parentResourceId ? { parentResourceId } : {}),
        },
      );
      dispatchResourcesChanged({ accountId, resourceTypeId });
      return r.version;
    },
    [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId],
  );

  const handleModifySecretVersion = useCallback(
    async (versionId: string, action: SecretVersionMutation): Promise<SecretVersion> => {
      const r = await apiPost<{ version: SecretVersion }>(
        `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/secret-versions/modify`,
        {
          accountId,
          resourceId,
          versionId,
          action,
          ...(parentResourceId ? { parentResourceId } : {}),
        },
      );
      return r.version;
    },
    [orgId, accountId, resourceId, pluginId, resourceTypeId, parentResourceId],
  );

  async function handleDelete() {
    await apiDelete(
      `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}?resourceId=${encodeURIComponent(resourceId)}&accountId=${accountId}`,
    );
    void navigate({ to: "/org/$orgId/accounts/$accountId", params: { orgId, accountId } });
    dispatchResourcesChanged({ accountId, resourceTypeId });
  }

  async function handleUpdate(changedFields: Record<string, string>): Promise<void> {
    await apiPost(`/api/org/${orgId}/resources/update`, {
      accountId,
      pluginId,
      resourceTypeId,
      resourceId,
      fields: changedFields,
      ...(parentResourceId ? { parentResourceId } : {}),
    });
    toast.success(`${resourceTypeLabel} updated.`);
    dispatchResourcesChanged({ accountId, resourceTypeId });
  }

  const childResourceGroups = useMemo(
    () => buildChildResourceGroups(childTypes, childResources) as ChildResourceGroup[],
    [childResources, childTypes],
  );

  const hydratedPeerPanes = useRef<{ forResource: string; panes: PeerPaneServerData[] } | null>(
    null,
  );
  const [hydratedVersion, setHydratedVersion] = useState(0);
  const peerPanesHydratingRef = useRef(false);

  // Cache validity derives from resourceId: a cache hydrated for a different
  // resource is treated as absent, so no synchronous prop-change reset is needed.
  const hydratedForThisResource =
    hydratedPeerPanes.current?.forResource === resourceId ? hydratedPeerPanes.current.panes : null;

  const peerPanes = useMemo((): PeerPaneData[] => {
    void hydratedVersion;
    if (hydratedForThisResource) {
      return hydratedForThisResource.map((p) => ({
        tabLabel: p.tabLabel,
        pluginLogoSvg: p.pluginLogoSvg,
        credentials: {},
        schema: p.schema,
      }));
    }
    if (serverPeerPanes.length > 0) {
      return serverPeerPanes.map((p) => ({
        tabLabel: p.tabLabel,
        pluginLogoSvg: p.pluginLogoSvg,
        credentials: {},
        schema: p.schema,
      }));
    }
    return (peerIntegrationStubs ?? []).map((s) => ({
      tabLabel: s.tabLabel,
      pluginLogoSvg: s.pluginLogoSvg,
      credentials: {},
      schema: { resourceGroups: [] },
      loading: true,
    }));
  }, [serverPeerPanes, peerIntegrationStubs, hydratedVersion, hydratedForThisResource]);

  const activePeerPluginIds = useMemo(() => {
    if (hydratedForThisResource) return hydratedForThisResource.map((p) => p.peerPluginId);
    if (serverPeerPanes.length > 0) return serverPeerPanes.map((p) => p.peerPluginId);
    return (peerIntegrationStubs ?? []).map((s) => s.peerPluginId);
  }, [serverPeerPanes, peerIntegrationStubs, hydratedVersion, hydratedForThisResource]);

  const handlePeerPaneOpen = useCallback(() => {
    if (peerPanesHydratingRef.current) return;
    if (hydratedPeerPanes.current?.forResource === resourceId) return;
    if ((peerIntegrationStubs ?? []).length === 0) return;
    peerPanesHydratingRef.current = true;
    void (async () => {
      try {
        const result = await apiPost<PeerPaneServerData[]>(
          `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/peer-panes`,
          {
            accountId,
            resourceId,
            ...(parentResourceId ? { parentResourceId } : {}),
          },
        );
        hydratedPeerPanes.current = { forResource: resourceId, panes: result };
        peerPanesHydratingRef.current = false;
        setHydratedVersion((v) => v + 1);
      } catch {
        peerPanesHydratingRef.current = false;
      }
    })();
  }, [
    orgId,
    pluginId,
    resourceTypeId,
    accountId,
    resourceId,
    parentResourceId,
    peerIntegrationStubs,
  ]);

  function openSshTab() {
    void navigateToWorkspaceTarget(
      navigate,
      resourceSshTabTarget(accountId, resourceId, pluginId, resourceTypeId),
      { label: `SSH: ${resourceDisplayName}`, mode: "pin" },
    );
  }

  function openSftpTab() {
    void navigateToWorkspaceTarget(
      navigate,
      resourceSftpTabTarget(accountId, resourceId, pluginId, resourceTypeId),
      { label: `SFTP: ${resourceDisplayName}`, mode: "pin" },
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* SFTP view — full screen (hidden while provisioning) */}
      {isSftpView && hasSftpBrowser && (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {sshHost && !sshQuickConnect ? (
            <SshQuickConnectPanel
              host={sshHost}
              {...(defaultSshUsername ? { defaultUsername: defaultSshUsername } : {})}
              preferredSshKeyId={agentLaunch.sshKeyId}
              preferredSshKeyName={agentLaunch.sshKeyName}
              onConnect={(config) => setSshQuickConnect(config)}
            />
          ) : (
            <SftpBrowser
              accountId={accountId}
              {...(sshQuickConnect && sshHost
                ? {
                    sshKeyId: sshQuickConnect.sshKeyId,
                    sshHost,
                    sshUsername: sshQuickConnect.username,
                  }
                : {})}
            />
          )}
        </div>
      )}
      {isSftpView && !hasSftpBrowser && (
        <div className="flex-1 flex items-center justify-center text-on-surface-muted text-sm">
          Waiting for resource to be ready…
        </div>
      )}

      {/* SSH view — full screen */}
      {isSshView && (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {sshHost && !sshQuickConnect && !autoConnectPending && agentLaunch.autoConnectReady && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-surface/40">
              <label className="flex items-center gap-2 text-xs text-on-surface-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  aria-label="Forward SSH agent"
                  checked={agentForward}
                  onChange={toggleAgentForward}
                  className="accent-green-600"
                />
                <span>Forward SSH agent</span>
              </label>
              <span
                className="text-[10px] text-on-surface-faint"
                title="Forwards the same SSH key used to log in, so commands like `git clone` on the remote can authenticate with it. A compromised remote could use the forwarded key against other hosts that accept it — only enable for hosts you trust. Takes effect on the next connection."
              >
                (forwards your selected key; applies on next connect)
              </span>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            {sshHost &&
            !sshQuickConnect &&
            (autoConnectPending || !agentLaunch.autoConnectReady) ? (
              <div className="flex h-full items-center justify-center px-4 text-sm text-on-surface-muted">
                {agentLaunch.autoConnectReady
                  ? "Connecting with infrawrench-agent..."
                  : "Preparing agent SSH session..."}
              </div>
            ) : sshHost && !sshQuickConnect ? (
              <>
                {agentLaunchError && (
                  <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    {agentLaunchError}
                  </div>
                )}
                {autoConnectError && (
                  <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Could not auto-connect with {agentLaunch.sshKeyName ?? "the agent key"}:{" "}
                    {autoConnectError}
                  </div>
                )}
                <SshQuickConnectPanel
                  host={sshHost}
                  {...(defaultSshUsername ? { defaultUsername: defaultSshUsername } : {})}
                  preferredSshKeyId={agentLaunch.sshKeyId}
                  preferredSshKeyName={agentLaunch.sshKeyName}
                  onConnect={async (config) => {
                    setSshQuickConnect(config);
                    const { token } = await apiPost<{ token: string }>(
                      `/api/org/${orgId}/ws-token`,
                    );
                    setWsToken(token);
                  }}
                />
              </>
            ) : sshHost && sshQuickConnect && wsToken ? (
              <WebTerminal
                accountId={accountId}
                resourceId={resourceId}
                token={wsToken}
                orgId={orgId}
                sshKeyId={sshQuickConnect.sshKeyId}
                sshHost={sshHost}
                sshUsername={sshQuickConnect.username}
                agentForward={agentForward}
                initialCommand={agentLaunch.initialCommand}
                initialCwd={agentLaunch.initialCwd}
                agentTerminal={Boolean(agentSessionId)}
              />
            ) : wsToken ? (
              <WebTerminal
                accountId={accountId}
                resourceId={resourceId}
                token={wsToken}
                orgId={orgId}
                agentForward={agentForward}
                initialCommand={agentLaunch.initialCommand}
                initialCwd={agentLaunch.initialCwd}
                agentTerminal={Boolean(agentSessionId)}
              />
            ) : !sshHost ? (
              <div className="flex items-center justify-center h-full">
                <button
                  type="button"
                  onClick={async () => {
                    const { token } = await apiPost<{ token: string }>(
                      `/api/org/${orgId}/ws-token`,
                    );
                    setWsToken(token);
                  }}
                  className="px-4 py-2 text-sm text-on-surface-secondary border border-border-strong hover:border-border-strong rounded-lg transition-colors"
                >
                  Connect SSH Terminal
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-on-surface-muted text-sm animate-pulse">
                Connecting…
              </div>
            )}
          </div>
        </div>
      )}

      {/* Detail view — shown when not in SSH or SFTP view */}
      {!isSshView && !isSftpView && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Top buttons for SSH/SFTP/Connect */}
          <div className="shrink-0 flex justify-end gap-2 px-4 py-2 border-b border-border bg-surface">
            {hasSftpBrowser && (
              <button
                type="button"
                onClick={openSftpTab}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Open SFTP tab
              </button>
            )}
            {hasSshPanel && (
              <button
                type="button"
                onClick={openSshTab}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Open SSH tab
              </button>
            )}
            {sshHost && (
              <button
                type="button"
                onClick={() => setShowSshTunnel(true)}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Connect service via SSH
              </button>
            )}
            {sshHost && (
              <button
                type="button"
                onClick={() => setShowJumpboxDialog(true)}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Connect through jumpbox…
              </button>
            )}
            {sshHost && (
              <button
                type="button"
                onClick={() => setShowDockerSetup(true)}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Setup Docker
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowDropSpotlight(true)}
              className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
            >
              Connect resource
            </button>
          </div>

          <div className="flex-1 overflow-hidden min-h-0">
            <DetailView
              schema={detailSchema}
              resourceId={resourceId}
              pluginLogoSvg={pluginLogoSvg}
              {...(hasSqlEditor
                ? {
                    onRunQuery: handleRunQuery,
                    onExecute: handleExecute,
                    onEstimateQueryCost: handleEstimateQueryCost,
                  }
                : {})}
              {...(hasKvBrowser
                ? {
                    onListKvKeys: handleListKvKeys,
                    onGetKvValue: handleGetKvValue,
                    onPutKvValue: handlePutKvValue,
                    onDeleteKvKey: handleDeleteKvKey,
                  }
                : {})}
              peerPanes={peerPanes}
              onPeerPaneOpen={handlePeerPaneOpen}
              renderPeerPane={(pane, index) => {
                const peerPluginId = activePeerPluginIds[index] ?? "";
                return (
                  <PeerPaneView
                    pane={pane}
                    accountId={accountId}
                    parentResourceId={resourceId}
                    onOpenPill={(child: PeerPaneResource, group: PeerPaneResourceGroup) => {
                      void navigate({
                        to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                        params: {
                          orgId,
                          pluginId: group.pluginId,
                          resourceTypeId: group.resourceTypeId,
                          resourceId: child.id,
                        },
                        search: {
                          accountId,
                          parent: resourceId,
                        },
                      });
                    }}
                    {...(pane.schema.supportsYamlImport
                      ? {
                          onImportYaml: async (yamlText) =>
                            apiPost<{ applied: number }>(
                              `/api/org/${orgId}/resources/${peerPluginId || "kubernetes"}/import-yaml`,
                              {
                                accountId,
                                yaml: yamlText,
                                parentResourceId: resourceId,
                              },
                            ),
                        }
                      : {})}
                    onCreate={(group) => setPeerCreateTarget(group)}
                    {...(pane.schema.supportsK9s
                      ? {
                          k9s: {
                            label: "Open in k9s",
                            onOpen: async () => {
                              const { token } = await apiPost<{ token: string }>(
                                `/api/org/${orgId}/ws-token`,
                              );
                              setK9sPane({
                                peerPluginId: peerPluginId || "kubernetes",
                                token,
                              });
                            },
                          },
                        }
                      : {})}
                  />
                );
              }}
              {...(dependencies ? { dependencies, onOpenDependency: handleOpenDependency } : {})}
              childResourceGroups={childResourceGroups}
              onChildClick={handleChildClick}
              onChildCreate={handleChildCreate}
              onChildDelete={handleChildDelete}
              onChildEdit={handleChildEdit}
              renderChildResource={(child) => (
                <DraggableChildPill child={child} onOpen={() => handleChildClick(child)} />
              )}
              {...(hasManifestEditor ||
              detailSchema.bucketPolicyEditor ||
              detailSchema.settingsEditor
                ? { onGetManifest: handleGetManifest, onApplyManifest: handleApplyManifest }
                : {})}
              {...(detailSchema.describe ? { onGetDescribe: handleGetDescribe } : {})}
              {...(detailSchema.logs ? { onGetLogs: handleGetLogs } : {})}
              {...(detailSchema.chatPanel ? { onChatStream: handleChatStream } : {})}
              {...(detailSchema.publishPanel ? { onPublishMessage: handlePublishMessage } : {})}
              {...(detailSchema.speechPanel?.modes.includes("tts")
                ? { onSynthesizeSpeech: handleSynthesizeSpeech }
                : {})}
              {...(detailSchema.speechPanel?.modes.includes("stt")
                ? { onTranscribeAudio: handleTranscribeAudio }
                : {})}
              {...(hasArtifactRegistry ? { onListArtifacts: handleListArtifacts } : {})}
              {...(hasSecretVersions
                ? {
                    onListSecretVersions: handleListSecretVersions,
                    onAccessSecretVersion: handleAccessSecretVersion,
                    onAddSecretVersion: handleAddSecretVersion,
                    onModifySecretVersion: handleModifySecretVersion,
                  }
                : {})}
              {...(pluginId === "kubernetes" && resourceTypeId === "k8s-pod" && parentResourceId
                ? {
                    onOpenConsole: async () => {
                      const { token } = await apiPost<{ token: string }>(
                        `/api/org/${orgId}/ws-token`,
                      );
                      setConsoleToken(token);
                      setConsoleOpen(true);
                    },
                  }
                : {})}
              {...(detailSchema.noSqlBrowser
                ? {
                    renderNoSqlBrowser: () => {
                      const cap = detailSchema.noSqlBrowser!;
                      if (cap.driver === "firestore" || cap.driver === "dynamodb") {
                        return (
                          <FirestoreDocumentBrowser
                            pluginId={pluginId}
                            accountId={accountId}
                            resourceTypeId={resourceTypeId}
                            resourceId={resourceId}
                            databaseLabel={cap.databaseLabel}
                            singleCollection={cap.singleCollection ?? false}
                            {...(parentResourceId ? { parentResourceId } : {})}
                          />
                        );
                      }
                      return (
                        <FirestoreMongoPeerBrowser
                          resourceId={resourceId}
                          firestoreDatabaseId={cap.databaseLabel}
                        />
                      );
                    },
                  }
                : {})}
              {...(hasStorageBrowser && storageBucketName
                ? {
                    renderStorageBrowser: () => (
                      <StorageBrowser accountId={accountId} bucketName={storageBucketName} />
                    ),
                  }
                : {})}
              metricSeries={metricSeries}
              renderChangesTab={() => (
                <ResourceChangesPanel orgId={orgId} resourceId={resourceId} />
              )}
            />
          </div>
        </div>
      )}

      {/* Bottom panels — KV, Docker, Storage (inline like desktop, only when not in SSH/SFTP) */}
      {!isSshView && !isSftpView && hasKvConsole && !isMongoDb && (
        <KvConsole
          accountId={accountId}
          driverName={kvDriverName ?? "redis"}
          pluginId={pluginId}
          {...(parentResourceId ? { parentResourceId } : {})}
        />
      )}

      {!isSshView && !isSftpView && hasKvConsole && isMongoDb && (
        <MongoDocumentBrowser accountId={accountId} databaseName={databaseName ?? "test"} />
      )}

      {!isSshView && !isSftpView && hasDockerActions && containerId && (
        <DockerActionsPanel accountId={accountId} containerId={containerId} />
      )}

      {/* SSH bottom bar — connection info */}
      {isSshView && (wsToken || sshQuickConnect) && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-t border-border bg-surface">
          <span className="size-1.5 rounded-full bg-green-500 shrink-0" />
          <span className="text-xs font-mono text-on-surface-tertiary">
            {sshQuickConnect && sshHost
              ? `${sshQuickConnect.username}@${sshHost}:22`
              : `SSH connected`}
          </span>
          {sshQuickConnect && (
            <button
              type="button"
              onClick={() => setSshQuickConnect(null)}
              className="ml-auto text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      )}

      {/* Bottom action row */}
      {(canDelete || canEdit || (credentialFormats && credentialFormats.length > 0)) &&
        !isSshView &&
        !isSftpView && (
          <div className="shrink-0 px-4 py-2 border-t border-border flex items-center justify-end gap-3">
            {credentialFormats && credentialFormats.length > 0 && (
              <button
                type="button"
                onClick={() => setShowExportCredential(true)}
                className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Get credentials…
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => setShowEditModal(true)}
                className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Edit {resourceTypeLabel}…
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-on-surface-faint hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
              >
                Delete {resourceTypeLabel}…
              </button>
            )}
          </div>
        )}

      {confirmDelete && (
        <ConfirmDeleteModal
          kind={resourceTypeLabel}
          name={resourceDisplayName}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {showEditModal && canEdit && (
        <EditResourceModal
          displayName={resourceTypeLabel}
          fields={editableFields ?? []}
          initialValues={Object.fromEntries(
            Object.entries(resourceFields ?? {}).map(([k, v]) => [k, String(v ?? "")]),
          )}
          onClose={() => setShowEditModal(false)}
          onSubmit={async (changed) => {
            await handleUpdate(changed);
            // Server-rendered page: a full reload picks up the new fields.
            // Soft client refresh would need refetching detail; defer to nav.
            window.location.reload();
          }}
        />
      )}

      {showExportCredential && credentialFormats && credentialFormats.length > 0 && (
        <CredentialExportModal
          resourceDisplayName={resourceDisplayName}
          formats={credentialFormats}
          generate={async (formatId) =>
            apiPost<CredentialExport>(
              `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/export-credential`,
              {
                resourceId,
                accountId,
                formatId,
                ...(parentResourceId ? { parentResourceId } : {}),
              },
            )
          }
          onClose={() => setShowExportCredential(false)}
        />
      )}

      {createTarget && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={pluginId}
          resourceTypeId={createTarget.typeId}
          resourceTypeDisplayName={createTarget.displayName}
          parentResourceId={resourceId}
          onClose={() => setCreateTarget(null)}
          onCreated={(resource) => {
            const childTypeId = createTarget.typeId;
            setCreateTarget(null);
            dispatchResourcesChanged({ accountId, resourceTypeId: childTypeId });
            void navigateToWorkspaceTarget(
              navigate,
              resourceTabTarget(accountId, resource.id, pluginId, childTypeId),
              { label: resource.displayName },
            );
          }}
        />
      )}

      {showDropSpotlight && (
        <SpotlightSearch
          mode="drop"
          onClose={() => setShowDropSpotlight(false)}
          onDrop={(result) => {
            setShowDropSpotlight(false);
            setDropSource(result);
          }}
        />
      )}

      {dropSource && (
        <ConnectResourceModal
          source={dropSource}
          targetPluginId={pluginId}
          targetAccountId={accountId}
          targetResourceId={resourceId}
          sshHost={sshHost}
          defaultSshUsername={defaultSshUsername}
          onClose={() => setDropSource(null)}
          onConnected={() => {
            setDropSource(null);
            dispatchResourcesChanged({ accountId, resourceTypeId });
          }}
        />
      )}

      {showSshTunnel && sshHost && (
        <SshTunnelModal
          sshHost={sshHost}
          defaultUsername={defaultSshUsername}
          onClose={() => setShowSshTunnel(false)}
          onTunnelEstablished={(newAccountId) => {
            setShowSshTunnel(false);
            useUIStore.getState().bumpAccounts();
            void navigate({
              to: "/org/$orgId/accounts/$accountId",
              params: { orgId, accountId: newAccountId },
            });
          }}
        />
      )}

      {showJumpboxDialog && sshHost && (
        <ConnectThroughJumpboxDialog
          sourceDisplayName={resourceDisplayName}
          publicHost={sshHost}
          privateHost={sshPrivateHost}
          defaultUsername={defaultSshUsername}
          onClose={() => setShowJumpboxDialog(false)}
          onAdded={() => {
            setShowJumpboxDialog(false);
            useUIStore.getState().bumpAccounts();
          }}
        />
      )}

      {showDockerSetup && sshHost && (
        <DockerSetupModal
          sshHost={sshHost}
          defaultUsername={defaultSshUsername}
          onClose={() => setShowDockerSetup(false)}
          onComplete={(newAccountId) => {
            setShowDockerSetup(false);
            useUIStore.getState().bumpAccounts();
            void navigate({
              to: "/org/$orgId/accounts/$accountId",
              params: { orgId, accountId: newAccountId },
            });
          }}
        />
      )}

      {consoleOpen && consoleToken && parentResourceId && (
        <Modal
          onClose={() => {
            setConsoleOpen(false);
            setConsoleToken(null);
          }}
          ariaLabel={`Console: ${resourceDisplayName}`}
        >
          <div className="w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-on-surface">
                Console: {resourceDisplayName}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setConsoleOpen(false);
                  setConsoleToken(null);
                }}
                aria-label="Close"
                className="text-on-surface-muted hover:text-on-surface-secondary text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <K8sExecTerminal
                accountId={accountId}
                resourceId={parentResourceId}
                peerPluginId={pluginId}
                namespace={String(resourceFields?.["namespace"] ?? "default")}
                podName={resourceDisplayName}
                {...(typeof resourceFields?.["containerName"] === "string" &&
                resourceFields["containerName"]
                  ? { containerName: String(resourceFields["containerName"]) }
                  : {})}
                token={consoleToken}
              />
            </div>
          </div>
        </Modal>
      )}

      {peerCreateTarget && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={peerCreateTarget.pluginId}
          resourceTypeId={peerCreateTarget.resourceTypeId}
          resourceTypeDisplayName={peerCreateTarget.title.replace(/\s*\(\d+\)$/, "")}
          parentResourceId={resourceId}
          onClose={() => setPeerCreateTarget(null)}
          onCreated={() => {
            const peerTypeId = peerCreateTarget.resourceTypeId;
            setPeerCreateTarget(null);
            dispatchResourcesChanged({ accountId, resourceTypeId: peerTypeId });
          }}
        />
      )}

      {k9sPane && (
        <Modal onClose={() => setK9sPane(null)} ariaLabel={`k9s: ${resourceDisplayName}`}>
          <div className="w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-on-surface">k9s: {resourceDisplayName}</h2>
              <button
                type="button"
                onClick={() => setK9sPane(null)}
                aria-label="Close"
                className="text-on-surface-muted hover:text-on-surface-secondary text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <K9sTerminal
                accountId={accountId}
                resourceId={resourceId}
                peerPluginId={k9sPane.peerPluginId}
                token={k9sPane.token}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
