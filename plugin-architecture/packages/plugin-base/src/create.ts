/**
 * Types for the dynamic create-resource form.
 * Plugins implement `getCreateConfig` to return a fully-populated config
 * (including live API data like available regions, sizes, images, disks)
 * so the host can render a rich, platform-agnostic creation UI.
 */

export interface SizeOption {
  id: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  /** Included boot disk in GB, if the platform bundles it with the size */
  diskGb?: number;
  priceMonthly?: number;
  category?: string;
  /**
   * Optional tag list used by `size-picker` together with the field's
   * `filterByFieldKey` to hide sizes that don't match the picked sibling
   * value (e.g. DO managed-DB sizes that are only valid for one engine).
   * When omitted the size is shown for every filter value.
   */
  availableFor?: string[];
}

export interface RegionOption {
  id: string;
  /** Short identifier shown in the selected-state summary */
  label: string;
  /** Human-readable city/country, e.g. "Iowa, USA" or "Frankfurt, Germany" */
  location?: string;
  /** Emoji flag, e.g. "🇺🇸" */
  flag?: string;
  /**
   * Optional tag list used by `region-picker` together with the field's
   * `filterByFieldKey` to hide regions that don't match the picked sibling
   * value (e.g. region availability per managed-DB engine on DigitalOcean).
   * When omitted the region is shown for every filter value.
   */
  availableFor?: string[];
}

export interface ImageOption {
  /** Value submitted in `createResource` fields */
  id: string;
  label: string;
  description?: string;
  /** OS family slug, e.g. "debian-12", "ubuntu-2404-lts-amd64" */
  family?: string;
  /** True for images owned by the account (not public) */
  isOwned?: boolean;
  /** Grouping label, e.g. "Debian", "Ubuntu", "My Images" */
  category?: string;
}

export interface DiskOption {
  /** Value submitted in `createResource` fields */
  id: string;
  label: string;
  sizeGb: number;
  zone?: string;
  diskType?: string;
}

export interface PolicyOption {
  /** Value submitted in `createResource` fields (e.g. AWS policy ARN, GCP role name) */
  id: string;
  label: string;
  description?: string;
  /** Grouping label, e.g. "AWS Managed", "Customer Managed", "Predefined", "Custom" */
  category?: string;
  /** Optional badge shown inline, e.g. "GA", "Beta", "Deprecated" */
  badge?: string;
}

export type CreateFieldKind =
  | "text" // single-line text input
  | "password" // single-line input rendered with masking (type="password")
  | "number" // numeric input
  | "datetime" // date/time picker — emits a string per `datetimeMode`
  | "select" // simple dropdown with static options
  | "size-picker" // visual size selector with RAM/CPU bars
  | "region-picker" // searchable list of region/zone options
  | "disk-slider" // boot-disk GB slider
  | "image-picker" // OS image + account image picker
  | "disk-picker" // existing disk picker
  | "ssh-key-picker" // SSH public key — host resolves from ~/.ssh and app registry
  | "resource-picker" // associate with an existing resource (e.g. VPC network)
  | "policy-picker" // multi-select IAM policies/roles — value is JSON array of IDs
  | "key-value-list" // list of rows with a text key + one-of-N value toggle — value is JSON array
  | "code" // syntax-highlighted code editor (rendered in a split side-pane)
  | "json-schema"; // structured JSON Schema builder — value is a JSON Schema object string

/**
 * Output format for a `datetime` field. Controls what the picker submits as
 * the field value:
 *   - "datetime" (default): ISO 8601 UTC string, e.g. "2026-07-22T00:00:00Z"
 *   - "date":               "YYYY-MM-DD" (no time component)
 *   - "epoch-ms":           milliseconds since epoch, rendered as a string
 */
export type DatetimeMode = "datetime" | "date" | "epoch-ms";

/** Describes a specific plugin/resource-type/output that can provide a value */
export interface AssociationSource {
  pluginId: string;
  resourceTypeId: string;
  outputKey: string;
}

/**
 * A single show/hide predicate evaluated against the current form values.
 * Matches when the named field's value equals `fieldValue`, is included in
 * `fieldValues`, or (for `fieldValuesNot`) is NOT included in that list. When
 * multiple of these are set they are AND-ed together.
 */
export interface ShowWhenCondition {
  fieldKey: string;
  fieldValue?: string;
  fieldValues?: string[];
  fieldValuesNot?: string[];
}

/**
 * A field visibility rule. Either a single condition, or a compound `allOf`
 * (every condition must match) / `anyOf` (at least one must match). Lets fields
 * express conditions like "show when type is A/AAAA/CNAME AND mode is custom".
 */
export type ShowWhenRule =
  | ShowWhenCondition
  | { allOf: ShowWhenCondition[] }
  | { anyOf: ShowWhenCondition[] };

