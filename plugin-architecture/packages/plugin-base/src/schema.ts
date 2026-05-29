import type { SecretResolution } from "./secrets.js";
import type { CreateFieldConfig } from "./create.js";

/**
 * Component schema — a sealed discriminated union of renderable primitives.
 *
 * Plugins return these plain data structures. The host app owns all React code
 * and interprets the schema. Plugins have zero UI framework dependencies.
 *
 * Actions are typed host operations — plugins cannot inject arbitrary handlers.
 */

export type HostAction =
  | { type: "reroll-secret"; fieldKey: string }
  | {
      /**
       * Reissue an output upstream by delegating to whichever resource supplied
       * the current credential. Emitted by peer plugins when the resource is
       * peer-spawned (no local secretState) and the connection flowed in from
       * a parent's outputs — e.g. a `pg-database` opened from a Neon database.
       * The host walks up to the parent and calls `parentClient.rerollOutput`,
       * mapping `outputKey` (on the child) through the integration's
       * `credentialMappings` to the parent output that originally produced it.
       * If the parent doesn't implement `rerollOutput`, the host hides the
       * action.
       */
      type: "reroll-parent-output";
      outputKey: string;
      confirmMessage?: string;
    }
  | { type: "open-url"; url: string }
  | { type: "copy-to-clipboard"; fieldKey: string }
  | {
      type: "navigate-to-resource";
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
    }
  | { type: "refresh-resource" }
  | {
      /**
       * Invoke a plugin-defined action against the current resource.
       * The host resolves this by calling `client.invokeAction(typeId, resourceId, actionId, accountId)`.
       * `confirmMessage` triggers a host-level confirmation prompt before dispatch.
       */
      type: "plugin-action";
      actionId: string;
      confirmMessage?: string;
      successMessage?: string;
    }
  | {
      /**
       * Invoke a plugin-defined NoSQL command after showing the user a form.
       * The form uses the same `CreateFieldConfig` shape as the standard
       * create modal — supporting text, select, number, region-picker,
       * resource-picker, showWhen conditionals, and so on. On submit, the
       * host calls `client.executeNoSqlCommand(...)` with the form values
       * keyed by `field.key`.
       */
      type: "prompt-nosql-command";
      command: string;
      /** Modal title. Defaults to the command name. */
      title?: string;
      /** Descriptive text shown above the form (e.g. destructive-action warning). */
      description?: string;
      /**
       * Styling for `description`. `"error"` renders it as a red warning
       * banner (use for empty-state / blocked prompts like "nothing to
       * attach"); defaults to muted info text.
       */
      descriptionVariant?: "info" | "error";
      /**
       * When true, the prompt is informational only — the host hides the
       * form fields and the submit button, leaving just the title,
       * description, and a single Close button. Use when the action can't
       * proceed (e.g. nothing available to pick). Pair with
       * `descriptionVariant: "error"` to explain why.
       */
      blocked?: boolean;
      fields: CreateFieldConfig[];
      /** Submit button label. Defaults to "Submit". */
      submitLabel?: string;
      /** When true, the submit button uses a red/danger style. */
      danger?: boolean;
    };

export interface TextNode {
  kind: "text";
  content: string;
  variant?: "heading" | "subheading" | "body" | "mono" | "muted";
  /** When true, the host renders a copy button that copies `content`. Pairs well with `variant: "mono"` for code/snippet blocks. */
  copyable?: boolean;
}

export interface BadgeNode {
  kind: "badge";
  label: string;
  color: "green" | "yellow" | "red" | "blue" | "gray";
}

/**
 * Health/lifecycle status for infrastructure resources.
 * "info" — static blue, used for resources we can't directly connect to and
 * therefore can't actively health-check (e.g. private-VPC managed services).
 */
export type ResourceStatus = "healthy" | "degraded" | "error" | "unknown" | "provisioning" | "info";

