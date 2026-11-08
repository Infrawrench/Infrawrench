/**
 * The permission and role vocabulary, shared by every domain that documents a
 * permission string (team roles, API key scopes, ...).
 */
import { Predicate, Schema } from "effect";
import { ALL_PERMISSIONS } from "@infrawrench/server-core/permissions/catalog";

/**
 * A permission string. Documented as the catalog's enum, decoded as any
 * string: a role or key may hold a wildcard (`resources:*:read`, `*`), which
 * the enum cannot list, and the routes always accepted one. The enum is read
 * when the document is built, not at import.
 */
export const Permission = Schema.Any.pipe(
  Schema.refine(Predicate.isString, {
    toJsonSchema: () => ({ type: "string", enum: [...ALL_PERMISSIONS] }),
  }),
).annotate({
  identifier: "Permission",
  description:
    "A permission string. Roles may grant exact permissions like the entries in this enum, or wildcards (e.g. `resources:*:read`, `*`).",
});

/** The legacy text role on a membership or invitation. */
export const OrganizationRole = Schema.Literals(["owner", "admin", "member"]).annotate({
  identifier: "OrganizationRole",
});
