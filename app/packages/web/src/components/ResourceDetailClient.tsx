import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
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
  type QueryResult,
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
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PeerPaneResource,
  PeerPaneResourceGroup,
  PeerPaneSchema,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
} from "@infrawrench/plugin-base";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
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
}

interface ChildTypeData {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate: boolean;
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
  supportsMetrics,
  resourceFields,
  parentResourceId,
}: Props) {
  const navigate = useNavigate();
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
    (messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ChatStreamEvent> => {
      const url = `/api/org/${orgId}/resources/chat-stream`;
      const body = JSON.stringify({
        pluginId,
        accountId,
        resourceTypeId,
        resourceId,
        messages,
        ...(parentResourceId ? { parentResourceId } : {}),
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

  const hydratedPeerPanes = useRef<PeerPaneServerData[] | null>(null);
  const [hydratedVersion, setHydratedVersion] = useState(0);
  const peerPanesHydratingRef = useRef(false);

  useEffect(() => {
    hydratedPeerPanes.current = null;
    peerPanesHydratingRef.current = false;
    setHydratedVersion((v) => v + 1);
  }, [resourceId]);

  const peerPanes = useMemo((): PeerPaneData[] => {
    void hydratedVersion;
    if (hydratedPeerPanes.current) {
      return hydratedPeerPanes.current.map((p) => ({
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
  }, [serverPeerPanes, peerIntegrationStubs, hydratedVersion]);

  const activePeerPluginIds = useMemo(() => {
    if (hydratedPeerPanes.current) return hydratedPeerPanes.current.map((p) => p.peerPluginId);
    if (serverPeerPanes.length > 0) return serverPeerPanes.map((p) => p.peerPluginId);
    return (peerIntegrationStubs ?? []).map((s) => s.peerPluginId);
  }, [serverPeerPanes, peerIntegrationStubs, hydratedVersion]);

  const handlePeerPaneOpen = useCallback(() => {
    if (peerPanesHydratingRef.current) return;
    if (hydratedPeerPanes.current) return;
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
        hydratedPeerPanes.current = result;
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
          {sshHost && !sshQuickConnect && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-surface/40">
              <label className="flex items-center gap-2 text-xs text-on-surface-muted cursor-pointer select-none">
                <input
                  type="checkbox"
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
            {sshHost && !sshQuickConnect ? (
              <SshQuickConnectPanel
                host={sshHost}
                {...(defaultSshUsername ? { defaultUsername: defaultSshUsername } : {})}
                onConnect={async (config) => {
                  setSshQuickConnect(config);
                  const { token } = await apiPost<{ token: string }>(`/api/org/${orgId}/ws-token`);
                  setWsToken(token);
                }}
              />
            ) : sshHost && sshQuickConnect && wsToken ? (
              <WebTerminal
                accountId={accountId}
                resourceId={resourceId}
                token={wsToken}
                sshKeyId={sshQuickConnect.sshKeyId}
                sshHost={sshHost}
                sshUsername={sshQuickConnect.username}
                agentForward={agentForward}
              />
            ) : wsToken ? (
              <WebTerminal
                accountId={accountId}
                resourceId={resourceId}
                token={wsToken}
                agentForward={agentForward}
              />
            ) : !sshHost ? (
              <div className="flex items-center justify-center h-full">
                <button
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
                onClick={openSftpTab}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Open SFTP tab
              </button>
            )}
            {hasSshPanel && (
              <button
                onClick={openSshTab}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Open SSH tab
              </button>
            )}
            {sshHost && (
              <button
                onClick={() => setShowSshTunnel(true)}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Connect service via SSH
              </button>
            )}
            {sshHost && (
              <button
                onClick={() => setShowJumpboxDialog(true)}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Connect through jumpbox…
              </button>
            )}
            {sshHost && (
              <button
                onClick={() => setShowDockerSetup(true)}
                className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface-secondary border border-border hover:border-border-strong rounded-lg transition-colors"
              >
                Setup Docker
              </button>
            )}
            <button
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
              childResourceGroups={childResourceGroups}
              onChildClick={handleChildClick}
              onChildCreate={handleChildCreate}
              renderChildResource={(child) => (
                <DraggableChildPill child={child} onOpen={() => handleChildClick(child)} />
              )}
              {...(hasManifestEditor || detailSchema.bucketPolicyEditor
                ? { onGetManifest: handleGetManifest, onApplyManifest: handleApplyManifest }
                : {})}
              {...(detailSchema.describe ? { onGetDescribe: handleGetDescribe } : {})}
              {...(detailSchema.logs ? { onGetLogs: handleGetLogs } : {})}
              {...(detailSchema.chatPanel ? { onChatStream: handleChatStream } : {})}
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
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <span className="text-xs font-mono text-on-surface-tertiary">
            {sshQuickConnect && sshHost
              ? `${sshQuickConnect.username}@${sshHost}:22`
              : `SSH connected`}
          </span>
          {sshQuickConnect && (
            <button
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
                onClick={() => setShowExportCredential(true)}
                className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Get credentials…
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => setShowEditModal(true)}
                className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors px-2 py-1 rounded hover:bg-surface-overlay"
              >
                Edit {resourceTypeLabel}…
              </button>
            )}
            {canDelete && (
              <button
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
        >
          <div className="w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-on-surface">
                Console — {resourceDisplayName}
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
        <Modal onClose={() => setK9sPane(null)}>
          <div className="w-[min(1100px,92vw)] h-[min(720px,82vh)] overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-on-surface">k9s — {resourceDisplayName}</h2>
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
