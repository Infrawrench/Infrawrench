import type { ResourceTypeDefinition } from "./resource.js";

export interface CredentialField {
  key: string;
  label: string;
  description?: string;
  /** Rendered as a password input and encrypted at rest */
  sensitive: boolean;
  placeholder?: string;
  /** Pre-filled value shown in the input when the modal opens */
  defaultValue?: string;
  /** Use a textarea instead of a single-line input (e.g. kubeconfig YAML) */
  multiline?: boolean;
}

/**
 * Declares that this plugin supports a SQL editor.
 * The host uses `driver` to look up the appropriate query engine and introspection
 * queries, and `credentialKey` to find the connection string in the account credentials.
 */
export interface SqlDriverDeclaration {
  /**
   * Identifier for the SQL engine — the host maps this to concrete Tauri commands
   * and introspection queries (e.g. "postgres", "mysql", "sqlite").
   */
  driver: string;
  /** The key in the account credentials that holds the connection string/URI. */
  credentialKey: string;
}

/**
 * Declares that this plugin supports a Redis-compatible key-value store.
 * The host manages the connection; the plugin issues raw commands via KvHostServices.
 */
export interface KvDriverDeclaration {
  /** Identifier for the KV engine (e.g. "redis"). */
  driver: string;
  /** The key in the account credentials that holds the connection string/URI. */
  credentialKey: string;
}

/**
 * Declares that this plugin manages a Docker daemon.
 * The host manages the connection; the plugin issues typed operations via DockerHostServices.
 */
export interface DockerDriverDeclaration {
  /** Identifier for the Docker engine — always "docker". */
  driver: string;
  /** The key in the account credentials that holds the Docker host URI. */
  credentialKey: string;
}

export interface PluginManifest {
  /** Unique identifier — must match the blessed registry entry */
  id: string;
  version: string;
  displayName: string;
  description?: string;
  /** Raw SVG string — injected by the host into dashboard cards */
  logoSvg: string;
  author: string;
  license: "MIT";
  /** Minimum infrawrench host version required (semver) */
  minHostVersion: string;
  /** Plugin IDs this plugin may receive associations from */
  peerPlugins?: string[];
  /** Fields the host must collect from the user when adding an account */
  credentialFields: CredentialField[];
  /**
   * If present, the host will offer a SQL editor for resources from this plugin.
   * The host is responsible for the actual connection and query execution —
   * plugins only declare intent.
   */
  sqlDriver?: SqlDriverDeclaration;
  /**
   * If present, the host will inject KvHostServices into the plugin client,
   * enabling Redis-style command execution.
   */
  kvDriver?: KvDriverDeclaration;
  /**
   * If present, the host will inject DockerHostServices into the plugin client,
   * enabling Docker daemon operations.
   */
  dockerDriver?: DockerDriverDeclaration;
  /**
   * If true, this plugin's client implements importSecret() and listNamespacesForImport(),
   * allowing other resources to be dragged onto accounts of this plugin to create secrets.
   */
  supportsSecretImport?: boolean;
}

/**
 * Host-provided SQL execution primitives injected into plugin clients.
 * The host owns the actual connection and Tauri commands; the plugin
 * owns the SQL strings (queries, introspection, stats).
 */
export interface SqlHostServices {
  /** Run a SELECT and return rows */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Run an INSERT/UPDATE/DELETE and return affected row count */
  execute(sql: string, params: unknown[]): Promise<number>;
}

/**
 * Host-provided Redis command execution injected into plugin clients.
 * The host owns the connection; the plugin issues raw commands.
 */
