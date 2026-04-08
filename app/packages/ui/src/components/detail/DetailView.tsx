import React, { useState } from "react";
import type { DetailViewSchema, PeerPaneSchema, StatusDotNode } from "@infrawrench/plugin-base";
import { SchemaRenderer, StatusDotNodeRenderer } from "../renderer/SchemaRenderer.js";
import { AssociationPicker } from "./AssociationPicker.js";
import { SqlEditorView, type QueryResult } from "./SqlEditorView.js";
import { useUIStore } from "../../store/ui.store.js";

export interface PeerPaneData {
  tabLabel: string;
  pluginLogoSvg: string;
  credentials: Record<string, string>;
  schema: PeerPaneSchema;
}

/** A single child resource shown in a group on the detail page */
export interface ChildResource {
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  status?: StatusDotNode;
  subtitle?: string;
}

/** A group of child resources by type */
export interface ChildResourceGroup {
  typeId: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate: boolean;
  resources: ChildResource[];
}

interface DetailViewProps {
  schema: DetailViewSchema;
  resourceId: string;
  pluginLogoSvg: string;
  /** Called when the user confirms an association reroll */
  onReroll?: (fieldKey: string, selection: RerollSelection | { kind: "literal"; value: string }) => void;
  /** Available provider resources for the reroll picker */
  providerResources?: ProviderResource[];
  /**
   * Host-provided SQL executor. Required when schema.sqlEditor is set.
   * The host owns the DB driver — this component only provides the UI.
   */
  onRunQuery?: (sql: string) => Promise<QueryResult>;
  /** Host-provided mutation executor (UPDATE/INSERT/DELETE with $1… params) */
  onExecute?: (sql: string, params: unknown[]) => Promise<number>;
  /** Additional panes from peer plugins — rendered as extra tabs */
  peerPanes?: PeerPaneData[];
  renderPeerPane?: (pane: PeerPaneData, index: number) => React.ReactNode;
  /** Child resource groups — fetched by the host from child resource types */
  childResourceGroups?: ChildResourceGroup[];
  /** Called when a child resource card is clicked */
  onChildClick?: (child: ChildResource) => void;
  /** Called when the user clicks "Create" for a child resource type */
  onChildCreate?: (group: ChildResourceGroup) => void;
  /** Custom renderer for child resource pills — allows the host to provide draggable pills */
  renderChildResource?: (child: ChildResource, group: ChildResourceGroup) => React.ReactNode;
}

export interface RerollSelection {
  kind: "output-ref";
  providerResourceId: string;
  providerPluginId: string;
  providerResourceTypeId: string;
  providerAccountId: string;
  providerOutputKey: string;
}

export interface ProviderResource {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  outputKey: string;
  pluginLogoSvg: string;
}

type Tab = "overview" | "sql" | `peer:${number}`;

export function DetailView({
  schema,
  resourceId,
  pluginLogoSvg,
  onReroll,
  providerResources = [],
  onRunQuery,
  onExecute,
  peerPanes = [],
  renderPeerPane,
  childResourceGroups = [],
  onChildClick,
  onChildCreate,
  renderChildResource,
}: DetailViewProps) {
  const { rerollingField, closeReroll } = useUIStore();
  const hasSqlEditor = !!schema.sqlEditor && !!onRunQuery;
  const hasTabs = hasSqlEditor || peerPanes.length > 0;
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 px-6 pt-6 pb-0 border-b border-gray-800">
        <div
          className="w-8 h-8 flex-shrink-0 mt-0.5"
          dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-gray-100 truncate">{schema.title}</h1>
          {schema.subtitle && (
            <p className="text-sm text-gray-500 mt-0.5">{schema.subtitle}</p>
          )}
          {/* Tab bar */}
          {hasTabs && (
            <div className="flex gap-0 mt-3 -mb-px">
              <TabButton
                active={activeTab === "overview"}
                onClick={() => setActiveTab("overview")}
                logoSvg={pluginLogoSvg}
              >
                Overview
              </TabButton>
              {hasSqlEditor && (
                <TabButton
                  active={activeTab === "sql"}
                  onClick={() => setActiveTab("sql")}
                >
                  SQL Editor
                </TabButton>
              )}
              {peerPanes.map((pane, i) => (
                <TabButton
                  key={i}
                  active={activeTab === `peer:${i}`}
                  onClick={() => setActiveTab(`peer:${i}`)}
                  logoSvg={pane.pluginLogoSvg}
                >
                  {pane.tabLabel}
                </TabButton>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 pt-1">
          {schema.status && <StatusDotNodeRenderer node={schema.status} />}
          {schema.headerActions?.map((action, i) => (
            <SchemaRenderer key={i} node={action} resourceId={resourceId} />
          ))}
        </div>
      </div>

      {/* Body */}
      {activeTab === "overview" && (
        <div className="flex-1 overflow-auto p-6 space-y-6">
          {schema.sections.map((section, i) => (
            <SchemaRenderer key={i} node={section} resourceId={resourceId} />
          ))}

          {schema.children && schema.children.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
                Children
              </h3>
              <div className="flex flex-wrap gap-3">
                {schema.children.map((child) => (
                  <div
                    key={child.resourceId}
                    className="text-xs text-gray-400 border border-gray-800 rounded px-2 py-1"
                  >
                    {child.displayName}
                  </div>
                ))}
              </div>
            </div>
          )}

          {childResourceGroups.map((group) => (
            <div key={group.typeId}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {group.pluralDisplayName}
                </h3>
                {group.supportsCreate && onChildCreate && (
                  <button
                    onClick={() => onChildCreate(group)}
                    className="text-xs text-gray-600 hover:text-blue-400 transition-colors"
                  >
                    + Create {group.displayName}
                  </button>
                )}
              </div>
              {group.resources.length === 0 ? (
                <p className="text-xs text-gray-600">No {group.pluralDisplayName.toLowerCase()} yet.</p>
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
          />
        </div>
      )}

      {peerPanes.map((pane, i) =>
        activeTab === `peer:${i}` ? (
          <div key={i} className="flex-1 overflow-auto p-6 space-y-6">
            {renderPeerPane ? (
              renderPeerPane(pane, i)
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3 text-sm text-gray-400">
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

/** Fallback child pill — used when no custom renderChildResource is provided */
function ChildResourcePill({ child, onClick }: { child: ChildResource; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex items-center gap-2 pl-3 pr-3 py-1.5 rounded-full border border-gray-700 bg-gray-900 hover:border-gray-600 transition-colors text-left"
    >
      {child.status && (
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          child.status.status === "healthy" ? "bg-emerald-400"
          : child.status.status === "error" ? "bg-red-400"
          : child.status.status === "degraded" ? "bg-yellow-400"
          : child.status.status === "provisioning" ? "bg-blue-400 animate-pulse"
          : "bg-gray-500"
        }`} />
      )}
      <span className="text-sm font-medium text-gray-200">{child.displayName}</span>
      {child.subtitle && (
        <span className="text-xs text-gray-500">{child.subtitle}</span>
      )}
      <span className="text-gray-700 group-hover:text-gray-400 transition-colors text-xs ml-1">
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
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-blue-500 text-white"
          : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600"
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
