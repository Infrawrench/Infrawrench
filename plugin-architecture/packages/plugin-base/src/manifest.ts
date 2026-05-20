import type { ResourceTypeDefinition } from "./resource.js";

export interface CredentialFieldRegion {
  id: string;
  label: string;
  location?: string;
  flag?: string;
}

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
  /** When provided, the field is rendered as the searchable region picker */
  regions?: CredentialFieldRegion[];
  /**
   * When set, the field is rendered as a picker of existing accounts in the same
   * organization. The stored value is the selected account's id (or empty for
   * "None"). `pluginId` filters the dropdown to accounts of a single plugin —
   * e.g. the SSH plugin's "Connect through" field filters to `ssh`.
   */
  accountReference?: { pluginId: string };
  /** Field is optional — the modal accepts an empty value and skips validation. */
  optional?: boolean;
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

/**
 * Declares that this plugin manages a Kubernetes cluster.
 * The host owns the kubeconfig parsing + auth (via @kubernetes/client-node);
 * the plugin issues typed operations via KubernetesHostServices.
 */
export interface KubernetesDriverDeclaration {
  /** Identifier for the K8s driver — always "kubernetes". */
  driver: string;
  /** The key in the account credentials that holds the kubeconfig YAML. */
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
   * If present, the host will inject KubernetesHostServices into the plugin client,
   * backed by @kubernetes/client-node so exec/auth-provider/OIDC kubeconfigs work.
   */
  kubernetesDriver?: KubernetesDriverDeclaration;
  /**
   * If true, this plugin's client implements importSecret() and listNamespacesForImport(),
   * allowing other resources to be dragged onto accounts of this plugin to create secrets.
   */
  supportsSecretImport?: boolean;
  /**
   * Optional per-account rate-limit budget the background poller and probe
   * paths use when fanning out listResources calls. Missing → default bucket.
   */
  rateLimit?: RateLimitDeclaration;
}

