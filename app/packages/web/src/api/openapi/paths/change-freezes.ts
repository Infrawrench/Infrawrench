import { z } from "../zod";
import { strict, Uuid, IsoDateTime } from "../common";

/**
 * Body of the 423 returned when an active change freeze blocks a destructive
 * mutation, for the routes still documented here (resource deletion,
 * destructive invoke-action calls, secret-version destroys, deployment
 * rollbacks). The change-freeze endpoints themselves, and the HttpApi
 * endpoints behind the gate, are `http/domains/change-freezes` and
 * `http/schemas/change-freeze.ts`, which define the same component. Callers
 * holding `freezes:override` may retry with the
 * `x-change-freeze-override: true` header; the override is audit-logged.
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
