/**
 * Scope dimensions for DORA metrics: what a change can be grouped and
 * filtered by. Environment, repository and owner are built in.
 *
 * **Extension point.** Another feature adds a dimension by calling
 * `registerDoraScopeDimension` at module load (a service catalogue registering
 * `service`, mapping each change's resources to the service that owns them).
 * The API takes the dimension id as a free string and lists what is
 * registered, so a new dimension needs no schema, route or UI change: the
 * picker, the breakdown table, the CLI's `--by` and the drill-down all read
 * the registry.
 */
import { DORA_BUILTIN_DIMENSIONS, type DoraScopeValue } from "@infrawrench/client-core";
import { lookupResourceOwners } from "../ownership/store";

/** What a dimension sees of a change. */
export interface DoraScopeSubject {
  id: string;
  type: "deploy" | "resource_change";
  environment: string | null;
  repository: string | null;
  accountId: string | null;
  pluginId: string | null;
  resourceId: string | null;
  targetResourceId: string | null;
}

export interface DoraScopeDimension {
  id: string;
  label: string;
  /**
   * The value each subject takes, by subject id. Called once per report with
   * every subject in the window, so a lookup should batch. A missing entry
   * means "not known", which groups as its own row.
   */
  resolve(
    organizationId: string,
    subjects: DoraScopeSubject[],
  ): Promise<Map<string, DoraScopeValue | null>>;
}

const builtinLabel = (id: string) => DORA_BUILTIN_DIMENSIONS.find((d) => d.id === id)?.label ?? id;

const environmentDimension: DoraScopeDimension = {
  id: "environment",
  label: builtinLabel("environment"),
  async resolve(_org, subjects) {
    const out = new Map<string, DoraScopeValue | null>();
    for (const s of subjects) {
      out.set(
        s.id,
        s.environment ? { key: s.environment.toLowerCase(), label: s.environment } : null,
      );
    }
    return out;
  },
};

const repositoryDimension: DoraScopeDimension = {
  id: "repository",
  label: builtinLabel("repository"),
  async resolve(_org, subjects) {
    const out = new Map<string, DoraScopeValue | null>();
    for (const s of subjects) {
      out.set(s.id, s.repository ? { key: s.repository.toLowerCase(), label: s.repository } : null);
    }
    return out;
  },
};

/**
 * Owner from resource ownership: the deployed thing's owner (the project or
 * service), falling back to the deploy row's own. A member keys by user id so
 * a rename does not split their history; a free-text owner keys by its text.
 */
const ownerDimension: DoraScopeDimension = {
  id: "owner",
  label: builtinLabel("owner"),
  async resolve(organizationId, subjects) {
    const ids = subjects.flatMap((s) =>
      [s.targetResourceId, s.resourceId].filter((x): x is string => !!x),
    );
    const owners = await lookupResourceOwners(organizationId, ids);
    const out = new Map<string, DoraScopeValue | null>();
    for (const s of subjects) {
      const o =
        (s.targetResourceId ? owners.get(s.targetResourceId) : undefined) ??
        (s.resourceId ? owners.get(s.resourceId) : undefined);
      out.set(
        s.id,
        o
          ? {
              key: o.userId ? `user:${o.userId}` : `label:${o.displayName.toLowerCase()}`,
              label: o.displayName,
            }
          : null,
      );
    }
    return out;
  },
};

const registry = new Map<string, DoraScopeDimension>(
  [environmentDimension, repositoryDimension, ownerDimension].map((d) => [d.id, d]),
);

/** Add (or replace) a scope dimension. See the module comment. */
export function registerDoraScopeDimension(dimension: DoraScopeDimension): void {
  registry.set(dimension.id, dimension);
}

export function listDoraScopeDimensions(): DoraScopeDimension[] {
  return [...registry.values()];
}

export function getDoraScopeDimension(id: string): DoraScopeDimension | undefined {
  return registry.get(id);
}
