/**
 * Ephemeral environments — capture a set of existing resources as a
 * parameterised template, stamp copies of it out on demand, and have each copy
 * delete itself when its TTL runs out.
 *
 * This module is the shared pure half: the wire contract for
 * `/api/org/:orgId/environments`, the template document model, and every piece
 * of judgement that decides what an instantiation actually does — dependency
 * ordering, parameter substitution, output-reference rewriting and name
 * prefixing. None of it touches a database, a provider API or a plugin, which
 * is what lets the same functions run in the API handler, the editor UI and the
 * unit tests.
 *
 * **Nothing here knows what a provider is.** A template is built from each
 * plugin's own create-field metadata (`getCreateConfig`), so the set of fields
 * that can be captured, varied or prefixed is whatever the plugin says its
 * create form takes. The host never special-cases a `pluginId`.
 */
import type { CloudFetch } from "./fetch";

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

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const MAX_PREFIXED_NAME = 63;

/**
 * Reduce a free-text instance name to something every provider accepts as a
 * name component: lowercase, alphanumerics and single dashes, no leading or
 * trailing dash. Deliberately conservative — this string is prepended to names
 * the user never sees us build, and the strictest common denominator (RFC 1123
 * label rules) is the only one that is safe everywhere.
 */
export function slugifyEnvironmentName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 24).replace(/-$/, "");
}

/**
 * Prefix a captured name with the instance's prefix. Truncates the *captured*
 * half rather than the prefix, so two instances of one template can never
 * collide by having their distinguishing part cut off.
 */
export function applyNamePrefix(name: string, prefix: string): string {
  const slug = slugifyEnvironmentName(prefix);
  if (slug === "") return name;
  if (name === "") return slug;
  const room = MAX_PREFIXED_NAME - slug.length - 1;
  if (room <= 0) return slug.slice(0, MAX_PREFIXED_NAME);
  const tail = name.length > room ? name.slice(name.length - room) : name;
  return `${slug}-${tail.replace(/^-/, "")}`;
}

// ---------------------------------------------------------------------------
// Dependency ordering
// ---------------------------------------------------------------------------

/** Member keys this member must be created after, in no particular order. */
export function memberDependencies(member: EnvironmentTemplateMember): string[] {
  const deps = new Set<string>();
  if (member.parentMember) deps.add(member.parentMember);
  for (const value of Object.values(member.fields)) {
    if (value.kind === "output" || value.kind === "member-id") deps.add(value.member);
  }
  deps.delete(member.key);
  return [...deps];
}

export interface TemplateOrder {
  /** Creation order. Empty when the template does not have a total order. */
  ordered: EnvironmentTemplateMember[];
  /** Member keys caught in a dependency cycle. */
  cycle: string[];
  /** References pointing at a member that is not in the template. */
  missing: { member: string; target: string }[];
}

/**
 * Topologically sort a template's members so a resource is always created
 * after everything it references.
 *
 * Kahn's algorithm with a deterministic tie-break (the template's own member
 * order), because an instantiation that lists its steps in a different order
 * on every run is impossible to read a failure out of. Cycles and dangling
 * references are **reported, not thrown**: both are template bugs the editor
 * has to be able to show against the offending member.
 */
export function orderTemplateMembers(members: EnvironmentTemplateMember[]): TemplateOrder {
  const byKey = new Map(members.map((m) => [m.key, m]));
  const missing: { member: string; target: string }[] = [];
  const deps = new Map<string, string[]>();

  for (const member of members) {
    const resolved: string[] = [];
    for (const dep of memberDependencies(member)) {
      if (byKey.has(dep)) resolved.push(dep);
      else missing.push({ member: member.key, target: dep });
    }
    deps.set(member.key, resolved);
  }
  if (missing.length > 0) return { ordered: [], cycle: [], missing };

  const indegree = new Map<string, number>(members.map((m) => [m.key, 0]));
  const dependents = new Map<string, string[]>(members.map((m) => [m.key, []]));
  for (const member of members) {
    for (const dep of deps.get(member.key)!) {
      indegree.set(member.key, indegree.get(member.key)! + 1);
      dependents.get(dep)!.push(member.key);
    }
  }

  // Ready set kept in template order: the tie-break is the document, so the
  // plan a user reads is the plan that runs.
  const ordered: EnvironmentTemplateMember[] = [];
  const remaining = members.map((m) => m.key);
  while (ordered.length < members.length) {
    const nextIndex = remaining.findIndex((key) => indegree.get(key) === 0);
    if (nextIndex === -1) break;
    const [key] = remaining.splice(nextIndex, 1);
    ordered.push(byKey.get(key!)!);
    for (const dependent of dependents.get(key!)!) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
    }
  }

  if (ordered.length !== members.length) {
    return { ordered: [], cycle: remaining.sort(), missing: [] };
  }
  return { ordered, cycle: [], missing: [] };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate a template document. Returns a human-readable problem or null —
 * shared verbatim by the editor and the API boundary, so the form and the
 * server cannot disagree about what a valid template is.
 */
