/**
 * The wire contract for `/api/org/:orgId/environments`: the template document
 * model, capture inputs and drafts, instance rows, org settings, cost
 * estimates, and the limits every surface enforces.
 */

// ---------------------------------------------------------------------------
// Template document
// ---------------------------------------------------------------------------

/**
 * What a member's create-form field is filled with at instantiation time.
 *
 * The three non-literal kinds are the whole reason a template is more than a
 * list of resources:
 * - `parameter` — the field the user chose to vary (region, size, a name).
 * - `output` — another member's resolved **output** (a connection string, an
 *   IP). This is the captured half of an output reference: an instantiated
 *   database's connection string flows into the app that consumes it.
 * - `member-id` — another member's provider-side id. Covers the containment
 *   and identity edges a provider expresses as a bare id (a subnet's VPC, a
 *   record's zone) without the host having to know which is which.
 */
export type TemplateFieldValue =
  | { kind: "literal"; value: string }
  | { kind: "parameter"; parameter: string }
  | { kind: "output"; member: string; outputKey: string }
  | { kind: "member-id"; member: string };

/** One resource in a template, keyed by a slug that is stable across edits. */
export interface EnvironmentTemplateMember {
  /** Unique within the template; the id every reference is written against. */
  key: string;
  pluginId: string;
  resourceTypeId: string;
  /** Account the copy is created in. Overridable per instantiation. */
  accountId: string;
  /** Display name of the resource this member was captured from. */
  sourceName: string;
  /** The captured resource's id, kept for provenance. May be stale. */
  sourceResourceId?: string;
  /**
   * The create-form field that carries the resource's name, when the plugin
   * has one. Detected at capture by matching the captured value against the
   * source's display name — never by guessing at key spellings — and it is
   * what the instance name prefix is applied to.
   */
  nameFieldKey?: string;
  /** Member key of the captured parent, for child resource types. */
  parentMember?: string;
  /** Create-form fields, keyed exactly as `createResource` expects them. */
  fields: Record<string, TemplateFieldValue>;
}

export type EnvironmentParameterType = "string" | "number" | "select";

/** A field the user chooses to vary at instantiation. */
export interface EnvironmentParameter {
  key: string;
  label: string;
  type: EnvironmentParameterType;
  required: boolean;
  defaultValue?: string;
  /** `select` only. */
  options?: { id: string; label: string }[];
  description?: string;
}

export interface EnvironmentTemplate {
  id: string;
  name: string;
  description: string | null;
  parameters: EnvironmentParameter[];
  members: EnvironmentTemplateMember[];
  createdAt: string;
  updatedAt: string;
  /** Instances alive right now that came from this template. */
  activeInstanceCount?: number;
}

export interface EnvironmentTemplateListResponse {
  templates: EnvironmentTemplate[];
}

