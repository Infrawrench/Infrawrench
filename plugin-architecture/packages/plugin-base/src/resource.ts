export type FieldKind = "string" | "number" | "boolean" | "enum" | "secret" | "association";

/** Describes a specific plugin/resource-type/output that can provide a value */
export interface AssociationSource {
  pluginId: string;
  resourceTypeId: string;
  outputKey: string;
}

export interface FieldDefinition {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  /** For "enum" fields */
  enumValues?: string[];
  /**
   * For "secret" fields — which output keys from other resources can resolve this.
   * e.g. ["connectionString"] means any resource that outputs "connectionString" can fill this.
   */
  resolvableOutputKeys?: string[];
  /**
   * For "association" fields — explicit list of plugin/type/output combos that can provide this.
   * Also supports literal string input (user pastes a value directly).
   */
  resolvableFrom?: AssociationSource[];
  /** Whether the field supports a literal string value in addition to output-ref resolution */
  allowLiteral?: boolean;
}

export interface ResourceOutput {
  key: string;
  label: string;
  /** Sensitive outputs are encrypted at rest and masked in the UI */
  sensitive: boolean;
  description?: string;
}

/**
 * Declares that another plugin can be instantiated from this resource's outputs
 * and rendered as additional tabs in the resource detail view.
 *
 * Example: A GKE cluster declares a Kubernetes peer integration, mapping its
 * `kubeconfig` output to the Kubernetes plugin's `kubeconfig` credential.
 */
export interface PeerPluginIntegration {
  /** ID of the peer plugin to instantiate */
  pluginId: string;
  /**
   * Maps output keys from this resource to credential keys on the peer plugin.
   * All listed outputs are resolved and passed as credentials to the peer plugin's client.
   */
  credentialMappings: { outputKey: string; credentialKey: string }[];
  /** Label shown on the tab in the detail view */
  tabLabel: string;
}

/** A single key-value entry in a secret export (e.g. DATABASE_URL → connectionString output) */
export interface SecretExportEntry {
  /** The key in the K8s secret / env var name */
  envKey: string;
  /** The output key on the source resource to resolve */
  outputKey: string;
  /** Human-readable description */
  description?: string;
}

/**
 * Declares a set of secrets that can be created from a resource's outputs.
 * Shown when the user drags a resource onto a K8s cluster or SSH target.
 * Multiple templates allow different shapes (e.g. single URL vs individual fields).
 */
export interface SecretExportTemplate {
  id: string;
  displayName: string;
  description?: string;
  entries: SecretExportEntry[];
}

export interface ResourceTypeDefinition {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  description: string;
  fields: FieldDefinition[];
  outputs: ResourceOutput[];
  /** Set on child resource types — points to the parent type's id */
  parentTypeId?: string;
  /** Whether instances of this type can be pinned directly to a dashboard */
  dashboardPinnable: boolean;
  /** Named icon key within the plugin's icon set, falls back to the plugin logo */
  iconKey?: string;
  /**
   * Peer plugin integrations — other plugins whose panes are shown as extra tabs
   * when viewing a resource of this type. The host resolves the listed outputs and
   * passes them as credentials to the peer plugin's client.
   */
  peerIntegrations?: PeerPluginIntegration[];
  /**
   * When present, the host renders a "Connect to service via SSH…" context menu item
   * for instances of this type. `hostOutputKey` names the output key whose resolved
   * value is used as the SSH server address (e.g. "ipv4").
   */
  sshEndpoint?: {
    hostOutputKey: string;
    /**
     * Optional guard: SSH/SFTP buttons are only shown when the resource field
     * named by `fieldKey` equals `value` (case-insensitive).
     * For example `{ fieldKey: "status", value: "RUNNING" }` hides buttons
     * while a GCE instance is still staging.
     */
    runningWhen?: { fieldKey: string; value: string };
  };
  /** If true, the host will show a storage browser and fetch storage stats for dashboard cards of this type */
  supportsStorageBrowser?: boolean;
  /** If true, the host will offer a "Create" button for this resource type */
  supportsCreate?: boolean;
  /** If true, the host will open a built-in SSH terminal for instances of this type */
  supportsTerminal?: boolean;
  /** If true, the host will open a built-in SFTP file browser for instances of this type */
  supportsSftpBrowser?: boolean;
  /**
   * Secret export templates — declares what secrets this resource can produce
   * when dragged onto a K8s cluster or SSH target. Each template maps output keys
   * to env-var-style secret keys.
   */
  secretExportTemplates?: SecretExportTemplate[];
  /**
   * Per-resource SQL driver — when present, the host resolves a connection string
   * from this resource's outputs and enables a SQL editor tab in the detail view.
   * Unlike the manifest-level sqlDriver (which uses account credentials), this
   * resolves the connection per-resource via client.resolveOutput().
   */
  resourceSqlDriver?: {
    /** Identifier for the SQL engine (e.g. "postgres", "mysql") */
    driver: string;
    /** The output key to resolve for the connection string */
    connectionStringOutputKey: string;
  };
  /** If true, the host renders a Metrics tab and calls fetchMetricSeries */
  supportsMetrics?: boolean;
}
