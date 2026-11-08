/**
 * Schemas shared by every domain's endpoint definitions. A component used by
 * more than one domain is defined once, here: the spec builder fails when two
 * domains define the same component name differently.
 */
import { Schema, SchemaTransformation } from "effect";

/**
 * A UUID. Documented, not checked: route params were never validated as
 * UUIDs, so an id that is not one finds nothing (404) rather than a 400, and a
 * stored id is never refused on the way out.
 */
export const Uuid = Schema.String.annotate({
  format: "uuid",
  examples: ["00000000-0000-0000-0000-000000000000"],
});

/** An ISO-8601 timestamp the service already holds as a string. */
export const IsoDateTime = Schema.String.annotate({ format: "date-time" });

/**
 * A timestamp the service holds as a `Date` (a Drizzle `timestamp` column),
 * sent as ISO-8601. Declared as the string it is on the wire, decoding to a
 * `Date`, so the document carries the `date-time` format.
 */
export const IsoDate = IsoDateTime.pipe(
  Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString),
);

export const Email = Schema.String.annotate({ format: "email" });

/** `{ ok: true }`, what every delete and fire-and-forget write answers. */
export const Ok = Schema.Struct({ ok: Schema.Literal(true) }).annotate({ identifier: "Ok" });
export const ok = { ok: true } as const;

/** `:orgId` on the org tree. */
export const OrgId = Uuid.annotate({ description: "Organization id" });

/** Path params of an org-tree endpoint with nothing else in its path. */
export const OrgParams = { orgId: OrgId } as const;

/** Path params of an org-tree endpoint addressing one object by `:id`. */
export const OrgIdParams = { orgId: OrgId, id: Uuid } as const;
