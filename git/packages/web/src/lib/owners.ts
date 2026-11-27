/**
 * Where the signed-in person can create a repository, and what each of those
 * namespaces takes: read from the session, which carries the namespace's
 * default visibility and whether one more private repository fits its plan.
 */
import type { Session, Visibility } from "@infrawrench/git-contract";

export interface Owner {
  readonly slug: string;
  readonly label: string;
  readonly kind: "user" | "org";
  /** What a new repository here starts as, unless its creator says otherwise. */
  readonly defaultVisibility: Visibility;
  /** Why one more private repository does not fit, in the quota's words. Null when it does. */
  readonly privateRepositoryRefusal: string | null;
}

/** The person's own namespace, then their organisations' where they hold `git:write`. */
export function ownersOf(session: Session): Owner[] {
  const owners: Owner[] = [];
  if (session.user?.username != null) {
    owners.push({
      slug: session.user.username,
      label: session.user.username,
      kind: "user",
      defaultVisibility: session.personal?.defaultVisibility ?? "private",
      privateRepositoryRefusal: session.personal?.privateRepositoryRefusal ?? null,
    });
  }
  for (const organization of session.organizations) {
    if (organization.namespace === null) continue;
    if (!organization.permissions.includes("git:write")) continue;
    owners.push({
      slug: organization.namespace,
      label: `${organization.namespace} (${organization.name})`,
      kind: "org",
      defaultVisibility: organization.defaultVisibility,
      privateRepositoryRefusal: organization.privateRepositories
        ? null
        : (organization.privateRepositoryRefusal ??
          "This organisation's plan includes no more private repositories"),
    });
  }
  return owners;
}

/**
 * What the form's visibility shows: the person's own choice once they have
 * made one, else the namespace's default; never private where it is refused.
 */
export function visibilityFor(owner: Owner, chosen: Visibility | null): Visibility {
  if (owner.privateRepositoryRefusal !== null) return "public";
  return chosen ?? owner.defaultVisibility;
}
