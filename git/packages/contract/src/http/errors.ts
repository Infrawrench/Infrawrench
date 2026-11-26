/**
 * The forge API's error responses.
 *
 * The same wire shape as the app's API: a JSON object with an `error`
 * sentence a person can read, here always with room for a machine-readable
 * `code` beside it (`username_taken`, `not_mergeable`), which is what the UI
 * branches on. One `Schema.Error` class per status, no `_tag` on the wire.
 */
import { Schema } from "effect";

const fields = {
  error: Schema.String.annotate({ description: "Human-readable error message" }),
  code: Schema.optionalKey(
    Schema.String.annotate({
      description: "Machine-readable reason, when the client can act on which one it is.",
    }),
  ),
} as const;

const errorAnnotations = (status: number) =>
  ({ httpApiStatus: status, identifier: "Error" }) as const;

export class BadRequest extends Schema.Error<BadRequest>("infrawrench/git/BadRequest")(
  fields,
  errorAnnotations(400),
) {}

/** Nobody is signed in and the endpoint needs someone. */
export class Unauthorized extends Schema.Error<Unauthorized>("infrawrench/git/Unauthorized")(
  fields,
  errorAnnotations(401),
) {}

/** Private repositories and storage follow the organisation's plan. */
export class PaymentRequired extends Schema.Error<PaymentRequired>(
  "infrawrench/git/PaymentRequired",
)(fields, errorAnnotations(402)) {}

/** Signed in, and may see the object, but not do this to it. */
export class Forbidden extends Schema.Error<Forbidden>("infrawrench/git/Forbidden")(
  fields,
  errorAnnotations(403),
) {}

/**
 * Missing, or not visible to the caller. A private repository answers 404 to
 * anyone without read access, never 403, so its existence does not leak.
 */
export class NotFound extends Schema.Error<NotFound>("infrawrench/git/NotFound")(
  fields,
  errorAnnotations(404),
) {}

/** The request lost a race or names something taken (a slug, a branch, a moved head). */
export class Conflict extends Schema.Error<Conflict>("infrawrench/git/Conflict")(
  fields,
  errorAnnotations(409),
) {}

/** Well-formed, but the repository's state refuses it (not mergeable, protected branch). */
export class UnprocessableEntity extends Schema.Error<UnprocessableEntity>(
  "infrawrench/git/UnprocessableEntity",
)(fields, errorAnnotations(422)) {}

export class TooManyRequests extends Schema.Error<TooManyRequests>(
  "infrawrench/git/TooManyRequests",
)(fields, errorAnnotations(429)) {}

export class InternalServerError extends Schema.Error<InternalServerError>(
  "infrawrench/git/InternalServerError",
)(fields, errorAnnotations(500)) {}

/** The repository's storage (its Durable Object or R2) did not answer in time. */
export class ServiceUnavailable extends Schema.Error<ServiceUnavailable>(
  "infrawrench/git/ServiceUnavailable",
)(fields, errorAnnotations(503)) {}

/**
 * The codes the API sends in `code`. A client that does not know one reads
 * `error` instead, so the list only ever grows.
 */
export const ERROR_CODES = [
  "sign_in_required",
  "username_required",
  // git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
  "signups_closed",
  "username_taken",
  "username_reserved",
  "username_invalid",
  "namespace_taken",
  "namespace_already_claimed",
  "name_taken",
  "name_invalid",
  "repository_archived",
  "repository_empty",
  "plan_required",
  "ref_not_found",
  "ref_exists",
  "path_not_found",
  "not_a_file",
  "not_a_directory",
  "too_large",
  "head_moved",
  "not_mergeable",
  "merge_conflict",
  "checks_required",
  "approvals_required",
  "changes_requested",
  "draft",
  "already_merged",
  "protected_branch",
  "merge_method_not_allowed",
  "no_commits_between",
  "pull_request_exists",
  "locked",
  "key_in_use",
  "key_invalid",
  "last_admin",
  "terraform_locked",
  "terraform_unavailable",
  "ci_unavailable",
  "must_fix_findings",
  "not_implemented",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const notFound = (error = "Not found") => new NotFound({ error });
export const badRequest = (error: string, code?: ErrorCode) =>
  new BadRequest(code === undefined ? { error } : { error, code });
export const unauthorized = (error = "Sign in to continue") =>
  new Unauthorized({ error, code: "sign_in_required" });
export const forbidden = (error = "Forbidden", code?: ErrorCode) =>
  new Forbidden(code === undefined ? { error } : { error, code });
export const conflict = (error: string, code?: ErrorCode) =>
  new Conflict(code === undefined ? { error } : { error, code });
export const unprocessable = (error: string, code?: ErrorCode) =>
  new UnprocessableEntity(code === undefined ? { error } : { error, code });

/** An endpoint the contract defines and this server does not serve yet. A 503 with `not_implemented`. */
export const notImplemented = (what: string) =>
  new ServiceUnavailable({ error: `${what} is not available yet`, code: "not_implemented" });

/** What a read may answer: a request that fails its schema, or nothing there for this caller. */
export const ReadErrors = [BadRequest, NotFound] as const;
/** {@link ReadErrors} plus what a write adds: nobody signed in, or not allowed. */
export const WriteErrors = [BadRequest, Unauthorized, Forbidden, NotFound] as const;
