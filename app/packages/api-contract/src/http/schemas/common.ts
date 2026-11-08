/**
 * Schemas shared by every domain's endpoint definitions. A component used by
 * more than one domain is defined once, here: the spec builder fails when two
 * domains define the same component name differently.
 */
import { Predicate, Schema, SchemaTransformation } from "effect";

/**
 * A UUID. Documented, not checked: route params were never validated as
 * UUIDs, so an id that is not one finds nothing (404) rather than a 400, and a
 * stored id is never refused on the way out.
 */
export const Uuid = Schema.String.annotate({
  format: "uuid",
  examples: ["00000000-0000-0000-0000-000000000000"],
});

/**
 * The host's composite resource id, `pluginId:accountId:externalId`.
 * Documented, not checked, like {@link Uuid}: no route ever refused an id for
 * its shape, so one that is not composite finds nothing rather than a 400.
 */
export const ResourceId = Schema.String.check(
  Schema.makeFilter(() => true, {
    toJsonSchema: () => ({ minLength: 1, pattern: "^[^:]+:[^:]+:.+$" }),
  }),
).annotate({
  identifier: "ResourceId",
  description: "Composite id `pluginId:accountId:externalId`.",
  examples: ["gcp:00000000-0000-0000-0000-000000000000:projects/p/instances/i"],
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

/**
 * A free-form JSON object whose shape depends on its source (a plugin's
 * fields, an audit entry's metadata). Any object decodes; the document says
 * `additionalProperties: true` as the hand-written spec did.
 */
export const JsonObject = Schema.Any.pipe(
  Schema.refine(Predicate.isObject, {
    toJsonSchema: () => ({ type: "object", additionalProperties: true }),
  }),
).annotate({
  identifier: "JsonObject",
  description: "Free-form JSON object whose shape depends on the plugin.",
});

/**
 * What an endpoint the spec never documented sends: the service's (or the
 * plugin's) value, unchanged.
 */
export const Undocumented = Schema.Unknown;
