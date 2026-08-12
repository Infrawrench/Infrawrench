import type { PeerGuidanceAction } from "./schema.js";
import type { AssociationSource } from "./create.js";
import type { PostureCheckRule, PostureSeverity } from "./posture.js";
import type { PrincipalRoleDeclaration } from "./principal.js";

export type { AssociationSource };

/**
 * `"password"` is a write-only string: it is rendered masked in the Edit form,
 * is never populated from a resource's stored field values (providers must not
 * return secrets), and is only submitted when the user actually types a new
 * value. Leaving it blank means "keep the current secret".
 */
export type FieldKind =
  "string" | "number" | "boolean" | "enum" | "secret" | "association" | "password";

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
 * Whether the host's Edit form offers this field, and therefore whether the
 * host may submit it through `updateResource`.
 *
 * This predicate *is* the writable surface of a resource type — everything the
 * host does that writes a field goes through the same edit path, so anything
 * that needs to know "can I set this?" (the inline Edit modal, the detail
 * endpoint's `editableFields`, the change-timeline revert) asks here rather
 * than re-deriving the rule. `secret` and `association` kinds are excluded
 * because the form has no wiring for external references, and `editable:
 * false` is the plugin declaring an identity/key field the provider won't let
 * you rename.
 *
 * It says nothing about whether the resource type supports updates at all —
 * that is `ResourceTypeDefinition.supportsUpdate` plus a plugin client that
 * implements `updateResource`, both of which the caller checks.
 */
export function isFieldEditable(field: FieldDefinition): boolean {
  if (field.editable === false) return false;
  if (field.kind === "secret" || field.kind === "association") return false;
  return true;
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
  /**
   * A host-managed resource lease (TTL) — never declared by a plugin's
   * `expiryFields`; the cloud host injects these items into the radar from
   * its own lease rows.
   */
  | "lease"
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
  /**
   * When `from: "created"` and the primary `fieldKey` is empty/unparseable,
   * try this field instead. Used so never-rotated secrets can age from
   * `createdDate` without stuffing creation into the rotation field.
   */
  fallbackFieldKey?: string;
}

/**
 * Marks a resource type as one half of the DNS surface — a zone (the thing a
 * domain's records live in) or a record — and names the fields the host reads
 * to render it. Feeds the cross-provider Domains view and the dangling-DNS
 * posture check.
 *
 * Same contract as `orphanRule`, `expiryFields` and `postureChecks`: evaluated
 * over already-synced `fields`, never an extra provider API call. Every key
 * defaults to the name the majority of providers already use, so a type whose
 * lister stores `type`/`name`/`content`/`ttl` needs only `{ role: "record" }`.
 */
export type DnsRoleDeclaration = DnsZoneRole | DnsRecordRole;

/** A DNS zone / managed domain: the container records hang off. */
export interface DnsZoneRole {
  role: "zone";
  /**
   * Field holding the apex domain (`"example.com"`). Default `"name"`. The
   * host strips a trailing dot, so Cloud DNS's `dnsName` works unchanged.
   */
  domainKey?: string;
  /** Field holding the provider's own record count, when the lister stores one. */
  recordCountKey?: string;
  /** Field holding the zone's status; drives the status dot on the surface. */
  statusKey?: string;
  /**
   * Field that marks the zone as split-horizon/internal. Private zones are
   * listed but never analysed for takeover — an internal name resolving to
   * nothing is a broken deploy, not an exposure.
   */
  privateKey?: string;
  /**
   * Values of `privateKey` (case-insensitive) that mean private. Omit for a
   * boolean field, where truthiness is the test.
   */
  privateValues?: string[];
  /**
   * Set on types that are private by definition (Azure Private DNS), where
   * there is no field to read because the type itself is the answer. Mutually
   * exclusive with `privateKey`.
   */
  isPrivate?: boolean;
}

/** A DNS record inside a zone. */
export interface DnsRecordRole {
  role: "record";
  /**
   * Field holding the record name. Default `"name"`. May be relative (`"www"`,
   * `"@"`) or fully qualified with or without a trailing dot — the host
   * normalises against the owning zone's domain either way.
   */
  nameKey?: string;
  /** Field holding the record type (`"A"`, `"CNAME"`…). Default `"type"`. */
  typeKey?: string;
  /**
   * Field holding the record's target. Default `"content"`. A comma-joined
   * list (Route 53's `values`, Cloud DNS's `rrdatas`) is split by the host and
   * each element analysed separately.
   */
  contentKey?: string;
  /** Field holding the TTL in seconds. Default `"ttl"`. */
  ttlKey?: string;
  /** Field holding MX/SRV priority, when the lister stores one. */
  priorityKey?: string;
  /** Field that is truthy when the provider proxies the record (Cloudflare's orange cloud). */
  proxiedKey?: string;
  /**
   * Field naming the owning zone, used only when the sync path recorded no
   * `parentResourceId`. Its value is matched against each zone's external id
   * and against the zone's declared `domainKey`, so either form works.
   */
  zoneKey?: string;
}

/**
 * What kind of protection a backup-ish resource type provides. Drives grouping
 * and labels on the Backups surface only; the coverage maths is identical for
 * every role.
 */
export type BackupRoleKind = "snapshot";

/**
 * Marks a resource type as one that **is a backup** — an EBS snapshot, an RDS
 * snapshot, a Droplet backup image, a Neon or PlanetScale backup — and names
 * the fields the host reads to join it back to the thing it protects.
 *
 * Same contract as `orphanRule`, `expiryFields`, `postureChecks` and
 * `dnsRole`: evaluated over already-synced `fields`, **never an extra provider
 * API call**. Every key defaults to the name the majority of providers already
 * use, so a lister that stores `sourceId`/`createdAt`/`sizeGb` needs only
 * `{ role: "snapshot" }`.
 *
 * The one key that carries weight is {@link sourceKey}: without it a snapshot
 * can be counted but never attributed, so the host can tell you "you have 400
 * snapshots" and nothing about your RPO. Declare it whenever the lister
 * genuinely syncs the source id — and **only** then. A `sourceKey` naming a
 * field the lister never populates would make every protected volume read as
 * unprotected, which is worse than not declaring the role at all.
 */
export interface BackupRoleDeclaration {
  /** What this type is. Currently only point-in-time snapshots/backups. */
  role: BackupRoleKind;
  /**
   * Field that says which *kind* of thing an instance of this type is, for
   * providers that model backups and non-backups as one type. Hetzner's
   * `image` is the case: one listing carries public distribution images,
   * user snapshots and automatic backups, and without this narrowing every
   * public Ubuntu image would be counted as a backup of nothing.
   *
   * Instances whose value is not in {@link backupTypeValues} are skipped
   * entirely — not counted, not reported as orphans.
   */
  backupTypeKey?: string;
  /**
   * Values of {@link backupTypeKey} (case-insensitive) that mean "this row is
   * a backup". Required alongside `backupTypeKey` — a key with no value list
   * has nothing to test, and a list with no key has nothing to read, which is
   * the `privateValues requires privateKey` stance.
   */
  backupTypeValues?: string[];
  /**
   * Field holding the **id of the resource this backup protects** — a volume
   * id, a disk self-link, a DB instance identifier, a branch id. Default
   * `"sourceId"`. Matched against the candidate's external id, its Infrawrench
   * id and its display name (the identity rules the dependency graph already
   * uses), and a slash-path value is also matched on its last segment so a
   * self-link joins to a bare disk name.
   *
   * A field whose value is empty on some instances is fine and expected —
   * Hetzner only sets `bound_to` on automatic backups — those rows are
   * reported as unattributable rather than as orphans.
   *
   * Mutually exclusive with {@link sourceTemplate}.
   */
  sourceKey?: string;
  /**
   * A `{field}` template composing the source's identity out of more than one
   * field, for providers whose backup names its source in two halves —
   * PlanetScale's `{databaseName}/{branchName}`, Spanner's
   * `{instance}/{database}`. The same shape as `dependsOn`'s `matchTemplate`,
   * and the reason it exists is the same: a bare `branchName` of `"main"`
   * matches a branch in every database in the account, and an ambiguous match
   * is no match — which would make every PlanetScale backup read as an orphan.
   *
   * A template referencing a field that is empty on an instance yields no
   * source for that instance (unattributable), never a partial match.
   *
   * Mutually exclusive with {@link sourceKey}.
   */
  sourceTemplate?: string;
  /**
   * Field holding when the backup was taken. Default `"createdAt"`. This is
   * the clock the RPO is measured against; parsed with the expiry radar's
   * tolerance (ISO, date-only, epoch seconds or milliseconds).
   *
   * A backup whose timestamp is missing or unparseable **never satisfies an
   * RPO** — an undatable backup is not evidence of a recent one — but it still
   * counts as a backup, so the resource reads as "backed up, age unknown"
   * rather than unprotected. That is why, unlike `dnsRole`, the default is not
   * required to name a real field: a lister that stores no timestamp yields a
   * degraded declaration, not a meaningless one.
   */
  createdKey?: string;
  /**
   * Field holding the backup's size, for the spend estimate on orphaned
   * snapshots. Default `"sizeGb"`, read per {@link sizeUnit}. A value with a
   * unit suffix (`"8 GiB"`) has its leading number taken; a value that is a
   * pre-formatted human string with no leading number is skipped rather than
   * guessed at.
   */
  sizeKey?: string;
  /**
   * What {@link sizeKey} is counted in. Default `"gib"`. Set `"bytes"` for
   * listers that store a raw byte count (Spanner's `sizeBytes`) — the host
   * converts, so the surface never reports 21 billion GiB.
   */
  sizeUnit?: "gib" | "bytes";
}

/**
 * Marks a resource type as **stateful and therefore needing protection** — a
 * volume, a disk, a managed database, a database cluster — and names both the
 * types that can protect it and any provider-native automated backup the
 * lister already syncs.
 *
 * The declaration is deliberately the mirror image of
 * {@link BackupRoleDeclaration} rather than a field on it: the question "what
 * protects this?" is answered by the protected type, because that is the type
 * whose absence of a backup is the finding. A snapshot type that nothing
 * declares as a protector is inert; a stateful type that declares no
 * protectors and no automated-backup field is simply never judged.
 */
export interface BackupPolicyDeclaration {
  /**
   * Resource type ids (within this same plugin) whose instances protect this
   * type — usually one snapshot type. An instance of one of these types whose
   * `sourceKey` resolves to this resource counts as a backup of it.
   *
   * May be empty for a type protected only by a provider-native automated
   * backup (a managed database with a retention window and no listable
   * snapshot type).
   */
  protectedBy: string[];
  /**
   * Field that is **truthy when the provider is taking automated backups** —
   * DO's droplet `backups` flag, Cloud SQL's `backupEnabled`. A resource whose
   * automated backups are on is never reported as unprotected, even with no
   * snapshot in the inventory, because the provider is holding restore points
   * we cannot list.
   *
   * Truthiness follows the posture-check word lists (`true/1/yes/enabled` vs
   * `false/0/no/disabled`); an absent or unrecognised value is treated as "we
   * don't know", which never clears the resource and never flags it either.
   * See {@link automatedBackupWhen} for the other reading.
   */
  automatedBackupFieldKey?: string;
  /**
   * How to read {@link automatedBackupFieldKey}:
   * - `"truthy"` (default) — a boolean-ish flag.
   * - `"present"` — **any non-empty value means backups are on**, because the
   *   field holds a datum rather than a flag. DigitalOcean's droplet
   *   `nextBackupStart` is the case: it carries the next backup window's ISO
   *   timestamp when backups are enabled and `""` when they are not, which is
   *   exactly what the existing `droplet-backups-disabled` posture check reads
   *   with `equals ""`.
   *
   * Only set `"present"` on a field the lister writes unconditionally.
   * A key the lister sometimes omits would read as "off" on the rows where it
   * is missing.
   */
  automatedBackupWhen?: "truthy" | "present";
  /**
   * Field holding the provider-native **retention window in days** — RDS's
   * `backupRetentionPeriod`, Azure's `backupRetentionDays`. A positive value
   * both proves automated backups are on (so this key alone is enough; you
   * need not also declare `automatedBackupFieldKey`) and is what the org's
   * `minRetentionDays` policy is checked against. `0` is the documented
   * provider encoding for "automated backups disabled" and is read that way.
   */
  retentionDaysFieldKey?: string;
}

/**
 * Declares the hostname space instances of this type are served at — the
 * provider-owned namespace a CNAME points into (`myapp.vercel.app`,
 * `assets.s3.amazonaws.com`). This is what makes dangling-DNS detection
 * possible without a history table: a record pointing into a namespace we
 * manage, that no synced resource claims, is a subdomain-takeover candidate.
 *
 * Only declare a namespace whose claimant this plugin's lister genuinely
 * syncs. The host will not evaluate a rule unless the org has a synced account
 * for the plugin **and** at least one synced resource of a type declaring the
 * matched pattern — missing data must never alarm, and "you don't have AWS
 * connected" is missing data, not a finding.
 */
export interface DnsServiceHostRule {
  /** Stable id, unique within the plugin; appears in the finding. */
  id: string;
  /** Human name of the namespace, e.g. "S3 bucket endpoint". */
  label: string;
  /**
   * Regex source matched against the whole lowercased hostname — hosts anchor
   * it themselves, so don't write `^`/`$`. Capture group 1 must be the part
   * that identifies the instance (the bucket name, the app slug); for an
   * opaque provider-minted label capture it anyway and set `labelIs: "opaque"`.
   */
  hostPattern: string;
  /**
   * How capture group 1 relates to the instance:
   * - `"name"` (default) — it IS the resource's name/external id, so
   *   `myapp.vercel.app` is claimed by a project called `myapp`.
   * - `"opaque"` — the provider mints it (`d111111abcdef8.cloudfront.net`), so
   *   only an exact `hostKeys` value can claim the hostname.
   */
  labelIs?: "name" | "opaque";
  /**
   * Fields holding the full hostname an instance answers to, checked in
   * addition to (and, for `labelIs: "opaque"`, instead of) the name match. A
   * value that is a URL is reduced to its host, so a `url` field works.
   */
  hostKeys?: string[];
  /** Severity of an unclaimed pointer into this namespace. Default `"high"`. */
  severity?: PostureSeverity;
  /** Plugin-authored sentence on what an attacker who claims the name gains. */
  reason: string;
}

/**
 * Declares that a resource type can be powered off and back on through a pair
 * of the plugin's own invoke-actions ("plugin-action" `HostAction`s dispatched
 * via `client.invokeAction`). The generic convention behind sleep/wake
 * schedules: the host discovers eligibility from this hint — it never
 * hard-codes provider names or string-matches action ids — and executes the
 * named actions server-side when a schedule window opens or closes.
 *
 * Only declare action ids the plugin's `invokeAction` actually accepts for
 * this type. The stop action should be the one that halts billing where the
 * provider distinguishes (e.g. Azure deallocate rather than an OS-level stop).
 */
export interface LifecycleActionsDeclaration {
  /** actionId understood by `invokeAction` that starts/resumes the resource. */
  startActionId: string;
  /** actionId that stops/suspends/powers off the resource. */
  stopActionId: string;
  /**
   * Field on this type holding the provider's run-state (e.g. "status").
   * When declared with the value lists below, hosts skip a transition whose
   * stored state already matches the desired one instead of re-invoking.
   */
  statusFieldKey?: string;
  /** Values of that field (case-insensitive) that mean "running". */
  runningValues?: string[];
  /** Values of that field (case-insensitive) that mean "stopped". */
  stoppedValues?: string[];
}

/**
 * Points the host at the CPU-utilisation series this type's
 * `fetchMetricSeries` emits. Series identity is the label string — the same
 * key the metrics warehouse stores — so the declaration must match it
 * exactly.
 */
export interface RightsizingCpuMetric {
  /** Exact `MetricSeries.label` of the CPU-utilisation series. */
  seriesLabel: string;
  /**
   * How the series encodes utilisation: `"percent"` (0–100, the default) or
   * `"fraction"` (0–1 — e.g. GCE `instance/cpu/utilization`).
   */
  scale?: "percent" | "fraction";
}

/**
 * Points the host at the memory series, when the provider reports one.
 * Providers disagree on what the number means, so the declaration says:
 * - `"percent"` — utilisation 0–100 (e.g. DO managed-database `Memory Used`).
 * - `"used-bytes"` — absolute bytes in use.
 * - `"available-bytes"` — absolute bytes free/available (e.g. DO droplet
 *   `Memory Available`, Azure `Available Memory Bytes`); the host derives
 *   used% from the current size's total RAM.
 */
export interface RightsizingMemoryMetric {
  /** Exact `MetricSeries.label` of the memory series. */
  seriesLabel: string;
  interpretation: "percent" | "used-bytes" | "available-bytes";
}

/**
 * Declares that this resource type can be right-sized: its create form's
 * size-picker options (`SizeOption.vcpus` / `memoryMb` / `priceMonthly`) are a
 * real catalog of what the resource could be resized to, and the metric series
 * named here measure how much of the current size is actually used.
 *
 * The generic convention behind the "Oversized" savings finder — the same
 * shape as `orphanRule` and `lifecycle`: the host discovers eligibility from
 * the declaration and never hard-codes provider names. The host reads
 * candidate sizes from `getCreateConfig`'s size-picker for `sizeFieldKey`
 * (hydrating prices through `getCreateSizePricing` where the plugin implements
 * it), computes p95 utilisation from already-stored metrics, and applies a
 * recommended resize through the ordinary `updateResource` path — so only
 * declare this on types whose `updateResource` actually accepts a new value
 * for `sizeFieldKey`.
 */
export interface RightsizingDeclaration {
  /**
   * Field holding the current size id (e.g. "serverType", "size",
   * "machineType"). Must be the key of the create form's size-picker so the
   * stored value and the catalog ids agree, and must be accepted by
   * `updateResource` to apply a resize.
   */
  sizeFieldKey: string;
  /**
   * Key of the create form's size-picker field, when it differs from the
   * stored field (Azure stores `vmSize` but the create form's picker is
   * `size`). Defaults to `sizeFieldKey`.
   */
  createSizeFieldKey?: string;
  /**
   * Field holding the provider location the resource lives in (region, zone,
   * location). Passed to `getCreateSizePricing` as `regionId` and matched
   * against `SizeOption.availableFor` when present.
   */
  regionFieldKey?: string;
  /**
   * Field holding the resource's actual disk size in GB, for providers that
   * bundle disk with size and refuse resizes onto a smaller included disk
   * (Hetzner `primary_disk_size`, DO droplet `disk`). Without it the host
   * falls back to the current size's own `diskGb` — conservative, since a
   * bundled disk never shrinks.
   */
  diskFieldKey?: string;
  cpuMetric: RightsizingCpuMetric;
  /** Omit when the provider stores no memory series for this type. */
  memoryMetric?: RightsizingMemoryMetric;
  /**
   * ISO 4217 currency of the catalog's `priceMonthly` values. Defaults to
   * "USD"; set it when the provider bills in something else (Hetzner: EUR).
   */
  priceCurrency?: string;
  /**
   * Regex applied to size ids to guard cross-family resizes the provider
   * would reject (architecture changes above all). When set, a candidate
   * qualifies only if every capture group matches the current size's — e.g.
   * `"^([a-z]+)"` keeps Hetzner `cax` (arm) and `cx` (x86) apart. Must
   * contain at least one capture group.
   */
  sizeFamilyPattern?: string;
  /**
   * Plugin-authored caveat surfaced in the resize confirm dialog — the place
   * to say "requires the server to be powered off first" or "the VM restarts
   * during the resize". The plugin is the one that knows.
   */
  resizeNote?: string;
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
  /**
   * Marks this type as the plugin's **account root**: an account of this
   * plugin holds exactly one instance of it, and that instance *is* the
   * account. Hosts render its detail view in place of the account's inventory
   * page, and the sidebar skips it so an account expands straight to the
   * root's children rather than through a section containing a single pill.
   *
   * Declare this only when the provider genuinely admits one instance per
   * credential — where a second one is not rare but *impossible*. UploadThing
   * is the shape it exists for: an API key is app-scoped, every endpoint is
   * implicitly scoped to that app, and there is no "list apps" call to make,
   * so an account can never hold two. A provider that merely *usually* has
   * one (a single Fly org, one Neon project) must not declare it — the page
   * would silently hide every instance but the first.
   *
   * At most one type per plugin may set this, and it must be a top-level type
   * (no `parentTypeId`). `plugin-loader.test.ts` enforces both.
   *
   * Nothing else changes: the type is still a real resource with its own id,
   * outputs, and detail route, still syncs like any other, and is still
   * reachable directly by URL. This only decides what an account *opens* to.
   */
  accountRoot?: boolean;
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
  /**
   * Declarative security posture rules — "this resource is probably exposed":
   * a public bucket, a 0.0.0.0/0 ingress rule, an unencrypted disk, an access
   * key past its rotation budget, missing deletion protection.
   *
   * The security sibling of {@link ResourceTypeDefinition.orphanRule}: each
   * rule flags the resource when ALL its conditions hold against the
   * instance's stored `fields`, evaluated by hosts over already-synced
   * resources (`evaluatePostureRule`) — no plugin client, credentials, or
   * extra API calls. Only declare rules over fields the type's lister already
   * populates; a condition on a field that never lands in `fields` simply
   * never matches. See `PostureCheckRule` in `posture.ts`.
   */
  postureChecks?: PostureCheckRule[];
  /**
   * Marks this type as a DNS zone or a DNS record and names the fields the
   * host reads; see {@link DnsRoleDeclaration}. Absent = the type never
   * appears on the Domains surface.
   */
  dnsRole?: DnsRoleDeclaration;
  /**
   * Provider hostname namespaces instances of this type are served at; see
   * {@link DnsServiceHostRule}. Absent = a record pointing at this type's
   * hostnames is never analysed for takeover.
   */
  dnsServiceHosts?: DnsServiceHostRule[];
  /**
   * Marks this type as one that **is a backup** and names the fields joining
   * it to what it protects; see {@link BackupRoleDeclaration}. Absent = the
   * type never counts as protection for anything.
   */
  backupRole?: BackupRoleDeclaration;
  /**
   * Marks this type as **stateful and needing protection**, and names what can
   * protect it; see {@link BackupPolicyDeclaration}. Absent = the type is
   * never judged for backup coverage.
   */
  backupPolicy?: BackupPolicyDeclaration;
  /**
   * Start/stop action pair for sleep/wake schedules; see
   * {@link LifecycleActionsDeclaration}. Absent = the type cannot be
   * scheduled.
   */
  lifecycle?: LifecycleActionsDeclaration;
  /**
   * Size catalog + utilisation metric hints for the "Oversized" savings
   * finder; see {@link RightsizingDeclaration}. Absent = the type is never
   * flagged as oversized.
   */
  rightsizing?: RightsizingDeclaration;
  /**
   * Marks this type as an identity principal inside the customer's cloud — an
   * IAM user or role, a service account, an app registration, a role binding,
   * a long-lived API key — and names the already-synced fields the
   * cross-cloud access review reads; see {@link PrincipalRoleDeclaration}.
   * Absent = instances never appear on the access review.
   *
   * This is about the principals in *your provider accounts*, not about
   * Infrawrench's own team roles and not about the credentials Infrawrench
   * stores for you.
   */
  principalRole?: PrincipalRoleDeclaration;
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