/** Body of `POST`/`PUT` on `/environments/templates`. */
export interface EnvironmentTemplateInput {
  name: string;
  description?: string | null;
  parameters: EnvironmentParameter[];
  members: EnvironmentTemplateMember[];
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** A resource being captured, as the server reads it out of the inventory. */
export interface CaptureSourceResource {
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string;
  parentResourceId?: string | null;
  fields: Record<string, string>;
  /**
   * Output references already recorded against this resource's fields — the
   * `secret_field_states` / `associations` rows the create path writes. A
   * reference whose target is also being captured becomes an `output` field
   * value; one that points outside the selection stays a literal, because the
   * thing it points at is not part of the environment.
   */
  outputRefs?: { fieldKey: string; targetResourceId: string; outputKey: string }[];
}

/**
 * The create-form field metadata a capture works from — a projection of the
 * plugin's own `CreateFieldConfig`, narrowed to what the template needs.
 */
export interface CaptureCreateField {
  key: string;
  label: string;
  kind: string;
  required: boolean;
  options?: { id: string; label: string }[];
  /** `transient` fields never reach `createResource`, so they never capture. */
  transient?: boolean;
}

/** A draft member, plus the metadata the editor needs to offer "vary this". */
export interface CaptureDraftMember extends EnvironmentTemplateMember {
  fieldMeta: Record<
    string,
    {
      label: string;
      kind: string;
      required: boolean;
      options?: { id: string; label: string }[];
      /** False for fields already pinned to a reference — varying them is meaningless. */
      parameterisable: boolean;
    }
  >;
}

export interface CaptureDraft {
  members: CaptureDraftMember[];
  /**
   * Parameters worth offering, derived from the field *kinds* the plugins
   * declare (a region picker is a region, a size picker is a size). One
   * parameter per (kind, key) across the whole selection, so bumping "region"
   * moves every member that has one.
   */
  suggestedParameters: EnvironmentParameter[];
  /** Resources that could not be captured, and why — never silently dropped. */
  skipped: { resourceId: string; displayName: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an instance row.
 * - `creating` — members are being created right now.
 * - `active` — every member was created.
 * - `partial` — a create failed part-way. The members that *did* get created
 *   are recorded and can be torn down; this status exists so they can never
 *   become orphaned cloud resources with no row pointing at them.
 * - `tearing-down` / `deleted` — teardown in flight / finished.
 * - `failed` — nothing usable was created.
 */
export type EnvironmentInstanceStatus =
  "creating" | "active" | "partial" | "tearing-down" | "deleted" | "failed";

export type EnvironmentMemberStatus = "pending" | "created" | "failed" | "deleted";

export interface EnvironmentInstanceMember {
  id: string;
  memberKey: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  /** Null until the create returns — and after a create that failed. */
  resourceId: string | null;
  externalId: string | null;
  displayName: string;
  status: EnvironmentMemberStatus;
  error: string | null;
  /** The lease that will auto-delete this member at the instance's TTL. */
  leaseId: string | null;
  position: number;
}

export interface EnvironmentInstance {
  id: string;
  templateId: string | null;
  /** Denormalized: the template may be renamed or deleted later. */
  templateName: string;
  name: string;
  namePrefix: string;
  parameters: Record<string, string>;
  status: EnvironmentInstanceStatus;
  /** The TTL deadline every member's lease is set to. */
  expiresAt: string;
  error: string | null;
  members: EnvironmentInstanceMember[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface EnvironmentInstanceListResponse {
  instances: EnvironmentInstance[];
}

/** Body of `POST /environments/templates/:id/instantiate`. */
export interface EnvironmentInstantiateInput {
  /** Human name for the copy; also the default name prefix. */
  name: string;
  parameters?: Record<string, string>;
  /** Required. The whole feature is "it deletes itself". */
  ttlHours: number;
  /** Per-member account overrides, keyed by member key. */
  accountOverrides?: Record<string, string>;
  note?: string;
}

/** Org-level rails on how long an ephemeral environment may live. */
export interface EnvironmentSettings {
  /** Longest TTL an instantiation may ask for, in hours. */
  maxTtlHours: number;
  /** Pre-filled TTL in the instantiate form, in hours. */
  defaultTtlHours: number;
}

/** Response of `POST /environments/templates/:id/estimate`. */
export interface EnvironmentCostEstimate {
  /** Sum of the priced members. Null when nothing could be priced. */
  monthlyAmount: number | null;
  currency: string | null;
  /** True when at least one member could not be priced — "at least $X/mo". */
  partial: boolean;
  /** Members whose cost is unknown; reported, never rounded to zero. */
  unpricedCount: number;
  members: {
    memberKey: string;
    displayName: string;
    monthlyAmount: number | null;
    currency: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const ENVIRONMENT_LIMITS = {
  /** Members in one template. A template is a environment, not an estate. */
  maxMembers: 50,
  maxParameters: 20,
  maxTemplatesPerOrg: 100,
  /** Live (non-terminal) instances per org — a governance rail on spend. */
  maxLiveInstancesPerOrg: 50,
  maxNameLength: 60,
  maxNoteLength: 500,
  /** Shortest TTL that is worth the provisioning. */
  minTtlHours: 1,
  /**
   * Ceiling on the org's own `maxTtlHours` setting. An "ephemeral" environment
   * that can outlive a month is just infrastructure nobody owns.
   */
  hardMaxTtlHours: 720,
  /** Default org ceiling until someone changes it. */
  defaultMaxTtlHours: 168,
  /** Pre-filled TTL in the instantiate form. */
  defaultTtlHours: 24,
} as const;