export interface StatusDotNode {
  kind: "status-dot";
  status: ResourceStatus;
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

export interface MetricSeriesPoint {
  timestamp: number;
  value: number;
}

export interface MetricSeries {
  label: string;
  unit?: string;
  points: MetricSeriesPoint[];
}

export interface MetricChartNode {
  kind: "metric-chart";
  title: string;
  series: MetricSeries[];
  timeRangeLabel?: string;
}

/** A column definition for a {@link TableNode}. */
export interface TableColumn {
  /** Key referenced by each row's `cells` record. */
  key: string;
  /** Header label shown in the table. */
  label: string;
  /** Optional column width preset. */
  width?: "auto" | "narrow" | "wide";
  /** If true, values in this column render in a monospace font. */
  mono?: boolean;
}

export interface TableRow {
  /**
   * Cell values keyed by {@link TableColumn.key}. A string renders as plain
   * text; an {@link ActionNode} renders as an inline button so per-row
   * actions (delete, detach, reveal) can live alongside the data.
   */
  cells: Record<string, string | ActionNode>;
  /** Indentation depth (0 = top-level). Used for nested rows (e.g. RECORD subfields). */
  depth?: number;
}

/**
 * A generic tabular display — ideal for schema/column listings, policy rules,
 * and other grid-shaped metadata. Platform-agnostic; plugins supply the columns
 * and rows, host owns the rendering.
 */
export interface TableNode {
  kind: "table";
  columns: TableColumn[];
  rows: TableRow[];
  /** If true, the first column renders in a slightly bolder/emphasised style. */
  emphasizeFirstColumn?: boolean;
}

export type SchemaNode =
  | TextNode
  | BadgeNode
  | StatusDotNode
  | KeyValueListNode
  | ActionNode
  | GridNode
  | SectionNode
  | LinkNode
  | MetricChartNode
  | TableNode;

/** A single labelled metric shown in dashboard card footers */
export interface DashboardStat {
  label: string;
  value: string;
  variant?: "default" | "status-healthy" | "status-degraded" | "status-error";
}

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
  /** Generic stats shown in the card footer */
  stats?: DashboardStat[];
  /**
   * When set, clicking the pill triggers this action instead of navigating
   * to the linked resource. Useful for pseudo-resource pills (sub-objects
   * that aren't full registered resource types — e.g. Firestore indexes or
   * backup schedules) that still want a click-to-delete affordance.
   */
  onClickAction?: HostAction;
  /**
   * When true, the pill is rendered as a static informational chip — no
   * click handler, no navigation arrow. Use for read-only sub-objects
   * like completed operations that have no detail page to navigate to.
   */
  nonInteractive?: boolean;
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
  /**
   * When true, the host renders an "Estimate" button next to "Run" in the SQL
   * editor. Clicking it calls `PluginClient.estimateQueryCost`. Useful for
   * pay-per-byte-scanned backends like BigQuery.
   */
  supportsQueryCost?: boolean;
}

/**
 * Result of a dry-run / cost estimation for a SQL query. Returned by
 * `PluginClient.estimateQueryCost`. All fields other than `bytesProcessed` are
 * optional so the host can render whatever the backend happens to expose.
 */
