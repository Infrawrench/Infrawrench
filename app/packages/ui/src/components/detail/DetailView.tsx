import { useState } from "react";
import type { DetailViewSchema } from "@infrawrench/plugin-base";
import { SchemaRenderer, StatusDotNodeRenderer } from "../renderer/SchemaRenderer.js";
import { AssociationPicker } from "./AssociationPicker.js";
import { SqlEditorView, type QueryResult } from "./SqlEditorView.js";
import { useUIStore } from "../../store/ui.store.js";

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

type Tab = "overview" | "sql";

export function DetailView({
  schema,
  resourceId,
  pluginLogoSvg,
  onReroll,
  providerResources = [],
  onRunQuery,
  onExecute,
}: DetailViewProps) {
  const { rerollingField, closeReroll } = useUIStore();
  const hasSqlEditor = !!schema.sqlEditor && !!onRunQuery;
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
          {hasSqlEditor && (
            <div className="flex gap-0 mt-3 -mb-px">
              <TabButton
                active={activeTab === "overview"}
                onClick={() => setActiveTab("overview")}
              >
                Overview
              </TabButton>
              <TabButton
                active={activeTab === "sql"}
                onClick={() => setActiveTab("sql")}
              >
                SQL Editor
              </TabButton>
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
      {(!hasSqlEditor || activeTab === "overview") && (
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-blue-500 text-white"
          : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600"
      }`}
    >
      {children}
    </button>
  );
}
