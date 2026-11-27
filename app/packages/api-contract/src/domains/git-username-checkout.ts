/**
 * Paying for a short username on git.infrawrench.com
 * (`/api/git-username-checkout`), the endpoint definitions.
 *
 * Two browser redirects, not a JSON API. The forge holds no Stripe key, so it
 * sends a person who chose a short username here with a signed token for the
 * hold it wrote (client-core `git-username-checkout-token.ts`); `open` checks
 * the token and redirects to a Stripe Checkout page. Stripe sends the browser
 * back to `return`, which gives the person the name if the webhook has not
 * already (the same idempotent step) and redirects to the forge.
 *
 * No auth middleware: the token is the authentication on the way out, and the
 * Checkout session's id, which only Stripe and the payer know, on the way
 * back. Neither reads the app's session, because the person may never have
 * signed in to the app. A browser is the only caller, so both stay out of the
 * published document.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { GIT_USERNAME_CHECKOUT_PATH } from "@infrawrench/client-core";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";

export class GitUsernameCheckoutGroup extends HttpApiGroup.make("gitUsernameCheckout")
  .add(
    HttpApiEndpoint.get("open", "/", {
      query: { token: Schema.optional(Schema.String) },
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Open the payment page for a short username")
      .annotate(Security, []),
    HttpApiEndpoint.get("return", "/return", {
      query: { session_id: Schema.optional(Schema.String) },
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Come back from the payment page")
      .annotate(Security, []),
  )
  .prefix(GIT_USERNAME_CHECKOUT_PATH)
  .annotate(OpenApi.Title, "Git")
  .annotate(OpenApi.Exclude, true) {}

export class GitUsernameCheckoutApi extends withApiDefaults(
  HttpApi.make("gitUsernameCheckout").add(GitUsernameCheckoutGroup),
) {}
