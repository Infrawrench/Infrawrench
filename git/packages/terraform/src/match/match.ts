import type { StateResourceInstance } from "./state-resources.js";

/**
 * Tying the resources in a workspace's state to the organisation's
 * Infrawrench resources, so a resource page can say which repository and path
 * manage it and a workspace can list what it manages.
 *
 * **No provider is named here.** What a state entry would have to look like
 * to be a given Infrawrench resource is something only that resource's plugin
 * knows, and plugins already say it: `terraformExport.mapResource` gives the
 * Terraform type a resource maps to and the `importId` Terraform knows it by.
 * The caller (server-core) runs that mapper over the inventory and hands the
 * answers in as {@link InventoryCandidate}s; this only compares them.
 *
 * The rules are IaC reconciliation's (`client-core/src/iac/reconcile.ts`), so
 * the forge and the app's IaC tab never disagree about a resource:
 *
 * - Identity first: the plugin's import id, then the resource's external id.
 * - Qualified by Terraform type where the plugin gives one. An id that two
 *   resource types share is then no match across them.
 * - Where the plugin gives no type, an identifier must resolve to exactly one
 *   state entry. Two candidates are a coincidence, not a match.
 * - An entry is matched once.
 */

export interface InventoryCandidate {
  /** The Infrawrench resource id (`<accountId>:<typeId>:<externalId>`). */
  readonly resourceId: string;
  /** The Terraform type the plugin maps this resource to, or null when it has no mapping. */
  readonly terraformType: string | null;
  /** The id `terraform import` takes for it, from the plugin's mapper. */
  readonly importId: string | null;
  /** The provider's own id for the resource, as the plugin synced it. */
  readonly externalId: string | null;
}

export type MatchBasis = "import-id" | "external-id" | "identifier";

export interface ResourceLink {
  readonly address: string;
  readonly resourceId: string;
  readonly terraformType: string;
  /** How the two were tied, so a link can be argued with. */
  readonly matchedBy: MatchBasis;
}

export interface MatchResult {
  readonly links: readonly ResourceLink[];
  /** State entries no inventory resource matched: not synced, or from an unconnected account. */
  readonly unmatched: readonly StateResourceInstance[];
}

function typedKey(type: string, identifier: string): string {
  return `${type}\u0000${identifier}`;
}

export function matchStateToInventory(
  instances: readonly StateResourceInstance[],
  inventory: readonly InventoryCandidate[],
): MatchResult {
  const byTypedIdentity = new Map<string, StateResourceInstance[]>();
  const byIdentity = new Map<string, StateResourceInstance[]>();
  const add = (
    map: Map<string, StateResourceInstance[]>,
    key: string,
    instance: StateResourceInstance,
  ) => {
    const list = map.get(key);
    if (list) list.push(instance);
    else map.set(key, [instance]);
  };
  for (const instance of instances) {
    for (const identifier of instance.identifiers) {
      add(byTypedIdentity, typedKey(instance.type, identifier), instance);
      add(byIdentity, identifier, instance);
    }
  }

  const consumed = new Set<StateResourceInstance>();
  const links: ResourceLink[] = [];
  // Sorted so the same state and inventory always link the same way, whatever
  // order the inventory was read in.
  const ordered = [...inventory].sort((a, b) =>
    a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
  );

  for (const candidate of ordered) {
    const identifiers: { value: string; basis: MatchBasis }[] = [];
    if (candidate.importId) {
      identifiers.push({ value: candidate.importId.toLowerCase(), basis: "import-id" });
    }
    if (candidate.externalId) {
      const value = candidate.externalId.toLowerCase();
      if (!identifiers.some((known) => known.value === value)) {
        identifiers.push({ value, basis: "external-id" });
      }
    }

    for (const identifier of identifiers) {
      let match: StateResourceInstance | undefined;
      let matchedBy: MatchBasis = identifier.basis;
      if (candidate.terraformType !== null) {
        const pool = byTypedIdentity.get(typedKey(candidate.terraformType, identifier.value));
        match = pool?.find((instance) => !consumed.has(instance));
      } else {
        const free = (byIdentity.get(identifier.value) ?? []).filter(
          (instance) => !consumed.has(instance),
        );
        if (free.length === 1) {
          match = free[0];
          matchedBy = "identifier";
        }
      }
      if (match) {
        consumed.add(match);
        links.push({
          address: match.address,
          resourceId: candidate.resourceId,
          terraformType: match.type,
          matchedBy,
        });
        break;
      }
    }
  }

  links.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { links, unmatched: instances.filter((instance) => !consumed.has(instance)) };
}
