/**
 * The 423 an active change freeze answers a destructive mutation with.
 * Shared by every endpoint behind the freeze gate (`../change-freeze.ts`):
 * environment instantiation and teardown today, resource deletion,
 * destructive actions, secret-version destroys and rollbacks as they move.
 */
import { Schema } from "effect";
import { IsoDateTime, Uuid } from "./common";

export class ChangeFreezeBlocked extends Schema.Error<ChangeFreezeBlocked>(
  "infrawrench/http/ChangeFreezeBlocked",
)(
  {
    error: Schema.String,
    code: Schema.Literal("change_freeze_active"),
    freeze: Schema.Struct({
      id: Uuid,
      name: Schema.String,
      reason: Schema.NullOr(Schema.String),
      startsAt: IsoDateTime,
      endsAt: Schema.NullOr(IsoDateTime),
    }),
  },
  {
    httpApiStatus: 423,
    identifier: "ChangeFreezeBlocked",
    description:
      "Blocked by an active change freeze. Retry with the `x-change-freeze-override: true` header if you hold `freezes:override`; both blocks and overrides are audit-logged.",
  },
) {}