export function validateTemplate(input: EnvironmentTemplateInput): string | null {
  const name = input.name?.trim() ?? "";
  if (name === "") return "A template needs a name.";
  if (name.length > ENVIRONMENT_LIMITS.maxNameLength) {
    return `Template names are limited to ${ENVIRONMENT_LIMITS.maxNameLength} characters.`;
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    return "A template needs at least one resource.";
  }
  if (input.members.length > ENVIRONMENT_LIMITS.maxMembers) {
    return `Templates are limited to ${ENVIRONMENT_LIMITS.maxMembers} resources.`;
  }
  if (input.parameters.length > ENVIRONMENT_LIMITS.maxParameters) {
    return `Templates are limited to ${ENVIRONMENT_LIMITS.maxParameters} parameters.`;
  }

  const memberKeys = new Set<string>();
  for (const member of input.members) {
    if (!KEY_PATTERN.test(member.key)) {
      return `"${member.key}" is not a valid resource key (lowercase letters, digits and dashes).`;
    }
    if (memberKeys.has(member.key)) return `Duplicate resource key "${member.key}".`;
    memberKeys.add(member.key);
    if (!member.pluginId || !member.resourceTypeId || !member.accountId) {
      return `Resource "${member.key}" is missing its plugin, type or account.`;
    }
  }

  const paramKeys = new Set<string>();
  for (const parameter of input.parameters) {
    if (!KEY_PATTERN.test(parameter.key)) {
      return `"${parameter.key}" is not a valid parameter key (lowercase letters, digits and dashes).`;
    }
    if (paramKeys.has(parameter.key)) return `Duplicate parameter "${parameter.key}".`;
    paramKeys.add(parameter.key);
    if (parameter.type === "select" && (parameter.options ?? []).length === 0) {
      return `Parameter "${parameter.key}" is a dropdown with no options.`;
    }
  }

  for (const member of input.members) {
    for (const [fieldKey, value] of Object.entries(member.fields)) {
      if (value.kind === "parameter" && !paramKeys.has(value.parameter)) {
        return `Resource "${member.key}" uses parameter "${value.parameter}", which the template does not define.`;
      }
      if (
        (value.kind === "output" || value.kind === "member-id") &&
        !memberKeys.has(value.member)
      ) {
        return `Resource "${member.key}" field "${fieldKey}" references "${value.member}", which is not in the template.`;
      }
    }
  }

  const order = orderTemplateMembers(input.members);
  if (order.cycle.length > 0) {
    return `These resources reference each other in a loop: ${order.cycle.join(", ")}.`;
  }
  return null;
}

/**
 * Validate supplied parameter values against a template. Returns a problem or
 * null. Missing optional parameters fall back to their default; a missing
 * required parameter with no default is an error, because guessing at it would
 * mean creating the wrong thing and billing for it.
 */
export function validateParameterValues(
  template: Pick<EnvironmentTemplate, "parameters">,
  values: Record<string, string>,
): string | null {
  for (const parameter of template.parameters) {
    const raw = values[parameter.key] ?? parameter.defaultValue;
    if (raw === undefined || raw === "") {
      if (parameter.required) return `Parameter "${parameter.label}" is required.`;
      continue;
    }
    if (parameter.type === "number" && !Number.isFinite(Number(raw))) {
      return `Parameter "${parameter.label}" must be a number.`;
    }
    if (parameter.type === "select") {
      const ids = (parameter.options ?? []).map((o) => o.id);
      if (!ids.includes(raw)) {
        return `Parameter "${parameter.label}" must be one of: ${ids.join(", ")}.`;
      }
    }
  }
  for (const key of Object.keys(values)) {
    if (!template.parameters.some((p) => p.key === key)) {
      return `Unknown parameter "${key}".`;
    }
  }
  return null;
}

