/**
 * The WorkOS sign-in callback, `GET /callback`, the endpoint definition.
 *
 * Public and browser-only: WorkOS redirects here with `code` and the `state`
 * nonce the sign-in route put in a cookie. The handler answers every input
 * itself (a missing code is a plain-text 400, a provider error or a second
 * failed state check an HTML page), so the query is documented, never
 * decoded. Internal in the published spec (`openapi/public-spec.ts`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { describeResponse, requiredQuery } from "../http/schemas/documented";
import { undecodedQuery } from "../http/schemas/raw-query";

const CallbackQuery = {
  code: undecodedQuery(Schema.String.annotate({ description: "Authorization code from WorkOS" })),
  state: undecodedQuery(
    Schema.String.annotate({ description: "CSRF nonce echoed back by WorkOS" }),
  ),
  error: undecodedQuery(
    Schema.String.annotate({
      description: "Error code WorkOS sends instead of `code` when sign-in failed on its side",
    }),
  ),
  error_description: undecodedQuery(
    Schema.String.annotate({ description: "Human-readable detail accompanying `error`" }),
  ),
};

const SignInFailedText = Schema.String.pipe(HttpApiSchema.status(400), HttpApiSchema.asText());
const SignInFailedPage = Schema.String.pipe(
  HttpApiSchema.status(400),
  HttpApiSchema.asText({ contentType: "text/html" }),
);
const SealFailed = Schema.String.pipe(HttpApiSchema.status(500), HttpApiSchema.asText());

export class CallbackGroup extends HttpApiGroup.make("callback")
  .add(
    HttpApiEndpoint.get("callback", "/callback", {
      query: CallbackQuery,
      success: HttpApiSchema.Empty(302),
      error: [SignInFailedText, SignInFailedPage, SealFailed],
    })
      .annotate(OpenApi.Summary, "WorkOS OAuth callback")
      .annotate(
        OpenApi.Description,
        "Exchanges an authorization code for a session and sets the `wos-session` cookie. " +
          "If the `state` nonce does not match the cookie set at sign-in (most often because " +
          "the cookie expired while the user was still on AuthKit) the flow is restarted once " +
          "with a fresh nonce rather than failing. Public.",
      )
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(
          302,
          "Redirect to `/`, or back to sign-in to restart a failed state check",
        )(
          describeResponse(
            400,
            "Missing code, a provider error redirect (`error` present), or a state check " +
              "that already failed its one restart",
          )(describeResponse(500, "Failed to seal session")(requiredQuery(["code"])(operation))),
        ),
      ),
  )
  .annotate(OpenApi.Title, "Auth") {}

export class CallbackApi extends withApiDefaults(HttpApi.make("callback").add(CallbackGroup)) {}