export interface QueryCostEstimate {
  /** Total bytes the query would scan. */
  bytesProcessed: number;
  /** Estimated cost in USD (backend-specific pricing model). */
  estimatedCostUsd?: number;
  /** True if the backend would serve this query from cache for free. */
  cacheHit?: boolean;
  /** Human-readable pricing model note, e.g. "$6.25 per TB scanned (on-demand)". */
  pricingNote?: string;
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

/** One key in a KV namespace — returned by listKvKeys(). */
export interface KvKeyEntry {
  /** Key name. */
  name: string;
  /** Unix-seconds expiration. Omitted for keys that never expire. */
  expiration?: number;
  /** Arbitrary JSON metadata associated with the key, if any. */
  metadata?: unknown;
}

/** Cursor-paginated result returned by `PluginClient.listKvKeys`. */
export interface KvListResult {
  items: KvKeyEntry[];
  /** Opaque cursor for the next page. Empty/undefined when the last page was returned. */
  nextCursor?: string;
}

/**
 * When present on a DetailViewSchema, the host renders a "Keys" tab that lists
 * the contents of a key-value namespace, lets the user reveal a single value,
 * and write or delete keys. Backed by PluginClient.listKvKeys / getKvValue /
 * putKvValue / deleteKvKey.
 *
 * Aimed at provider KV stores with a REST surface (Cloudflare Workers KV,
 * Vercel Edge Config, etc.). Values are treated as UTF-8 strings — binary
 * payloads still come through, but the UI surfaces a "looks binary" warning
 * instead of pretending to be a hex editor.
 */
export interface KvBrowserCapability {
  /** Label shown in the panel header (e.g. namespace title). */
  namespaceLabel?: string;
  /** Default page size for listKvKeys. Plugins may clamp this server-side. */
  defaultPageSize?: number;
  /** Short note shown above the key list — vendor-specific caveats, etc. */
  helpText?: string;
}

/** One entry in an artifact registry (image, package, or version). */
export interface ArtifactEntry {
  /** Package/image name, e.g. "nginx" or "my-repo/my-image" */
  name: string;
  /** Tag or version, e.g. "1.25" or "1.2.3" */
  version?: string;
  /** Content-addressable digest, e.g. "sha256:…" */
  digest?: string;
  sizeBytes?: number;
  /** ISO-8601 pushed/updated timestamp */
  updatedAt?: string;
  /** All tags pointing at this digest (Docker/OCI registries) */
  tags?: string[];
  /** Media/content type (OCI) */
  mediaType?: string;
}

/**
 * When present on a DetailViewSchema, the host renders an "Artifacts" tab that
 * browses the images/packages/versions inside a registry-shaped resource. The
 * plugin must implement listArtifacts() on PluginClient.
 */
export interface ArtifactRegistryCapability {
  /** Content format: "docker" | "maven" | "npm" | "python" | "helm" | "go" | "apt" | "yum" | "generic" */
  format?: string;
  /** True when the registry is tag-based (Docker/OCI). False for version-based (npm/maven). */
  supportsTags?: boolean;
  /** Optional prefix/namespace to pre-fill the search input. */
  defaultPrefix?: string;
}

/**
 * When present on a DetailViewSchema, the host renders a Monaco-based manifest
 * editor tab alongside the overview. The plugin is responsible for fetching and
 * applying manifests via getManifest() / applyManifest() on PluginClient.
 */
export interface ManifestEditorCapability {
  /** Language mode for the editor — typically "json" for K8s resources */
  language: "json" | "yaml";
  /** K8s resource kind — shown in the tab label (e.g. "Deployment", "ConfigMap") */
  resourceKind?: string;
  /** If true, the manifest is read-only (no Apply button) */
  readOnly?: boolean;
}

/**
 * One row in a {@link SettingsEditorCapability} form — a single named setting
 * rendered as a labeled control instead of raw JSON. The plugin owns the
 * control choice, label, and (for selects) the option list; the host renders
 * it generically and tracks edits.
 */
export interface SettingDescriptor {
  /** Provider setting id (sent back on apply). */
  id: string;
  /** Human label, e.g. "Always Use HTTPS". */
  label: string;
  /** Optional one-line explanation shown under the label. */
  description?: string;
  /**
   * Control to render:
   *   - "toggle"   — on/off switch; value is "on"/"off"
   *   - "select"   — dropdown over `options`
   *   - "number"   — numeric input
   *   - "text"     — single-line text / JSON blob
   *   - "readonly" — value shown but not editable (provider-managed)
   */
  control: "toggle" | "select" | "number" | "text" | "readonly";
  /** `select` options. */
  options?: { value: string; label: string }[];
  /** Current value as a string ("on"/"off", a number, an enum, or JSON). */
  value: string;
  /** Optional grouping heading (e.g. "Security", "Performance"). */
  group?: string;
}

/**
 * When present, the host renders a human-friendly settings form (toggles,
 * dropdowns, numbers) instead of a raw JSON editor. The plugin loads the rows
 * via `getManifest()` returning `{"settings": SettingDescriptor[]}` and applies
 * via `applyManifest()` receiving a JSON array of changed `{id, value}` pairs.
 * Used by the Cloudflare zone-settings tab.
 */
export interface SettingsEditorCapability {
  /** Tab label. Defaults to "Settings". */
  tabLabel?: string;
  /** Optional copy shown above the form. */
  description?: string;
}

/**
 * When present on a DetailViewSchema, the host renders the interactive
 * "Bucket Policy" tab — statement builder + JSON toggle + templates + lint
 * banner + plain-English summary. The plugin still loads/stores the raw JSON
 * via `getManifest()` / `applyManifest()` on PluginClient; this capability
 * just swaps the tab UI for the structured editor.
 *
 * Used by S3-compatible buckets across plugins (AWS S3, DigitalOcean Spaces,
 * Scaleway Object Storage). All three vendors use AWS-style policy JSON +
 * `arn:aws:s3:::bucket` ARNs, so the editor is vendor-agnostic; `vendor` is
 * surfaced for vendor-specific copy and template tweaks.
 */
export interface BucketPolicyEditorCapability {
  /**
   * Canonical bucket ARN used as the default `Resource` in new statements and
   * as the basis for the `bucket/*` object-resource shorthand. For S3-
   * compatible vendors this is `arn:aws:s3:::{bucket}`.
   */
  bucketArn: string;
  /** Short bucket name (without ARN prefix). Drives plain-English summaries. */
  bucketName: string;
  /** Vendor flavour — drives template availability and copy. */
  vendor: "aws-s3" | "do-spaces" | "scaleway-os";
}

/**
 * When present on a DetailViewSchema, the host renders a "Describe" tab that
 * shows the plain-text describe output (kubectl-style: object status, events,
 * related objects). The plugin must implement describeResource() on PluginClient.
 */
export interface DescribeCapability {
  /** "text" renders in a mono font with no highlighting; "yaml" enables syntax colors. */
  language?: "text" | "yaml";
}

/**
 * When present on a DetailViewSchema, the host renders a "Logs" tab that shows
 * the plain-text log output for the resource (kubectl-style: pod/container
 * stdout+stderr). The plugin must implement getLogs() on PluginClient. The UI
 * supports a tail-lines selector, container dropdown, previous-instance
 * toggle, and follow mode (the host polls getLogs at a fixed cadence).
 */
export interface LogsCapability {
  /** Default tail length when the Logs tab first opens. */
  defaultTailLines?: number;
  /** If true, the UI shows a "Previous instance" checkbox. */
  supportsPrevious?: boolean;
}

/** Lifecycle state of a secret version (aligned with GCP Secret Manager). */
export type SecretVersionState = "enabled" | "disabled" | "destroyed";

/** One version of a secret — returned by listSecretVersions(). */
export interface SecretVersion {
  /** Human-readable identifier (e.g. "1", "2", or a UUID). */
  id: string;
  state: SecretVersionState;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 destroyed timestamp; present only when state is "destroyed". */
  destroyedAt?: string;
  /** True when this version is the primary/latest enabled version. */
  isLatest?: boolean;
}

/** Mutation verbs supported by modifySecretVersion. */
export type SecretVersionMutation = "enable" | "disable" | "destroy";

/**
 * When present on a DetailViewSchema, the host renders a "Versions" tab for
 * managing the secret values of this resource: listing versions, revealing
 * one value, adding a new version, and disable/enable/destroy actions. The
 * plugin must implement listSecretVersions, accessSecretVersion,
 * addSecretVersion and modifySecretVersion on PluginClient.
 */
export interface SecretVersionsCapability {
  /** If true, the add-version form offers an "upload file" mode alongside the textarea. */
  supportsFileUpload?: boolean;
  /** Short note displayed above the versions table (e.g. "Values shown once; GCP does not log reads."). */
  helpText?: string;
  /**
   * When false, hides the per-row "Reveal" button. Use for resources whose version
   * material cannot be returned to the caller — e.g. GCP KMS symmetric keys, where
   * the plaintext never leaves Google.
   */
  supportsReveal?: boolean;
  /**
   * When true, the "Add version" form skips the value textarea — the plugin
   * generates new material itself (e.g. GCP KMS key rotation creates a new
   * CryptoKeyVersion server-side).
   */
  valuelessAdd?: boolean;
}

/**
 * A labeled group of pseudo-resource pills with an optional per-group
 * "+ Create" button. Use this when the resource has sub-objects that aren't
 * full registered resource types but should still render as a labeled
 * section of pills (e.g. Firestore indexes, backup schedules).
 */
export interface ChildGroupSchema {
  /** Heading shown above the pill grid. */
  title: string;
  /** Pills rendered in the group. Each pill's `onClickAction` drives clicks. */
  items: DashboardCardSchema[];
  /** When set, an inline "+ Create" button appears in the group header. */
  createAction?: HostAction;
  /** Label for the create button. Defaults to "+ Create". */
  createLabel?: string;
  /** Shown when the group is empty. Defaults to a generic "No items yet." */
  emptyText?: string;
}

/**
 * How a single column of a {@link ChildTableSchema} sources and formats its
 * cell value from a child {@link ResourceInstance}.
 */
export interface ChildTableColumn {
  /** Stable column id — also used as the table header key. */
  key: string;
  /** Header label. */
  label: string;
  width?: "auto" | "narrow" | "wide";
  /** Where the raw cell value comes from on each child resource. */
  source: { kind: "field"; fieldKey: string } | { kind: "external-id" } | { kind: "display-name" };
  /**
   * Optional formatter applied to the raw string:
   *   - "mono"          — monospace text
   *   - "type-badge"    — colored pill keyed by DNS record type (A/AAAA/CNAME/MX/TXT…)
   *   - "proxy-status"  — orange-cloud / grey-cloud indicator for boolean values
   *   - "ttl"           — formats numeric seconds via the same rules as `formatDnsTtl`
   *   - "boolean-yesno" — renders truthy/falsy as "Yes"/"No"
   * Defaults to plain text.
   */
  format?: "text" | "mono" | "type-badge" | "proxy-status" | "ttl" | "boolean-yesno";
  /**
   * When set, strip the value of this sibling field (plus a leading dot) from
   * the end of the cell value — used to display the short record name ("www")
   * instead of the FQDN ("www.example.com"). A value equal to the suffix
   * renders as "@" (the zone apex).
   */
  stripSuffixFromFieldKey?: string;
  /**
   * Display-label overrides keyed by raw cell value. When the value matches a
   * key, the mapped label is shown (as a muted, non-mono badge) instead of the
   * raw value — e.g. mapping Cloudflare's Worker placeholders `100::` /
   * `192.0.2.1` to "Worker".
   */
  valueMap?: Record<string, string>;
}

/**
 * A Cloudflare-dashboard-style table of a resource's child instances, rendered
 * in place of the auto-injected pill group for the same `typeId`. The host
 * pulls the rows from the child resources it already loads (the same source
 * that feeds the pill groups) and suppresses the matching pill group. The
 * per-row "+ Create" button and row navigation reuse the host's existing
 * child-create / navigate handlers — no new host action is required.
 */
export interface ChildTableSchema {
  /** Heading shown above the table. */
  title: string;
  /** Child resource type whose instances populate the rows. */
  typeId: string;
  columns: ChildTableColumn[];
  /** Shown when there are no child resources of this type. */
  emptyText?: string;
  /** Overrides the "+ Create {displayName}" header button label. */
  createLabel?: string;
  /**
   * Row click target:
   *   - "navigate" (default) — open the child's detail page
   *   - "edit" — open an inline edit form on the current page (requires the
   *     child type to support update)
   *   - "none" — rows aren't clickable
   */
  onRowClick?: "navigate" | "edit" | "none";
  /**
   * Rows whose `fieldKey` value is in `fieldValues` are treated as read-only —
   * not clickable for edit. Used for provider-managed records (e.g. a DNS
   * record whose content is a Worker placeholder).
   */
  readOnlyRowWhen?: { fieldKey: string; fieldValues: string[] };
}

/**
 * A plugin-defined tab on the detail view. Tab bodies reuse the same
 * structure as the Overview tab — `SectionNode[]` + labeled pill groups.
 * Each tab can also declare its own header actions that show up in the
 * top bar when the tab is active.
 */
export interface DetailViewTab {
  /** Stable identifier — used as the active-tab key. */
  id: string;
  /** Label shown in the tab strip. */
  label: string;
  /** Rendered as the tab body's sections (same as the overview sections). */
  sections?: SectionNode[];
  /** Labeled pill groups rendered after the sections (per-group create buttons, etc.). */
  childGroups?: ChildGroupSchema[];
  /** Child-resource tables rendered after the sections, replacing matching pill groups. */
  childTables?: ChildTableSchema[];
  /**
   * Auto-injected child-resource groups (and any matching `childTables`) for
   * these resource type IDs render inside this tab instead of on Overview.
   * Lets a plugin split a long list of child types across multiple tabs.
   */
  childResourceTypeIds?: string[];
  /** Header actions visible in the top bar when this tab is active. */
  headerActions?: ActionNode[];
}

/** Full detail view — shown when user clicks a card or sidebar item */
export interface DetailViewSchema {
  title: string;
  subtitle?: string;
  status?: StatusDotNode;
  sections: SectionNode[];
  /** Child resources shown in a sub-grid — can be pinned independently */
  children?: DashboardCardSchema[];
  /** Labeled groups of pseudo-resource pills — each group has its own "+ Create" button. */
  childGroups?: ChildGroupSchema[];
  /**
   * Child resources rendered as dashboard-style tables instead of pills. Each
   * entry's `typeId` matches an auto-injected child group, which the host then
   * suppresses from the pill render.
   */
  childTables?: ChildTableSchema[];
  headerActions?: ActionNode[];
  /** If present, the host renders a SQL editor tab alongside the overview */
  sqlEditor?: SqlEditorCapability;
  /** If present, the host renders a cloud storage file browser panel */
  storageBrowser?: StorageBrowserCapability;
  /** If present, the host renders an Artifacts tab that browses a registry */
  artifactRegistry?: ArtifactRegistryCapability;
  /** If present, the host renders a Monaco manifest editor tab */
  manifestEditor?: ManifestEditorCapability;
  /**
   * If present, the host renders a human-friendly settings form (backed by
   * getManifest/applyManifest) instead of raw JSON. Used by Cloudflare zones.
   */
  settingsEditor?: SettingsEditorCapability;
  /** If present, the host renders the interactive bucket-policy editor tab */
  bucketPolicyEditor?: BucketPolicyEditorCapability;
  /** If present, the host renders a "Describe" tab with plain-text describe output. */
  describe?: DescribeCapability;
  /** If present, the host renders a "Logs" tab with plain-text log output. */
  logs?: LogsCapability;
  /** If present, the host renders a "Versions" tab for managing secret values. */
  secretVersions?: SecretVersionsCapability;
  /** If present, the host renders a Metrics tab with time-series charts */
  metricsCapability?: { defaultTimeRangeMs?: number };
  /** If present, the host renders an inline NoSQL document browser. */
  noSqlBrowser?: NoSqlBrowserCapability;
  /** If present, the host renders a "Keys" tab backed by KV listing/get/put/delete. */
  kvBrowser?: KvBrowserCapability;
  /** Plugin-defined tabs rendered alongside Overview / SQL / Logs / etc. */
  customTabs?: DetailViewTab[];
  /** If present, the host renders a "Playground" tab with a chat interface. */
  chatPanel?: ChatPanelCapability;
  /**
   * If present, the host renders a "Publish" tab with a body editor + Send
   * button. Backs onto `PluginClient.publishMessage`. Used for pub/sub
   * resources (Cloudflare Queues, AWS SQS/SNS/Kinesis/EventBridge, GCP
   * Pub/Sub & Cloud Tasks, Azure Service Bus & Event Hub, Kafka topics).
   */
  publishPanel?: PublishPanelCapability;
}

/**
 * A chat playground tab for resources that expose a conversational endpoint
 * (DigitalOcean Gradient AI agents, future AWS Bedrock agents, etc.). The
 * plugin owns the wire protocol — the host calls `streamChatMessage` with
 * the conversation history and renders deltas as they arrive.
 */
export interface ChatPanelCapability {
  /** Label for the tab. Defaults to "Playground". */
  tabLabel?: string;
  /** One-line copy shown at the top of the chat pane (e.g. model + endpoint). */
  subtitle?: string;
  /** Pre-filled assistant intro shown before the user's first turn. */
  greeting?: string;
  /** Placeholder text in the input. Defaults to "Send a message…". */
  inputPlaceholder?: string;
  /** Disable the input and render this message instead. Used when the resource isn't ready (still provisioning, no endpoint key available, etc.). */
  disabledReason?: string;
}

/**
 * A plugin-defined extra input rendered alongside the message body in the
 * publish panel — e.g. SNS Subject, Kinesis PartitionKey, SQS DelaySeconds,
 * Service Bus queue picker.
 */
export interface PublishPanelField {
  /** Key returned in PublishMessagePayload.extras. */
  key: string;
  /** Label shown above the input. */
  label: string;
  /** Form input shape. */
  kind: "text" | "number" | "select" | "key-value-list";
  /** Placeholder for "text" and "number". */
  placeholder?: string;
  /** Default value for "text", "number", "select". */
  defaultValue?: string;
  /** Option list for "select". */
  options?: Array<{ value: string; label: string }>;
  /** Short note rendered under the input. */
  helpText?: string;
  /** Field is optional — empty values are passed through unchanged. */
  optional?: boolean;
}

/**
 * Publish-panel tab — a JSON/text body editor plus an optional set of
 * plugin-defined extra inputs. The plugin handles the send via
 * `PluginClient.publishMessage`.
 */
export interface PublishPanelCapability {
  /** Label for the tab. Defaults to "Publish". */
  tabLabel?: string;
  /** One-line copy shown at the top of the pane. */
  subtitle?: string;
  /** Body editor mode. Defaults to "json". */
  bodyFormat?: "json" | "text";
  /** Pre-filled body content. */
  defaultBody?: string;
  /** Help text shown above the body editor (e.g. shape constraints). */
  helpText?: string;
  /** Submit button label. Defaults to "Send". */
  submitLabel?: string;
  /** Extra inputs rendered above the body editor. */
  extraFields?: PublishPanelField[];
  /** Disable the input and render this message instead. */
  disabledReason?: string;
}

/**
 * Payload sent to `PluginClient.publishMessage`. `body` is the raw text the
 * user typed (JSON-serialised if `bodyFormat` was "json" — the plugin is
 * responsible for parsing). `extras` carries values from `extraFields`,
 * keyed by the field's `key`. Key-value list fields arrive as a nested
 * `Record<string, string>`.
 */
export interface PublishMessagePayload {
  body: string;
  extras: Record<string, string | Record<string, string>>;
}

/** Result of a successful publish — surfaced under the form. */
export interface PublishMessageResult {
  /** Provider-assigned id (message id, sequence number, etc.). */
  id?: string;
  /** One-line summary shown under the form on success. */
  summary?: string;
}

/** A single chat turn sent to or received from the plugin. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Event in the streaming chat protocol. Plugins yield zero or more `delta`
 * events as tokens arrive, then a single terminal `done` (or `error`) event.
 * Plugins that can't stream natively can yield one `delta` with the full
 * text then `done`.
 */
export type ChatStreamEvent =
  | { kind: "delta"; text: string }
  | {
      kind: "done";
      /** The complete assistant turn. Hosts append this to the visible history. */
      message: ChatMessage;
      /** Optional usage metadata surfaced under the input. */
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
    }
  | { kind: "error"; message: string };

/**
 * When present on a DetailViewSchema, the host renders a NoSQL document
 * browser inline on the detail page. The plugin implements
 * executeNoSqlCommand() on PluginClient to handle the backend operations.
 *
 * Supports three drivers:
 *  - "firestore" — native Google Cloud Firestore REST API
 *  - "mongodb-peer" — the detail page hosts a MongoDB document browser. The
 *    host resolves a linked MongoDB account from the user and uses its
 *    connection for reads; the plugin that owns the detail view does not
 *    implement commands itself.
 *  - "dynamodb" — Amazon DynamoDB. Like Firestore, the plugin implements
 *    listCollections/find/getDocument/insertDocument/updateDocument/
 *    deleteDocument/countDocuments. Unlike Firestore, a DynamoDB resource is
 *    a single table — `listCollections` returns the one table name, and
 *    documents are keyed by composite (partition + optional sort) primary
 *    keys encoded into the `_name` field of each returned document so the
 *    Firestore-style UI can address them.
 */
export interface NoSqlBrowserCapability {
  driver: "firestore" | "mongodb-peer" | "dynamodb";
  /** Database identifier shown above the collection list (e.g. Firestore database id). */
  databaseLabel: string;
  /** Optional help text shown above the browser when collections are empty. */
  helpText?: string;
  /**
   * When true, the host's collection sidebar hides the "+ add collection" and
   * "drop collection" affordances — used by drivers (DynamoDB) where the
   * resource is a single fixed collection (the table).
   */
  singleCollection?: boolean;
}

/** Sidebar tree node */
export interface SidebarItemSchema {
  id: string;
  label: string;
  status?: StatusDotNode;
  children?: SidebarItemSchema[];
}

export interface PeerPaneResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  subtitle?: string;
  status?: ResourceStatus;
  fields: Record<string, unknown>;
  externalId?: string;
  /** Host will show an exec/shell button for pods */
  supportsExec?: boolean;
  /** Extra: container name for kubectl exec */
  containerName?: string;
  /** Extra: namespace this resource lives in */
  namespace?: string;
}

