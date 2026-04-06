import type { SecretResolution } from "./secrets.js";

/**
 * Component schema — a sealed discriminated union of renderable primitives.
 *
 * Plugins return these plain data structures. The host app owns all React code
 * and interprets the schema. Plugins have zero UI framework dependencies.
 *
 * Actions are typed host operations — plugins cannot inject arbitrary handlers.
 */

// ─── Action types ─────────────────────────────────────────────────────────────

export type HostAction =
  | { type: "reroll-secret"; fieldKey: string }
  | { type: "open-url"; url: string }
  | { type: "copy-to-clipboard"; fieldKey: string }
  | {
      type: "navigate-to-resource";
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
    }
  | { type: "refresh-resource" };

// ─── Schema nodes ─────────────────────────────────────────────────────────────

export interface TextNode {
  kind: "text";
  content: string;
  variant?: "heading" | "subheading" | "body" | "mono" | "muted";
}

export interface BadgeNode {
  kind: "badge";
  label: string;
  color: "green" | "yellow" | "red" | "blue" | "gray";
}

export interface StatusDotNode {
  kind: "status-dot";
  status: "healthy" | "degraded" | "error" | "unknown" | "provisioning";
  label?: string;
}

export interface SecretValuePlaceholder {
  kind: "secret-placeholder";
  fieldKey: string;
  resolution: SecretResolution;
}

export interface KVItem {
  key: string;
  value: string | SecretValuePlaceholder;
  copyable?: boolean;
  sensitive?: boolean;
}

export interface KeyValueListNode {
  kind: "key-value-list";
  items: KVItem[];
}

export interface ActionNode {
  kind: "action";
  label: string;
  action: HostAction;
  variant?: "default" | "danger" | "ghost";
}

export interface GridNode {
  kind: "grid";
  columns: 1 | 2 | 3 | 4;
  items: SchemaNode[];
}

export interface SectionNode {
  kind: "section";
  title?: string;
  children: SchemaNode[];
}

export interface LinkNode {
  kind: "link";
  label: string;
  url: string;
}

export type SchemaNode =
  | TextNode
  | BadgeNode
  | StatusDotNode
  | KeyValueListNode
  | ActionNode
  | GridNode
  | SectionNode
  | LinkNode;

// ─── View schemas ─────────────────────────────────────────────────────────────

/**
 * Dashboard card — always rendered as:
 *   ┌──────────────┐
 *   │   [logo svg] │
 *   │  <name>      │
 *   │  ● healthy   │
 *   └──────────────┘
 * The logo is injected by the host from the plugin manifest's logoSvg.
 */
export interface DashboardCardSchema {
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
  displayName: string;
  status?: StatusDotNode;
  /** Corner badges (e.g. "prod", "us-east-1") */
  badges?: BadgeNode[];
}

/** Structured metadata the host can inject so the plugin can populate the SQL editor sidebar */
export interface SqlTableMeta {
  name: string;
  columns: Array<{ name: string; type: string }>;
  /** Primary key column names — enables inline row editing in the SQL editor */
  pkColumns?: string[];
}

/**
 * When present on a DetailViewSchema, the host must render a SQL editor tab.
 * The host owns SQL execution (via its native DB driver); plugins declare support
 * and supply table metadata so the editor sidebar can be populated.
 */
export interface SqlEditorCapability {
  /** Key in the host's credentials/resolved-outputs that holds the connection string */
  connectionStringOutputKey: string;
  defaultQuery?: string;
  /** Pre-fetched table/column metadata — populated by the host before calling renderDetail() */
  tables?: SqlTableMeta[];
}

/** A single object or directory entry returned by listStorageObjects() */
export interface StorageObject {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  contentType?: string;
}

/**
 * When present on a DetailViewSchema, the host renders a file-browser panel
 * backed by PluginClient.listStorageObjects().
 */
export interface StorageBrowserCapability {
  bucketName: string;
}

/** Full detail view — shown when user clicks a card or sidebar item */
export interface DetailViewSchema {
  title: string;
  subtitle?: string;
  status?: StatusDotNode;
  sections: SectionNode[];
  /** Child resources shown in a sub-grid — can be pinned independently */
  children?: DashboardCardSchema[];
  headerActions?: ActionNode[];
  /** If present, the host renders a SQL editor tab alongside the overview */
  sqlEditor?: SqlEditorCapability;
  /** If present, the host renders a cloud storage file browser panel */
  storageBrowser?: StorageBrowserCapability;
}

/** Sidebar tree node */
export interface SidebarItemSchema {
  id: string;
  label: string;
  status?: StatusDotNode;
  children?: SidebarItemSchema[];
}