/** Fill in defaults for parameters the caller left out. */
export function resolveParameterValues(
  template: Pick<EnvironmentTemplate, "parameters">,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const parameter of template.parameters) {
    const raw = values[parameter.key] ?? parameter.defaultValue ?? "";
    if (raw !== "") out[parameter.key] = raw;
  }
  return out;
}

/**
 * Validate a requested TTL against the org's ceiling. Returns a problem or
 * null. A TTL is mandatory — there is no "forever" branch to fall through to.
 */
export function validateTtlHours(ttlHours: number, settings: EnvironmentSettings): string | null {
  if (!Number.isFinite(ttlHours)) return "A time-to-live is required.";
  if (ttlHours < ENVIRONMENT_LIMITS.minTtlHours) {
    return `The shortest time-to-live is ${ENVIRONMENT_LIMITS.minTtlHours} hour.`;
  }
  const ceiling = Math.min(settings.maxTtlHours, ENVIRONMENT_LIMITS.hardMaxTtlHours);
  if (ttlHours > ceiling) {
    return `This organization limits ephemeral environments to ${ceiling} hours.`;
  }
  return null;
}

/** Clamp an org settings document into the range the code actually supports. */
export function normalizeEnvironmentSettings(
  input: Partial<EnvironmentSettings> | null | undefined,
): EnvironmentSettings {
  const maxTtlHours = Math.min(
    Math.max(
      Math.round(Number(input?.maxTtlHours ?? ENVIRONMENT_LIMITS.defaultMaxTtlHours)) ||
        ENVIRONMENT_LIMITS.defaultMaxTtlHours,
      ENVIRONMENT_LIMITS.minTtlHours,
    ),
    ENVIRONMENT_LIMITS.hardMaxTtlHours,
  );
  const defaultTtlHours = Math.min(
    Math.max(
      Math.round(Number(input?.defaultTtlHours ?? ENVIRONMENT_LIMITS.defaultTtlHours)) ||
        ENVIRONMENT_LIMITS.defaultTtlHours,
      ENVIRONMENT_LIMITS.minTtlHours,
    ),
    maxTtlHours,
  );
  return { maxTtlHours, defaultTtlHours };
}

// ---------------------------------------------------------------------------
// Instantiation plan
// ---------------------------------------------------------------------------

export interface InstantiationStep {
  member: EnvironmentTemplateMember;
  /** Outputs of earlier members this step needs resolved before it runs. */
  needs: { member: string; outputKey: string }[];
}

export interface InstantiationPlan {
  steps: InstantiationStep[];
  /**
   * Which outputs must be resolved from each created member, so the runner
   * asks the plugin for exactly those and nothing else.
   */
  outputsNeeded: Record<string, string[]>;
}

/** Build the ordered plan. Throws nothing — callers validate first. */
export function buildInstantiationPlan(members: EnvironmentTemplateMember[]): InstantiationPlan {
  const { ordered } = orderTemplateMembers(members);
  const outputsNeeded: Record<string, string[]> = {};
  const steps: InstantiationStep[] = ordered.map((member) => {
    const needs: { member: string; outputKey: string }[] = [];
    for (const value of Object.values(member.fields)) {
      if (value.kind !== "output") continue;
      needs.push({ member: value.member, outputKey: value.outputKey });
      const list = (outputsNeeded[value.member] ??= []);
      if (!list.includes(value.outputKey)) list.push(value.outputKey);
    }
    return { member, needs };
  });
  return { steps, outputsNeeded };
}

/** What the runner knows about members it has already created. */
export interface CreatedMemberState {
  /** The provider-side id of the created resource. */
  externalId: string;
  /** Outputs resolved from it so far, keyed by output key. */
  outputs: Record<string, string>;
}

export type ResolveFieldsResult =
  { fields: Record<string, string>; problem?: undefined } | { fields?: undefined; problem: string };

/**
 * Turn a member's template fields into the literal `fields` map
 * `createResource` takes.
 *
 * Everything a provider would reject is caught here rather than mid-apply: an
 * unresolved parameter, a reference to a member that has not been created, an
 * output the source did not produce. A missing value is **never** substituted
 * with an empty string — that is how you create a resource in the wrong region
 * and find out from the bill.
 */
