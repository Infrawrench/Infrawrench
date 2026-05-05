import React, { useEffect, useState } from "react";
import type {
  DetailViewSchema,
  LogsFetchParams,
  LogsFetchResult,
  ManifestEditorCapability,
  MetricSeries,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
} from "@infrawrench/plugin-base";
import { MetricChart } from "../charts/MetricChart.js";
import { SchemaRenderer, StatusDotNodeRenderer } from "../renderer/SchemaRenderer.js";
import { AssociationPicker } from "./AssociationPicker.js";
import { SqlEditorView, type QueryResult } from "./SqlEditorView.js";
import { ManifestEditorView } from "./ManifestEditorView.js";
import { DescribeView } from "./DescribeView.js";
import { LogsView } from "./LogsView.js";
import { SecretVersionsView } from "./SecretVersionsView.js";
import {
  ArtifactRegistryView,
  type ArtifactListParams,
  type ArtifactListResult,
} from "./ArtifactRegistryView.js";
import { useUIStore } from "../../store/ui.store.js";
import {
  dispatchInvokePluginAction,
  dispatchNavigateToResource,
  dispatchPromptNoSqlCommand,
  dispatchRefreshResource,
} from "../../utils.js";
import type { HostAction } from "@infrawrench/plugin-base";
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
  /** Custom renderer for child resource pills — allows the host to provide draggable pills */
  renderChildResource?: (child: ChildResource, group: ChildResourceGroup) => React.ReactNode;
  /** Time-series metric data — rendered as charts in a Metrics tab when present */
  metricSeries?: MetricSeries[] | undefined;
  /**
   * When `schema.noSqlBrowser` is set, the host provides the actual browser
   * UI via this render prop. The detail view renders it inside a dedicated
   * "Documents" tab. Keeping the UI in the host lets it hold driver-specific
   * state (connection strings, linked mongo accounts, etc.) without polluting
   * the shared component.
   */
  renderNoSqlBrowser?: () => React.ReactNode;
}

type Tab =
  | "overview"
  | "sql"
  | "manifest"
  | "describe"
  | "logs"
  | "metrics"
  | "artifacts"
  | "secret-versions"
  | "nosql-browser"
  | `peer:${number}`
  | `custom:${string}`;

