import { z } from "./zod";
import { ALL_PERMISSIONS } from "@infrawrench/server-core/permissions";

/** Strict object helper — refuses unknown properties. */
export const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const Uuid = z
  .string()
  .uuid()
  .openapi({ format: "uuid", example: "00000000-0000-0000-0000-000000000000" });
export const IsoDateTime = z.string().datetime({ offset: true }).openapi({ format: "date-time" });
export const Email = z.string().email().openapi({ format: "email" });

export const Ok = strict({ ok: z.literal(true) }).openapi("Ok");

export const ErrorResponse = strict({
  error: z.string().openapi({ description: "Human-readable error message" }),
}).openapi("Error");

export const Role = z.enum(["owner", "admin", "member"]).openapi("OrganizationRole");

/**
 * Catalog of permission strings recognised by the server. Granted permissions
 * stored on roles or API keys may also use wildcards (e.g. `resources:*:read`
 * or `*`); see the per-operation `x-required-permission` extension for what
 * each endpoint checks.
 */
type PermissionEnumTuple = readonly [
  (typeof ALL_PERMISSIONS)[number],
  ...(typeof ALL_PERMISSIONS)[number][],
];
export const Permission = z.enum(ALL_PERMISSIONS as PermissionEnumTuple).openapi("Permission", {
  description:
    "A permission string. Roles may grant exact permissions like the entries in this enum, or wildcards (e.g. `resources:*:read`, `*`).",
});

export const ResourceStatus = z
  .enum(["healthy", "degraded", "error", "unknown", "provisioning", "info"])
  .openapi("ResourceStatus", {
    description: "Normalized status reported by a plugin's renderSidebarItem/renderDetail.",
  });

/** Path param schemas for the org-scoped router. */
export const OrgIdParam = strict({
  orgId: Uuid.openapi({ param: { name: "orgId", in: "path" }, description: "Organization id" }),
});

/**
 * A free-form JSON value — used where plugins return arbitrary fields/outputs.
 * We don't model the recursion in OpenAPI (it doesn't help generated clients
 * and confuses zod-to-openapi); just declare it as `additionalProperties: true`.
 */
export const JsonObject = z.record(z.unknown()).openapi("JsonObject", {
  type: "object",
  additionalProperties: true,
  description: "Free-form JSON object whose shape depends on the plugin.",
});

/** Encoded resource id used by the host: `<pluginId>:<accountId>:<externalId>`. */
export const ResourceId = z
  .string()
  .min(1)
  .regex(/^[^:]+:[^:]+:.+$/)
  .openapi("ResourceId", {
    description: "Composite id `pluginId:accountId:externalId`.",
    example: "gcp:00000000-0000-0000-0000-000000000000:projects/p/instances/i",
  });

/**
 * The 403 returned by routes that require a recent sign-in rather than merely
 * a valid session (see `auth/step-up.ts`). Distinguished from a plain 403 by
 * the `code` field so clients can re-authenticate and retry instead of
 * reporting a permanent authorization failure.
 */
export const ReauthenticationRequiredResponse = strict({
  error: z.string().openapi({ description: "Human-readable error message" }),
  code: z.literal("reauthentication_required"),
}).openapi("ReauthenticationRequired");

/** Common header shared by every error response slot in this spec. */
export const ErrorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
  401: {
    description: "Unauthenticated",
    content: { "application/json": { schema: ErrorResponse } },
  },
  403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
  /**
   * The organization's plan does not include this feature. Distinct from `403`,
   * which means the caller lacks a permission — this is about the plan, and the
   * fix is billing rather than a role change.
   */
  402: {
    description: "Payment required — the organization's plan does not include this",
    content: { "application/json": { schema: ErrorResponse } },
  },
  /** Use in place of `403` on step-up-protected routes. */
  reauth: {
    description:
      "Recent sign-in required. Send the user through sign-in again and retry; the request itself was well-formed.",
    content: { "application/json": { schema: ReauthenticationRequiredResponse } },
  },
  404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  /** The resource is busy — e.g. a deploy to this environment is already running. */
  409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
  500: { description: "Server error", content: { "application/json": { schema: ErrorResponse } } },
} as const;
