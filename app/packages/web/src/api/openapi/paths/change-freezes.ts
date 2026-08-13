import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ChangeFreezeInput = strict({
  name: z.string().min(1).max(120),
  reason: z.string().max(2000).optional(),
  /** Defaults to now. */
  startsAt: IsoDateTime.optional(),
  /** Omit for an open-ended freeze that holds until an admin ends it. */
  endsAt: IsoDateTime.optional(),
}).openapi("ChangeFreezeInput");

const ChangeFreeze = strict({
  id: Uuid,
  name: z.string(),
  reason: z.string().nullable(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime.nullable(),
  active: z.boolean(),
  createdByUserId: z.string().nullable(),
  endedByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("ChangeFreeze");

const ChangeFreezeStatus = strict({
  freeze: ChangeFreeze.nullable().openapi({
    description: "The freeze currently in effect, or null when changes are allowed.",
  }),
}).openapi("ChangeFreezeStatus");

/**
 * Body of the 423 returned when an active change freeze blocks a destructive
 * mutation. Shared by resource deletion, destructive invoke-action calls,
 * secret-version destroys, and deployment rollbacks. Callers holding
 * `freezes:override` may retry with the `x-change-freeze-override: true`
 * header; the override is audit-logged.
 */
const ChangeFreezeBlocked = strict({
  error: z.string(),
  code: z.literal("change_freeze_active"),
  freeze: strict({
    id: Uuid,
    name: z.string(),
    reason: z.string().nullable(),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime.nullable(),
  }),
}).openapi("ChangeFreezeBlocked");

/** 423 response slot for operations gated by the org change freeze. */
export const FreezeLockedResponse = {
  description:
    "Blocked by an active change freeze. Retry with the `x-change-freeze-override: true` header if you hold `freezes:override`; both blocks and overrides are audit-logged.",
  content: { "application/json": { schema: ChangeFreezeBlocked } },
} as const;

export function registerChangeFreezePaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/change-freezes",
    tags: ["Change Freezes"],
    summary: "List change freeze windows, newest first",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Freeze windows",
        content: { "application/json": { schema: z.array(ChangeFreeze) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/change-freezes/status",
    tags: ["Change Freezes"],
    summary: "The freeze currently in effect, if any",
    description:
      "Returns the active freeze window (active, started, not yet past its end time) or `freeze: null`. Clients poll this to show the freeze banner and pre-warn before destructive actions.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Current freeze status",
        content: { "application/json": { schema: ChangeFreezeStatus } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/change-freezes",
    tags: ["Change Freezes"],
    summary: "Declare a change freeze window",
    description:
      "While the freeze is in effect, destructive actions (resource deletion, destructive plugin actions, secret-version destroys, deployment rollbacks) return `423` unless explicitly overridden by a caller with `freezes:override`.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ChangeFreezeInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: ChangeFreeze } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/change-freezes/{id}",
    tags: ["Change Freezes"],
    summary: "Update a change freeze window",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: ChangeFreezeInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: ChangeFreeze } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/change-freezes/{id}/end",
    tags: ["Change Freezes"],
    summary: "End a change freeze now",
    request: { params: idParam },
    responses: {
      200: { description: "Ended", content: { "application/json": { schema: ChangeFreeze } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/change-freezes/{id}",
    tags: ["Change Freezes"],
    summary: "Delete a change freeze window",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