export function DetailView({
  schema,
  resourceId,
  pluginLogoSvg,
  onReroll,
  providerResources = [],
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
  peerPanes = [],
  renderPeerPane,
  onPeerPaneOpen,
  childResourceGroups = [],
  onChildClick,
  onChildCreate,
  renderChildResource,
  metricSeries,
  renderNoSqlBrowser,
}: DetailViewProps) {
  const { rerollingField, closeReroll } = useUIStore();
  const hasSqlEditor = !!schema.sqlEditor && !!onRunQuery;
  const hasManifestEditor = !!schema.manifestEditor && !!onGetManifest;
  const hasDescribe = !!schema.describe && !!onGetDescribe;
  const hasLogs = !!schema.logs && !!onGetLogs;
  const hasMetrics = !!metricSeries && metricSeries.length > 0;
  const hasArtifacts = !!schema.artifactRegistry && !!onListArtifacts;
  const hasSecretVersions =
    !!schema.secretVersions &&
    !!onListSecretVersions &&
    !!onAccessSecretVersion &&
    !!onAddSecretVersion &&
    !!onModifySecretVersion;
  const hasNoSqlBrowser = !!schema.noSqlBrowser && !!renderNoSqlBrowser;
  const customTabs = schema.customTabs ?? [];
  const hasTabs =
    hasSqlEditor ||
    hasManifestEditor ||
    hasDescribe ||
    hasLogs ||
    hasMetrics ||
    hasArtifacts ||
    hasSecretVersions ||
    hasNoSqlBrowser ||
    customTabs.length > 0 ||
    peerPanes.length > 0;
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  // Reset to Overview when navigating to a different resource — otherwise
  // a stale tab (e.g. `peer:0` from a parent cluster) can leave the page blank.
  useEffect(() => {
    setActiveTab("overview");
  }, [resourceId]);

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
          <div className="flex gap-0 px-6 -mb-px overflow-x-auto">
            <TabButton
              active={activeTab === "overview"}
              onClick={() => setActiveTab("overview")}
              logoSvg={pluginLogoSvg}
            >
              Overview
            </TabButton>
            {hasSqlEditor && (
              <TabButton active={activeTab === "sql"} onClick={() => setActiveTab("sql")}>
                SQL Editor
              </TabButton>
            )}
            {hasManifestEditor && (
              <TabButton active={activeTab === "manifest"} onClick={() => setActiveTab("manifest")}>
                Manifest
              </TabButton>
            )}
            {hasDescribe && (
              <TabButton active={activeTab === "describe"} onClick={() => setActiveTab("describe")}>
                Describe
              </TabButton>
            )}
            {hasLogs && (
              <TabButton active={activeTab === "logs"} onClick={() => setActiveTab("logs")}>
                Logs
              </TabButton>
            )}
            {hasMetrics && (
              <TabButton active={activeTab === "metrics"} onClick={() => setActiveTab("metrics")}>
                Metrics
              </TabButton>
            )}
            {hasArtifacts && (
              <TabButton
                active={activeTab === "artifacts"}
                onClick={() => setActiveTab("artifacts")}
              >
                Artifacts
              </TabButton>
            )}
            {hasSecretVersions && (
              <TabButton
                active={activeTab === "secret-versions"}
                onClick={() => setActiveTab("secret-versions")}
              >
                Versions
              </TabButton>
            )}
            {hasNoSqlBrowser && (
              <TabButton
                active={activeTab === "nosql-browser"}
                onClick={() => setActiveTab("nosql-browser")}
              >
                Documents
              </TabButton>
            )}
            {customTabs.map((tab) => (
              <TabButton
                key={tab.id}
                active={activeTab === `custom:${tab.id}`}
                onClick={() => setActiveTab(`custom:${tab.id}`)}
              >
                {tab.label}
              </TabButton>
            ))}
            {peerPanes.map((pane, i) => (
              <TabButton
                key={i}
                active={activeTab === `peer:${i}`}
                onClick={() => {
                  setActiveTab(`peer:${i}`);
                  if (pane.loading) onPeerPaneOpen?.(pane, i);
                }}
                logoSvg={pane.pluginLogoSvg}
              >
                {pane.tabLabel}
              </TabButton>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      {activeTab === "overview" && (
        <div className="flex-1 overflow-auto p-6 space-y-6">
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
                  <ChildResourcePill
                    key={child.resourceId}
                    child={{
                      id: child.resourceId,
                      displayName: child.displayName,
                      pluginId: child.pluginId,
                      resourceTypeId: child.resourceTypeId,
                      accountId: "",
                      ...(child.status ? { status: child.status } : {}),
                      ...(child.badges && child.badges[0]
                        ? { subtitle: child.badges[0].label }
                        : {}),
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
                ))}
              </div>
            </div>
          )}

          {schema.childGroups?.map((group, gi) => (
            <div key={gi}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
                  {group.title}
                </h3>
                {group.createAction && (
                  <button
                    onClick={() => dispatchPillAction(group.createAction!)}
                    className="text-xs text-on-surface-faint hover:text-accent transition-colors"
                  >
                    {group.createLabel ?? "+ Create"}
                  </button>
                )}
              </div>
              {group.items.length === 0 ? (
                <p className="text-xs text-on-surface-faint">
                  {group.emptyText ?? "No items yet."}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {group.items.map((child) => (
                    <ChildResourcePill
                      key={child.resourceId}
                      child={{
                        id: child.resourceId,
                        displayName: child.displayName,
                        pluginId: child.pluginId,
                        resourceTypeId: child.resourceTypeId,
                        accountId: "",
                        ...(child.status ? { status: child.status } : {}),
                        ...(child.badges && child.badges[0]
                          ? { subtitle: child.badges[0].label }
                          : {}),
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
                  ))}
                </div>
              )}
            </div>
          ))}

          {childResourceGroups.map((group) => (
            <div key={group.typeId}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
                  {group.pluralDisplayName}
                </h3>
                {group.supportsCreate && onChildCreate && (
                  <button
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
                      <React.Fragment key={child.id}>
                        {renderChildResource(child, group)}
                      </React.Fragment>
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
          ))}
        </div>
      )}

      {hasSqlEditor && activeTab === "sql" && (
        <div className="flex-1 overflow-hidden">
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

      {hasManifestEditor && activeTab === "manifest" && (
        <div className="flex-1 overflow-hidden">
          <ManifestEditorView
            capability={schema.manifestEditor!}
            onGetManifest={onGetManifest!}
            onApplyManifest={onApplyManifest}
          />
        </div>
      )}

      {hasDescribe && activeTab === "describe" && (
        <div className="flex-1 overflow-hidden">
          <DescribeView capability={schema.describe!} onGetDescribe={onGetDescribe!} />
        </div>
      )}

      {hasLogs && activeTab === "logs" && (
        <div className="flex-1 overflow-hidden">
          <LogsView capability={schema.logs!} onGetLogs={onGetLogs!} />
        </div>
      )}

      {hasMetrics && activeTab === "metrics" && (
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {metricSeries!.map((series, i) => (
            <MetricChart
              key={i}
              node={{
                kind: "metric-chart",
                title: series.label,
                series: [series],
                timeRangeLabel: schema.metricsCapability?.defaultTimeRangeMs
                  ? `Last ${Math.round(schema.metricsCapability.defaultTimeRangeMs / 60000)} min`
                  : undefined,
              }}
            />
          ))}
        </div>
      )}

      {hasArtifacts && activeTab === "artifacts" && (
        <div className="flex-1 overflow-hidden">
          <ArtifactRegistryView
            capability={schema.artifactRegistry!}
            onListArtifacts={onListArtifacts!}
          />
        </div>
      )}

      {hasSecretVersions && activeTab === "secret-versions" && (
        <div className="flex-1 overflow-hidden">
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
        <div className="flex-1 flex flex-col overflow-hidden">{renderNoSqlBrowser!()}</div>
      )}

      {customTabs.map((tab) =>
        activeTab === `custom:${tab.id}` ? (
          <div key={tab.id} className="flex-1 overflow-auto p-6 space-y-6">
            {tab.sections?.map((section, i) => (
              <SchemaRenderer key={i} node={section} resourceId={resourceId} />
            ))}
            {tab.childGroups?.map((group, gi) => (
              <div key={gi}>
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
                  <p className="text-xs text-on-surface-faint">
                    {group.emptyText ?? "No items yet."}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {group.items.map((child) => (
                      <ChildResourcePill
                        key={child.resourceId}
                        child={{
                          id: child.resourceId,
                          displayName: child.displayName,
                          pluginId: child.pluginId,
                          resourceTypeId: child.resourceTypeId,
                          accountId: "",
                          ...(child.status ? { status: child.status } : {}),
                          ...(child.badges && child.badges[0]
                            ? { subtitle: child.badges[0].label }
                            : {}),
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
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : null,
      )}

      {peerPanes.map((pane, i) =>
        activeTab === `peer:${i}` ? (
          <div key={i} className="flex-1 overflow-auto p-6 space-y-6">
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
        ...(action.submitLabel ? { submitLabel: action.submitLabel } : {}),
        ...(action.danger ? { danger: action.danger } : {}),
      });
      break;
  }
}

/** Fallback child pill — used when no custom renderChildResource is provided */
function ChildResourcePill({
  child,
  onClick,
  nonInteractive,
}: {
  child: ChildResource;
  onClick: () => void;
  nonInteractive?: boolean;
}) {
  const statusDot = child.status && (
    <span
      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
        child.status.status === "healthy"
          ? "bg-emerald-400"
          : child.status.status === "error"
            ? "bg-red-400"
            : child.status.status === "degraded"
              ? "bg-yellow-400"
              : child.status.status === "provisioning"
                ? "bg-blue-400 animate-pulse"
                : "bg-surface-sunken"
      }`}
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
}: {
  active: boolean;
  onClick: () => void;
  logoSvg?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}
