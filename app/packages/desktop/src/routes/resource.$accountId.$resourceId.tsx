import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type {
  ResourceInstance,
  DetailViewSchema,
  FieldDefinition,
  MetricSeries,
  ResourceTypeDefinition,
  CredentialFormat,
} from "@infrawrench/plugin-base";
import { evaluatePeerIntegrationUnreachable } from "@infrawrench/plugin-base";
import {
  invokeCloudAction,
  runCloudNoSqlCommand,
  deleteCloudResource,
  fetchCloudPeerPanes,
} from "../lib/cloud-api";
import {
  REFRESH_RESOURCE_EVENT,
  NAVIGATE_TO_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
  REROLL_PARENT_OUTPUT_EVENT,
  buildAgentLaunchCommand,
  dispatchResourcesChanged,
  dispatchRefreshResource,
  resourceTabTitle,
  formatErrorMessage,
  toast,
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
import { buildPluginHostServices, persistPlaintextSecret } from "../lib/sql-drivers";
import { createPluginClient } from "../lib/plugin-client";
import { makeResourceCostEstimator } from "../lib/cost-estimate";
import { applyCredentialRewriters } from "../lib/credential-rewriters";
import { invoke } from "../lib/invoke";
import type { PluginClient, PeerPaneContext, AssociationSource } from "@infrawrench/plugin-base";
import type { AgentLaunchDefaults, PeerPaneData } from "@infrawrench/ui";
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
import { useResourceOperations } from "./_resource-detail/-useResourceOperations";

export const Route = createFileRoute("/resource/$accountId/$resourceId")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  component: () => null,
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    plugin?: string;
    type?: string;
    parent?: string;
    agentSession?: string;
    sshKeyId?: string;
    sshKeyName?: string;
  } => ({
    ...(typeof search["plugin"] === "string" ? { plugin: search["plugin"] } : {}),
    ...(typeof search["type"] === "string" ? { type: search["type"] } : {}),
    ...(typeof search["parent"] === "string" ? { parent: search["parent"] } : {}),
    ...(typeof search["agentSession"] === "string" ? { agentSession: search["agentSession"] } : {}),
    ...(typeof search["sshKeyId"] === "string" ? { sshKeyId: search["sshKeyId"] } : {}),
    ...(typeof search["sshKeyName"] === "string" ? { sshKeyName: search["sshKeyName"] } : {}),
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
  agentSessionId?: string | undefined;
  sshKeyId?: string | undefined;
  sshKeyName?: string | undefined;
  initialCommand?: string | undefined;
  initialCwd?: string | undefined;
  /**
   * Title to show instead of the resource's own display name, for panels
   * standing in for something else — an account-root resource rendered as its
   * account's page. Applies to the header and the workspace tab together, so
   * the two can't disagree.
   */
  titleOverride?: string | undefined;
}

type AgentLaunchSession = {
  id: string;
  tool: string;
  workspace_name: string | null;
  project_name: string;
  repo: string;
};

export function ResourcePanel({
  accountId,
  resourceId,
  peerPlugin,
  peerType,
  peerParent,
  view: locationHash,
  agentSessionId,
  sshKeyId,
  sshKeyName,
  initialCommand,
  initialCwd,
  titleOverride,
}: ResourcePanelProps) {
  const tabId = useTabId();
  const decodedResourceId = decodeURIComponent(resourceId);
  const currentView = locationHash.replace(/^#/, "");
  const isSshView = currentView === "ssh";
  const isSftpView = currentView === "sftp";

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
  const [agentLaunchDefaults, setAgentLaunchDefaults] = useState<AgentLaunchDefaults>({});
  const [resolvedAgentLaunchLookupKey, setResolvedAgentLaunchLookupKey] = useState<string | null>(
    null,
  );
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null);
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

  // One estimator for both surfaces that quote a monthly figure — the detail
  // header's standing estimate and the edit modal's change delta — so the two
  // are always the same plugin call over the same fields.
  const loadCostEstimate = useMemo(
    () =>
      makeResourceCostEstimator({
        resource,
        accountId,
        resourceId: decodedResourceId,
        getLocalClient: () => clientRef.current,
        getCloudCtx: () => cloudCtxRef.current,
      }),
    [resource, accountId, decodedResourceId],
  );
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
  // Rehydrate launch metadata ONLY for agent tabs (agentSessionId present)
  // that are missing pieces of it (e.g. restored after a restart). Plain SSH
  // tabs must never look up agent sessions — a VM that once hosted an agent
  // session would otherwise silently attach the agent's screen.
  const agentLaunchLookupKey =
    isSshView && agentSessionId && !(sshKeyId && sshKeyName && initialCommand && initialCwd)
      ? `${accountId}:${decodedResourceId}:${agentSessionId}`
      : null;

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
      ...(titleOverride ? { titleOverride } : {}),
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
    if (!agentLaunchLookupKey || !agentSessionId) {
      setAgentLaunchDefaults({});
      setResolvedAgentLaunchLookupKey(null);
      setAgentLaunchError(null);
      return;
    }

    let cancelled = false;
    setAgentLaunchError(null);

    async function resolveAgentLaunchDefaults() {
      // Cloud sessions live in the org, not this machine's SQLite, and the
      // server owns the launch command and the managed org key — the same
      // `POST /agents/sessions/:id/open` web rehydrates from. Reading the
      // local table here would report "session no longer exists" for every
      // agent tab opened against an org.
      if (activeCloudOrgId) {
        const result = await invoke<{
          command: string;
          cwd: string;
          sshKeyId?: string;
          sshKeyName?: string;
        }>("cloud_agents_open_session", { orgId: activeCloudOrgId, sessionId: agentSessionId });
        if (cancelled) return;
        const cloudNext: AgentLaunchDefaults = {};
        if (!sshKeyId && result.sshKeyId) cloudNext.sshKeyId = result.sshKeyId;
        if (!sshKeyName && result.sshKeyName) cloudNext.sshKeyName = result.sshKeyName;
        if (!initialCommand) cloudNext.initialCommand = result.command;
        if (!initialCwd) cloudNext.initialCwd = result.cwd;
        setAgentLaunchDefaults(cloudNext);
        setResolvedAgentLaunchLookupKey(agentLaunchLookupKey);
        return;
      }

      const db = await getDb();
      // Look up the exact session this tab was opened for — never "the
      // latest session on this VM", which could belong to another tab.
      const rows = await db.select<AgentLaunchSession[]>(
        `SELECT id, tool, workspace_name, project_name, repo
         FROM agent_sessions
         WHERE id = $1 AND account_id = $2 AND vm_resource_id = $3
         LIMIT 1`,
        [agentSessionId, accountId, decodedResourceId],
      );
      const session = rows[0];
      if (cancelled) return;
      if (!session) {
        setAgentLaunchDefaults({});
        setAgentLaunchError(
          "This agent session no longer exists. You can still connect to the VM manually below.",
        );
        setResolvedAgentLaunchLookupKey(agentLaunchLookupKey);
        return;
      }

      const next: AgentLaunchDefaults = {};
      if (!sshKeyId || !sshKeyName) {
        const key = await invoke<{ id: string; name: string; publicKey: string }>(
          "ssh_key_ensure_agent_key",
        );
        if (!sshKeyId) next.sshKeyId = key.id;
        if (!sshKeyName) next.sshKeyName = key.name;
      }
      if (!initialCommand) {
        next.initialCommand = buildAgentResourceLaunchCommand(session);
      }
      if (!initialCwd) {
        next.initialCwd = `~/${agentWorkspaceName(session)}`;
      }
      if (!cancelled) {
        setAgentLaunchDefaults(next);
        setResolvedAgentLaunchLookupKey(agentLaunchLookupKey);
      }
    }

    void resolveAgentLaunchDefaults().catch((err) => {
      console.warn(`Failed to resolve agent SSH launch metadata for ${agentSessionId}`, err);
      if (!cancelled) {
        setAgentLaunchDefaults({});
        setAgentLaunchError(
          `Couldn't prepare the agent SSH session: ${formatErrorMessage(err)}. You can still connect to the VM manually below.`,
        );
        setResolvedAgentLaunchLookupKey(agentLaunchLookupKey);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    activeCloudOrgId,
    agentSessionId,
    agentLaunchLookupKey,
    decodedResourceId,
    initialCommand,
    initialCwd,
    sshKeyId,
    sshKeyName,
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

  const {
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
    handleSynthesizeSpeech,
    handleTranscribeAudio,
    handleGetLogs,
    handleListArtifacts,
    handleListSecretVersions,
    handleAccessSecretVersion,
    handleAddSecretVersion,
    handleModifySecretVersion,
  } = useResourceOperations({
    accountId,
    decodedResourceId,
    resource,
    cloudCtxRef,
    clientRef,
    connectionStringRef,
    sqlDriverIdRef,
  });
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

  async function handleChildDelete(child: {
    id: string;
    pluginId: string;
    resourceTypeId: string;
    accountId: string;
  }): Promise<void> {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      await deleteCloudResource(
        cloud.orgId,
        child.pluginId,
        child.resourceTypeId,
        child.id,
        child.accountId || accountId,
      );
    } else {
      const client = await createPluginClient(child.accountId || accountId, child.pluginId);
      if (!client.deleteResource) throw new Error("Plugin does not support deletion");
      await client.deleteResource(child.resourceTypeId, child.id, child.accountId || accountId);
      const db = await getDb();
      await db.execute("DELETE FROM resources WHERE id = $1", [child.id]);
    }
    dispatchResourcesChanged({ accountId, resourceTypeId: child.resourceTypeId });
    setRefreshVersion((v) => v + 1);
  }

  async function handleChildEdit(
    child: { id: string; pluginId: string; resourceTypeId: string; accountId: string },
    changedFields: Record<string, string>,
  ): Promise<void> {
    const cloud = cloudCtxRef.current;
    if (cloud) {
      const { updateCloudResource } = await import("../lib/cloud-api");
      await updateCloudResource(cloud.orgId, {
        accountId: child.accountId || accountId,
        pluginId: child.pluginId,
        resourceTypeId: child.resourceTypeId,
        resourceId: child.id,
        fields: changedFields,
        parentResourceId: decodedResourceId,
      });
    } else {
      const client = await createPluginClient(child.accountId || accountId, child.pluginId);
      if (!client.updateResource) throw new Error("Plugin does not support updates");
      const updated = await client.updateResource(
        child.resourceTypeId,
        child.id,
        child.accountId || accountId,
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
    }
    dispatchResourcesChanged({ accountId, resourceTypeId: child.resourceTypeId });
    setRefreshVersion((v) => v + 1);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-muted text-sm animate-pulse">
        Loading…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-danger text-sm">{error}</div>;
  }

  if (!schema) return null;

  const hasSqlEditor = !!schema?.sqlEditor && pgConnected;
  const hasStorageBrowser = !!schema?.storageBrowser;
  const hasTerminal = !!sshConfig;
  const hasSshPanel = hasTerminal || !!sshHost;
  const hasSftpBrowser = !!sshConfig || !!sshHost;
  const agentLaunchResolving = Boolean(
    agentLaunchLookupKey && resolvedAgentLaunchLookupKey !== agentLaunchLookupKey,
  );
  // When agent metadata can't be resolved (session deleted, key provisioning
  // failed), drop the agent fields entirely so the pane falls back to the
  // ordinary quick-connect panel instead of waiting forever.
  const agentLaunchFailed = agentLaunchError !== null;
  const effectiveAgentSessionId = agentLaunchFailed ? undefined : agentSessionId;
  const effectiveSshKeyId = agentLaunchFailed
    ? undefined
    : (sshKeyId ?? agentLaunchDefaults.sshKeyId);
  const effectiveSshKeyName = agentLaunchFailed
    ? undefined
    : (sshKeyName ?? agentLaunchDefaults.sshKeyName);
  const effectiveInitialCommand = agentLaunchFailed
    ? undefined
    : (initialCommand ?? agentLaunchDefaults.initialCommand);
  const effectiveInitialCwd = agentLaunchFailed
    ? undefined
    : (initialCwd ?? agentLaunchDefaults.initialCwd);
  const agentAutoConnectReady =
    !agentLaunchResolving &&
    (!effectiveAgentSessionId || Boolean(effectiveInitialCommand && effectiveInitialCwd));

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
              // Overridden here rather than in the plugin: only the host knows
              // this panel is standing in for its account, and the plugin has
              // no way to read the name the user gave that account.
              schema={titleOverride ? { ...schema, title: titleOverride } : schema}
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
              loadCostEstimate={loadCostEstimate}
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
              onSynthesizeSpeech={handleSynthesizeSpeech}
              onTranscribeAudio={handleTranscribeAudio}
              onChildCreate={(rt) => setCreateChildTarget(rt)}
              onChildDelete={handleChildDelete}
              onChildEdit={handleChildEdit}
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
            agentSessionId={effectiveAgentSessionId}
            sshKeyId={effectiveSshKeyId}
            sshKeyName={effectiveSshKeyName}
            initialCommand={effectiveInitialCommand}
            initialCwd={effectiveInitialCwd}
            autoConnectReady={agentAutoConnectReady}
            // An agent tab opened while an org is active is one of the org's
            // sessions, so its key is the org's — see SshViewPane.
            agentKeyScope={activeCloudOrgId ? "cloud" : "app"}
            agentLaunchError={agentLaunchError ?? undefined}
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
          <span className="text-xs text-danger font-mono">SQL connection failed: {pgError}</span>
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

function agentWorkspaceName(session: {
  workspace_name: string | null;
  project_name: string;
  repo: string;
}): string {
  const inferred = workspaceNameFromRepo(session.repo);
  const stored = session.workspace_name?.trim();
  if (!stored || stored === session.project_name) return inferred || session.project_name;
  return stored;
}

function workspaceNameFromRepo(repo: string): string {
  const trimmed = repo.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return "";
  const lastSegment = trimmed.split(/[\\/]/).pop() ?? "";
  return lastSegment.replace(/\.git$/i, "") || "";
}

function buildAgentResourceLaunchCommand(session: AgentLaunchSession): string {
  // No launchReadyToken here: this fallback path re-attaches to an existing
  // session's screen, so the shared launch command only waits on the setup
  // marker written by the bootstrap script.
  return buildAgentLaunchCommand({
    sessionId: session.id,
    tool: session.tool === "claude-code" ? "claude-code" : "codex",
    workspaceName: agentWorkspaceName(session),
  });
}
