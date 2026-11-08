/**
 * The public alert-email unsubscribe link in every alert email
 * (`/api/alert-email/unsubscribe?t=`), the endpoint definitions.
 *
 * No auth middleware: the HMAC-signed token in the URL is the whole
 * authorization, and all it can do is stop mail to the one address it names.
 * The GET only renders a confirmation page (link scanners and mail previewers
 * fetch every URL in a message, and must not unsubscribe anyone), and the
 * POST does the work, which is also exactly what an RFC 8058 one-click
 * `List-Unsubscribe-Post` sends. Both answer HTML, an invalid token included,
 * so the token is read by hand rather than refused by a decoder. The path is
 * in the public spec's withheld list, so both operations are `x-internal`.
 *
 * The org-scoped half (the recipient picker's options, the external-address
 * policy and the suppression list) is `../alert-email`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { describeResponse } from "../../schemas/documented";

const HtmlPage = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" }));

const InvalidTokenPage = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/html" }),
  HttpApiSchema.status(400),
);

/**
 * The document's `t` parameter. Declared here rather than as a `query`
 * schema, because the handler reads the first `t` from the URL as Hono's
 * `c.req.query("t")` did, and every answer is an HTML page: a decoder would
 * refuse a repeated `t` with the JSON 400 instead.
 */
const TOKEN_PARAMETER = {
  schema: { type: "string" },
  required: true,
  name: "t",
  in: "query",
} as const;

const documentUnsubscribe = (operation: Record<string, unknown>) => {
  const parameters = Array.isArray(operation["parameters"]) ? operation["parameters"] : [];
  return describeResponse(
    400,
    "Invalid token",
  )({ ...operation, parameters: [...parameters, TOKEN_PARAMETER] });
};

export class AlertEmailUnsubscribeGroup extends HttpApiGroup.make("alertEmailUnsubscribe")
  .add(
    HttpApiEndpoint.get("confirm", "/unsubscribe", {
      success: HtmlPage,
      error: InvalidTokenPage,
    })
      .annotate(OpenApi.Summary, "Unsubscribe confirmation page (from an alert email)")
      .annotate(SuccessDescription, "An HTML page")
      .annotate(Security, [])
      .annotate(OpenApi.Transform, documentUnsubscribe),
    HttpApiEndpoint.post("unsubscribe", "/unsubscribe", {
      success: HtmlPage,
      error: InvalidTokenPage,
    })
      .annotate(OpenApi.Summary, "Unsubscribe an address from alert email (RFC 8058 one-click)")
      .annotate(SuccessDescription, "An HTML page")
      .annotate(Security, [])
      .annotate(OpenApi.Transform, documentUnsubscribe),
  )
  .prefix("/api/alert-email")
  .annotate(OpenApi.Title, "Alerts") {}

export class AlertEmailUnsubscribeApi extends withApiDefaults(
  HttpApi.make("alertEmailUnsubscribe").add(AlertEmailUnsubscribeGroup),
) {}
