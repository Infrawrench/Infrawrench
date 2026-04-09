import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  DetailView,
  DraggableChildPill,
  StatusDotNodeRenderer,
  ConfirmDeleteModal,
  type QueryResult,
  type ChildResource,
  type ChildResourceGroup,
  type PeerPaneData,
} from "@infrawrench/ui";
import type { DetailViewSchema, PeerPaneSchema } from "@infrawrench/plugin-base";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { CreateResourceModal } from "./CreateResourceModal";
import { KvConsole } from "@/components/KvConsole";
import { DockerActionsPanel } from "@/components/DockerActionsPanel";
import { MongoDocumentBrowser } from "@/components/MongoDocumentBrowser";
import { StorageBrowser } from "@/components/StorageBrowser";
import { SftpBrowser } from "@/components/SftpBrowser";
import { WebTerminal } from "@/components/WebTerminal";

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
  canDelete: boolean;
  hasManifestEditor: boolean;
  resourceDisplayName: string;
  resourceTypeLabel: string;
  // Connection feature flags
  hasSqlEditor?: boolean | undefined;
  hasStorageBrowser?: boolean | undefined;
  hasKvConsole?: boolean | undefined;
  kvDriverName?: string | undefined;
  isMongoDb?: boolean | undefined;
  hasDockerActions?: boolean | undefined;
  hasSshTerminal?: boolean | undefined;
  hasSftpBrowser?: boolean | undefined;
  containerId?: string | undefined;
  databaseName?: string | undefined;
  storageBucketName?: string | undefined;
}