export interface CreateFieldConfig {
  /** Key used in the `fields` map passed to `createResource` */
  key: string;
  label: string;
  kind: CreateFieldKind;
  required: boolean;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  /**
   * When set, this field is only shown when the rule matches the current form
   * values. Supports a single condition or a compound `allOf` / `anyOf`.
   * Hidden fields are excluded from the submitted form data.
   */
  showWhen?: ShowWhenRule;
  /**
   * When true, the field is not rendered in the form UI but its
   * `defaultValue` is still submitted. Use for fields whose value is
   * derived from the action context (e.g. the resource name to delete)
   * and would just be noise to show the user.
   */
  hidden?: boolean;
  /**
   * When true, this field is a UI-only control (e.g. a mode toggle) and its
   * value is stripped from the submitted form data. The host never passes
   * transient fields to `createResource`.
   */
  transient?: boolean;
  /**
   * `resource-picker` — when true, the picker emits a *live output reference*
   * encoding the picked resource's identity (plugin/type/id/account/output)
   * rather than the flattened literal value. The host persists this as an
   * output-ref association so the field tracks the source's value over time.
   * Also makes the picker search across every account whose plugin matches a
   * source, not just the account the resource is being created in.
   */
  referenceMode?: boolean;
  /** `text` — render as a multi-line textarea instead of an input (e.g. JSON blobs). */
  multiline?: boolean;
  /** `select` options */
  options?: { id: string; label: string }[];
  /** `number` input bounds */
  minValue?: number;
  maxValue?: number;
  stepValue?: number;
  /** `datetime` — output format for the picked value. Defaults to "datetime". */
  datetimeMode?: DatetimeMode;
  /** `size-picker` data */
  sizes?: SizeOption[];
  /** `region-picker` data */
  regions?: RegionOption[];
  /** `disk-slider` — all values in GB */
  minGb?: number;
  maxGb?: number;
  defaultGb?: number;
  stepGb?: number;
  /** `image-picker` data */
  images?: ImageOption[];
  /** `disk-picker` data */
  disks?: DiskOption[];
  /** `resource-picker` — resources to pick from (filtered by association sources from the resource type definition) */
  associationSources?: AssociationSource[];
  /**
   * `resource-picker` — when set, the picker reads the current form value of
   * this field and passes it to the host as a regional scope hint. Used to
   * avoid the picker fanning out across every region for regional resources
   * (e.g. AWS VPCs/security groups) when the user has already picked a region
   * in the same form.
   */
  scopeFromFieldKey?: string;
  /**
   * `region-picker` — when set, the picker reads the current form value of
   * this field and hides any region whose `availableFor` list doesn't include
   * that value. Lets a sibling field (e.g. managed-DB `engine`) reactively
   * narrow the region list so users can't pick combinations the provider
   * would reject (e.g. Redis in a region where DO doesn't host Redis).
   */
  filterByFieldKey?: string;
  /** `policy-picker` — policies/roles the user can attach. Value is JSON array of `id`s. */
  policies?: PolicyOption[];
  /**
   * `key-value-list` — configures the row shape of the entry list. Each
   * submitted entry becomes an object `{ [entryKeyName]: <key text>,
   * [entryValueName]: <picked option id> }`. The overall field value is a
   * JSON-serialized array of these objects.
   */
  entryKeyLabel?: string;
  entryKeyPlaceholder?: string;
  /** Output JSON key for the key text. Defaults to "key". */
  entryKeyName?: string;
  entryValueLabel?: string;
  /** Output JSON key for the picked option id. Defaults to "value". */
  entryValueName?: string;
  entryValueOptions?: { id: string; label: string }[];
  /** Option id pre-selected on newly-added rows. */
  entryValueDefault?: string;
  /**
   * `code` — Monaco language id for syntax highlighting (e.g. "javascript",
   * "python", "go", "java", "yaml", "json"). Defaults to "plaintext".
   */
  codeLanguage?: string;
  /** Label on the "add row" button. Defaults to "+ Add". */
  addLabel?: string;
  minEntries?: number;
  maxEntries?: number;
  /**
   * Optional in-form actions (e.g. "+ Generate role"). Each renders as a
   * button the user can click to mint a value via the plugin.
   */
  actions?: FieldAction[];
}

export interface CreateResourceConfig {
  fields: CreateFieldConfig[];
}

/**
 * A button the host renders alongside a create-form field. Clicking it calls
 * the plugin's `executeFieldAction`, which can mint a fresh resource (e.g. an
 * IAM role) and return its identifier as the field's new value. Designed to
 * be domain-agnostic — the plugin owns what each action means.
 */
export interface FieldAction {
  /** Plugin-defined identifier passed back to `executeFieldAction`. */
  id: string;
  /** Button label, e.g. "+ Generate role". */
  label: string;
  /** Optional helper text shown as a tooltip / aria-label. */
  description?: string;
  /**
   * Optional inline mini-form. When present, clicking the action button
   * expands a panel of these fields instead of firing immediately; the
   * host calls `executeFieldAction` only after the user submits the panel.
   * The panel's values are passed to the plugin as `actionFields`, kept
   * separate from the main create-form values to avoid key collisions.
   *
   * Use for "create a thing on the side and select it" flows — e.g. minting
   * a new security group with a chosen name and port set, then attaching
   * the new SG to the EC2 instance being created in the outer form.
   */
  formFields?: CreateFieldConfig[];
  /** Label on the panel's submit button. Defaults to "Create". */
  submitLabel?: string;
}

/**
 * Result of `PluginClient.executeFieldAction`. `value` becomes the field's
 * new submitted value. For `select` fields, the host can prepend `option` to
 * the field's options list so the freshly-created entity shows up there.
 */
export interface FieldActionResult {
  value: string;
  option?: { id: string; label: string };
}

/**
 * Optional follow-up pricing request for size-picker options.
 * Used by hosts to progressively hydrate prices after initial create-form render.
 */
export interface CreateSizePricingRequest {
  /** Region/zone selected in the create form (provider-specific identifier). */
  regionId?: string;
  /** Size options currently shown in the create form. */
  sizes: Array<{
    id: string;
    vcpus: number;
    memoryMb: number;
  }>;
}
