import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  useUIStore,
  useTabId,
  resourceTabTitle,
  RESOURCES_CHANGED_EVENT,
  REFRESH_RESOURCE_EVENT,
  INVOKE_PLUGIN_ACTION_EVENT,
  PROMPT_NOSQL_COMMAND_EVENT,
  PromptNoSqlCommandModal,
  type InvokePluginActionDetail,
  type PromptNoSqlCommandDetail,
  type ResourcePickerOption,
} from "@infrawrench/ui";
import type {
  AssociationSource,
  CredentialFormat,
  DetailViewSchema,
  PeerPaneSchema,
} from "@infrawrench/plugin-base";
import { ResourceDetailClient } from "@/components/ResourceDetailClient";
import { apiGet, apiPost } from "@/lib/api";

interface ResourceDetailResponse {
  detailSchema: DetailViewSchema;
  childResources: {
    id: string;
    displayName: string;
    resourceTypeId: string;
    pluginId: string;
    accountId: string;
    status?: { kind: "status-dot"; status: string; label?: string };
  }[];
  childTypes: {
    id: string;
    displayName: string;
    pluralDisplayName: string;
    supportsCreate: boolean;
  }[];
  pluginId: string;
  pluginLogoSvg: string;
  resourceId: string;
  accountId: string;
  resourceTypeId: string;
  peerPanes: {
    tabLabel: string;
    pluginLogoSvg: string;
    schema: PeerPaneSchema;
    peerPluginId: string;
  }[];
  peerIntegrationStubs?: {
    tabLabel: string;
    pluginLogoSvg: string;
    peerPluginId: string;
  }[];
  canDelete: boolean;
  credentialFormats?: CredentialFormat[];
  hasManifestEditor: boolean;
  hasSecretVersions?: boolean;
  resourceDisplayName: string;
  resourceTypeLabel: string;
  resourceFields?: Record<string, string | number | boolean>;
  hasSqlEditor?: boolean;
  hasStorageBrowser?: boolean;
  hasArtifactRegistry?: boolean;
  hasKvConsole?: boolean;
  kvDriverName?: string;
  isMongoDb?: boolean;
  hasDockerActions?: boolean;
  hasSshTerminal?: boolean;
  hasSftpBrowser?: boolean;
  sshHost?: string;
  sshPrivateHost?: string;
  defaultSshUsername?: string;
  containerId?: string;
  databaseName?: string;
  storageBucketName?: string;
  supportsMetrics?: boolean;
}

export const Route = createFileRoute("/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId")(
  {
    // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
    // every open tab simultaneously and keeps them alive across tab switches.
    component: () => null,
    validateSearch: (search: Record<string, unknown>): { accountId?: string; parent?: string } => ({
      ...(typeof search["accountId"] === "string" ? { accountId: search["accountId"] } : {}),
      ...(typeof search["parent"] === "string" ? { parent: search["parent"] } : {}),
    }),
  },
);

interface ResourcePanelProps {
  orgId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
  accountId?: string | undefined;
  parent?: string | undefined;
  /** "ssh" / "sftp" / "" — derived from the tab target's `view`. */
  view: string;
}

