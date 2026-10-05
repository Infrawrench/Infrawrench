/**
 * IdP group → Infrawrench role resolution. Pure, so the preview and the sync
 * provably make the same decision.
 *
 * The rules, in order:
 *
 *  1. **Owners are never touched.** An owner's role is changed by another
 *     owner on the team page or not at all. A directory that could demote an
 *     owner could lock an org out of its own settings; one that could promote
 *     to owner would hand an IdP admin (who is not an Infrawrench owner) the
 *     keys. The mapping routes refuse an owner target for the same reason.
 *  2. **First matching mapping wins**, in `position` order. A member in two
 *     mapped groups gets the role of whichever row is higher in the list, and
 *     the preview flags them as a conflict so that order is a decision
 *     somebody saw.
 *  3. **No match falls back to the default role** (the org's choice, or the
 *     system `member` role when unset). Falling back rather than leaving the
 *     role alone is deliberate: removing someone from the "Platform admins"
 *     group in the IdP has to take admin away here too, or the directory is
 *     only ever able to grant.
 */

export interface GroupRoleMapping {
  id: string;
  directoryGroupId: string;
  groupName: string;
  roleId: string;
  position: number;
  createdAt?: Date | string;
}

export interface RoleResolution {
  /** The role the member should hold. Null only for owners (left alone). */
  roleId: string | null;
  source: "mapping" | "default" | "owner_unchanged";
  /** The mapping that decided it, when one did. */
  mappingId: string | null;
  /** Every mapping whose group the member is in, in evaluation order. */
  matchedMappingIds: string[];
  /** More than one mapping matched and they named different roles. */
  conflict: boolean;
}

/** Mappings in evaluation order: `position`, then creation time, then id. */
export function orderMappings<T extends GroupRoleMapping>(mappings: readonly T[]): T[] {
  return [...mappings].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function resolveDirectoryRole(input: {
  groupIds: readonly string[];
  mappings: readonly GroupRoleMapping[];
  defaultRoleId: string;
  currentIsOwner: boolean;
}): RoleResolution {
  const groups = new Set(input.groupIds);
  const matched = orderMappings(input.mappings).filter((m) => groups.has(m.directoryGroupId));
  const conflict = new Set(matched.map((m) => m.roleId)).size > 1;
  const matchedMappingIds = matched.map((m) => m.id);

  if (input.currentIsOwner) {
    return {
      roleId: null,
      source: "owner_unchanged",
      mappingId: null,
      matchedMappingIds,
      conflict,
    };
  }
  const winner = matched[0];
  if (winner) {
    return {
      roleId: winner.roleId,
      source: "mapping",
      mappingId: winner.id,
      matchedMappingIds,
      conflict,
    };
  }
  return {
    roleId: input.defaultRoleId,
    source: "default",
    mappingId: null,
    matchedMappingIds,
    conflict: false,
  };
}

/**
 * Lower-cased domain of an email address, or null when it has none. The part
 * after the *last* `@`, so a quoted local part containing `@` cannot smuggle a
 * different domain past the check.
 */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/** Whether an email sits inside one of the verified domains (exact match, no subdomains). */
export function isInVerifiedDomains(
  email: string | null | undefined,
  verifiedDomains: readonly string[],
): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return verifiedDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * A bare hostname a person could own, normalised, or null when the input is
 * not one: no scheme, no path, no port, at least one dot, labels of letters,
 * digits and hyphens.
 */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, "");
  if (d.length < 3 || d.length > 253) return null;
  if (
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(d)
  ) {
    return null;
  }
  return d;
}
