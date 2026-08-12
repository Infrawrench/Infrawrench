/**
 * Template-document judgement: name slugging and prefixing, dependency
 * ordering, document and parameter validation, and the TTL/settings rails.
 * Shared verbatim by the editor and the API boundary, so the form and the
 * server cannot disagree about what a valid template is.
 */
import type {
  EnvironmentSettings,
  EnvironmentTemplate,
  EnvironmentTemplateInput,
  EnvironmentTemplateMember,
} from "./types";
import { ENVIRONMENT_LIMITS } from "./types";

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
 * Parse an hours input field into a number, or null for "unanswered".
 *
 * The guard every TTL text input shares: `Number("")` is 0 and
 * `Number("abc")` is NaN, and storing either silently ships a value the user
 * never typed. Null keeps the field visibly empty and the form invalid.
 */
export function parseTtlDraft(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
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