export function resolveMemberFields(
  member: EnvironmentTemplateMember,
  context: {
    parameters: Record<string, string>;
    created: Record<string, CreatedMemberState>;
    namePrefix: string;
  },
): ResolveFieldsResult {
  const fields: Record<string, string> = {};
  for (const [fieldKey, value] of Object.entries(member.fields)) {
    switch (value.kind) {
      case "literal":
        fields[fieldKey] = value.value;
        break;
      case "parameter": {
        const resolved = context.parameters[value.parameter];
        if (resolved === undefined || resolved === "") {
          return { problem: `Parameter "${value.parameter}" has no value.` };
        }
        fields[fieldKey] = resolved;
        break;
      }
      case "member-id": {
        const source = context.created[value.member];
        if (!source) {
          return { problem: `"${value.member}" has not been created yet.` };
        }
        fields[fieldKey] = source.externalId;
        break;
      }
      case "output": {
        const source = context.created[value.member];
        if (!source) {
          return { problem: `"${value.member}" has not been created yet.` };
        }
        const resolved = source.outputs[value.outputKey];
        if (resolved === undefined) {
          return {
            problem: `"${value.member}" did not produce an output named "${value.outputKey}".`,
          };
        }
        fields[fieldKey] = resolved;
        break;
      }
    }
  }

  // The name prefix is applied last and only to the field capture identified
  // as the name, so a template whose plugin has no name field simply keeps the
  // captured value rather than having a prefix pushed somewhere arbitrary.
  if (member.nameFieldKey && fields[member.nameFieldKey] !== undefined) {
    fields[member.nameFieldKey] = applyNamePrefix(fields[member.nameFieldKey]!, context.namePrefix);
  }
  return { fields };
}

/**
 * The display name a member's resource is expected to end up with.
 *
 * Teardown needs this to find a resource whose creation **succeeded but was
 * never confirmed** — a create that returned right before the confirming write
 * failed. It resolves the name field the same way `resolveMemberFields` does
 * (literal or parameter; both are known before the run starts, unlike output
 * references) and falls back to the captured name when the plugin has no name
 * field to prefix.
 */
export function expectedMemberDisplayName(
  member: EnvironmentTemplateMember,
  parameters: Record<string, string>,
  namePrefix: string,
): string {
  const key = member.nameFieldKey;
  if (!key) return member.sourceName;
  const value = member.fields[key];
  const raw =
    value?.kind === "literal"
      ? value.value
      : value?.kind === "parameter"
        ? parameters[value.parameter]
        : undefined;
  if (raw === undefined || raw === "") return member.sourceName;
  return applyNamePrefix(raw, namePrefix);
}

// ---------------------------------------------------------------------------
// Failure bookkeeping and teardown recovery
// ---------------------------------------------------------------------------

/** The row patch that records a failed member. */
export interface MemberFailureRecord {
  status: "failed";
  error: string;
  /** Present whenever the provider returned a resource before the failure. */
  resourceId?: string;
  externalId?: string | null;
  displayName?: string;
}

/**
 * Build the single write that records a member failure.
 *
 * When the create **succeeded** and something after it threw — including the
 * write that was supposed to confirm the creation — the id has to travel with
 * the failure. Recording the failure without it was a way to lose a running,
 * billing resource: teardown would see a member with no resource id and treat
 * it as nothing to do. One statement, so there is no second write to lose.
 */
export function buildMemberFailureRecord(
  error: string,
  created: { resourceId: string; externalId: string | null; displayName: string } | null,
): MemberFailureRecord {
  if (!created) return { status: "failed", error };
  return {
    status: "failed",
    error,
    resourceId: created.resourceId,
    externalId: created.externalId,
    displayName: created.displayName,
  };
}

/**
 * What teardown must do with one recorded member.
 *
 * - `skip` — already torn down.
 * - `delete` — a resource id is on record; delete it.
 * - `verify` — the member was attempted and carries **no** id, so the provider
 *   may or may not hold a resource for it. Ask the provider before concluding
 *   anything; treating this as "handled" is how a resource bills forever.
 * - `unattempted` — the run never reached this member, so nothing can exist.
 */
export type TeardownAction = "skip" | "delete" | "verify" | "unattempted";

/**
 * The highest position the run can possibly have touched.
 *
 * Instantiation stops at the first failure, so every member past that point is
 * untouched. The `+ 1` covers the member that was **in flight** when a process
 * died: its row is still `pending`, but a provider call may have gone out.
 */
