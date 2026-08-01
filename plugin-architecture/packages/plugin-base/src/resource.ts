import type { PeerGuidanceAction } from "./schema.js";
import type { AssociationSource } from "./create.js";

export type { AssociationSource };

/**
 * `"password"` is a write-only string: it is rendered masked in the Edit form,
 * is never populated from a resource's stored field values (providers must not
 * return secrets), and is only submitted when the user actually types a new
 * value. Leaving it blank means "keep the current secret".
 */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "secret"
  | "association"
  | "password";

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

/**
 * Declares that a field (or output) on this resource type names another
 * resource — a dependency the host draws on the dependency graph.
 *
 * The host can already *guess* these: it indexes every resource by the values
 * that identify it and looks each field value up in that index. Guessing has to
 * be conservative, so it drops any value claimed by two resources and refuses
 * plain names across accounts. A declaration removes the guesswork: it says
 * which field points where, so `namespace: "default"` resolves to the namespace
 * type instead of being thrown away as ambiguous.
 *
 * Declaring is optional and incremental — a type with no rules still gets the
 * inferred edges. Nothing here is provider-specific in the host: it reads the
 * rule and matches values, exactly as it does for the peer-integration and
 * SSH-endpoint declarations.
 *
 * **Don't declare a field whose target you can't name.** A rule takes the field
 * over: the host stops guessing about it, even when the rule matches nothing.
 * That is the point — a match against the wrong type is worse than no edge —
 * but it cuts both ways. `targetPluginId` defaults to the declaring plugin, so
 * a rule for a field that points *outside* this provider (an SSH target's
 * `host`, which names someone else's server) would both fail to match and
 * suppress the inference that resolves it correctly today. Leave those fields
 * undeclared.
 */
export interface ResourceDependencyRule {
  /** The field on this type holding the reference (e.g. "vpcId"). */
  fieldKey: string;
  /**
   * Read `fieldKey` from the resource's resolved outputs instead of its fields.
   * Use when the pointer only exists as an output (a resolved endpoint, say).
   */
  from?: "fields" | "outputs";
  /** Resource type the value names. Omit to accept any type. */
  targetTypeId?: string;
  /** Plugin owning the target, when the link crosses providers. Defaults to this plugin. */
  targetPluginId?: string;
  /**
   * What the value is matched against on the target: `"externalId"` (default),
   * or the name of a field/output key on the target — e.g. `"name"` when the
   * provider references things by name rather than id.
   */
  targetKey?: string;
  /**
   * Compose the value to match from several of this resource's fields, for
   * targets whose identity is a composite. `"{databaseName}/{branchName}"`
   * matches a PlanetScale branch whose external id is `"{db}/{branch}"`;
   * `"{catalogName}.{schemaName}"` matches a Databricks schema.
   *
   * Placeholders name fields on **this** resource (outputs when
   * `from: "outputs"`). If any placeholder is missing or empty the rule yields
   * nothing — a half-built key must never be matched. `fieldKey` still names
   * the field the edge is attributed to and is what the UI captions.
   *
   * One placeholder may hold a comma-joined list: the template is expanded per
   * element, so `"{namespace}/{configMaps}"` over `"a, b"` matches `prod/a`
   * and `prod/b`. Two list-valued placeholders yield nothing rather than a
   * cartesian product.
   *
   * Prefer this over matching a bare segment: a scope-qualified id composed in
   * full stays exact, where matching just the tail goes ambiguous the moment
   * two scopes contain the same name (`main` in five databases).
   */
  matchTemplate?: string;
  /**
   * How the edge reads in the UI (e.g. "runs in", "routes to"). Defaults to
   * the usual `field ← key` caption.
   */
  label?: string;
}

/**
 * What a declared expiry field counts down toward — used by hosts purely for
 * grouping, labels and icons on the cross-provider Expiry radar. Pick the
 * closest match; `"other"` is a valid answer.
 */
export type ExpiryKind =
  | "tls-cert"
  | "domain"
  | "api-token"
  | "access-key"
  | "k8s-cert"
  | "ssh-key"
  | "secret-version"
  | "other";

/**
 * Declares that a field this type's lister already stores carries a deadline —
 * a certificate's notAfter, a domain's registration expiry, a token's
 * expiration, an access key's creation date. Feeds the cross-provider Expiry
 * radar (web/desktop/mobile screens, the `infrawrench expiring` CLI and the
 * poller's expiry alerts).
 *
 * Exactly like `orphanRule` and `dependsOn`, this is evaluated over
 * already-synced `fields` — no plugin client, no credentials, no extra
 * provider API calls, ever. Only declare a field the lister actually
 * populates; a rule over a field that never lands in `fields` simply yields
 * nothing. Values may be ISO 8601 strings, date-only strings, or unix epochs
 * (seconds or milliseconds, number or numeric string) — the host parses all
 * of these; anything unparseable is skipped, never alarmed on.
 */