export interface KvHostServices {
  /** Run a Redis command and return the response */
  command(cmd: string, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Host-provided Docker daemon operations injected into plugin clients.
 * The host owns the connection; the plugin issues typed operation strings.
 */
export interface DockerHostServices {
  /** Run a Docker operation and return the result */
  command(op: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Host-provided HTTP request proxy injected into plugin clients.
 * Allows plugins to make HTTP requests through the host process, which can
 * supply custom CA certificates that the browser/renderer won't trust.
 */
export interface HttpHostServices {
  /** Make an HTTP request through the host process (supports custom CA certs). */
  request(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    caCert?: string;
  }): Promise<{ status: number; body: string }>;
}

export interface HostServices {
  /** Present only when the plugin's manifest declares a sqlDriver */
  sql?: SqlHostServices;
  /** Present only when the plugin's manifest declares a kvDriver */
  kv?: KvHostServices;
  /** Present only when the plugin's manifest declares a dockerDriver */
  docker?: DockerHostServices;
  /** Always available — proxies HTTP requests through the host for custom CA support */
  http?: HttpHostServices;
}

/**
 * Context passed to a plugin's renderPeerPane method when the plugin is being
 * rendered as a secondary tab inside another plugin's resource detail view.
 */
export interface PeerPaneContext {
  /** The label declared in PeerPluginIntegration.tabLabel */
  tabLabel: string;
  /** Info about the parent resource that initiated the peer integration */
  parentPluginId: string;
  parentResourceTypeId: string;
  parentResourceId: string;
}

export interface PluginClient {
  /** List all instances of a resource type for an account */
  listResources(typeId: string, accountId: string): Promise<ResourceInstance[]>;
  /** Fetch a single resource's current state */
  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance>;
  /** Resolve an output value — called by the host's SecretResolver */
  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string>;
  /** Return the component schema for a resource's detail view */
  renderDetail(resource: ResourceInstance): DetailViewSchema;
  /**
   * Return the component schema for a peer pane — called when this plugin is embedded
   * as a secondary tab inside another plugin's resource detail view.
   * The client's credentials have already been resolved from the parent resource's outputs.
   */
  renderPeerPane?(context: PeerPaneContext): PeerPaneSchema | Promise<PeerPaneSchema>;
  /** Return the sidebar item schema for a resource */
  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema;
  /** Fetch table/column schema for the SQL editor — only when sql services are injected */
  introspect?(): Promise<SqlTableMeta[]>;
  /** Fetch lightweight stats for dashboard cards (version, size, table count) */
  fetchStats?(): Promise<{ version: string; size: string; tableCount: number }>;
  /** List objects in a storage bucket at a given prefix (delimiter="/") */
  listStorageObjects?(bucket: string, prefix: string): Promise<StorageObject[]>;
  /** Upload a file to the given key within a bucket */
  uploadStorageObject?(bucket: string, key: string, file: File, onProgress?: (pct: number) => void): Promise<void>;
  /** Create a folder placeholder (zero-byte object with trailing slash) */
  makeStorageFolder?(bucket: string, key: string): Promise<void>;
  /** Delete an object. If key ends with "/" deletes all objects under that prefix. */
  deleteStorageObject?(bucket: string, key: string): Promise<void>;
  /** Return a short-lived bearer token the host can use for direct storage API calls (e.g. batch download via IPC). */
  getStorageAccessToken?(): Promise<string>;
  /** Fetch lightweight stats for a storage bucket dashboard card (object count + total size). */
  fetchStorageStats?(bucketName: string): Promise<{ count: number; size: string }>;
  /** Return SSH connection details for terminal access — only when the resource type declares supportsTerminal */
  getSshConfig?(): { host: string; port: number; username: string; privateKey: string };
  /** Fetch a fully-populated create form config for a resource type (regions, sizes, etc. from live API). */
  getCreateConfig?(typeId: string): Promise<CreateResourceConfig>;
  /**
   * Optionally resolve size pricing after initial form load.
   * Hosts may call this asynchronously to avoid blocking create modal rendering.
   */
  getCreateSizePricing?(typeId: string, request: CreateSizePricingRequest): Promise<Record<string, number>>;
  /**
   * Optionally estimate the total monthly cost for the current create-form field values.
   * Plugins can include provider-specific components like storage in this estimate.
   */
  getCreateCostEstimate?(typeId: string, fields: Record<string, string>): Promise<number | null>;
  /** Permanently delete a resource. The host is responsible for confirming with the user first. */
  deleteResource?(typeId: string, resourceId: string, accountId: string): Promise<void>;
  /** Create a new resource of the given type. Fields are the raw form values. */
  createResource?(typeId: string, accountId: string, fields: Record<string, string>): Promise<ResourceInstance>;
  /**
   * Execute a SQL query against a specific resource without using the node SQL driver.
   * Used for providers with REST-based query APIs (e.g. BigQuery).
   * The host calls this in place of the standard sql driver path when present.
   */
  executeQuery?(resourceId: string, accountId: string, sql: string): Promise<{ rows: Record<string, unknown>[]; durationMs: number }>;
  /**
   * Introspect a specific resource's schema (tables, columns) for SQL autocomplete.
   * Counterpart to introspect() but resource-scoped, for REST-based query providers.
   */
  introspectResource?(resourceId: string, accountId: string): Promise<SqlTableMeta[]>;
  /**
   * Import secret data into this plugin's target (e.g. create a K8s Secret).
   * Called by the host after resolving all output values from the source resource.
   */
  importSecret?(
    accountId: string,
    config: { namespace: string; secretName: string; data: Record<string, string> },
  ): Promise<void>;
  /**
   * List namespaces available for secret import targeting.
   * The host uses this to populate the namespace dropdown in the secret export modal.
   */
  listNamespacesForImport?(accountId: string): Promise<string[]>;
}

export interface Plugin {
  manifest: PluginManifest;
  resourceTypes: ResourceTypeDefinition[];
  /** Create a scoped client for a set of credentials — host never exposes raw credentials */
  createClient(credentials: Record<string, string>, services?: HostServices): PluginClient;
}

// Forward declarations — defined in their own modules but used here
import type { ResourceInstance } from "./instance.js";
import type {
  DetailViewSchema,
  PeerPaneSchema,
  SidebarItemSchema,
  SqlTableMeta,
  StorageObject,
} from "./schema.js";
import type { CreateResourceConfig, CreateSizePricingRequest } from "./create.js";