export function attemptedPositionCeiling(
  members: { status: EnvironmentMemberStatus; position: number }[],
): number {
  let highest = -1;
  for (const member of members) {
    if (member.status !== "pending" && member.position > highest) highest = member.position;
  }
  return highest + 1;
}

export function classifyTeardownMember(
  member: { status: EnvironmentMemberStatus; resourceId: string | null; position: number },
  attemptedCeiling: number,
): TeardownAction {
  if (member.status === "deleted") return "skip";
  if (member.resourceId) return "delete";
  return member.position <= attemptedCeiling ? "verify" : "unattempted";
}

/**
 * How tearing one member down ended.
 *
 * `ambiguous` and `needs-attention` are separate outcomes from `failed` because
 * nothing was attempted in either case: the environment declined to delete
 * something it could not prove was its own, and said so.
 */
export type MemberTeardownOutcome =
  "deleted" | "already-gone" | "failed" | "ambiguous" | "needs-attention";

// ---------------------------------------------------------------------------
// The identity rule
// ---------------------------------------------------------------------------

/**
 * **Delete only when identity is certain. Where it is not, report and leave.**
 *
 * This single rule settles the two ways this feature can destroy something it
 * did not create, and it is deliberately asymmetric because the costs are:
 * an orphaned resource costs money, and money is recoverable; a wrongly
 * deleted resource costs data, and data is not.
 *
 * - **Rolling back a member whose TTL could not be attached** is a *certain*
 *   identity — the provider handed us the id seconds earlier — so it deletes.
 * - **Recovering a member with no recorded id** is an *inferred* identity, and
 *   a display name is not an identity. It deletes only with the corroboration
 *   below, and otherwise reports the resource for a human.
 *
 * `createdAt` is necessary but nowhere near sufficient on its own: it is a
 * required field on `ResourceInstance`, so listers whose provider exposes no
 * creation time fill it with the time of the call. Such a resource always
 * looks freshly created. The load-bearing signal is therefore our **own**
 * inventory — a `resources` row that predates this environment is a fact no
 * plugin can fabricate.
 */
export interface RecoveryCandidate {
  /** The provider's own id, when the lister supplies one. */
  externalId: string | null;
  /** Provider-reported creation time. May be the time of the listing call. */
  createdAt?: string | undefined;
  /**
   * When Infrawrench already had a row for this resource, when that row was
   * first written. Null when we have never seen it before.
   */
  knownSince?: string | null | undefined;
  /** True when another environment member already owns this resource. */
  claimedByAnotherMember?: boolean | undefined;
}

export type RecoveryDecision =
  | { action: "already-gone" }
  | { action: "ambiguous" }
  | { action: "needs-attention"; reason: string }
  | { action: "delete" };

/**
 * Allowance for clock skew between a provider's timestamps and ours. Kept
 * small: every second of it is a second of someone else's resource that could
 * be mistaken for ours.
 */
const RECOVERY_SKEW_MS = 60_000;

export function classifyRecoveryCandidate(
  candidates: RecoveryCandidate[],
  instanceCreatedAt: string,
): RecoveryDecision {
  if (candidates.length === 0) return { action: "already-gone" };
  if (candidates.length > 1) return { action: "ambiguous" };

  const candidate = candidates[0]!;
  const startedAt = Date.parse(instanceCreatedAt);
  if (Number.isNaN(startedAt)) {
    return { action: "needs-attention", reason: "this environment has no usable start time" };
  }

  if (candidate.claimedByAnotherMember) {
    return { action: "needs-attention", reason: "it belongs to another environment" };
  }

  // Our own inventory, and the one signal a plugin cannot fake. A resource we
  // were already tracking before this environment existed is not ours.
  if (candidate.knownSince != null) {
    const known = Date.parse(candidate.knownSince);
    if (!Number.isNaN(known) && known < startedAt - RECOVERY_SKEW_MS) {
      return { action: "needs-attention", reason: "it existed before this environment did" };
    }
  }

  // A lister with no real creation time reports the moment it was called, so
  // an unparseable one is the *only* case this can catch — but a provider that
  // does report honestly must not be ignored.
  const created = candidate.createdAt === undefined ? Number.NaN : Date.parse(candidate.createdAt);
  if (Number.isNaN(created)) {
    return {
      action: "needs-attention",
      reason: "the provider reports no creation time to check it against",
    };
  }
  if (created < startedAt - RECOVERY_SKEW_MS) {
    return { action: "needs-attention", reason: "it predates this environment" };
  }

  return { action: "delete" };
}

