/**
 * Shared plumbing for the per-domain create handlers.
 *
 * Each domain module (`compute.ts`, `storage.ts`, …) exports a
 * `<domain>GetCreateConfig` and a `<domain>CreateResource`. Both return
 * `null` for a `typeId` they do not own so `../create-handlers.ts` can try the
 * next module; the arms are mutually exclusive, so module order carries no
 * meaning. Leaf module — it must not import from any domain module.
 */
import type {
  CreateResourceConfig,
  ResourceInstance,
  ResourceWarning,
} from "@infrawrench/plugin-base";

export interface DoCreateContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  credentials: Record<string, string>;
}

/**
 * Everything a create branch needs. The wrapper in `../create-handlers.ts`
 * resolves the project-parent plumbing once and hands the same object to every
 * domain module, so a branch reads exactly as it did when they all lived in
 * one function.
 */
export interface DoCreateArgs {
  ctx: DoCreateContext;
  typeId: string;
  accountId: string;
  fields: Record<string, string>;
  parentResourceId: string | undefined;
  /** Collected non-fatal problems, surfaced to the host as `warnings`. */
  warnings: ResourceWarning[];
  /** Written by branches that mint account-wide credentials (Spaces keys). */
  credentialUpdatesRef: { value?: Record<string, string> };
  /**
   * Parent external id (a project UUID, or a domain name for DNS records),
   * recovered from `parentResourceId` or the form's `projectId` field.
   */
  parentExternalId: string;
  /**
   * Synthetic `{accountId}:project:{id}` parent for project-assignable types,
   * so a resource created from the account base still nests under its project.
   */
  effectiveParentId: string;
  /** POST the new resource's URN to its project, warning (not throwing) on failure. */
  assignToProjectIfNeeded(urn: string): Promise<void>;
}

export type GetConfigHandler = (
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
) => Promise<CreateResourceConfig | null>;

export type CreateHandler = (args: DoCreateArgs) => Promise<ResourceInstance | null>;

/**
 * Build a "Project" select field for the create form. Returned as a
 * single-element array so callers can spread it into their fields list
 * (`...projectField`); empty when a `parentResourceId` was already passed
 * in (the form was opened from a project's detail page so the target is
 * implicit) or when the account has no projects at all (DO assigns to
 * the default project automatically). Default option is the project DO
 * marks `is_default`, falling back to the first listed project.
 *
 * The field key is fixed as `projectId` so `doCreateResourceImpl` can
 * resolve it generically: when there's no parentResourceId it reads
 * `fields["projectId"]` as the project to assign to, and synthesizes a
 * matching `parentResourceId` on the returned ResourceInstance so the
 * new resource nests under its project in the sidebar.
 */
export async function buildProjectField(
  ctx: DoCreateContext,
  parentResourceId: string | undefined,
): Promise<CreateResourceConfig["fields"]> {
  if (parentResourceId) return [];
  const projectsData = await ctx
    .fetch<{
      projects?: Array<{ id: string; name: string; is_default?: boolean }> | null;
    }>("/projects")
    .catch(() => null);
  const projects = projectsData?.projects ?? [];
  if (projects.length === 0) return [];
  const options = projects.map((p) => ({
    id: p.id,
    label: p.is_default ? `${p.name} (default)` : p.name,
  }));
  const defaultProjectId = projects.find((p) => p.is_default)?.id ?? options[0]?.id;
  return [
    {
      key: "projectId",
      label: "Project",
      kind: "select" as const,
      required: false,
      options,
      ...(defaultProjectId ? { defaultValue: defaultProjectId } : {}),
      description: "DigitalOcean project to assign this resource to.",
    },
  ];
}
