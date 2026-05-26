import type { PeerGuidanceAction } from "./schema.js";
import type { AssociationSource } from "./create.js";

export type { AssociationSource };

export type FieldKind = "string" | "number" | "boolean" | "enum" | "secret" | "association";

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
  /**
   * When false, the field is omitted from the host's Edit form even on
   * resource types that declare `supportsUpdate`. Use for identity/key fields
   * the provider doesn't allow renaming (e.g. a bucket name). Defaults to
   * true on update-capable resource types.
   */
  editable?: boolean;
}

export interface ResourceOutput {
  key: string;
  label: string;
  /** Sensitive outputs are encrypted at rest and masked in the UI */
  sensitive: boolean;
  description?: string;
  /**
   * When true, the output is omitted from the detail page's outputs panel but
   * is still available to peer integrations, secret exports, and tool calls.
   * Use for large blob-style values (e.g. a kubeconfig YAML) that are noise
   * in the UI but load-bearing for downstream consumers.
   */
  hidden?: boolean;
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
  /**
   * Optional gate. The tab only renders when the named field on the resource
   * exists and matches one of the conditions. Use `equals` for exact match or
   * `prefix` for "starts with" — useful for engine-conditional integrations
   * (e.g. only show the PostgreSQL tab when `databaseVersion` starts with
   * `POSTGRES_`).
   */
  showWhen?: { fieldKey: string; equals?: string; prefix?: string };
  /**
   * Additional gate: each listed field must exist and be non-empty for the
   * tab to render. Combined with `showWhen` (AND). Useful when a single
   * `showWhen` can't express both an engine check and a "must have an
   * endpoint" check — e.g. Cloud SQL postgres only shows when the engine is
   * Postgres AND a public IP is available.
   */
  requiresFields?: string[];
  /**
   * Declarative "this tab can't actually connect" predicate. When the listed
   * fields are all empty on the parent resource, the host shows the tab but
   * skips spawning the peer plugin / running rewriters; instead it renders a
   * static guidance pane with `title` + `suggestions`.
   *
   * Use this for private-only network endpoints (private-IP-only Cloud SQL,
   * AlloyDB without a publicly reachable instance, AWS RDS with public
   * accessibility disabled, etc.) where Infrawrench can't synthesise VPC
   * reachability. Providers know which field signals "no public endpoint";
   * the host doesn't need to know provider-specific details.
   */
  unreachableWhen?: {
    /** All of these fields must be empty (or absent) for the tab to render unreachable. */
    fieldsEmpty: string[];
    /** One-sentence summary of why this tab can't connect from here. */
    title: string;
    /** Practical next steps, in priority order. Rendered as a bulleted list. */
    suggestions: string[];
  };
  /**
   * Optional call-to-action shown in the peer pane when credential resolution
   * FAILS (the integration's outputs couldn't produce a working credential).
   * Instead of a bare error, the host renders the error text plus this button;
   * clicking it dispatches the action's `command` to the parent resource's
   * `executeNoSqlCommand`. Use for fixes the user can trigger in-place — e.g.
   * minting a DB connection user for engines where DO never exposes the
   * built-in user's password.
   */
  credentialSetupAction?: PeerGuidanceAction;
  /**
   * When true, the host calls the peer plugin's `fetchMetricSeries` (with its
   * resolved credentials) and merges the returned series into the parent
   * resource's Metrics tab. Use for peers whose data points are meaningful
   * alongside the parent's own metrics — e.g. a SQL peer reporting connection
   * counts on top of the parent's CPU/memory series. Implies the parent gets
   * a Metrics tab even when its own `supportsMetrics` is false.
   */
  exposeMetricsToParent?: boolean;
}

/**
 * Evaluate `integration.unreachableWhen` against a resource's fields. Returns
 * the guidance to display when the predicate matches, or `null` when the
 * integration is reachable (or the predicate isn't declared).
 *
 * Used by both the server's `buildPeerPanes` and the desktop renderer's
 * peer-pane hydration so the unreachable-check behaves identically across
 * platforms.
 */