/**
 * Whether the member's auto-delete lease may be cancelled.
 *
 * **Only a confirmed outcome cancels it.** The lease *is* the retry machinery —
 * it re-attempts the delete at expiry, defers through change freezes and
 * reports when it gives up. Cancelling it after a failed delete turns a
 * transient provider error into a resource that bills until somebody
 * remembers to retry the teardown by hand. `ambiguous` and `needs-attention`
 * keep it for the same reason plus a better one: nothing was deleted, so the
 * resource is still there and still on a clock.
 */
export function leaseShouldBeCancelled(outcome: MemberTeardownOutcome): boolean {
  return outcome === "deleted" || outcome === "already-gone";
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Field kinds worth offering as a parameter, and what to call the parameter. */
const PARAMETERISABLE_KINDS: Record<string, string> = {
  "region-picker": "region",
  "size-picker": "size",
  "disk-slider": "disk",
  select: "option",
};

function uniqueKey(base: string, taken: Set<string>): string {
  const slug = slugifyEnvironmentName(base) || "item";
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${slug}-${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Build a draft template out of a selection of live resources.
 *
 * The shape of every member comes from the plugin's own create-field list:
 * a captured field that is not a create field is dropped (it is derived or
 * read-only, and feeding it back would fail), and a create field the source
 * has no value for is left out (its default applies). That is the whole reason
 * this is provider-agnostic — no per-provider table decides what is
 * reproducible, the plugin's create form does.
 *
 * References are preserved in two ways, in confidence order: a recorded output
 * reference whose target is also in the selection becomes an `output` value;
 * otherwise a field whose literal value is exactly another selected resource's
 * external id becomes a `member-id` value. Containment (`parentResourceId`)
 * becomes `parentMember`. Anything pointing outside the selection stays a
 * literal — the environment does not own it.
 */
export function buildCaptureDraft(input: {
  resources: CaptureSourceResource[];
  /** Create fields per `${pluginId}:${resourceTypeId}`. */
  createFields: Record<string, CaptureCreateField[]>;
}): CaptureDraft {
  const skipped: CaptureDraft["skipped"] = [];
  const takenKeys = new Set<string>();
  const keyByResourceId = new Map<string, string>();
  const captureable: { source: CaptureSourceResource; fields: CaptureCreateField[] }[] = [];

  for (const source of input.resources) {
    const fields = input.createFields[`${source.pluginId}:${source.resourceTypeId}`];
    if (!fields || fields.length === 0) {
      skipped.push({
        resourceId: source.resourceId,
        displayName: source.displayName,
        reason: "This resource type cannot be created by its plugin, so it cannot be stamped out.",
      });
      continue;
    }
    captureable.push({ source, fields });
    keyByResourceId.set(source.resourceId, uniqueKey(source.displayName, takenKeys));
  }

  const externalIdToKey = new Map<string, string>();
  for (const { source } of captureable) {
    const key = keyByResourceId.get(source.resourceId)!;
    // Only unambiguous ids may act as an identity: two resources sharing one
    // external id would let a reference resolve to either.
    if (source.externalId && externalIdToKey.has(source.externalId)) {
      externalIdToKey.set(source.externalId, "");
    } else if (source.externalId) {
      externalIdToKey.set(source.externalId, key);
    }
  }

  const members: CaptureDraftMember[] = [];
  for (const { source, fields } of captureable) {
    const key = keyByResourceId.get(source.resourceId)!;
    const refByField = new Map(
      (source.outputRefs ?? [])
        .filter((r) => keyByResourceId.has(r.targetResourceId))
        .map((r) => [r.fieldKey, r]),
    );

    const templateFields: Record<string, TemplateFieldValue> = {};
    const fieldMeta: CaptureDraftMember["fieldMeta"] = {};
    let nameFieldKey: string | undefined;

    for (const field of fields) {
      if (field.transient) continue;
      const captured = source.fields[field.key];
      if (captured === undefined || captured === "") continue;

      const ref = refByField.get(field.key);
      let value: TemplateFieldValue;
      if (ref) {
        value = {
          kind: "output",
          member: keyByResourceId.get(ref.targetResourceId)!,
          outputKey: ref.outputKey,
        };
      } else {
        const target = externalIdToKey.get(captured);
        value =
          target && target !== "" && target !== key
            ? { kind: "member-id", member: target }
            : { kind: "literal", value: captured };
      }
      templateFields[field.key] = value;

      // The name field is whichever create field the provider echoed back as
      // the resource's display name. No key spellings are guessed at.
      if (nameFieldKey === undefined && captured === source.displayName) {
        nameFieldKey = field.key;
      }

      fieldMeta[field.key] = {
        label: field.label,
        kind: field.kind,
        required: field.required,
        ...(field.options ? { options: field.options } : {}),
        parameterisable: value.kind === "literal",
      };
    }

    const parentKey = source.parentResourceId
      ? keyByResourceId.get(source.parentResourceId)
      : undefined;

    members.push({
      key,
      pluginId: source.pluginId,
      resourceTypeId: source.resourceTypeId,
      accountId: source.accountId,
      sourceName: source.displayName,
      sourceResourceId: source.resourceId,
      ...(nameFieldKey ? { nameFieldKey } : {}),
      ...(parentKey ? { parentMember: parentKey } : {}),
      fields: templateFields,
      fieldMeta,
    });
  }

  return { members, suggestedParameters: suggestParameters(members), skipped };
}

/**
 * Offer one parameter per create-field key whose kind says it is a knob
 * (region, size, disk). Keyed by field key rather than per member, so a
 * template whose four resources all live in `region` gets one "Region"
 * parameter that moves all four.
 */
export function suggestParameters(members: CaptureDraftMember[]): EnvironmentParameter[] {
  const byFieldKey = new Map<
    string,
    { label: string; kind: string; values: Set<string>; options?: { id: string; label: string }[] }
  >();

  for (const member of members) {
    for (const [fieldKey, meta] of Object.entries(member.fieldMeta)) {
      if (!meta.parameterisable) continue;
      if (!PARAMETERISABLE_KINDS[meta.kind]) continue;
      const value = member.fields[fieldKey];
      if (!value || value.kind !== "literal") continue;
      const entry = byFieldKey.get(fieldKey) ?? {
        label: meta.label,
        kind: meta.kind,
        values: new Set<string>(),
        ...(meta.options ? { options: meta.options } : {}),
      };
      entry.values.add(value.value);
      byFieldKey.set(fieldKey, entry);
    }
  }

  const out: EnvironmentParameter[] = [];
  const taken = new Set<string>();
  for (const [fieldKey, entry] of byFieldKey) {
    // A field the members already disagree on is not one knob; making it a
    // single parameter would quietly rewrite the ones that differ.
    if (entry.values.size !== 1) continue;
    const key = uniqueKey(PARAMETERISABLE_KINDS[entry.kind] ?? fieldKey, taken);
    const [defaultValue] = [...entry.values];
    out.push({
      key,
      label: entry.label,
      type: entry.kind === "select" ? "select" : "string",
      required: true,
      defaultValue: defaultValue!,
      ...(entry.kind === "select" && entry.options ? { options: entry.options } : {}),
    });
  }
  return out;
}

/**
 * Turn a draft into the parameterised document, promoting the chosen fields to
 * parameters. `chosen` names which suggested parameters the user kept.
 */
export function applyChosenParameters(
  draft: CaptureDraft,
  chosen: string[],
): { parameters: EnvironmentParameter[]; members: EnvironmentTemplateMember[] } {
  const keep = new Set(chosen);
  const parameters = draft.suggestedParameters.filter((p) => keep.has(p.key));
  const byLabel = new Map(parameters.map((p) => [p.label, p.key]));

  const members = draft.members.map((member) => {
    const fields: Record<string, TemplateFieldValue> = {};
    for (const [fieldKey, value] of Object.entries(member.fields)) {
      const meta = member.fieldMeta[fieldKey];
      const parameterKey = meta ? byLabel.get(meta.label) : undefined;
      const suggestion = parameters.find((p) => p.key === parameterKey);
      if (
        parameterKey &&
        suggestion &&
        value.kind === "literal" &&
        value.value === suggestion.defaultValue
      ) {
        fields[fieldKey] = { kind: "parameter", parameter: parameterKey };
      } else {
        fields[fieldKey] = value;
      }
    }
    const { fieldMeta: _fieldMeta, ...rest } = member;
    return { ...rest, fields };
  });

  return { parameters, members };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Human countdown for a TTL: "2d 4h", "45m", "expired". */
export function formatTimeRemaining(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const remainderMinutes = minutes % 60;
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}

/** True while an instance still owns cloud resources worth tearing down. */
export function instanceIsLive(instance: Pick<EnvironmentInstance, "status">): boolean {
  return (
    instance.status === "creating" ||
    instance.status === "active" ||
    instance.status === "partial" ||
    instance.status === "tearing-down"
  );
}

// ---------------------------------------------------------------------------
// Bearer helpers
// ---------------------------------------------------------------------------

/** Read the org's templates (`resources:read`). */
export async function fetchEnvironmentTemplates(
  api: CloudFetch,
  orgId: string,
): Promise<EnvironmentTemplateListResponse> {
  const res = await api.org<EnvironmentTemplateListResponse>(orgId, "/environments/templates");
  return res ?? { templates: [] };
}

/** Read the org's instances (`resources:read`). */
export async function fetchEnvironmentInstances(
  api: CloudFetch,
  orgId: string,
): Promise<EnvironmentInstanceListResponse> {
  const res = await api.org<EnvironmentInstanceListResponse>(orgId, "/environments/instances");
  return res ?? { instances: [] };
}

/** Read the org's TTL rails (`resources:read`). */
export async function fetchEnvironmentSettings(
  api: CloudFetch,
  orgId: string,
): Promise<EnvironmentSettings> {
  const res = await api.org<EnvironmentSettings>(orgId, "/environments/settings");
  return normalizeEnvironmentSettings(res);
}

/** Update the org's TTL rails (`org:settings:write`). */
export async function updateEnvironmentSettings(
  api: CloudFetch,
  orgId: string,
  body: EnvironmentSettings,
): Promise<EnvironmentSettings | null> {
  return api.org<EnvironmentSettings>(orgId, "/environments/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Preview a capture without persisting anything (`resources:read`). */
export async function previewEnvironmentCapture(
  api: CloudFetch,
  orgId: string,
  body: { resourceIds?: string[]; accountId?: string; tagKey?: string; tagValue?: string },
): Promise<CaptureDraft | null> {
  return api.org<CaptureDraft>(orgId, "/environments/capture", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Persist a template (`resources:write`). */
export async function createEnvironmentTemplate(
  api: CloudFetch,
  orgId: string,
  body: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate | null> {
  return api.org<EnvironmentTemplate>(orgId, "/environments/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Replace a template (`resources:write`). */
export async function updateEnvironmentTemplate(
  api: CloudFetch,
  orgId: string,
  templateId: string,
  body: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate | null> {
  return api.org<EnvironmentTemplate>(
    orgId,
    `/environments/templates/${encodeURIComponent(templateId)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

/** Remove a template (`resources:write`). Live instances keep running. */
export async function deleteEnvironmentTemplate(
  api: CloudFetch,
  orgId: string,
  templateId: string,
): Promise<void> {
  await api.org(orgId, `/environments/templates/${encodeURIComponent(templateId)}`, {
    method: "DELETE",
  });
}

/** Price an instantiation before it runs (`resources:read`). */
export async function estimateEnvironmentCost(
  api: CloudFetch,
  orgId: string,
  templateId: string,
  body: { parameters?: Record<string, string> },
): Promise<EnvironmentCostEstimate | null> {
  return api.org<EnvironmentCostEstimate>(
    orgId,
    `/environments/templates/${encodeURIComponent(templateId)}/estimate`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Stamp out a copy (`resources:write` **and** `resources:delete` — every
 * instance carries a standing auto-delete, which is the permission the leases
 * API gates that on).
 */
export async function instantiateEnvironment(
  api: CloudFetch,
  orgId: string,
  templateId: string,
  body: EnvironmentInstantiateInput,
): Promise<EnvironmentInstance | null> {
  return api.org<EnvironmentInstance>(
    orgId,
    `/environments/templates/${encodeURIComponent(templateId)}/instantiate`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Tear an instance down now (`resources:delete`). */
export async function tearDownEnvironmentInstance(
  api: CloudFetch,
  orgId: string,
  instanceId: string,
): Promise<EnvironmentInstance | null> {
  return api.org<EnvironmentInstance>(
    orgId,
    `/environments/instances/${encodeURIComponent(instanceId)}/teardown`,
    { method: "POST" },
  );
}

/** Forget a torn-down instance's row (`resources:write`). */
export async function deleteEnvironmentInstance(
  api: CloudFetch,
  orgId: string,
  instanceId: string,
): Promise<void> {
  await api.org(orgId, `/environments/instances/${encodeURIComponent(instanceId)}`, {
    method: "DELETE",
  });
}