export function ResourcePanel({
  orgId,
  pluginId,
  resourceTypeId,
  resourceId,
  accountId,
  parent,
  view: currentView,
}: ResourcePanelProps) {
  const tabId = useTabId();
  const [data, setData] = useState<ResourceDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promptModal, setPromptModal] = useState<PromptNoSqlCommandDetail | null>(null);

  const loadPromptResources = useCallback(
    (sources: AssociationSource[], acctId: string) =>
      apiPost<ResourcePickerOption[]>(`/api/org/${orgId}/resources/picker-resources`, {
        sources,
        accountId: acctId,
      }),
    [orgId],
  );

  const detailUrl = `/api/org/${orgId}/resources/${pluginId}/${resourceTypeId}/detail?resourceId=${encodeURIComponent(resourceId)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}${parent ? `&parentResourceId=${encodeURIComponent(parent)}` : ""}&includePeerPanes=false`;

  useEffect(() => {
    setData(null);
    setError(null);
    let retries = 0;
    let cancelled = false;

    function load() {
      apiGet<ResourceDetailResponse>(detailUrl)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch((e) => {
          if (cancelled) return;
          // Retry up to 3 times on "not found" — resource may still be propagating
          if (retries < 3 && e.message?.includes("not found")) {
            retries++;
            setTimeout(load, 1000 * retries);
          } else {
            setError(e.message);
          }
        });
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [detailUrl]);

  useEffect(() => {
    if (!data || !tabId) return;
    useUIStore
      .getState()
      .setWorkspaceTabTitle(tabId, resourceTabTitle(data.resourceDisplayName, currentView));
  }, [data, currentView, tabId]);

  useEffect(() => {
    let cancelled = false;
    function refreshFromDb() {
      apiGet<ResourceDetailResponse>(detailUrl)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {});
    }
    // Manual refresh button: hit the provider for just this one resource, then re-read detail.
    async function refreshFromProvider() {
      if (!accountId) return refreshFromDb();
      try {
        await apiPost(`/api/org/${orgId}/resources/refresh`, {
          resourceId,
          accountId,
          typeId: resourceTypeId,
        });
      } catch {
        // ignore — fall through to re-read whatever we have
      }
      if (!cancelled) refreshFromDb();
    }
    async function handlePluginAction(e: Event) {
      const detail = (e as CustomEvent<InvokePluginActionDetail>).detail;
      if (!accountId) return;
      if (detail.confirmMessage && !window.confirm(detail.confirmMessage)) return;
      try {
        await apiPost(`/api/org/${orgId}/resources/invoke-action`, {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          actionId: detail.actionId,
          ...(parent ? { parentResourceId: parent } : {}),
        });
        if (detail.successMessage) {
          window.alert(detail.successMessage);
        }
        refreshFromProvider();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Action failed");
      }
    }
    function handlePromptNoSqlCommand(e: Event) {
      const detail = (e as CustomEvent<PromptNoSqlCommandDetail>).detail;
      if (!accountId) return;
      setPromptModal(detail);
    }

    const id = setInterval(refreshFromDb, 30_000);
    window.addEventListener(RESOURCES_CHANGED_EVENT, refreshFromDb);
    window.addEventListener(REFRESH_RESOURCE_EVENT, refreshFromProvider);
    window.addEventListener(INVOKE_PLUGIN_ACTION_EVENT, handlePluginAction);
    window.addEventListener(PROMPT_NOSQL_COMMAND_EVENT, handlePromptNoSqlCommand);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener(RESOURCES_CHANGED_EVENT, refreshFromDb);
      window.removeEventListener(REFRESH_RESOURCE_EVENT, refreshFromProvider);
      window.removeEventListener(INVOKE_PLUGIN_ACTION_EVENT, handlePluginAction);
      window.removeEventListener(PROMPT_NOSQL_COMMAND_EVENT, handlePromptNoSqlCommand);
    };
  }, [detailUrl, orgId, pluginId, resourceId, resourceTypeId, accountId, parent]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  if (!data) return <div className="p-6 text-on-surface-muted text-sm animate-pulse">Loading…</div>;

  return (
    <>
      <ResourceDetailClient
        detailSchema={data.detailSchema}
        childResources={data.childResources}
        childTypes={data.childTypes}
        pluginId={data.pluginId}
        pluginLogoSvg={data.pluginLogoSvg}
        resourceId={data.resourceId}
        accountId={data.accountId}
        resourceTypeId={data.resourceTypeId}
        peerPanes={data.peerPanes}
        peerIntegrationStubs={data.peerIntegrationStubs}
        canDelete={data.canDelete}
        credentialFormats={data.credentialFormats}
        hasManifestEditor={data.hasManifestEditor}
        hasSecretVersions={data.hasSecretVersions}
        resourceDisplayName={data.resourceDisplayName}
        resourceTypeLabel={data.resourceTypeLabel}
        hasSqlEditor={data.hasSqlEditor}
        hasStorageBrowser={data.hasStorageBrowser}
        hasArtifactRegistry={data.hasArtifactRegistry}
        hasKvConsole={data.hasKvConsole}
        kvDriverName={data.kvDriverName}
        isMongoDb={data.isMongoDb}
        hasDockerActions={data.hasDockerActions}
        hasSshTerminal={data.hasSshTerminal}
        hasSftpBrowser={data.hasSftpBrowser}
        sshHost={data.sshHost}
        sshPrivateHost={data.sshPrivateHost}
        defaultSshUsername={data.defaultSshUsername}
        containerId={data.containerId}
        databaseName={data.databaseName}
        storageBucketName={data.storageBucketName}
        initialView={currentView === "ssh" || currentView === "sftp" ? currentView : undefined}
        supportsMetrics={data.supportsMetrics}
        resourceFields={data.resourceFields}
        parentResourceId={parent}
      />
      {promptModal && accountId && (
        <PromptNoSqlCommandModal
          title={promptModal.title ?? promptModal.command}
          {...(promptModal.description ? { description: promptModal.description } : {})}
          fields={promptModal.fields}
          submitLabel={promptModal.submitLabel ?? "Submit"}
          danger={!!promptModal.danger}
          resourcePickerProps={{
            accountId,
            loadResources: loadPromptResources,
          }}
          onCancel={() => setPromptModal(null)}
          onSubmit={async (values) => {
            await apiPost(`/api/org/${orgId}/resources/nosql-command`, {
              pluginId,
              accountId,
              resourceTypeId,
              resourceId,
              command: promptModal.command,
              args: [JSON.stringify(values)],
              ...(parent ? { parentResourceId: parent } : {}),
            });
            setPromptModal(null);
            window.dispatchEvent(new CustomEvent(REFRESH_RESOURCE_EVENT));
          }}
        />
      )}
    </>
  );
}