export function evaluatePeerIntegrationUnreachable(
  integration: PeerPluginIntegration,
  fields: Record<string, unknown> | undefined,
): { title: string; suggestions: string[] } | null {
  const rule = integration.unreachableWhen;
  if (!rule) return null;
  const allEmpty = rule.fieldsEmpty.every((key) => {
    const v = fields?.[key];
    return v == null || v === "";
  });
  if (!allEmpty) return null;
  return { title: rule.title, suggestions: rule.suggestions };
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
  /**
   * When true on a type with `parentTypeId`, instances appear in the account
   * sidebar as their own top-level section (in addition to being grouped
   * under the parent on the parent's detail page). Default false — child
   * types are sidebar-hidden, matching DO Droplets-inside-Projects: the
   * project is the navigable parent and droplets only show in its detail
   * page. Set true for child types the user thinks of as first-class
   * resources (e.g. snapshots, custom images, child databases of a project)
   * so they're reachable without first drilling into the parent.
   */
  showInSidebar?: boolean;
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
     * Optional output key resolving to a private/internal address (e.g.
     * "privateIp"). When present, the host can offer the user a "Private IP"
     * option — primarily used by the "Connect through jumpbox" flow, where the
     * jump host typically reaches the target on its private interface.
     */
    privateHostOutputKey?: string;
    /**
     * Optional guard: SSH/SFTP buttons are only shown when the resource field
     * named by `fieldKey` equals `value` (case-insensitive).
     * For example `{ fieldKey: "status", value: "RUNNING" }` hides buttons
     * while a GCE instance is still staging.
     */
    runningWhen?: { fieldKey: string; value: string };
    /** Static default SSH username for this resource type (e.g. "root" for Hetzner). */
    defaultUsername?: string;
    /**
     * Field key storing the per-instance SSH username (e.g. "sshUsername").
     * Resolved from the resource's `fields` map. When present and non-empty,
     * takes precedence over `defaultUsername`.
     */
    usernameFieldKey?: string;
  };
  /** If true, the host will show a storage browser and fetch storage stats for dashboard cards of this type */
  supportsStorageBrowser?: boolean;
  /** If true, the host will offer a "Create" button for this resource type */
  supportsCreate?: boolean;
  /**
   * Whether instances of this type can be deleted via the host's delete button.
   * Undefined/true → button shown (caller is expected to implement `deleteResource`).
   * Set `false` on types whose provider API doesn't support deletion (e.g. GCP KMS key rings).
   */
  supportsDelete?: boolean;
  /**
   * Whether instances of this type can be edited via the host's Edit button.
   * When true the plugin must implement `updateResource` and the host renders
   * an Edit action on the detail view that opens a form over the resource's
   * editable fields. Defaults to false.
   */
  supportsUpdate?: boolean;
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
  /**
   * Declare downloadable credentials this resource can generate (e.g. AWS IAM access keys,
   * GCP service-account JSON keys). When non-empty, the host shows a "Get credentials" button
   * on the resource detail page and calls `client.exportCredential(typeId, resourceId, accountId, formatId)`.
   */
  credentialFormats?: CredentialFormat[];
  /**
   * Resource types this resource can be attached onto via drag-drop — e.g. a
   * gce-disk declares gce-instance here. Drops are only accepted when the target
   * belongs to the same account; when `matchField` is set, the named field must
   * also match between source and target (e.g. matching zone).
   */
  attachTargets?: AttachTarget[];
}

/**
 * Declares that this resource type can be dragged onto a resource of `resourceTypeId`
 * within the same account to trigger `client.attachResource`.
 */
export interface AttachTarget {
  pluginId: string;
  resourceTypeId: string;
  /** If set, a field with this key must match between source and target. */
  matchField?: string;
  /** Short verb shown on the drop hint, e.g. "Attach". Defaults to "Attach". */
  verb?: string;
}

/**
 * Declares one way a resource can produce credentials for external use. A resource type
 * can declare multiple formats (e.g. GCP service accounts offer JSON and PKCS#12 keys).
 * The plugin is responsible for the actual credential-creation API call in `exportCredential`.
 */
export interface CredentialFormat {
  /** Stable identifier passed back to `exportCredential`. */
  id: string;
  /** Short label shown in the format picker, e.g. "Access Key", "JSON Key File". */
  label: string;
  /** Longer description shown alongside the label. */
  description?: string;
  /**
   * Presentation hint for the credential body. Affects the download extension and
   * whether the UI renders it as a code block or as base64-decoded binary.
   */
  mediaType: "json" | "text" | "ini" | "binary-base64";
  /** Suggested filename (without path). `{resource}` is replaced with the resource external id. */
  filenameTemplate?: string;
}
