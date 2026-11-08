/**
 * Change freezes: `/api/org/:orgId/change-freezes`, the endpoint definitions.
 *
 * The write body is decoded here exactly as the route's zod schema did: a
 * strict object (an unknown key is refused), the same length bounds, and
 * timestamps in the shape zod's `datetime({ offset: true })` accepted. Any
 * failure is the one sentence the route always sent, "Invalid freeze window".
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

/**
 * zod 3's `datetime({ offset: true })`: a calendar-valid date (leap days
 * included), `T`, `HH:MM` with optional seconds and fraction, then `Z` or an
 * offset. Not exported to the document, which says `format: date-time` as
 * the zod spec did; without the `u` flag `isPattern` leaves it out.
 */
const ZOD_OFFSET_DATETIME = new RegExp(
  "^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|" +
    "\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|" +
    "(02)-(0[1-9]|1\\d|2[0-8])))" +
    "T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z|([+-]\\d{2}:?\\d{2}))$",
);

const OffsetDateTime = IsoDateTime.check(Schema.isPattern(ZOD_OFFSET_DATETIME));

const ChangeFreezeInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(120)),
  reason: Schema.optionalKey(Schema.String.check(maxLength(2000))),
  /** Defaults to now. */
  startsAt: Schema.optionalKey(OffsetDateTime),
  /** Omit for an open-ended freeze that holds until an admin ends it. */
  endsAt: Schema.optionalKey(OffsetDateTime),
}).annotate({ identifier: "ChangeFreezeInput" });

export const ChangeFreeze = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  reason: Schema.NullOr(Schema.String),
  startsAt: IsoDateTime,
  endsAt: Schema.NullOr(IsoDateTime),
  active: Schema.Boolean,
  createdByUserId: Schema.NullOr(Schema.String),
  endedByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "ChangeFreeze" });

export const ChangeFreezeStatus = Schema.Struct({
  freeze: Schema.NullOr(ChangeFreeze).annotate({
    description: "The freeze currently in effect, or null when changes are allowed.",
  }),
}).annotate({ identifier: "ChangeFreezeStatus" });

/** The zod schema was `.strict()`: a key it does not list is refused, not dropped. */
const strictBody = { errors: "all", onExcessProperty: "error" } as const;

export class ChangeFreezesGroup extends HttpApiGroup.make("changeFreezes")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(ChangeFreeze),
    })
      .annotate(RequiredPermission, "freezes:read")
      .annotate(OpenApi.Summary, "List change freeze windows, newest first")
      .annotate(SuccessDescription, "Freeze windows"),
    HttpApiEndpoint.get("status", "/status", {
      params: OrgParams,
      success: ChangeFreezeStatus,
    })
      .annotate(RequiredPermission, "freezes:read")
      .annotate(OpenApi.Summary, "The freeze currently in effect, if any")
      .annotate(
        OpenApi.Description,
        "Returns the active freeze window (active, started, not yet past its end time) or `freeze: null`. Clients poll this to show the freeze banner and pre-warn before destructive actions.",
      )
      .annotate(SuccessDescription, "Current freeze status"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ChangeFreezeInput,
      success: ChangeFreeze,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "freezes:write")
      .annotate(OpenApi.Summary, "Declare a change freeze window")
      .annotate(
        OpenApi.Description,
        "While the freeze is in effect, destructive actions (resource deletion, destructive plugin actions, secret-version destroys, deployment rollbacks) return `423` unless explicitly overridden by a caller with `freezes:override`.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid freeze window")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: ChangeFreezeInput,
      success: ChangeFreeze,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "freezes:write")
      .annotate(OpenApi.Summary, "Update a change freeze window")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid freeze window")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.post("end", "/:id/end", {
      params: OrgIdParams,
      success: ChangeFreeze,
      error: NotFound,
    })
      .annotate(RequiredPermission, "freezes:write")
      .annotate(OpenApi.Summary, "End a change freeze now")
      .annotate(SuccessDescription, "Ended"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "freezes:write")
      .annotate(OpenApi.Summary, "Delete a change freeze window")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/change-freezes")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Change Freezes") {}

export class ChangeFreezesApi extends withApiDefaults(
  HttpApi.make("change-freezes").add(ChangeFreezesGroup),
) {}
