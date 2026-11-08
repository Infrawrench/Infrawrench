/**
 * Endpoint annotations the Infrawrench middlewares and spec builder read.
 *
 * - {@link RequiredPermission} is enforced by `OrgAuth` before the payload is
 *   decoded (a 403 outranks a 400, as `requirePermission` on a handler's first
 *   line always made it) and becomes the operation's `x-required-permission`,
 *   so the documented gate and the enforced gate are the same value.
 * - {@link InvalidRequestMessage} is the `error` of the 400 a payload, query
 *   or path that fails its schema gets ("Invalid budget"), next to the issues.
 * - {@link Internal} marks an operation `x-internal`, stripped from the public
 *   spec like the hand-written spec's internal routes.
 */
import { Context } from "effect";

export const RequiredPermission = Context.Reference<string | undefined>(
  "infrawrench/http/RequiredPermission",
  { defaultValue: () => undefined },
);

export const InvalidRequestMessage = Context.Reference<string>(
  "infrawrench/http/InvalidRequestMessage",
  { defaultValue: () => "Invalid request" },
);

export const Internal = Context.Reference<boolean>("infrawrench/http/Internal", {
  defaultValue: () => false,
});

/**
 * The OpenAPI tag an operation is filed under. Groups are named in code
 * (`budgets`); the document's tags are display names (`Budgets`) that the
 * docs sidebar and every SDK's module names come from.
 */
export const Tag = Context.Reference<string | undefined>("infrawrench/http/Tag", {
  defaultValue: () => undefined,
});

/**
 * An operation's own `security`, for the few that differ from the document's
 * global session-cookie-or-bearer requirement: `[]` for a public route,
 * `[{ bearerAuth: [] }]` for a bearer-only one. Unset inherits the global.
 */
export const Security = Context.Reference<
  ReadonlyArray<Readonly<Record<string, readonly string[]>>> | undefined
>("infrawrench/http/Security", { defaultValue: () => undefined });

/**
 * The description of an operation's success response ("Created", "Budgets").
 * Effect would otherwise use the success schema's own description or
 * identifier; annotating the schema instead would fork its component.
 */
export const SuccessDescription = Context.Reference<string | undefined>(
  "infrawrench/http/SuccessDescription",
  { defaultValue: () => undefined },
);

/**
 * The `x-required-permission` an operation documents when its handler owns the
 * gate (any of several permissions, or one that depends on the body or the
 * caller): stated in the document, not enforced by `OrgAuth`. Prefer
 * {@link RequiredPermission}, which is both.
 */
export const DocumentedPermission = Context.Reference<string | undefined>(
  "infrawrench/http/DocumentedPermission",
  { defaultValue: () => undefined },
);
