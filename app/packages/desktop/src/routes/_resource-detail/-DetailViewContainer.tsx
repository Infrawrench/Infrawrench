import type React from "react";
import { useEffect, useState } from "react";
import type {
  DetailViewSchema,
  ResourceInstance,
  ResourceTypeDefinition,
  MetricSeries,
  LogsFetchParams,
  LogsFetchResult,
  ArtifactEntry,
  KvListResult,
  CostEstimate,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
  ChatMessage,
  ChatStreamEvent,
  PublishMessagePayload,
  PublishMessageResult,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import {
  DetailView,
  DraggableChildPill,
  FirestoreDocumentBrowser,
  ResourceSchedulePanel,
  ResourceLeasePanel,
  RESOURCES_CHANGED_EVENT,
  buildDependencyGraph,
  directDependencies,
  type ChildResource,
  type ChildResourceGroup,
  type DependencyGraphNode,
  type KvBrowserListParams,
  type PeerPaneData,
  type QueryResult,
  type RerollSelection,
  type ResourceDependencies,
} from "@infrawrench/ui";
import { useNavigate } from "@tanstack/react-router";
import { PeerPaneView } from "../../components/PeerPaneView";
import { FirestoreMongoPeerBrowser } from "../../components/FirestoreMongoPeerBrowser";
import { getPlugin } from "../../plugins/loader";
import { createDesktopSchedulesClient } from "../../lib/schedules-client";
import { createDesktopLeasesClient } from "../../lib/leases-client";
import type { LeasesClient, SchedulesClient } from "@infrawrench/ui";
import { navigateToWorkspaceTarget, resourceTabTarget } from "../../lib/workspace-tabs";
import { fetchCloudDependencyGraph } from "../../lib/cloud-resources";
import { loadLocalDependencyGraph } from "../../lib/local-dependency-graph";

interface DetailViewContainerProps {
  schema: DetailViewSchema;
  decodedResourceId: string;
  accountId: string;
  logoSvg: string;
  resource: ResourceInstance | null;
  peerPanes: PeerPaneData[];
  childResourceGroups: ChildResourceGroup[];
  metricSeries: MetricSeries[] | undefined;
  hasSqlEditor: boolean;
  activeCloudOrgId: string | null;
  cloudParentResourceId: string | undefined;
  accountPluginId: string | undefined;
  onPeerPaneOpen: () => void;
  onRunQuery: (sql: string) => Promise<QueryResult>;
  onExecute: (sql: string, params: unknown[]) => Promise<number>;
  onEstimateQueryCost: (sql: string) => Promise<QueryCostEstimate>;
  onGetManifest: () => Promise<string>;
  onApplyManifest: (manifest: string) => Promise<void>;
  onGetDescribe: () => Promise<string>;
  onGetLogs: (params: LogsFetchParams) => Promise<LogsFetchResult>;
  onListArtifacts: (params: {
    pageToken?: string;
    prefix?: string;
  }) => Promise<{ items: ArtifactEntry[]; nextPageToken?: string }>;
  onListSecretVersions: () => Promise<SecretVersion[]>;
  onAccessSecretVersion: (versionId: string) => Promise<string>;
  onAddSecretVersion: (value: string) => Promise<SecretVersion>;
  onModifySecretVersion: (
    versionId: string,
    action: SecretVersionMutation,
  ) => Promise<SecretVersion>;
  onOpenConsole: () => void;
  /**
   * Price this resource's current configuration. Supplied by the route, which
   * is the only place that holds both the local plugin client and the cloud
   * context. Omitted when there is no resource loaded yet.
   */
  loadCostEstimate?:
    | ((changedFields: Record<string, string>) => Promise<CostEstimate | null>)
    | null;
  onNoSqlCommand: (command: string, args: (string | number)[]) => Promise<unknown>;
  onChatStream: (
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: { model?: string },
  ) => AsyncIterable<ChatStreamEvent>;
  onPublishMessage: (payload: PublishMessagePayload) => Promise<PublishMessageResult>;
  onSynthesizeSpeech: (payload: SynthesizeSpeechPayload) => Promise<SynthesizeSpeechResult>;
  onTranscribeAudio: (payload: TranscribeAudioPayload) => Promise<TranscribeAudioResult>;
  onListKvKeys?: (params: KvBrowserListParams) => Promise<KvListResult>;
  onGetKvValue?: (key: string) => Promise<string>;
  onPutKvValue?: (key: string, value: string) => Promise<void>;
  onDeleteKvKey?: (key: string) => Promise<void>;
  onChildCreate: (typeDef: ResourceTypeDefinition) => void;
  onChildDelete?: (child: ChildResource) => void | Promise<void>;
  onChildEdit?: (child: ChildResource, changedFields: Record<string, string>) => Promise<void>;
  onReroll?: (
    fieldKey: string,
    selection: RerollSelection | { kind: "literal"; value: string },
  ) => void;
  /** Renders the file browser when schema.storageBrowser is set. */
  renderStorageBrowser?: () => React.ReactNode;
}

let desktopSchedulesClient: SchedulesClient | null = null;
function getSchedulesClient(): SchedulesClient {
  if (!desktopSchedulesClient) desktopSchedulesClient = createDesktopSchedulesClient();
  return desktopSchedulesClient;
}

let desktopLeasesClient: LeasesClient | null = null;
function getLeasesClient(): LeasesClient {
  if (!desktopLeasesClient) desktopLeasesClient = createDesktopLeasesClient();
  return desktopLeasesClient;
}

export function DetailViewContainer({
  schema,
  decodedResourceId,
  accountId,
  logoSvg,
  resource,
  peerPanes,
  childResourceGroups,
  metricSeries,
  hasSqlEditor,
  activeCloudOrgId,
  cloudParentResourceId,
  accountPluginId,
  loadCostEstimate,
  onPeerPaneOpen,
  onRunQuery,
  onExecute,
  onEstimateQueryCost,
  onGetManifest,
  onApplyManifest,
  onGetDescribe,
  onGetLogs,
  onListArtifacts,
  onListSecretVersions,
  onAccessSecretVersion,
  onAddSecretVersion,
  onModifySecretVersion,
  onOpenConsole,
  onNoSqlCommand,
  onChatStream,
  onPublishMessage,
  onSynthesizeSpeech,
  onTranscribeAudio,
  onListKvKeys,
  onGetKvValue,
  onPutKvValue,
  onDeleteKvKey,
  onChildCreate,
  onChildDelete,
  onChildEdit,
  onReroll,
  renderStorageBrowser,
}: DetailViewContainerProps) {
  const navigate = useNavigate();
  const noSqlBrowser = schema?.noSqlBrowser;

  // Sleep/wake schedule tab — cloud mode only (the cloud poller executes the
  // transitions), and only for types whose plugin declares a lifecycle
  // start/stop pair. Discovered from the local plugin definition, never from
  // provider names.
  const [schedulable, setSchedulable] = useState(false);
  // Depend on the two identifying strings rather than the resource object —
  // a refetched (new-identity) resource of the same type must not re-run the
  // plugin load.
  const resourcePluginId = resource?.pluginId;
  const resourceTypeId = resource?.resourceTypeId;
  useEffect(() => {
    let cancelled = false;
    setSchedulable(false);
    if (!activeCloudOrgId || !resourcePluginId || !resourceTypeId) return undefined;
    getPlugin(resourcePluginId)
      .then((loaded) => {
        if (cancelled) return;
        const typeDef = loaded?.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
        setSchedulable(!!typeDef?.lifecycle);
      })
      .catch(() => {
        if (!cancelled) setSchedulable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId, resourcePluginId, resourceTypeId]);

  // Direct neighbors in the output-reference dependency graph — drives the
  // "Dependencies" tab. Best-effort: on failure the tab simply doesn't show.
  const [dependencies, setDependencies] = useState<ResourceDependencies | null>(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      const promise = activeCloudOrgId
        ? fetchCloudDependencyGraph(activeCloudOrgId, decodedResourceId)
        : loadLocalDependencyGraph();
      promise
        .then((graph) => {
          if (cancelled) return;
          const model = buildDependencyGraph(graph.nodes, graph.edges);
          setDependencies(directDependencies(model, decodedResourceId));
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
  }, [activeCloudOrgId, decodedResourceId]);
  const handleOpenDependency = (node: DependencyGraphNode) => {
    void navigateToWorkspaceTarget(
      navigate,
      resourceTabTarget(node.accountId, node.id, node.pluginId, node.resourceTypeId),
      { label: node.displayName },
    );
  };

  // The resource's standing monthly estimate, refreshed whenever the resource
  // does. Most plugins can't price their types, so this is null far more
  // often than not and the header chip simply doesn't render.
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  useEffect(() => {
    if (!loadCostEstimate) {
      setCostEstimate(null);
      return;
    }
    let cancelled = false;
    void loadCostEstimate({}).then((estimate) => {
      if (!cancelled) setCostEstimate(estimate);
    });
    return () => {
      cancelled = true;
    };
  }, [loadCostEstimate]);

  return (
    <div className="flex-1 overflow-hidden min-h-0">
      <DetailView
        schema={schema}
        resourceId={decodedResourceId}
        pluginLogoSvg={logoSvg}
        costEstimate={costEstimate}
        {...(onReroll ? { onReroll } : {})}
        peerPanes={peerPanes}
        renderPeerPane={(pane) => (
          <PeerPaneView
            key={pane.tabLabel}
            pane={pane}
            accountId={accountId}
            parentResourceId={decodedResourceId}
          />
        )}
        onPeerPaneOpen={onPeerPaneOpen}
        childResourceGroups={childResourceGroups}
        onChildClick={(child: ChildResource) => {
          void navigateToWorkspaceTarget(navigate, resourceTabTarget(child.accountId, child.id), {
            label: child.displayName,
          });
        }}
        onChildCreate={(group) => {
          if (!resource?.pluginId || !accountPluginId) return;
          const typeDef = childResourceGroups.find((g) => g.typeId === group.typeId);
          if (!typeDef) return;
          // Find the full ResourceTypeDefinition from the plugin
          void getPlugin(accountPluginId).then((p) => {
            const rt = p?.plugin.resourceTypes.find((t) => t.id === group.typeId);
            if (rt) onChildCreate(rt);
          });
        }}
        {...(onChildDelete ? { onChildDelete } : {})}
        {...(onChildEdit ? { onChildEdit } : {})}
        renderChildResource={(child: ChildResource) => (
          <DraggableChildPill
            child={child}
            onOpen={() => {
              void navigateToWorkspaceTarget(
                navigate,
                resourceTabTarget(child.accountId, child.id),
                { label: child.displayName },
              );
            }}
            extraDragData={{
              workspaceTabTarget: resourceTabTarget(child.accountId, child.id),
            }}
          />
        )}
        {...(hasSqlEditor
          ? {
              onRunQuery,
              onExecute,
              onEstimateQueryCost,
            }
          : {})}
        {...(schema.manifestEditor || schema.bucketPolicyEditor || schema.settingsEditor
          ? { onGetManifest, onApplyManifest }
          : {})}
        {...(schema.storageBrowser && renderStorageBrowser ? { renderStorageBrowser } : {})}
        {...(schema.describe ? { onGetDescribe } : {})}
        {...(schema.logs ? { onGetLogs } : {})}
        {...(schema.artifactRegistry ? { onListArtifacts } : {})}
        {...(schema.secretVersions
          ? {
              onListSecretVersions,
              onAccessSecretVersion,
              onAddSecretVersion,
              onModifySecretVersion,
            }
          : {})}
        {...(resource?.pluginId === "kubernetes" &&
        resource?.resourceTypeId === "k8s-pod" &&
        activeCloudOrgId &&
        cloudParentResourceId
          ? { onOpenConsole }
          : {})}
        {...(schema.chatPanel ? { onChatStream } : {})}
        {...(schema.publishPanel ? { onPublishMessage } : {})}
        {...(schema.speechPanel?.modes.includes("tts") ? { onSynthesizeSpeech } : {})}
        {...(schema.speechPanel?.modes.includes("stt") ? { onTranscribeAudio } : {})}
        {...(schema.kvBrowser && onListKvKeys && onGetKvValue && onPutKvValue && onDeleteKvKey
          ? {
              onListKvKeys,
              onGetKvValue,
              onPutKvValue,
              onDeleteKvKey,
            }
          : {})}
        {...(noSqlBrowser
          ? {
              renderNoSqlBrowser: () => {
                if (noSqlBrowser.driver === "firestore" || noSqlBrowser.driver === "dynamodb") {
                  return (
                    <FirestoreDocumentBrowser
                      databaseLabel={noSqlBrowser.databaseLabel}
                      connected={true}
                      singleCollection={noSqlBrowser.singleCollection ?? false}
                      onCommand={onNoSqlCommand}
                    />
                  );
                }
                return (
                  <FirestoreMongoPeerBrowser
                    resourceId={decodedResourceId}
                    firestoreDatabaseId={noSqlBrowser.databaseLabel}
                  />
                );
              },
            }
          : {})}
        {...(dependencies ? { dependencies, onOpenDependency: handleOpenDependency } : {})}
        {...(schedulable && activeCloudOrgId
          ? {
              renderScheduleTab: () => (
                <ResourceSchedulePanel
                  client={getSchedulesClient()}
                  target={{
                    resourceId: decodedResourceId,
                    accountId,
                    resourceName: resource?.displayName ?? decodedResourceId,
                  }}
                />
              ),
            }
          : {})}
        {...(activeCloudOrgId
          ? {
              // Lease tab — cloud mode only, like schedules (the rows live
              // server-side and the cloud poller runs the auto-delete pass),
              // but for every resource type: any resource can carry a TTL.
              renderLeaseTab: () => (
                <ResourceLeasePanel
                  client={getLeasesClient()}
                  target={{
                    resourceId: decodedResourceId,
                    accountId,
                    resourceName: resource?.displayName ?? decodedResourceId,
                  }}
                />
              ),
            }
          : {})}
        metricSeries={metricSeries}
      />
    </div>
  );
}
