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
  description: string;
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

export interface HostServices {
  /** Present only when the plugin's manifest declares a sqlDriver */
  sql?: SqlHostServices;
  /** Present only when the plugin's manifest declares a kvDriver */
  kv?: KvHostServices;
  /** Present only when the plugin's manifest declares a dockerDriver */
  docker?: DockerHostServices;
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
}

export interface Plugin {
  manifest: PluginManifest;
  resourceTypes: ResourceTypeDefinition[];
  /** Create a scoped client for a set of credentials — host never exposes raw credentials */
  createClient(credentials: Record<string, string>, services?: HostServices): PluginClient;
}

// Forward declarations — defined in their own modules but used here
import type { ResourceInstance } from "./instance.js";
import type { DetailViewSchema, SidebarItemSchema, SqlTableMeta, StorageObject } from "./schema.js";
