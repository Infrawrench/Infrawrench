/**
 * Setting up a workspace from git.infrawrench.com
 * (`/api/git-workspace-checkout`), the endpoint definitions.
 *
 * Two browser redirects, not a JSON API, like the short username's
 * (`git-username-checkout.ts`). The forge holds no Stripe key and creates no
 * organization, so it sends a person who belongs to none here with a signed
 * token naming them and the organization they asked for (client-core
 * `git-workspace-checkout-token.ts`); `open` checks the token and redirects
 * to the Pro plan's Stripe Checkout page. Stripe sends the browser back to
 * `return`, which creates the organization if the webhook has not already
 * (the same idempotent step) and redirects to the forge.
 *
 * No auth middleware: the token is the authentication on the way out, and the
 * Checkout session's id, which only Stripe and the payer know, on the way
 * back. Neither reads the app's session, because the person may never have
 * signed in to the app. A browser is the only caller, so both stay out of the
 * published document.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { GIT_WORKSPACE_CHECKOUT_PATH } from "@infrawrench/client-core";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";

export class GitWorkspaceCheckoutGroup extends HttpApiGroup.make("gitWorkspaceCheckout")
  .add(
    HttpApiEndpoint.get("open", "/", {
      query: { token: Schema.optional(Schema.String) },
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Open the payment page for a workspace")
      .annotate(Security, []),
    HttpApiEndpoint.get("return", "/return", {
      query: { session_id: Schema.optional(Schema.String) },
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Come back from the payment page")
      .annotate(Security, []),
  )
  .prefix(GIT_WORKSPACE_CHECKOUT_PATH)
  .annotate(OpenApi.Title, "Git")
  .annotate(OpenApi.Exclude, true) {}

export class GitWorkspaceCheckoutApi extends withApiDefaults(
  HttpApi.make("gitWorkspaceCheckout").add(GitWorkspaceCheckoutGroup),
) {}
