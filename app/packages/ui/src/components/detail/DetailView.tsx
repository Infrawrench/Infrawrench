import React, { useId, useRef, useState, type KeyboardEvent } from "react";
import type {
  ChatMessage,
  ChatStreamEvent,
  ChildGroupSchema,
  DashboardCardSchema,
  DetailViewSchema,
  KvListResult,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PublishMessagePayload,
  PublishMessageResult,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import { MetricChart } from "../charts/MetricChart.js";
import { SchemaRenderer, StatusDotNodeRenderer } from "../renderer/SchemaRenderer.js";
import { AssociationPicker } from "./AssociationPicker.js";
import { ChildResourceTable } from "./ChildResourceTable.js";
import { SqlEditorView, type QueryResult } from "./SqlEditorView.js";
import { ManifestEditorView } from "./ManifestEditorView.js";
import { SettingsEditorView } from "./SettingsEditorView.js";
import { BucketPolicyEditor } from "./BucketPolicyEditor.js";
import { DescribeView } from "./DescribeView.js";
import { LogsView } from "./LogsView.js";
import { ChatPanel } from "./ChatPanel.js";
import { PublishPanel } from "./PublishPanel.js";
import { SpeechPanel } from "./SpeechPanel.js";
import { SecretVersionsView } from "./SecretVersionsView.js";
import {
  ArtifactRegistryView,
  type ArtifactListParams,
  type ArtifactListResult,
} from "./ArtifactRegistryView.js";
import { KvBrowserView, type KvBrowserListParams } from "./KvBrowserView.js";
import { ResourceDependenciesPanel } from "../graph/ResourceDependenciesPanel.js";
import { statusDotClass } from "../schema-tokens.js";
import { useUIStore } from "../../store/ui.store.js";
import {
  dispatchInvokePluginAction,
  dispatchNavigateToResource,
  dispatchPromptNoSqlCommand,
  dispatchRefreshResource,
} from "../../utils.js";
import type { HostAction } from "@infrawrench/plugin-base";
import type { DependencyGraphNode, ResourceDependencies } from "@infrawrench/client-core";
import type {
  ChildResource,
  ChildResourceGroup,
  PeerPaneData,
  ProviderResource,
  RerollSelection,
} from "./detail-types.js";

export type { ChildResource, ChildResourceGroup, PeerPaneData, ProviderResource, RerollSelection };

interface DetailViewProps {
  schema: DetailViewSchema;
  resourceId: string;
  pluginLogoSvg: string;
  /** Called when the user confirms an association reroll */
  onReroll?: (
    fieldKey: string,
    selection: RerollSelection | { kind: "literal"; value: string },
  ) => void;
  /** Available provider resources for the reroll picker */
  providerResources?: ProviderResource[];
  /**
   * Host-provided SQL executor. Required when schema.sqlEditor is set.
   * The host owns the DB driver — this component only provides the UI.
   */
  onRunQuery?: (sql: string) => Promise<QueryResult>;
  /** Host-provided mutation executor (UPDATE/INSERT/DELETE with $1… params) */
  onExecute?: (sql: string, params: unknown[]) => Promise<number>;
  /** Host-provided dry-run / cost estimator. Shown when schema.sqlEditor.supportsQueryCost is true. */
  onEstimateQueryCost?: (sql: string) => Promise<QueryCostEstimate>;
  /** Fetch the raw manifest text for the manifest editor tab */
  onGetManifest?: () => Promise<string>;
  /** Apply an updated manifest — used by the manifest editor tab */
  onApplyManifest?: (manifest: string) => Promise<void>;
  /** Fetch describe text — used by the Describe tab when schema.describe is set */
  onGetDescribe?: () => Promise<string>;
  /** Fetch log output — used by the Logs tab when schema.logs is set */
  onGetLogs?: (params: LogsFetchParams) => Promise<LogsFetchResult>;
  /** List artifacts — used by the Artifacts tab when schema.artifactRegistry is set */
  onListArtifacts?: (params: ArtifactListParams) => Promise<ArtifactListResult>;
  /** List KV keys — used by the Keys tab when schema.kvBrowser is set */
  onListKvKeys?: (params: KvBrowserListParams) => Promise<KvListResult>;
  /** Read a single KV value (UTF-8) — used by the Keys tab */
  onGetKvValue?: (key: string) => Promise<string>;
  /** Create or overwrite a KV value — used by the Keys tab */
  onPutKvValue?: (key: string, value: string) => Promise<void>;
  /** Delete a KV key — used by the Keys tab */
  onDeleteKvKey?: (key: string) => Promise<void>;
  /** List secret versions — used by the Versions tab when schema.secretVersions is set */
  onListSecretVersions?: () => Promise<SecretVersion[]>;
  /** Access a secret version's plaintext value */
  onAccessSecretVersion?: (versionId: string) => Promise<string>;
  /** Add a new secret version with the given value */
  onAddSecretVersion?: (value: string) => Promise<SecretVersion>;
  /** Enable/disable/destroy a secret version */
  onModifySecretVersion?: (
    versionId: string,
    action: SecretVersionMutation,
  ) => Promise<SecretVersion>;
  /** Open a console/exec terminal for the resource — when set, renders a "Console" button in the header */
  onOpenConsole?: () => void;
  /** Additional panes from peer plugins — rendered as extra tabs */
  peerPanes?: PeerPaneData[];
  renderPeerPane?: (pane: PeerPaneData, index: number) => React.ReactNode;
  /** Called when the user first opens a peer pane tab — for lazy fetch */
  onPeerPaneOpen?: (pane: PeerPaneData, index: number) => void;
  /** Child resource groups — fetched by the host from child resource types */
  childResourceGroups?: ChildResourceGroup[];
  /** Called when a child resource card is clicked */
  onChildClick?: (child: ChildResource) => void;
  /** Called when the user clicks "Create" for a child resource type */
  onChildCreate?: (group: ChildResourceGroup) => void;
  /** Called when the user deletes a child resource from a child table */
  onChildDelete?: (child: ChildResource) => void | Promise<void>;
  /** Submit handler for a child table's inline edit form (changed fields only) */
  onChildEdit?: (child: ChildResource, changedFields: Record<string, string>) => Promise<void>;
  /** Custom renderer for child resource pills — allows the host to provide draggable pills */
  renderChildResource?: (child: ChildResource, group: ChildResourceGroup) => React.ReactNode;
  /** Time-series metric data — rendered as charts in a Metrics tab when present */
  metricSeries?: MetricSeries[] | undefined;
  /**
   * When set, a "Changes" tab renders the resource's change timeline via this
   * render prop. Host-driven rather than schema-driven — the feed is recorded
   * by the cloud poller on the generic stored record, so it exists for every
   * plugin, and only hosts with a change store (web today) wire it.
   */
  renderChangesTab?: (() => React.ReactNode) | undefined;
  /**
   * When `schema.noSqlBrowser` is set, the host provides the actual browser
   * UI via this render prop. The detail view renders it inside a dedicated
   * "Documents" tab. Keeping the UI in the host lets it hold driver-specific
   * state (connection strings, linked mongo accounts, etc.) without polluting
   * the shared component.
   */
  renderNoSqlBrowser?: () => React.ReactNode;
  /**
   * When `schema.storageBrowser` is set, the host renders the file browser
   * via this render prop. Lives inside a "Files" tab so it doesn't compete
   * for vertical space with editors (bucket policy, manifest, SQL).
   */
  renderStorageBrowser?: () => React.ReactNode;
  /**
   * When `schema.chatPanel` is set, the host wires this to a streaming
   * chat protocol — Electron IPC on desktop, NDJSON-over-fetch on web.
   * Each call returns an async iterable of stream events the host's
   * `ChatPanel` consumes incrementally.
   */
  onChatStream?: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatStreamEvent>;
  /**
   * When `schema.publishPanel` is set, the host wires this to publish one
   * message to the resource (Cloudflare Queue, SQS topic, …). Plugins throw
   * on validation/provider errors — the panel renders the thrown message
   * inline.
   */
  onPublishMessage?: (payload: PublishMessagePayload) => Promise<PublishMessageResult>;
  /**
   * When `schema.speechPanel` declares "tts", the host wires this to the
   * plugin's `synthesizeSpeech`. The result's audio is base64 in ordinary
   * JSON — see SpeechPanelCapability for why it isn't streamed.
   */
  onSynthesizeSpeech?: (payload: SynthesizeSpeechPayload) => Promise<SynthesizeSpeechResult>;
  /**
   * When `schema.speechPanel` declares "stt", the host wires this to the
   * plugin's `transcribeAudio`.
   */
  onTranscribeAudio?: (payload: TranscribeAudioPayload) => Promise<TranscribeAudioResult>;
  /**
   * Direct neighbors in the org's output-reference dependency graph. When
   * provided (and non-empty) alongside `onOpenDependency`, a "Dependencies"
   * tab renders the "Depends on / depended on by" panel. Hosts assemble this
   * from the shared graph model (`directDependencies` in client-core).
   */
  dependencies?: ResourceDependencies;
  /** Open a dependency neighbor's resource page. */
  onOpenDependency?: (node: DependencyGraphNode) => void;
}

type Tab =
  | "overview"
  | "files"
  | "sql"
  | "manifest"
  | "settings"
  | "bucket-policy"
  | "describe"
  | "logs"
  | "metrics"
  | "changes"
  | "artifacts"
  | "kv-browser"
  | "secret-versions"
  | "nosql-browser"
  | "chat"
  | "publish"
  | "speech"
  | "dependencies"
  | `peer:${number}`
  | `custom:${string}`;

const EMPTY_PROVIDER_RESOURCES: ProviderResource[] = [];
const EMPTY_PEER_PANES: PeerPaneData[] = [];
const EMPTY_CHILD_RESOURCE_GROUPS: ChildResourceGroup[] = [];

export function DetailView({
  schema,
  resourceId,
  pluginLogoSvg,
  onReroll,
  providerResources = EMPTY_PROVIDER_RESOURCES,
  onRunQuery,
  onExecute,
  onEstimateQueryCost,
  onGetManifest,
  onApplyManifest,
  onGetDescribe,
  onGetLogs,
  onListArtifacts,
  onListKvKeys,
  onGetKvValue,
  onPutKvValue,
  onDeleteKvKey,
  onListSecretVersions,
  onAccessSecretVersion,
  onAddSecretVersion,
  onModifySecretVersion,
  onOpenConsole,
  peerPanes = EMPTY_PEER_PANES,
  renderPeerPane,
  onPeerPaneOpen,
  childResourceGroups = EMPTY_CHILD_RESOURCE_GROUPS,
  onChildClick,
  onChildCreate,
  onChildDelete,
  onChildEdit,
  renderChildResource,
  metricSeries,
  renderChangesTab,
  renderNoSqlBrowser,
  renderStorageBrowser,
  onChatStream,
  onPublishMessage,
  onSynthesizeSpeech,
  onTranscribeAudio,
  dependencies,
  onOpenDependency,
}: DetailViewProps) {
  const { rerollingField, closeReroll } = useUIStore();
  const hasSqlEditor = !!schema.sqlEditor && !!onRunQuery;
  const hasManifestEditor = !!schema.manifestEditor && !!onGetManifest;
  const hasSettingsEditor = !!schema.settingsEditor && !!onGetManifest;
  const hasBucketPolicyEditor = !!schema.bucketPolicyEditor && !!onGetManifest;
  const hasStorageBrowser = !!schema.storageBrowser && !!renderStorageBrowser;
  const hasDescribe = !!schema.describe && !!onGetDescribe;
  const hasLogs = !!schema.logs && !!onGetLogs;
  // The tab shows whenever the schema declares the capability — a brand-new
  // resource that hasn't accumulated any metric data yet would otherwise have
  // the tab disappear, which reads as "metrics broken" rather than "no data
  // yet". `metricSeriesEmpty` drives the empty-state placeholder below.
  const hasMetrics = !!schema.metricsCapability;
  const metricSeriesEmpty = !metricSeries || metricSeries.length === 0;
  const hasChangesTab = !!renderChangesTab;
  const hasArtifacts = !!schema.artifactRegistry && !!onListArtifacts;
  const hasKvBrowser =
    !!schema.kvBrowser && !!onListKvKeys && !!onGetKvValue && !!onPutKvValue && !!onDeleteKvKey;
  const hasSecretVersions =
    !!schema.secretVersions &&
    !!onListSecretVersions &&
    !!onAccessSecretVersion &&
    !!onAddSecretVersion &&
    !!onModifySecretVersion;
  const hasNoSqlBrowser = !!schema.noSqlBrowser && !!renderNoSqlBrowser;
  const hasChatPanel = !!schema.chatPanel && !!onChatStream;
  const hasPublishPanel = !!schema.publishPanel && !!onPublishMessage;
  // A speech panel needs the handler for at least one of its declared modes —
  // a plugin that only synthesizes still gets a tab on a host that hasn't
  // wired transcription, it just renders the one half.
  const speechModes = schema.speechPanel?.modes ?? [];
  const hasSpeechPanel =
    !!schema.speechPanel &&
    ((speechModes.includes("tts") && !!onSynthesizeSpeech) ||
      (speechModes.includes("stt") && !!onTranscribeAudio));
  // Only claim a tab when the resource participates in the graph at all — an
  // always-empty Dependencies tab would just be tab-strip noise.
  const hasDependencies =
    !!dependencies &&
    !!onOpenDependency &&
    dependencies.dependsOn.length + dependencies.dependedOnBy.length > 0;
  const customTabs = schema.customTabs ?? [];
  const hasTabs =
    hasStorageBrowser ||
    hasSqlEditor ||
    hasManifestEditor ||
    hasSettingsEditor ||
    hasBucketPolicyEditor ||
    hasDescribe ||
    hasLogs ||
    hasMetrics ||
    hasChangesTab ||
    hasArtifacts ||
    hasKvBrowser ||
    hasSecretVersions ||
    hasNoSqlBrowser ||
    hasChatPanel ||
    hasPublishPanel ||
    hasSpeechPanel ||
    hasDependencies ||
    customTabs.length > 0 ||
    peerPanes.length > 0;
  const [activeTabState, setActiveTab] = useState<Tab>("overview");

  const baseTabId = useId();
  const tabIdFor = (key: Tab) => `${baseTabId}-tab-${key}`;
  const panelIdFor = (key: Tab) => `${baseTabId}-panel-${key}`;

  // Ordered list of tab keys (matches the visible tab strip).
  const tabKeys: Tab[] = ["overview"];
  if (hasStorageBrowser) tabKeys.push("files");
  if (hasSqlEditor) tabKeys.push("sql");
  if (hasManifestEditor) tabKeys.push("manifest");
  if (hasSettingsEditor) tabKeys.push("settings");
  if (hasBucketPolicyEditor) tabKeys.push("bucket-policy");
  if (hasDescribe) tabKeys.push("describe");
  if (hasLogs) tabKeys.push("logs");
  if (hasMetrics) tabKeys.push("metrics");
  if (hasChangesTab) tabKeys.push("changes");
  if (hasArtifacts) tabKeys.push("artifacts");
  if (hasKvBrowser) tabKeys.push("kv-browser");
  if (hasSecretVersions) tabKeys.push("secret-versions");
  if (hasNoSqlBrowser) tabKeys.push("nosql-browser");
  if (hasChatPanel) tabKeys.push("chat");
  if (hasPublishPanel) tabKeys.push("publish");
  if (hasSpeechPanel) tabKeys.push("speech");
  if (hasDependencies) tabKeys.push("dependencies");
  for (const tab of customTabs) tabKeys.push(`custom:${tab.id}` as Tab);
  for (let i = 0; i < peerPanes.length; i++) tabKeys.push(`peer:${i}` as Tab);

  // Derive the active tab: fall back to overview whenever the stored tab isn't
  // available (e.g. a stale `peer:0` after navigating to a different resource).
  const activeTab = tabKeys.includes(activeTabState) ? activeTabState : "overview";

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabKeys.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabKeys.length) % tabKeys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabKeys.length - 1;
    else return;
    e.preventDefault();
    const nextKey = tabKeys[next];
    if (!nextKey) return;
    setActiveTab(nextKey);
    if (nextKey.startsWith("peer:")) {
      const i = Number(nextKey.slice("peer:".length));
      const pane = peerPanes[i];
      if (pane?.loading) onPeerPaneOpen?.(pane, i);
    }
    tabRefs.current[next]?.focus();
  };

  // Child resource type IDs a custom tab has claimed — those groups/tables
  // render in that tab, not on Overview.
  const tabClaimedTypeIds = new Set<string>();
  for (const t of customTabs)
    for (const id of t.childResourceTypeIds ?? []) tabClaimedTypeIds.add(id);

  // Render the child-tables + auto child-groups whose typeId passes `predicate`,
  // in that order. Used by Overview (unclaimed types) and custom tabs (their
  // claimed types).
  // Types the schema suppresses outright — another surface on this page is
  // already their listing. Applied inside renderChildArea so it holds for
  // Overview and custom tabs alike; filtering at the call sites would let a
  // tab that claims the type render it anyway.
  const hiddenChildTypeIds = new Set(schema.hiddenChildTypeIds ?? []);

  const renderChildArea = (predicate: (typeId: string) => boolean) => {
    const visible = (typeId: string) => predicate(typeId) && !hiddenChildTypeIds.has(typeId);
    const tables = (schema.childTables ?? []).filter((t) => visible(t.typeId));
    const tableTypeIds = new Set(tables.map((t) => t.typeId));
    const groups = childResourceGroups.filter(
      (g) => visible(g.typeId) && !tableTypeIds.has(g.typeId),
    );
    return (
      <>
        {tables.map((tableSpec) => (
          <ChildResourceTable
            key={`table:${tableSpec.typeId}`}
            spec={tableSpec}
            group={childResourceGroups.find((g) => g.typeId === tableSpec.typeId)}
            onRowClick={onChildClick}
            {...(onChildCreate ? { onCreate: onChildCreate } : {})}
            {...(onChildDelete ? { onDelete: onChildDelete } : {})}
            {...(onChildEdit ? { onEdit: onChildEdit } : {})}
          />
        ))}
        {groups.map((group) => (
          <AutoChildGroup
            key={group.typeId}
            group={group}
            {...(onChildCreate ? { onChildCreate } : {})}
            {...(onChildClick ? { onChildClick } : {})}
            {...(renderChildResource ? { renderChildResource } : {})}
          />
        ))}
      </>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header — title row + (separate) tab row, so the tab strip always
          spans the full width and isn't squeezed by right-side actions. */}
      <div className="border-b border-border">
        <div className="flex items-start gap-3 px-6 pt-6 pb-4">
          <div
            className="w-8 h-8 flex-shrink-0 mt-0.5"
            dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-on-surface truncate">{schema.title}</h1>
            {schema.subtitle && (
              <p className="text-sm text-on-surface-muted mt-0.5">{schema.subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 pt-1">
            {schema.status && <StatusDotNodeRenderer node={schema.status} />}
            {onOpenConsole && (
              <button
                type="button"
                onClick={onOpenConsole}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-overlay hover:bg-surface-sunken text-on-surface-secondary transition-colors"
              >
                Console
              </button>
            )}
            {(() => {
              // Custom tabs can override the top-bar header actions when
              // active — otherwise we fall back to the schema-level ones.
              const activeCustom = activeTab.startsWith("custom:")
                ? customTabs.find((t) => `custom:${t.id}` === activeTab)
                : null;
              const actions = activeCustom?.headerActions ?? schema.headerActions ?? [];
              return actions.map((action, i) => (
                <SchemaRenderer key={i} node={action} resourceId={resourceId} />
              ));
            })()}
          </div>
        </div>
        {/* Tab bar — its own full-width row so the right-side actions never
            squeeze it (which would jitter widths between tabs). */}
        {hasTabs && (
          <div
            role="tablist"
            aria-label="Resource sections"
            aria-orientation="horizontal"
            className="flex gap-0 px-6 -mb-px overflow-x-auto"
          >
            {tabKeys.map((key, index) => {
              const tabProps = {
                active: activeTab === key,
                tabId: tabIdFor(key),
                panelId: panelIdFor(key),
                onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onTabKeyDown(e, index),
                buttonRef: (el: HTMLButtonElement | null) => {
                  tabRefs.current[index] = el;
                },
              };
              if (key === "overview") {
                return (
                  <TabButton
                    key={key}
                    {...tabProps}
                    onClick={() => setActiveTab("overview")}
                    logoSvg={pluginLogoSvg}
                  >
                    Overview
                  </TabButton>
                );
              }
              if (key === "files") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("files")}>
                    Files
                  </TabButton>
                );
              }
              if (key === "sql") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("sql")}>
                    SQL Editor
                  </TabButton>
                );
              }
              if (key === "manifest") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("manifest")}>
                    {schema.manifestEditor?.resourceKind ?? "Manifest"}
                  </TabButton>
                );
              }
              if (key === "settings") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("settings")}>
                    {schema.settingsEditor?.tabLabel ?? "Settings"}
                  </TabButton>
                );
              }
              if (key === "bucket-policy") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("bucket-policy")}>
                    Bucket Policy
                  </TabButton>
                );
              }
              if (key === "describe") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("describe")}>
                    Describe
                  </TabButton>
                );
              }
              if (key === "logs") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("logs")}>
                    Logs
                  </TabButton>
                );
              }
              if (key === "metrics") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("metrics")}>
                    Metrics
                  </TabButton>
                );
              }
              if (key === "changes") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("changes")}>
                    Changes
                  </TabButton>
                );
              }
              if (key === "artifacts") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("artifacts")}>
                    Artifacts
                  </TabButton>
                );
              }
              if (key === "kv-browser") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("kv-browser")}>
                    Keys
                  </TabButton>
                );
              }
              if (key === "secret-versions") {
                return (
                  <TabButton
                    key={key}
                    {...tabProps}
                    onClick={() => setActiveTab("secret-versions")}
                  >
                    Versions
                  </TabButton>
                );
              }
              if (key === "nosql-browser") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("nosql-browser")}>
                    Documents
                  </TabButton>
                );
              }
              if (key === "chat") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("chat")}>
                    {schema.chatPanel?.tabLabel ?? "Playground"}
                  </TabButton>
                );
              }
              if (key === "publish") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("publish")}>
                    {schema.publishPanel?.tabLabel ?? "Publish"}
                  </TabButton>
                );
              }
              if (key === "speech") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("speech")}>
                    {schema.speechPanel?.tabLabel ?? "Speech"}
                  </TabButton>
                );
              }
              if (key === "dependencies") {
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab("dependencies")}>
                    Dependencies
                  </TabButton>
                );
              }
              if (key.startsWith("custom:")) {
                const customId = key.slice("custom:".length);
                const tab = customTabs.find((t) => t.id === customId);
                if (!tab) return null;
                return (
                  <TabButton key={key} {...tabProps} onClick={() => setActiveTab(key)}>
                    {tab.label}
                  </TabButton>
                );
              }
              if (key.startsWith("peer:")) {
                const i = Number(key.slice("peer:".length));
                const pane = peerPanes[i];
                if (!pane) return null;
                return (
                  <TabButton
                    key={key}
                    {...tabProps}
                    onClick={() => {
                      setActiveTab(key);
                      if (pane.loading) onPeerPaneOpen?.(pane, i);
                    }}
                    logoSvg={pane.pluginLogoSvg}
                  >
                    {pane.tabLabel}
                  </TabButton>
                );
              }
              return null;
            })}
          </div>
        )}
      </div>

      {/* Body */}
      {activeTab === "overview" && (
        <div
          role="tabpanel"
          id={panelIdFor("overview")}
          aria-labelledby={tabIdFor("overview")}
          tabIndex={0}
          className="flex-1 overflow-auto p-6 space-y-6"
        >
          {schema.sections.map((section, i) => (
            <SchemaRenderer key={i} node={section} resourceId={resourceId} />
          ))}

          {schema.children && schema.children.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted mb-3">
                Children
              </h3>
              <div className="flex flex-wrap gap-2">
                {schema.children.map((child) => (
                  <SchemaChildPill key={child.resourceId} child={child} />
                ))}
              </div>
            </div>
          )}

          {schema.childGroups?.map((group, gi) => (
            <SchemaChildGroup key={gi} group={group} />
          ))}

          {renderChildArea((typeId) => !tabClaimedTypeIds.has(typeId))}
        </div>
      )}

      {hasSqlEditor && activeTab === "sql" && (
        <div
          role="tabpanel"
          id={panelIdFor("sql")}
          aria-labelledby={tabIdFor("sql")}
          className="flex-1 overflow-hidden"
        >
          <SqlEditorView
            tables={schema.sqlEditor!.tables ?? []}
            defaultQuery={schema.sqlEditor!.defaultQuery ?? "SELECT 1;"}
            onRunQuery={onRunQuery!}
            onExecute={onExecute}
            onEstimateQueryCost={
              schema.sqlEditor!.supportsQueryCost ? onEstimateQueryCost : undefined
            }
          />
        </div>
      )}

      {hasStorageBrowser && activeTab === "files" && (
        <div
          role="tabpanel"
          id={panelIdFor("files")}
          aria-labelledby={tabIdFor("files")}
          className="flex-1 overflow-hidden flex flex-col"
        >
          {renderStorageBrowser!()}
        </div>
      )}

      {hasManifestEditor && activeTab === "manifest" && (
        <div
          role="tabpanel"
          id={panelIdFor("manifest")}
          aria-labelledby={tabIdFor("manifest")}
          className="flex-1 overflow-hidden"
        >
          <ManifestEditorView
            capability={schema.manifestEditor!}
            onGetManifest={onGetManifest!}
            onApplyManifest={onApplyManifest}
          />
        </div>
      )}

      {hasSettingsEditor && activeTab === "settings" && (
        <div
          role="tabpanel"
          id={panelIdFor("settings")}
          aria-labelledby={tabIdFor("settings")}
          className="flex-1 overflow-hidden"
        >
          <SettingsEditorView
            capability={schema.settingsEditor!}
            onGetManifest={onGetManifest!}
            {...(onApplyManifest ? { onApplyManifest } : {})}
          />
        </div>
      )}

      {hasBucketPolicyEditor && activeTab === "bucket-policy" && (
        <div
          role="tabpanel"
          id={panelIdFor("bucket-policy")}
          aria-labelledby={tabIdFor("bucket-policy")}
          className="flex-1 overflow-hidden"
        >
          <BucketPolicyEditor
            capability={schema.bucketPolicyEditor!}
            onGetManifest={onGetManifest!}
            onApplyManifest={onApplyManifest}
          />
        </div>
      )}

      {hasDescribe && activeTab === "describe" && (
        <div
          role="tabpanel"
          id={panelIdFor("describe")}
          aria-labelledby={tabIdFor("describe")}
          className="flex-1 overflow-hidden"
        >
          <DescribeView capability={schema.describe!} onGetDescribe={onGetDescribe!} />
        </div>
      )}

      {hasLogs && activeTab === "logs" && (
        <div
          role="tabpanel"
          id={panelIdFor("logs")}
          aria-labelledby={tabIdFor("logs")}
          className="flex-1 overflow-hidden"
        >
          <LogsView capability={schema.logs!} onGetLogs={onGetLogs!} />
        </div>
      )}

      {hasMetrics && activeTab === "metrics" && (
        <div
          role="tabpanel"
          id={panelIdFor("metrics")}
          aria-labelledby={tabIdFor("metrics")}
          tabIndex={0}
          className="flex-1 overflow-auto p-6 space-y-6"
        >
          {metricSeriesEmpty ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-on-surface-muted">
              <p>No metric data yet.</p>
              <p className="text-xs text-on-surface-faint max-w-md text-center">
                Brand-new resources usually take a few minutes to show up here. Some series (memory,
                disk, load, filesystem on Droplets) also require the provider's metrics agent to be
                installed on the host.
              </p>
            </div>
          ) : (
            metricSeries!.map((series, i) => (
              <MetricChart
                key={i}
                node={{
                  kind: "metric-chart",
                  title: series.label,
                  series: [series],
                  ...(schema.metricsCapability?.defaultTimeRangeMs
                    ? {
                        timeRangeLabel: `Last ${Math.round(schema.metricsCapability.defaultTimeRangeMs / 60000)} min`,
                      }
                    : {}),
                }}
              />
            ))
          )}
        </div>
      )}

      {hasChangesTab && activeTab === "changes" && (
        <div
          role="tabpanel"
          id={panelIdFor("changes")}
          aria-labelledby={tabIdFor("changes")}
          tabIndex={0}
          className="flex-1 overflow-auto"
        >
          {renderChangesTab!()}
        </div>
      )}

      {hasArtifacts && activeTab === "artifacts" && (
        <div
          role="tabpanel"
          id={panelIdFor("artifacts")}
          aria-labelledby={tabIdFor("artifacts")}
          className="flex-1 overflow-hidden"
        >
          <ArtifactRegistryView
            capability={schema.artifactRegistry!}
            onListArtifacts={onListArtifacts!}
          />
        </div>
      )}

      {hasKvBrowser && activeTab === "kv-browser" && (
        <div
          role="tabpanel"
          id={panelIdFor("kv-browser")}
          aria-labelledby={tabIdFor("kv-browser")}
          className="flex-1 overflow-hidden"
        >
          <KvBrowserView
            capability={schema.kvBrowser!}
            onListKeys={onListKvKeys!}
            onGetValue={onGetKvValue!}
            onPutValue={onPutKvValue!}
            onDeleteKey={onDeleteKvKey!}
          />
        </div>
      )}

      {hasSecretVersions && activeTab === "secret-versions" && (
        <div
          role="tabpanel"
          id={panelIdFor("secret-versions")}
          aria-labelledby={tabIdFor("secret-versions")}
          className="flex-1 overflow-hidden"
        >
          <SecretVersionsView
            capability={schema.secretVersions!}
            onList={onListSecretVersions!}
            onAccess={onAccessSecretVersion!}
            onAdd={onAddSecretVersion!}
            onModify={onModifySecretVersion!}
          />
        </div>
      )}

      {hasNoSqlBrowser && activeTab === "nosql-browser" && (
        <div
          role="tabpanel"
          id={panelIdFor("nosql-browser")}
          aria-labelledby={tabIdFor("nosql-browser")}
          className="flex-1 flex flex-col overflow-hidden"
        >
          {renderNoSqlBrowser!()}
        </div>
      )}

      {hasChatPanel && activeTab === "chat" && (
        <div
          role="tabpanel"
          id={panelIdFor("chat")}
          aria-labelledby={tabIdFor("chat")}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <ChatPanel capability={schema.chatPanel!} onStream={onChatStream!} />
        </div>
      )}

      {hasPublishPanel && activeTab === "publish" && (
        <div
          role="tabpanel"
          id={panelIdFor("publish")}
          aria-labelledby={tabIdFor("publish")}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <PublishPanel capability={schema.publishPanel!} onPublish={onPublishMessage!} />
        </div>
      )}

      {hasSpeechPanel && activeTab === "speech" && (
        <div
          role="tabpanel"
          id={panelIdFor("speech")}
          aria-labelledby={tabIdFor("speech")}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <SpeechPanel
            capability={schema.speechPanel!}
            {...(onSynthesizeSpeech ? { onSynthesize: onSynthesizeSpeech } : {})}
            {...(onTranscribeAudio ? { onTranscribe: onTranscribeAudio } : {})}
          />
        </div>
      )}

      {hasDependencies && activeTab === "dependencies" && (
        <div
          role="tabpanel"
          id={panelIdFor("dependencies")}
          aria-labelledby={tabIdFor("dependencies")}
          tabIndex={0}
          className="flex-1 overflow-auto"
        >
          <ResourceDependenciesPanel
            dependencies={dependencies!}
            onOpenResource={onOpenDependency!}
          />
        </div>
      )}

      {customTabs.map((tab) =>
        activeTab === `custom:${tab.id}` ? (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelIdFor(`custom:${tab.id}` as Tab)}
            aria-labelledby={tabIdFor(`custom:${tab.id}` as Tab)}
            tabIndex={0}
            className="flex-1 overflow-auto p-6 space-y-6"
          >
            {tab.sections?.map((section, i) => (
              <SchemaRenderer key={i} node={section} resourceId={resourceId} />
            ))}
            {tab.childResourceTypeIds && tab.childResourceTypeIds.length > 0
              ? renderChildArea((typeId) => tab.childResourceTypeIds!.includes(typeId))
              : null}
            {tab.childGroups?.map((group, gi) => (
              <SchemaChildGroup key={gi} group={group} />
            ))}
          </div>
        ) : null,
      )}

      {peerPanes.map((pane, i) =>
        activeTab === `peer:${i}` ? (
          <div
            key={i}
            role="tabpanel"
            id={panelIdFor(`peer:${i}` as Tab)}
            aria-labelledby={tabIdFor(`peer:${i}` as Tab)}
            tabIndex={0}
            className="flex-1 overflow-auto p-6 space-y-6"
          >
            {pane.loading ? (
              <div className="flex items-center justify-center py-16 text-on-surface-muted text-sm animate-pulse">
                Loading {pane.tabLabel.toLowerCase()}…
              </div>
            ) : renderPeerPane ? (
              renderPeerPane(pane, i)
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised/50 px-4 py-3 text-sm text-on-surface-tertiary">
                {pane.schema.status && <StatusDotNodeRenderer node={pane.schema.status} />}
                <span>No renderer</span>
              </div>
            )}
          </div>
        ) : null,
      )}

      {/* AssociationPicker modal */}
      {rerollingField && rerollingField.resourceId === resourceId && (
        <AssociationPicker
          fieldKey={rerollingField.fieldKey}
          providerResources={providerResources}
          onConfirm={(selection) => {
            onReroll?.(rerollingField.fieldKey, selection);
            closeReroll();
          }}
          onCancel={closeReroll}
        />
      )}
    </div>
  );
}

