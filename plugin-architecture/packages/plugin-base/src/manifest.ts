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
  /**
   * Optional external link rendered beneath the field — e.g. a deep link to the
   * provider's "create token" page with the scopes this plugin needs pre-filled.
   * Opened through the host's external-URL handler so it works in both the web
   * app and the desktop shell.
   */
  helpLink?: { label: string; url: string };
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
  /**
   * Optional credential key that holds a PEM-encoded CA certificate to trust
   * for TLS chain verification. Use for managed-DB providers that sign with
   * their own internal CA (DigitalOcean, AWS RDS with default certs, etc.) —
   * the host passes the value through to the driver so cert verification
   * stays *on* with the vendor CA explicitly trusted, instead of being
   * disabled outright. When unset or empty, the driver uses the system
   * trust store.
   */
  caCertKey?: string;
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
  /** Unique plugin identifier, e.g. "digitalocean" */
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
  /**
   * If present, this plugin can report actual spend for an account via
   * `fetchCostData`, and the host schedules a low-frequency cost collection
   * pass for its accounts.
   */
  costs?: CostCapabilityDeclaration;
  /**
   * If present, this plugin can report a prepaid credit balance for an
   * account via `fetchCreditBalance`, and the host schedules a low-frequency
   * collection pass that turns the resulting series into a burn rate and a
   * runway. Independent of `costs`: most prepaid providers bill nothing in
   * arrears and expose no cost API at all.
   */
  credits?: CreditsCapabilityDeclaration;
  /**
   * If present, this plugin's provider publishes a public status feed. The
   * host polls `statusFeed.url` (no credentials — the feed is public) on a
   * low-frequency background pass and hands the raw body to the plugin's
   * `parseStatusFeed`, then correlates the returned incidents against the
   * resources an org holds on this plugin.
   */
  statusFeed?: StatusFeedDeclaration;
  /**
   * If present, this plugin supports credential preflight: the host offers a
   * per-capability permission checklist at add-account time (backed by
   * `PluginClient.verifyCredentials`) and, when `templateFormat` is set, a
   * least-privilege policy generator (backed by `Plugin.policyTemplate`).
   */
  preflight?: PreflightDeclaration;
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
 * `body` accepts a `Uint8Array` for SigV4 / binary payloads. By default the
 * response `body` is a UTF-8 string. Pass `responseEncoding: "binary"` when
 * the endpoint returns arbitrary bytes — then `rawBody` carries them and
 * `body` is empty. Prefer that over decoding a UTF-8 string, which would
 * corrupt anything that isn't text.
 */
