import type { ResourceTypeDefinition } from "./resource.js";

export interface CredentialField {
  key: string;
  label: string;
  description?: string;
  /** Rendered as a password input and encrypted at rest */
  sensitive: boolean;
  placeholder?: string;
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
}

export interface Plugin {
  manifest: PluginManifest;
  resourceTypes: ResourceTypeDefinition[];
  /** Create a scoped client for a set of credentials — host never exposes raw credentials */
  createClient(credentials: Record<string, string>): PluginClient;
}

// Forward declarations — defined in their own modules but used here
import type { ResourceInstance } from "./instance.js";
import type { DetailViewSchema, SidebarItemSchema } from "./schema.js";