export interface ExpiryFieldRule {
  /** Key into the instance's stored `fields` map holding the timestamp. */
  fieldKey: string;
  /**
   * What the timestamp means:
   * - `"expiry"` — the field IS the moment the clock runs out (cert
   *   notAfter, domain expiry date, token expiration).
   * - `"created"` — the field is a creation/rotation date and the deadline is
   *   derived from an age budget: `maxAgeDays` when set, otherwise the host's
   *   per-kind default (e.g. access keys are due for rotation at 90 days).
   */
  from: "expiry" | "created";
  /** Grouping bucket; drives labels/icons on the radar. */
  kind: ExpiryKind;
  /** Human caption for the deadline, e.g. "Certificate expires". */
  label: string;
  /**
   * Age budget in days for `from: "created"` rules, overriding the host's
   * per-kind default. Ignored for `from: "expiry"`.
   */
  maxAgeDays?: number;
}

export interface ResourceTypeDefinition {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  description: string;
  fields: FieldDefinition[];
  outputs: ResourceOutput[];
  /**
   * Fields on this type that point at other resources. Feeds the dependency
   * graph; see `ResourceDependencyRule`. Values that hold a comma-separated
   * list produce one edge per element.
   */
  dependsOn?: ResourceDependencyRule[];
  /**
   * Fields on this type that carry a deadline (cert expiry, domain renewal,
   * token expiration, key age). Feeds the cross-provider Expiry radar; see
   * `ExpiryFieldRule`. Evaluated over already-synced fields only.
   */
  expiryFields?: ExpiryFieldRule[];
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
  /**
   * Declares that this VM resource type can host an Infrawrench agent session.
   * Hosts use this metadata to list eligible accounts and to hide/provider-fill
   * fields such as SSH keys while keeping provider-specific create behavior in
   * the plugin.
   */
  agentVm?: AgentVmCapability;
  /**
   * When true, instances of this type can be dragged onto any resource that
   * declares `sshEndpoint` to set up an SSH-over-tunnel (e.g. a Cloudflare
   * Tunnel dropped on a server). The host orchestrates the cross-account wiring;
   * the drop is account-independent. Set on the Cloudflare `tunnel` type.
   */
  sshTunnelAttachSource?: boolean;
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
  /**
   * Declarative "this resource is probably wasted" heuristic — e.g. an
   * unattached volume or a reserved IP that isn't assigned to anything.
   *
   * The rule matches when ALL conditions hold against the instance's stored
   * `fields`. Hosts evaluate it over already-synced resources via
   * {@link evaluateOrphanRule} — no plugin client, credentials, or extra API
   * calls involved — and surface matches on the "Potential savings" page and
   * the `infrawrench orphans` CLI. Only declare rules over fields the type's
   * lister already populates; a condition on a field the lister never sets
   * simply never matches (empty-string and absent are distinct: `empty`
   * matches both, `equals`/`notEquals` never match an absent field).
   */
  orphanRule?: OrphanRule;
}

/** One predicate inside an {@link OrphanRule}. All conditions must hold. */
export interface OrphanCondition {
  /** Key into the instance's `fields` map. */
  fieldKey: string;
  /**
   * - `empty` — field is absent, `""`, `0` is NOT empty (a count of zero is a
   *   real value; use `equals` with `"0"` for that).
   * - `equals` / `notEquals` — string comparison against `value`
   *   (case-insensitive; numbers/booleans are stringified). An absent field
   *   never matches either.
   */
  when: "empty" | "equals" | "notEquals";
  /** Comparison operand for `equals` / `notEquals`. */
  value?: string;
}

/**
 * Declares when an instance of this type is likely orphaned or idle, and why.
 * Kept declarative (rather than a client method) so hosts can evaluate it
 * against stored resources without provider credentials.
 */
export interface OrphanRule {
  /** All must hold for the resource to be flagged. At least one required. */
  conditions: OrphanCondition[];
  /**
   * Human-readable explanation shown next to the flagged resource, e.g.
   * "Volume is not attached to any Droplet". Written by the plugin — the one
   * place that knows what the fields mean.
   */
  reason: string;
}

/**
 * Evaluate a type's {@link OrphanRule} against a resource instance's stored
 * fields. Returns the reason string when the resource is flagged, or `null`
 * when it isn't (or the type declares no rule).
 *
 * Shared by the web server's orphan aggregation and the desktop CLI so the
 * classification behaves identically everywhere.
 */
export function evaluateOrphanRule(
  rule: OrphanRule | undefined,
  fields: Record<string, string | number | boolean> | undefined,
): string | null {
  if (!rule || rule.conditions.length === 0) return null;
  const matches = rule.conditions.every((cond) => {
    const raw = fields?.[cond.fieldKey];
    if (cond.when === "empty") return raw == null || raw === "";
    if (raw == null) return false;
    const actual = String(raw).toLowerCase();
    const expected = (cond.value ?? "").toLowerCase();
    if (cond.when === "equals") return actual === expected;
    return actual !== expected;
  });
  return matches ? rule.reason : null;
}

export interface AgentVmCapability {
  /** Create-field key that accepts an SSH public key or provider key reference. */
  sshKeyFieldKey: string;
  /** Default SSH username for setup when the resource's sshEndpoint has none. */
  defaultUsername: string;
  /** Field defaults the Agents setup form should apply unless the user overrides them. */
  defaultFields?: Record<string, string>;
  /** Human-readable labels for default fields shown in the Agents setup form. */
  defaultFieldLabels?: Record<string, string>;
  /** Preferred image/create field values for an Ubuntu-like Linux image. */
  linuxImageDefaults?: Record<string, string>;
  /** Create-field keys the Agents defaults form should not show. */
  hiddenFieldKeys?: string[];
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