export interface PeerPaneResourceGroup {
  title: string;
  /** Resource type being listed — used by host to build DraggableResource */
  resourceTypeId: string;
  pluginId: string;
  items: PeerPaneResource[];
  /** If true, host shows a "Create" button for this group */
  supportsCreate?: boolean;
}

export interface PeerPaneSchema {
  status?: StatusDotNode;
  /** k9s launcher button shown if this is true and k9s is installed */
  supportsK9s?: boolean;
  /** If true, the host enables this pane as a drop target for secret export */
  supportsSecretImport?: boolean;
  /**
   * If true, the host renders an "Import YAML" button that posts to the peer
   * plugin's importYaml. Auto-set by the host based on whether the peer
   * client declares an importYaml method; plugins don't need to set this.
   */
  supportsYamlImport?: boolean;
  resourceGroups: PeerPaneResourceGroup[];
  /**
   * Static guidance shown in place of the resource groups. Populated by the
   * host when a `PeerPluginIntegration.unreachableWhen` matches, or when
   * credential resolution failed and the integration declared a
   * `credentialSetupAction` (the optional CTA below). Provider-agnostic;
   * carries the provider's text verbatim.
   */
  guidance?: { title: string; suggestions: string[]; action?: PeerGuidanceAction };
}

/**
 * A call-to-action button rendered inside a peer pane's guidance state — e.g.
 * "Make connection user" when a managed-DB peer can't connect because no
 * credentialed user has been minted. Clicking it opens the host's
 * prompt-nosql-command modal and dispatches `command` to the PARENT resource's
 * `executeNoSqlCommand` (the peer pane supplies the parent resource id), so the
 * provider that owns the parent handles the fix in-place.
 */
export interface PeerGuidanceAction {
  /** Button label, e.g. "Make connection user". */
  label: string;
  /** NoSQL command dispatched to the parent resource on submit. */
  command: string;
  /** Modal title. */
  title?: string;
  /** Modal description. */
  description?: string;
  /** Submit button label. */
  submitLabel?: string;
  /** Form fields (same shape as the create modal). */
  fields: CreateFieldConfig[];
}
