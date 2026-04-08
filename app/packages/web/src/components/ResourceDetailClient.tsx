"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DetailView,
  DraggableChildPill,
  StatusDotNodeRenderer,
  type QueryResult,
  type ChildResource,
  type ChildResourceGroup,
  type PeerPaneData,
} from "@infrawrench/ui";
import type { DetailViewSchema, PeerPaneSchema } from "@infrawrench/plugin-base";
import {
  getManifest as getManifestAction,
  applyManifest as applyManifestAction,
  deleteResource as deleteResourceAction,
} from "@/actions/resource-detail";
import { sqlQuery, sqlExecute } from "@/actions/connection-features";
import { KvConsole } from "@/components/KvConsole";
import { DockerActionsPanel } from "@/components/DockerActionsPanel";
import { MongoDocumentBrowser } from "@/components/MongoDocumentBrowser";
import { StorageBrowser } from "@/components/StorageBrowser";
import { SftpBrowser } from "@/components/SftpBrowser";
import { WebTerminal } from "@/components/WebTerminal";
import { generateWsToken } from "@/actions/ws-token";

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
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [wsToken, setWsToken] = useState<string | null>(null);

  // SQL queries via server action
  const handleRunQuery = useCallback(
    async (sql: string): Promise<QueryResult> => {
      if (!hasSqlEditor) return { rows: [], durationMs: 0 };
      const result = await sqlQuery({ accountId, resourceId, resourceTypeId, sql });
      return { rows: result.rows, durationMs: result.durationMs };
    },
    [accountId, resourceId, resourceTypeId, hasSqlEditor],
  );

  const handleExecute = useCallback(
    async (sql: string, params: unknown[]): Promise<number> => {
      const result = await sqlExecute({ accountId, resourceId, resourceTypeId, sql, params });
      return result.affectedRows;
    },
    [accountId, resourceId, resourceTypeId],
  );

  const handleChildClick = useCallback(
    (child: ChildResource) => {
      router.push(
        `/resources/${child.pluginId}/${child.resourceTypeId}/${encodeURIComponent(child.id)}`,
      );
    },
    [router],
  );

  // ── Manifest editor ──────────────────────────────────────────────────────
  const handleGetManifest = useCallback(async (): Promise<string> => {
    return getManifestAction({ accountId, resourceId });
  }, [accountId, resourceId]);

  const handleApplyManifest = useCallback(async (manifest: string): Promise<void> => {
    await applyManifestAction({ accountId, resourceId, manifest });
    router.refresh();
  }, [accountId, resourceId, router]);

  // ── Delete resource ──────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteResourceAction({ accountId, resourceTypeId, resourceId });
      router.push(`/accounts/${accountId}`);
      router.refresh();
    } catch (err) {
      setDeleting(false);
      alert(err instanceof Error ? err.message : "Failed to delete resource");
    }
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
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
          renderChildResource={(child) => (
            <DraggableChildPill
              child={child}
              onOpen={() => handleChildClick(child)}
            />
          )}
          {...(hasManifestEditor ? { onGetManifest: handleGetManifest, onApplyManifest: handleApplyManifest } : {})}
        />
      </div>

      {/* Connection feature panels */}
      {hasKvConsole && !isMongoDb && (
        <KvConsole accountId={accountId} driverName={kvDriverName ?? "redis"} />
      )}
      {hasKvConsole && isMongoDb && (
        <MongoDocumentBrowser accountId={accountId} databaseName={databaseName ?? "test"} />
      )}
      {hasDockerActions && containerId && (
        <DockerActionsPanel accountId={accountId} containerId={containerId} />
      )}
      {hasStorageBrowser && storageBucketName && (
        <StorageBrowser accountId={accountId} bucketName={storageBucketName} />
      )}
      {hasSftpBrowser && (
        <SftpBrowser accountId={accountId} />
      )}
      {hasSshTerminal && (
        <div className="border-t border-gray-800" style={{ height: "300px" }}>
          {wsToken ? (
            <WebTerminal accountId={accountId} token={wsToken} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <button
                onClick={async () => {
                  const token = await generateWsToken();
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

      {/* Delete button — mirrors desktop bottom bar */}
      {canDelete && !confirmDelete && (
        <div className="shrink-0 px-4 py-2 border-t border-gray-800 flex items-center justify-end gap-3">
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
          >
            Delete {resourceTypeLabel}…
          </button>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="shrink-0 px-4 py-3 border-t border-red-900/50 bg-red-950/30 flex items-center justify-between gap-3">
          <span className="text-xs text-red-400">
            Are you sure you want to delete this {resourceTypeLabel.toLowerCase()}? This cannot be undone.
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded border border-gray-700 hover:border-gray-600 transition-colors"
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded border border-red-800 hover:border-red-700 bg-red-950 hover:bg-red-900 transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
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