type ConnectionTab = "ssh" | "sftp" | "kv" | "mongo" | "docker" | "storage";

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
  canDelete,
  hasManifestEditor,
  resourceDisplayName,
  resourceTypeLabel,
  hasSqlEditor,
  hasStorageBrowser,
  hasKvConsole,
  kvDriverName,
  isMongoDb,
  hasDockerActions,
  hasSshTerminal,
  hasSftpBrowser,
  containerId,
  databaseName,
  storageBucketName,
}: Props) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [wsToken, setWsToken] = useState<string | null>(null);
  const [createTarget, setCreateTarget] = useState<ChildResourceGroup | null>(null);
  const [activeConnectionTab, setActiveConnectionTab] = useState<ConnectionTab | null>(null);

  // Build the list of available connection tabs
  const connectionTabs = useMemo(() => {
    const tabs: Array<{ id: ConnectionTab; label: string }> = [];
    if (hasSshTerminal) tabs.push({ id: "ssh", label: "SSH Terminal" });
    if (hasSftpBrowser) tabs.push({ id: "sftp", label: "SFTP Browser" });
    if (hasKvConsole && !isMongoDb) tabs.push({ id: "kv", label: kvDriverName === "memcached" ? "Memcached" : "Redis Console" });
    if (hasKvConsole && isMongoDb) tabs.push({ id: "mongo", label: "Documents" });
    if (hasDockerActions && containerId) tabs.push({ id: "docker", label: "Docker" });
    if (hasStorageBrowser && storageBucketName) tabs.push({ id: "storage", label: "Storage Browser" });
    return tabs;
  }, [hasSshTerminal, hasSftpBrowser, hasKvConsole, isMongoDb, kvDriverName, hasDockerActions, containerId, hasStorageBrowser, storageBucketName]);

  // SQL queries via API
  const handleRunQuery = useCallback(
    async (sql: string): Promise<QueryResult> => {
      if (!hasSqlEditor) return { rows: [], durationMs: 0 };
      const result = await apiPost<{ rows: Record<string, unknown>[]; durationMs: number }>("/api/sql/query", { accountId, resourceId, resourceTypeId, sql });
      return { rows: result.rows, durationMs: result.durationMs };
    },
    [accountId, resourceId, resourceTypeId, hasSqlEditor],
  );

  const handleExecute = useCallback(
    async (sql: string, params: unknown[]): Promise<number> => {
      const result = await apiPost<{ affectedRows: number }>("/api/sql/execute", { accountId, resourceId, resourceTypeId, sql, params });
      return result.affectedRows;
    },
    [accountId, resourceId, resourceTypeId],
  );

  const handleChildClick = useCallback(
    (child: ChildResource) => {
      void navigate({
        to: "/resources/$pluginId/$resourceTypeId/$resourceId",
        params: { pluginId: child.pluginId, resourceTypeId: child.resourceTypeId, resourceId: child.id },
      });
    },
    [navigate],
  );

  const handleChildCreate = useCallback(
    (group: ChildResourceGroup) => {
      setCreateTarget(group);
    },
    [],
  );

  // ── Manifest editor ──────────────────────────────────────────────────────
  const handleGetManifest = useCallback(async (): Promise<string> => {
    const result = await apiGet<{ manifest: string }>(`/api/resources/${pluginId}/${resourceTypeId}/manifest?resourceId=${encodeURIComponent(resourceId)}&accountId=${accountId}`);
    return result.manifest;
  }, [accountId, resourceId, pluginId, resourceTypeId]);

  const handleApplyManifest = useCallback(async (manifest: string): Promise<void> => {
    await apiPost(`/api/resources/${pluginId}/${resourceTypeId}/manifest`, { accountId, resourceId, manifest });
    window.dispatchEvent(new CustomEvent("iw:resources-changed"));
  }, [accountId, resourceId, pluginId, resourceTypeId]);

  // ── Delete resource ──────────────────────────────────────────────────────
  async function handleDelete() {
    await apiDelete(`/api/resources/${pluginId}/${resourceTypeId}?resourceId=${encodeURIComponent(resourceId)}&accountId=${accountId}`);
    void navigate({ to: "/accounts/$accountId", params: { accountId } });
    window.dispatchEvent(new CustomEvent("iw:resources-changed"));
  }

  // ── Child resource groups ────────────────────────────────────────────────
  const childResourceGroups = useMemo((): ChildResourceGroup[] => {
    return childTypes
      .map((ct) => ({
        typeId: ct.id,
        displayName: ct.displayName,
        pluralDisplayName: ct.pluralDisplayName,
        supportsCreate: ct.supportsCreate,
        resources: childResources
          .filter((r) => r.resourceTypeId === ct.id)
          .map((r) => {
            const child: ChildResource = {
              id: r.id,
              displayName: r.displayName,
              pluginId: r.pluginId,
              resourceTypeId: r.resourceTypeId,
              accountId: r.accountId,
            };
            if (r.status) child.status = r.status as ChildResource["status"];
            return child;
          }),
      }))
      .filter((g) => g.resources.length > 0 || g.supportsCreate);
  }, [childResources, childTypes]);

  // ── Peer panes ───────────────────────────────────────────────────────────
  const peerPanes = useMemo((): PeerPaneData[] => {
    return serverPeerPanes.map((p) => ({
      tabLabel: p.tabLabel,
      pluginLogoSvg: p.pluginLogoSvg,
      credentials: {}, // not needed for rendering
      schema: p.schema,
    }));
  }, [serverPeerPanes]);

  const showingConnectionPanel = activeConnectionTab !== null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Connection feature tabs — shown above the detail view when features are available */}
      {connectionTabs.length > 0 && (
        <div className="shrink-0 flex items-center gap-0 px-4 border-b border-gray-800 bg-gray-950">
          <button
            onClick={() => setActiveConnectionTab(null)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              !showingConnectionPanel
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600"
            }`}
          >
            Details
          </button>
          {connectionTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveConnectionTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeConnectionTab === tab.id
                  ? "border-blue-500 text-white"
                  : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Detail view (overview + sql/manifest/peer tabs) */}
      {!showingConnectionPanel && (
        <div className="flex-1 overflow-auto">
          <DetailView
            schema={detailSchema}
            resourceId={resourceId}
            pluginLogoSvg={pluginLogoSvg}
            {...(hasSqlEditor ? { onRunQuery: handleRunQuery, onExecute: handleExecute } : {})}
            peerPanes={peerPanes}
            renderPeerPane={(pane) => (
              <PeerPaneView pane={pane} />
            )}
            childResourceGroups={childResourceGroups}
            onChildClick={handleChildClick}
            onChildCreate={handleChildCreate}
            renderChildResource={(child) => (
              <DraggableChildPill
                child={child}
                onOpen={() => handleChildClick(child)}
              />
            )}
            {...(hasManifestEditor ? { onGetManifest: handleGetManifest, onApplyManifest: handleApplyManifest } : {})}
          />
        </div>
      )}

      {/* Connection feature panels */}
      {activeConnectionTab === "ssh" && (
        <div className="flex-1 overflow-hidden">
          {wsToken ? (
            <WebTerminal accountId={accountId} token={wsToken} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <button
                onClick={async () => {
                  const { token } = await apiPost<{ token: string }>("/api/ws-token");
                  setWsToken(token);
                }}
                className="px-4 py-2 text-sm text-gray-300 border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
              >
                Connect SSH Terminal
              </button>
            </div>
          )}
        </div>
      )}

      {activeConnectionTab === "sftp" && (
        <div className="flex-1 overflow-hidden">
          <SftpBrowser accountId={accountId} />
        </div>
      )}

      {activeConnectionTab === "kv" && (
        <div className="flex-1 overflow-hidden">
          <KvConsole accountId={accountId} driverName={kvDriverName ?? "redis"} />
        </div>
      )}

      {activeConnectionTab === "mongo" && (
        <div className="flex-1 overflow-hidden">
          <MongoDocumentBrowser accountId={accountId} databaseName={databaseName ?? "test"} />
        </div>
      )}

      {activeConnectionTab === "docker" && containerId && (
        <div className="flex-1 overflow-hidden">
          <DockerActionsPanel accountId={accountId} containerId={containerId} />
        </div>
      )}

      {activeConnectionTab === "storage" && storageBucketName && (
        <div className="flex-1 overflow-hidden">
          <StorageBrowser accountId={accountId} bucketName={storageBucketName} />
        </div>
      )}

      {/* Delete button */}
      {canDelete && !showingConnectionPanel && (
        <div className="shrink-0 px-4 py-2 border-t border-gray-800 flex items-center justify-end gap-3">
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Delete {resourceTypeLabel}…
          </button>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          kind={resourceTypeLabel.toLowerCase()}
          name={resourceDisplayName}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {createTarget && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={pluginId}
          resourceTypeId={createTarget.typeId}
          resourceTypeDisplayName={createTarget.displayName}
          onClose={() => setCreateTarget(null)}
          onCreated={(resource) => {
            setCreateTarget(null);
            window.dispatchEvent(new CustomEvent("iw:resources-changed"));
            void navigate({
              to: "/resources/$pluginId/$resourceTypeId/$resourceId",
              params: { pluginId, resourceTypeId: createTarget.typeId, resourceId: resource.id },
              search: { accountId },
            });
          }}
        />
      )}
    </div>
  );
}

// ── Peer pane renderer ─────────────────────────────────────────────────────
// Renders the peer pane schema inline — desktop uses PeerPaneView which handles
// K8s exec, k9s, etc. On web we render the schema groups as read-only.

function PeerPaneView({ pane }: { pane: PeerPaneData }) {
  const { schema } = pane;
  const peerSchema = schema as PeerPaneSchema;

  if (peerSchema.status?.status === "provisioning") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3 text-sm text-gray-400">
        <StatusDotNodeRenderer node={peerSchema.status} />
        <span>Waiting for cluster to be ready…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {peerSchema.status && (
        <div className="flex items-center gap-2">
          <StatusDotNodeRenderer node={peerSchema.status} />
        </div>
      )}
      {peerSchema.resourceGroups?.map((group, gi) => (
        <div key={gi}>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            {group.title}
          </h3>
          {group.items.length === 0 ? (
            <p className="text-xs text-gray-600">No {group.title.toLowerCase()} found.</p>
          ) : (
            <div className="space-y-1">
              {group.items.map((item, ii) => (
                <div
                  key={ii}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-800 bg-gray-900/50 text-sm"
                >
                  {item.status && (
                    <StatusDotNodeRenderer
                      node={{ kind: "status-dot", status: item.status }}
                    />
                  )}
                  <span className="text-gray-200 font-medium">{item.displayName}</span>
                  {item.subtitle && (
                    <span className="text-gray-500 text-xs">{item.subtitle}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
