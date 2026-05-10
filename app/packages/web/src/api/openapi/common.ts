import { z } from "./zod";

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

export const ResourceStatus = z
  .enum(["healthy", "warning", "error", "unknown", "pending", "stopped"])
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

/** Common header shared by every error response slot in this spec. */
export const ErrorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
  401: {
    description: "Unauthenticated",
    content: { "application/json": { schema: ErrorResponse } },
  },
  403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponse } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  500: { description: "Server error", content: { "application/json": { schema: ErrorResponse } } },
} as const;
