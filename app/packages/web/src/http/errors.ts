/**
 * The API's error responses, as Effect schemas.
 *
 * Every error this API has ever sent is a JSON object with an `error` string,
 * sometimes with a machine-readable `code` or a list of validation `issues`
 * beside it. Clients read `error` (the SDKs, the Terraform provider's error
 * hints, the web and desktop toasts), so the wire shape stays exactly that:
 * these are `Schema.Error` classes with no `_tag` on the wire, one per status.
 *
 * Each carries `identifier: "Error"` so the OpenAPI document keeps pointing
 * every error slot at the one `Error` component it always has.
 */
import { Schema } from "effect";

const message = Schema.String.annotate({ description: "Human-readable error message" });

/**
 * One `Error` component for every status: the response descriptions ("Bad
 * request", "Not found") are the spec builder's, keyed by status, so the
 * classes stay structurally identical and collapse into the one component.
 */
const errorAnnotations = (status: number) =>
  ({ httpApiStatus: status, identifier: "Error" }) as const;

export class BadRequest extends Schema.Error<BadRequest>("infrawrench/http/BadRequest")(
  { error: message },
  errorAnnotations(400),
) {}

export class Unauthorized extends Schema.Error<Unauthorized>("infrawrench/http/Unauthorized")(
  { error: message },
  errorAnnotations(401),
) {}

export class PaymentRequired extends Schema.Error<PaymentRequired>(
  "infrawrench/http/PaymentRequired",
)({ error: message }, errorAnnotations(402)) {}

export class Forbidden extends Schema.Error<Forbidden>("infrawrench/http/Forbidden")(
  { error: message },
  errorAnnotations(403),
) {}

export class NotFound extends Schema.Error<NotFound>("infrawrench/http/NotFound")(
  { error: message },
  errorAnnotations(404),
) {}

export class Conflict extends Schema.Error<Conflict>("infrawrench/http/Conflict")(
  { error: message },
  errorAnnotations(409),
) {}

/** What was there is gone for good (an expired download), unlike a 404's never-was. */
export class Gone extends Schema.Error<Gone>("infrawrench/http/Gone")(
  { error: message },
  errorAnnotations(410),
) {}

/** A well-formed request the server cannot act on (a widget kind this version does not know, ...). */
export class UnprocessableEntity extends Schema.Error<UnprocessableEntity>(
  "infrawrench/http/UnprocessableEntity",
)({ error: message }, errorAnnotations(422)) {}

export class InternalServerError extends Schema.Error<InternalServerError>(
  "infrawrench/http/InternalServerError",
)({ error: message }, errorAnnotations(500)) {}

/** An upstream provider (Slack, Jira, a cloud API) failed the call this route made. */
export class BadGateway extends Schema.Error<BadGateway>("infrawrench/http/BadGateway")(
  { error: message },
  errorAnnotations(502),
) {}

/** An upstream service (a warehouse, a provider API) took longer than this route waits. */
export class GatewayTimeout extends Schema.Error<GatewayTimeout>("infrawrench/http/GatewayTimeout")(
  { error: message },
  errorAnnotations(504),
) {}

export class ServiceUnavailable extends Schema.Error<ServiceUnavailable>(
  "infrawrench/http/ServiceUnavailable",
)({ error: message }, errorAnnotations(503)) {}

/** `Not found`, the body every missing-row 404 in this API has always had. */
export const notFound = (error = "Not found") => new NotFound({ error });
export const badRequest = (error: string) => new BadRequest({ error });
export const forbidden = (error: string) => new Forbidden({ error });
export const conflict = (error: string) => new Conflict({ error });

/**
 * The error slots most endpoints declare. Spread into an endpoint's `error`
 * list; the OpenAPI document then lists the same statuses the hand-written
 * spec did.
 */
export const StandardErrors = [BadRequest, Unauthorized, Forbidden, NotFound] as const;

/**
 * An already-shaped error response that is not one of the classes above, such
 * as the auth chain's refusals, which keep whatever status and body the
 * original middleware sent.
 */
export class HttpFailure extends Error {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super(typeof body["error"] === "string" ? body["error"] : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