export interface RateLimitDeclaration {
  /** Token bucket capacity (burst allowance) per account. */
  capacity: number;
  /** Tokens refilled per second per account. */
  refillPerSecond: number;
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
 * Host-provided Kubernetes operations injected into plugin clients. Backed
 * by the official `@kubernetes/client-node` SDK in the Node host process so
 * kubeconfigs with `exec` credential plugins, `auth-provider`, OIDC, and
 * multi-context configs work. Plugins fall back to a hand-rolled REST
 * fetcher when this service is absent (browser / renderer paths).
 */
export interface KubernetesHostServices {
  /** Run a high-level Kubernetes operation and return the result */
  command(op: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Host-provided HTTP request proxy injected into plugin clients.
 *
 * This is the *only* sanctioned outbound HTTP path for plugins. Going through
 * the host buys two things plugins can't get on their own:
 *   - Custom CA certificates the browser/renderer won't trust by default.
 *   - Per-account egress routing through a bastion agent when the account is
 *     bound to one. Plugins that bypass `services.http` and call `fetch`
 *     directly will *not* be tunnelled — even when the user has selected a
 *     bastion for that account.
 *
 * `body` accepts a `Uint8Array` for SigV4 / binary payloads. The response
 * body is always a UTF-8 string; for endpoints that return arbitrary binary
 * (storage object reads, etc.), use a dedicated host service instead.
 */
export interface HttpHostServices {
  /** Make an HTTP request through the host process. */
  request(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    caCert?: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

/**
 * Host-provided read access to persisted secretStates. Plugins can fetch the
 * decrypted plaintext of a secret they previously stashed (e.g. a password
 * captured at create time). The host owns encryption — plugins never see
 * ciphertext or the master key.
 *
 * Returns `null` when no entry exists or decryption fails.
 */
export interface SecretHostServices {
  getPlaintext(resourceId: string, fieldKey: string): Promise<string | null>;
}

export interface HostServices {
  /** Present only when the plugin's manifest declares a sqlDriver */
  sql?: SqlHostServices;
  /** Present only when the plugin's manifest declares a kvDriver */
  kv?: KvHostServices;
  /** Present only when the plugin's manifest declares a dockerDriver */
  docker?: DockerHostServices;
  /**
   * Present only when the host has a Kubernetes node driver registered
   * (Electron main / poller). The plugin client prefers this over the
   * hand-rolled REST fallback when available.
   */
  k8s?: KubernetesHostServices;
  /** Always available — proxies HTTP requests through the host for custom CA support */
  http?: HttpHostServices;
  /** Always available — read decrypted plaintext for the plugin's own persisted secretStates */
  secrets?: SecretHostServices;
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
  /**
   * Account id of the parent account. Use this as the accountId prefix for any
   * resource IDs generated in the peer pane so they match what `listResources`
   * returns when the user navigates into a pill.
   */
  accountId: string;
}

export interface PluginClient {
  /**
   * List all instances of a resource type for an account.
   *
   * `opts.regionHint` is a non-binding scope: the host passes it when it knows
   * the caller only cares about one region (e.g. a create-form resource-picker
   * after the user has selected a region). Plugins that fan out across regions
   * should restrict the fan-out to that one region; others can ignore it.
   * Results from outside the hinted region are still acceptable — the host
   * filters at the picker layer when it needs strict scoping.
   */
  listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): Promise<ResourceInstance[]>;
  /** Fetch a single resource's current state */
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
  /** Resolve an output value — called by the host's SecretResolver */
  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string>;
  /**
   * Optional async enrichment hook called by the host immediately before
   * `renderDetail` on the resource detail view. Plugins can make additional
   * API calls here and return an updated `ResourceInstance` (e.g. extra
   * fields/resolvedOutputs). The host passes the returned instance to
   * `renderDetail`. Failures should throw — the host will fall back to the
   * un-enriched resource.
   */
  enrichDetail?(resource: ResourceInstance): Promise<ResourceInstance>;
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
  /** Fetch connection stats (version, size) for SQL/KV/Docker resources. */
  fetchStats?(): Promise<{ version: string; size: string }>;
  /** Fetch generic labelled stats for a dashboard card. */
  fetchDashboardStats?(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]>;
  /** Fetch time-series metric data for a resource (e.g. CPU, memory, request rate). */
  fetchMetricSeries?(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]>;
  /** List objects in a storage bucket at a given prefix (delimiter="/") */
  listStorageObjects?(bucket: string, prefix: string): Promise<StorageObject[]>;
  /** Upload a file to the given key within a bucket */
  uploadStorageObject?(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void>;
  /** Create a folder placeholder (zero-byte object with trailing slash) */
  makeStorageFolder?(bucket: string, key: string): Promise<void>;
  /** Delete an object. If key ends with "/" deletes all objects under that prefix. */
  deleteStorageObject?(bucket: string, key: string): Promise<void>;
  /** Return a short-lived bearer token the host can use for direct storage API calls (e.g. batch download via IPC). */
  getStorageAccessToken?(): Promise<string>;
  /** Return SSH connection details for terminal access — only when the resource type declares supportsTerminal */
  getSshConfig?(): { host: string; port: number; username: string; privateKey: string };
  /** Fetch a fully-populated create form config for a resource type (regions, sizes, etc. from live API).
   * When creating a child resource from its parent's detail page, `parentResourceId` is the full
   * `{accountId}:{typeId}:{externalId}` id of the parent so the plugin can omit fields implied by it. */
  getCreateConfig?(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig>;
  /**
   * Optionally resolve size pricing after initial form load.
   * Hosts may call this asynchronously to avoid blocking create modal rendering.
   */
  getCreateSizePricing?(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>>;
  /**
   * Optionally estimate the total monthly cost for the current create-form field values.
   * Plugins can include provider-specific components like storage in this estimate.
   */
  getCreateCostEstimate?(typeId: string, fields: Record<string, string>): Promise<number | null>;
  /**
   * Execute an in-form field action (declared via `CreateFieldConfig.actions`).
   * Plugins typically use this to mint a dependency mid-form — e.g. generate
   * a fresh IAM role for a Lambda function — and return its identifier so
   * the host can fill the field with the new value.
   */
  executeFieldAction?(
    typeId: string,
    fieldKey: string,
    actionId: string,
    accountId: string,
    fields: Record<string, string>,
    /**
     * Values from the action's own inline form (declared via
     * `FieldAction.formFields`). Kept separate from the main create-form
     * `fields` so the two namespaces can't collide. Empty/undefined when the
     * action has no form panel.
     */
    actionFields?: Record<string, string>,
  ): Promise<FieldActionResult>;
  /** Permanently delete a resource. The host is responsible for confirming with the user first. */
  deleteResource?(typeId: string, resourceId: string, accountId: string): Promise<void>;
  /**
   * Apply a freshly-rerolled secret to the upstream provider before the host
   * persists it locally. Called when the user picks a literal value for a
   * sensitive field (e.g. resetting a Cloud SQL `rootPassword`). The plugin
   * is responsible for the upstream mutation; throwing aborts persistence so
   * the local store never drifts from the provider. Plugins that have
   * nothing to push (most fields) omit this method or return without action.
   */
  applySecretReroll?(
    typeId: string,
    resourceId: string,
    accountId: string,
    fieldKey: string,
    plaintext: string,
  ): Promise<void>;
  /**
   * Invoke a plugin-defined action against a resource — e.g. restart VMs in an
   * instance group. `actionId` is plugin-specific. The host calls this in
   * response to an `ActionNode` whose `action` is `{ type: "plugin-action" }`.
   */
  invokeAction?(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void>;
  /**
   * Execute a NoSQL document-browser command against a resource. Called by
   * the host when the detail view declares a `noSqlBrowser` capability.
   * `command` is plugin-specific (e.g. "listCollections", "find",
   * "deleteDocument"); `args` carry operation-specific params. The plugin
   * returns whatever payload the UI expects for that command.
   */
  executeNoSqlCommand?(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown>;
  /**
   * Attach a resource of `sourceTypeId` onto a resource of `targetTypeId` — e.g. a
   * persistent disk onto a VM. Only called when both resources live in the same
   * account and the source type declares the target in its `attachTargets`.
   */
  attachResource?(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void>;
  /** Create a new resource of the given type. Fields are the raw form values.
   * When creating a child resource from its parent's detail page, `parentResourceId` is the full
   * `{accountId}:{typeId}:{externalId}` id of the parent. */
  createResource?(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn>;
  /**
   * Execute a SQL query against a specific resource without using the node SQL driver.
   * Used for providers with REST-based query APIs (e.g. BigQuery).
   * The host calls this in place of the standard sql driver path when present.
   */
  executeQuery?(
    resourceId: string,
    accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }>;
  /**
   * Introspect a specific resource's schema (tables, columns) for SQL autocomplete.
   * Counterpart to introspect() but resource-scoped, for REST-based query providers.
   */
  introspectResource?(resourceId: string, accountId: string): Promise<SqlTableMeta[]>;
  /**
   * Estimate the cost of running a SQL query without executing it (a "dry run").
   * Used by backends that charge per byte scanned (e.g. BigQuery). The host
   * calls this when the user clicks the "Estimate" button in the SQL editor.
   */
  estimateQueryCost?(
    resourceId: string,
    accountId: string,
    sql: string,
  ): Promise<QueryCostEstimate>;
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
  /**
   * Fetch the full manifest for a resource as a text string (JSON or YAML).
   * Called when the user opens the manifest editor tab.
   */
  getManifest?(resourceId: string, accountId: string): Promise<string>;
  /**
   * Apply an updated manifest back to the resource.
   * The host is responsible for confirming destructive changes with the user first.
   */
  applyManifest?(resourceId: string, accountId: string, manifest: string): Promise<void>;
  /**
   * Apply arbitrary (possibly multi-document) YAML to this account's target —
   * `kubectl apply -f` equivalent. Used for bulk import of resources by pasting
   * YAML. Returns the number of documents applied.
   */
  importYaml?(accountId: string, yaml: string): Promise<{ applied: number }>;
  /**
   * Return a plain-text "describe" summary for a resource — in the spirit of
   * `kubectl describe`: object status, events, related objects, etc. Called
   * when the user opens the Describe tab.
   */
  describeResource?(typeId: string, resourceId: string, accountId: string): Promise<string>;
  /**
   * Fetch the last N lines of log output for a resource — in the spirit of
   * `kubectl logs`: stdout + stderr of a pod/container. The host polls this
   * periodically when follow mode is on. Plugins should return the list of
   * available containers on the first call so the UI can populate a dropdown.
   */
  getLogs?(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult>;
  /**
   * List artifacts (images/packages/versions) inside a registry-shaped resource.
   * Only called when the resource's DetailViewSchema declares an artifactRegistry
   * capability. Results are paginated; callers pass back the returned
   * nextPageToken to fetch subsequent pages.
   */
  listArtifacts?(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }>;
  /**
   * Generate downloadable credentials for a resource (e.g. AWS access key, GCP SA JSON key).
   * Only called for resource types that declare `credentialFormats`. The host is responsible
   * for showing a reveal-once modal and warning the user that the secret cannot be re-fetched.
   */
  exportCredential?(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport>;
  /**
   * List the versions of a secret-shaped resource (e.g. GCP Secret Manager Secret,
   * AWS Secrets Manager Secret). Only called when the detail view declares
   * `secretVersions`.
   */
  listSecretVersions?(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<SecretVersion[]>;
  /**
   * Return the decoded plaintext value of a specific version. Plugins should
   * surface an error for versions in `destroyed` state.
   */
  accessSecretVersion?(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
  ): Promise<string>;
  /**
   * Add a new version to a secret with the given plaintext value. The new
   * version becomes the latest enabled version.
   */
  addSecretVersion?(
    typeId: string,
    resourceId: string,
    accountId: string,
    value: string,
  ): Promise<SecretVersion>;
  /**
   * Enable, disable, or destroy a specific version. The host confirms the
   * destructive action before dispatching.
   */
  modifySecretVersion?(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
    action: SecretVersionMutation,
  ): Promise<SecretVersion>;
}

/** A single field in a credential export — e.g. "Access Key ID" and "Secret Access Key". */
export interface CredentialExportField {
  label: string;
  value: string;
  /** True for fields the UI should mask by default (e.g. secret key). */
  sensitive?: boolean;
  /** Optional short hint to show next to the field, e.g. "Only shown once". */
  hint?: string;
}

/**
 * Result of `exportCredential`. `content` is the primary payload for download (e.g. the full
 * JSON key file). `fields` is optional structured display for credentials that have multiple
 * named parts (e.g. AccessKeyId + SecretAccessKey).
 */
export interface CredentialExport {
  /** Raw payload, already decoded. For `binary-base64` media type this is the base64 string. */
  content: string;
  /** Suggested filename for download. */
  filename: string;
  /** MIME type for download (e.g. "application/json", "text/plain", "application/x-pkcs12"). */
  mimeType: string;
  /** Optional structured fields displayed as a key/value table. */
  fields?: CredentialExportField[];
  /** Short warning shown prominently, e.g. "Save this now — it cannot be retrieved later." */
  warning?: string;
}

/** Parameters passed to `PluginClient.getLogs`. */
export interface LogsFetchParams {
  /** Max lines to return from the tail. */
  tailLines?: number;
  /** Container name to fetch — required when the resource has more than one. */
  container?: string;
  /** If true, fetch logs from the previous container instance (pre-restart). */
  previous?: boolean;
}

/** Return shape of `PluginClient.getLogs`. */
export interface LogsFetchResult {
  /** Raw log text. Each line is a log entry including its trailing newline. */
  text: string;
  /** Container names available for this resource (drives the UI dropdown). */
  containers: string[];
  /** The container the returned `text` came from. */
  activeContainer: string;
}

export interface Plugin {
  manifest: PluginManifest;
  resourceTypes: ResourceTypeDefinition[];
  /** Create a scoped client for a set of credentials — host never exposes raw credentials */
  createClient(credentials: Record<string, string>, services?: HostServices): PluginClient;
}

// Forward declarations — defined in their own modules but used here
import type { ResourceCreateReturn, ResourceInstance } from "./instance.js";
import type {
  ArtifactEntry,
  DashboardStat,
  DetailViewSchema,
  MetricSeries,
  PeerPaneSchema,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
  SidebarItemSchema,
  SqlTableMeta,
  StorageObject,
} from "./schema.js";
import type {
  CreateResourceConfig,
  CreateSizePricingRequest,
  FieldActionResult,
} from "./create.js";