export interface HttpHostServices {
  /** Make an HTTP request through the host process. */
  request(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    caCert?: string;
    /**
     * How to decode the response. `"utf8"` (default) puts text in `body`.
     * `"binary"` puts the raw bytes in `rawBody` and leaves `body` empty.
     */
    responseEncoding?: "utf8" | "binary";
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    /** Set when `responseEncoding` was `"binary"`. */
    rawBody?: Uint8Array;
  }>;
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
  /**
   * Persist a plaintext secret against a resource + field, encrypted at rest
   * by the host. Used by plugins that mint a long-lived credential they want
   * to reuse across sessions and (in the cloud host) across an org's members
   * — e.g. a single agent endpoint access key shared by everyone's Playground
   * instead of minting a fresh one per session. The value never leaves the
   * host process; web/desktop clients only ever trigger the server-side read.
   * Optional so older host builds without a write path still satisfy the type.
   */
  setPlaintext?(resourceId: string, fieldKey: string, value: string): Promise<void>;
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
   * Probe the provider with this client's credentials and report what each
   * declared capability can actually do — ok / missing (with which
   * permissions) / unknown. Only called when the manifest declares
   * `preflight`. Run at add-account time and re-runnable from account
   * settings, so implementations must be read-only and side-effect free.
   * Failures to reach the provider at all should be reported as `unknown`
   * checks rather than thrown, so a partial probe still renders.
   */
  verifyCredentials?(): Promise<PreflightResult>;
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
  /**
   * Fetch normalized daily cost rows for an account over an inclusive date
   * range. Only called when the manifest declares `costs`. The host invokes
   * this from a low-frequency background pass (roughly daily, plus an initial
   * history backfill in month-sized chunks) — implementations should stay
   * within the provider's billing-API budget and go through `services.http`
   * so bastion routing and custom CAs keep working.
   */
  fetchCostData?(accountId: string, range: CostFetchRange): Promise<CostRow[]>;
  /**
   * Read the account's prepaid credit balance(s). Only called when the
   * manifest declares `credits`. Called on a low-frequency background pass
   * (roughly daily), so it should be one cheap request; the host derives the
   * burn rate from successive readings rather than asking the plugin for one.
   *
   * Throw {@link CreditAccessError} when the credential cannot see the balance
   * — that is a different situation from a failure and the host says so.
   */
  fetchCreditBalance?(accountId: string): Promise<CreditBalance[]>;
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
  /**
   * List keys inside a provider KV namespace. Called by the host's "Keys" tab
   * when the detail view declares a `kvBrowser` capability. Implementations
   * should use cursor-based pagination — callers pass back the previous
   * response's `nextCursor` to fetch subsequent pages.
   *
   * `resourceTypeId` and `resourceId` identify the namespace; the plugin can
   * resolve the upstream id from the resource (e.g. via `externalId`).
   */
  listKvKeys?(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    params?: { prefix?: string; cursor?: string; limit?: number },
  ): Promise<KvListResult>;
  /** Fetch the value stored under a single key as a UTF-8 string. */
  getKvValue?(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    key: string,
  ): Promise<string>;
  /** Create or overwrite the value stored under a single key. */
  putKvValue?(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    key: string,
    value: string,
  ): Promise<void>;
  /** Delete a single key from the namespace. */
  deleteKvKey?(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    key: string,
  ): Promise<void>;
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
   * Estimate what a configuration would cost per month, as a total plus the
   * line items that make it up. See {@link CostEstimate}.
   *
   * `fields` is a bag of field values keyed the way the *create form* keys
   * them — that is the one spelling every caller can produce, and it is what
   * the create form has in hand while the user is still typing. Hosts asking
   * about an existing resource pass its stored fields instead, so a plugin
   * whose lister spells a key differently from its create form (Azure's
   * `vmSize` vs `size`, the same split `rightsizing.createSizeFieldKey`
   * already names) should accept both spellings.
   *
   * Implementations must be cheap enough to call on every keystroke: the
   * create form debounces and then calls this on each field change, so rates
   * belong in the plugin's existing pricing cache, not in a fresh API round
   * trip per call. Return `null` for a type this plugin cannot price, and
   * quote a partial estimate (never a guessed one) when only some components
   * have known rates.
   */
  estimateCost?(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null>;
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
   * Reissue an output value upstream — e.g. reset the role password backing
   * the `connectionString` output. Called by the host when a peer plugin's
   * Reroll action delegates back to the resource that supplied the credential
   * (the child has no secretState of its own; the value flows from this
   * parent's outputs and a literal reroll would only update local state).
   *
   * The plugin is responsible for the upstream mutation; the host then
   * re-resolves the output to pick up the new value. Plugins with no concept
   * of reissue omit this — the host hides the reroll affordance in that case.
   */
  rerollOutput?(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
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
   * Send one round-trip in a chat conversation, streaming token deltas back
   * to the host. Called by the host's Playground tab when the user submits a
   * message. The plugin receives the full message history (including the
   * latest user turn) and yields:
   *   - zero or more `{ kind: "delta", text }` events as tokens arrive,
   *   - then exactly one terminal event: `{ kind: "done", message, usage? }`
   *     on success, or `{ kind: "error", message }` on failure.
   *
   * Plugins that can't stream natively can yield a single `delta` carrying
   * the full text followed by `done`. The host's wire protocol (Electron
   * IPC / NDJSON over HTTP) preserves the stream end-to-end.
   */
  streamChatMessage?(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
    /**
     * Optional per-turn context. `model` is set when the resource's chat panel
     * declares a model picker (see {@link ChatPanelCapability.models}); plugins
     * whose model is fixed by the resource can ignore it.
     */
    options?: { model?: string },
  ): AsyncIterable<ChatStreamEvent>;
  /**
   * Publish one message to a pub/sub resource — Cloudflare Queue, AWS SQS/SNS/
   * Kinesis/EventBridge, GCP Pub/Sub topic, GCP Cloud Tasks, Azure Service
   * Bus / Event Hub, Kafka topic, etc. Called by the host's Publish tab when
   * the user clicks Send. The plugin parses `payload.body` according to the
   * declared `bodyFormat` and pulls plugin-specific extras (subject,
   * partition key, attributes, ...) out of `payload.extras`. Returns a short
   * confirmation that the host renders under the form.
   */
  publishMessage?(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult>;
  /**
   * Synthesise one clip of speech for the Speech tab's TTS half. Called when
   * the user clicks Synthesize. Return audio the browser can play directly —
   * mp3 wherever the provider offers a choice of container.
   *
   * Only called when `renderDetail` set `speechPanel.modes` to include "tts".
   */
  synthesizeSpeech?(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult>;
  /**
   * Transcribe one clip for the Speech tab's STT half. The clip arrives
   * base64-encoded from either the microphone recorder or a file picker; the
   * plugin decodes it and posts it however the provider expects (multipart,
   * raw bytes, or a pre-signed upload followed by a poll).
   *
   * Only called when `renderDetail` set `speechPanel.modes` to include "stt".
   */
  transcribeAudio?(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult>;
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
   * Apply edits to an existing resource. `fields` carries only the keys the
   * user changed (host diffs the form against the current values); plugins
   * should merge against the current upstream state when the provider API
   * needs a full payload. Returns the refreshed `ResourceInstance` so the
   * host can persist the new field/display values without a follow-up
   * `getResource` round-trip. Only called for resource types that declare
   * `supportsUpdate: true`.
   */
  updateResource?(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance>;
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
  /**
   * Optional "eject to Terraform" capability. Declared on the plugin (not the
   * client) because mapping works purely from stored resource state — no
   * credentials or provider API calls — so hosts can export from persisted
   * inventory. Secrets must be referenced as `var.*`, never inlined.
   */
  terraformExport?: TerraformExportCapability;
  /**
   * Parse the raw body fetched from `manifest.statusFeed.url` into normalized
   * incidents. Required when the manifest declares `statusFeed`. Lives on the
   * Plugin (not the client) because it needs no credentials — the feed is
   * public. Malformed bodies should throw; the host logs the failure against
   * the feed rather than silently treating it as "no incidents".
   */
  parseStatusFeed?(body: string): StatusIncident[];
  /**
   * Build the paste-ready least-privilege credential document scoped to the
   * given capability ids (a subset of `manifest.preflight.capabilities`).
   * Required when `manifest.preflight.templateFormat` is set. Lives on the
   * Plugin (not the client) because generating a template needs no
   * credentials — the host offers it even before the user has working keys.
   */
  policyTemplate?(capabilityIds: string[]): PolicyTemplate;
}

// Forward declarations — defined in their own modules but used here
import type { CostCapabilityDeclaration, CostEstimate, CostFetchRange, CostRow } from "./cost.js";
import type { CreditBalance, CreditsCapabilityDeclaration } from "./credits.js";
import type { PolicyTemplate, PreflightDeclaration, PreflightResult } from "./preflight.js";
import type { StatusFeedDeclaration, StatusIncident } from "./status-feed.js";
import type { ResourceCreateReturn, ResourceInstance } from "./instance.js";
import type {
  ArtifactEntry,
  ChatMessage,
  ChatStreamEvent,
  DashboardStat,
  DetailViewSchema,
  KvListResult,
  MetricSeries,
  PeerPaneSchema,
  PublishMessagePayload,
  PublishMessageResult,
  QueryCostEstimate,
  SecretVersion,
  SecretVersionMutation,
  SidebarItemSchema,
  SqlTableMeta,
  StorageObject,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "./schema.js";
import type {
  CreateResourceConfig,
  CreateSizePricingRequest,
  FieldActionResult,
} from "./create.js";
import type { TerraformExportCapability } from "./terraform.js";
