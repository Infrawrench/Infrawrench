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

  // Direct neighbors in the output-reference dependency graph — drives the
  // "Dependencies" tab. Best-effort: on failure the tab simply doesn't show.
  const [dependencies, setDependencies] = useState<ResourceDependencies | null>(null);
  useEffect(() => {
    let cancelled = false;
    const promise = activeCloudOrgId
      ? fetchCloudDependencyGraph(activeCloudOrgId)
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
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId, decodedResourceId]);
  const handleOpenDependency = (node: DependencyGraphNode) => {
    void navigateToWorkspaceTarget(
      navigate,
      resourceTabTarget(node.accountId, node.id, node.pluginId, node.resourceTypeId),
      { label: node.displayName },
    );
  };

  return (
    <div className="flex-1 overflow-hidden min-h-0">
      <DetailView
        schema={schema}
        resourceId={decodedResourceId}
        pluginLogoSvg={logoSvg}
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
        metricSeries={metricSeries}
      />
    </div>
  );
}
