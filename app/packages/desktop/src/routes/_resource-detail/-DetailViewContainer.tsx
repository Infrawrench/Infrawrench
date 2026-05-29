import type React from "react";
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
} from "@infrawrench/plugin-base";
import {
  DetailView,
  DraggableChildPill,
  FirestoreDocumentBrowser,
  type ChildResource,
  type ChildResourceGroup,
  type KvBrowserListParams,
  type PeerPaneData,
  type QueryResult,
  type RerollSelection,
} from "@infrawrench/ui";
import { useNavigate } from "@tanstack/react-router";
import { PeerPaneView } from "../../components/PeerPaneView";
import { FirestoreMongoPeerBrowser } from "../../components/FirestoreMongoPeerBrowser";
import { getPlugin } from "../../plugins/loader";
import { navigateToWorkspaceTarget, resourceTabTarget } from "../../lib/workspace-tabs";

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
  onChatStream: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatStreamEvent>;
  onPublishMessage: (payload: PublishMessagePayload) => Promise<PublishMessageResult>;
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

  return (
    <div className="flex-1 overflow-hidden min-h-0">
      <DetailView
        schema={schema}
        resourceId={decodedResourceId}
        pluginLogoSvg={logoSvg}
        {...(onReroll ? { onReroll } : {})}
        peerPanes={peerPanes}
        renderPeerPane={(pane, i) => (
          <PeerPaneView
            key={i}
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
        metricSeries={metricSeries}
      />
    </div>
  );
}