/**
 * One auto-injected child-resource group: a labelled header (with an optional
 * "+ Create" button) over a wrap of resource pills. Shared by the Overview tab
 * and any custom tab that claims the group via `childResourceTypeIds`.
 */
function AutoChildGroup({
  group,
  onChildCreate,
  onChildClick,
  renderChildResource,
}: {
  group: ChildResourceGroup;
  onChildCreate?: (group: ChildResourceGroup) => void;
  onChildClick?: (child: ChildResource) => void;
  renderChildResource?: (child: ChildResource, group: ChildResourceGroup) => React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {group.pluralDisplayName}
        </h3>
        {group.supportsCreate && onChildCreate && (
          <button
            type="button"
            onClick={() => onChildCreate(group)}
            className="text-xs text-on-surface-faint hover:text-accent transition-colors"
          >
            + Create {group.displayName}
          </button>
        )}
      </div>
      {group.resources.length === 0 ? (
        <p className="text-xs text-on-surface-faint">
          No {group.pluralDisplayName.toLowerCase()} yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {group.resources.map((child) =>
            renderChildResource ? (
              <React.Fragment key={child.id}>{renderChildResource(child, group)}</React.Fragment>
            ) : (
              <ChildResourcePill
                key={child.id}
                child={child}
                onClick={() => onChildClick?.(child)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dispatch the subset of `HostAction` types that a pseudo-resource pill can
 * trigger on click. Reroll/copy/open-url actions belong to field-level UI,
 * not pills, and are intentionally unsupported here.
 */
function dispatchPillAction(action: HostAction): void {
  switch (action.type) {
    case "navigate-to-resource":
      dispatchNavigateToResource({
        pluginId: action.pluginId,
        resourceTypeId: action.resourceTypeId,
        resourceId: action.resourceId,
      });
      break;
    case "refresh-resource":
      dispatchRefreshResource();
      break;
    case "plugin-action":
      dispatchInvokePluginAction({
        actionId: action.actionId,
        ...(action.confirmMessage ? { confirmMessage: action.confirmMessage } : {}),
        ...(action.successMessage ? { successMessage: action.successMessage } : {}),
      });
      break;
    case "prompt-nosql-command":
      dispatchPromptNoSqlCommand({
        command: action.command,
        fields: action.fields,
        ...(action.title ? { title: action.title } : {}),
        ...(action.description ? { description: action.description } : {}),
        ...(action.descriptionVariant ? { descriptionVariant: action.descriptionVariant } : {}),
        ...(action.blocked ? { blocked: action.blocked } : {}),
        ...(action.submitLabel ? { submitLabel: action.submitLabel } : {}),
        ...(action.danger ? { danger: action.danger } : {}),
      });
      break;
  }
}

/**
 * A plugin-declared child pill.
 *
 * Schema items (`DetailViewSchema.children` and every `childGroups` entry, on
 * Overview and inside tabs alike) carry a resource id, a badge list and an
 * optional click action, none of which line up with the `ChildResource` shape
 * `ChildResourcePill` renders. This is that mapping, in one place — including
 * the fallback of navigating to the child when it declares no action.
 */
function SchemaChildPill({ child }: { child: DashboardCardSchema }) {
  return (
    <ChildResourcePill
      child={{
        id: child.resourceId,
        displayName: child.displayName,
        pluginId: child.pluginId,
        resourceTypeId: child.resourceTypeId,
        accountId: "",
        ...(child.status ? { status: child.status } : {}),
        ...(child.badges && child.badges[0] ? { subtitle: child.badges[0].label } : {}),
      }}
      nonInteractive={child.nonInteractive}
      onClick={() => {
        if (child.onClickAction) {
          dispatchPillAction(child.onClickAction);
        } else {
          dispatchNavigateToResource({
            pluginId: child.pluginId,
            resourceTypeId: child.resourceTypeId,
            resourceId: child.resourceId,
          });
        }
      }}
    />
  );
}

/** One `childGroups` entry: heading, optional create button, and its pills. */
function SchemaChildGroup({ group }: { group: ChildGroupSchema }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {group.title}
        </h3>
        {group.createAction && (
          <button
            type="button"
            onClick={() => dispatchPillAction(group.createAction!)}
            className="text-xs text-on-surface-faint hover:text-accent transition-colors"
          >
            {group.createLabel ?? "+ Create"}
          </button>
        )}
      </div>
      {group.items.length === 0 ? (
        <p className="text-xs text-on-surface-faint">{group.emptyText ?? "No items yet."}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {group.items.map((child) => (
            <SchemaChildPill key={child.resourceId} child={child} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Fallback child pill — used when no custom renderChildResource is provided */
function ChildResourcePill({
  child,
  onClick,
  nonInteractive,
}: {
  child: ChildResource;
  onClick: () => void;
  nonInteractive?: boolean | undefined;
}) {
  const statusDot = child.status && (
    <span
      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotClass(child.status.status)}`}
    />
  );
  if (nonInteractive) {
    return (
      <div className="flex items-center gap-2 pl-3 pr-3 py-1.5 rounded-full border border-border-strong bg-surface-raised/60 text-left">
        {statusDot}
        <span className="text-sm font-medium text-on-surface-secondary">{child.displayName}</span>
        {child.subtitle && <span className="text-xs text-on-surface-muted">{child.subtitle}</span>}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-2 pl-3 pr-3 py-1.5 rounded-full border border-border-strong bg-surface-raised hover:border-border-strong transition-colors text-left"
    >
      {statusDot}
      <span className="text-sm font-medium text-on-surface-secondary">{child.displayName}</span>
      {child.subtitle && <span className="text-xs text-on-surface-muted">{child.subtitle}</span>}
      <span className="text-on-surface-faint group-hover:text-on-surface-tertiary transition-colors text-xs ml-1">
        &rarr;
      </span>
    </button>
  );
}

function TabButton({
  active,
  onClick,
  logoSvg,
  children,
  tabId,
  panelId,
  onKeyDown,
  buttonRef,
}: {
  active: boolean;
  onClick: () => void;
  logoSvg?: string;
  children: React.ReactNode;
  tabId: string;
  panelId: string;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
        active
          ? "border-blue-500 text-white"
          : "border-transparent text-on-surface-muted hover:text-on-surface-secondary hover:border-border-strong"
      }`}
    >
      {logoSvg && (
        <span
          className="w-3.5 h-3.5 flex-shrink-0 inline-flex"
          dangerouslySetInnerHTML={{ __html: logoSvg }}
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
