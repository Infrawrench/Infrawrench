/**
 * `/api/session`: who is signed in, and the username a first sign-in picks.
 *
 * Signing in is a browser redirect, not an API call: `/auth/sign-in` sends
 * the browser to WorkOS AuthKit and `/auth/callback` sets the session cookie
 * (`urls.ts`). A person who has signed in but not yet claimed a username can
 * read everything a signed-out visitor can; anything that writes answers 403
 * `username_required` until they claim one.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiresUser, SuccessDescription } from "../http/annotations";
import { Authentication } from "../http/auth";
import { BadRequest, Conflict, Forbidden, PaymentRequired, TooManyRequests } from "../http/errors";
import {
  NamespaceRef,
  PersonalWorkspace,
  Session,
  UsernameAvailability,
  UsernameCheckout,
  UsernameCheckoutStart,
  WorkspaceCheckoutStart,
} from "../schemas/people";

const UsernameBody = Schema.Struct({
  username: Schema.String.annotate({
    description: "Letters, digits, dots, dashes and underscores (`names.ts`). Case is kept.",
  }),
});

export class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("me", "/", { success: Session })
      .annotate(OpenApi.Summary, "The signed-in person, or null")
      .annotate(
        OpenApi.Description,
        "Never a 401: a signed-out browser gets `user: null` and the sign-in URL.",
      )
      .annotate(SuccessDescription, "The session"),
    HttpApiEndpoint.post("signOut", "/sign-out", {
      success: Schema.Struct({
        ok: Schema.Literal(true),
        redirectTo: Schema.String.annotate({
          description: "Where to send the browser to end the WorkOS session too.",
        }),
      }),
    })
      .annotate(OpenApi.Summary, "Sign out")
      .annotate(OpenApi.Description, "Clears the session cookie. Idempotent.")
      .annotate(SuccessDescription, "Signed out"),
    HttpApiEndpoint.get("usernameAvailability", "/username-availability", {
      query: { username: Schema.String },
      success: UsernameAvailability,
      error: TooManyRequests,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Whether a username can be claimed")
      .annotate(SuccessDescription, "Availability"),
    HttpApiEndpoint.post("claimUsername", "/username", {
      payload: Schema.Struct({
        ...UsernameBody.fields,
        workspaceOrganizationId: Schema.optional(Schema.NullOr(Schema.String)).annotate({
          description:
            "The organisation the person's own repositories run CI and review agents in: one they belong to. Null or left out for none; `setWorkspace` changes it later.",
        }),
      }),
      success: Schema.Struct({ namespace: NamespaceRef }),
      error: [BadRequest, Conflict, Forbidden, PaymentRequired],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Claim a username")
      .annotate(
        OpenApi.Description,
        "Creates the person's namespace. 409 `username_taken` when someone has it, 409 `namespace_already_claimed` when the person already has one (use `renameUsername`). 403 `not_a_member` when `workspaceOrganizationId` is not an organisation of theirs (nothing is claimed). 402 `username_payment_required` for a username of 6 characters or fewer, which is paid for once (`startUsernameCheckout`).",
      )
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.put("renameUsername", "/username", {
      payload: UsernameBody,
      success: Schema.Struct({ namespace: NamespaceRef }),
      error: [BadRequest, Conflict, PaymentRequired, TooManyRequests],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Change username")
      .annotate(
        OpenApi.Description,
        "Repositories keep their ids, so nothing moves; old URLs stop resolving. 402 `username_payment_required` for a change to a username of 6 characters or fewer (`startUsernameCheckout`); keeping one, or changing its case, is free.",
      )
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.post("startUsernameCheckout", "/username/checkout", {
      payload: Schema.Struct({
        ...UsernameBody.fields,
        workspaceOrganizationId: Schema.optional(Schema.NullOr(Schema.String)).annotate({
          description: "As `claimUsername` takes it: connected once the username is paid for.",
        }),
        returnTo: Schema.optional(Schema.String).annotate({
          description: "A path on this site to go on to once the username is claimed.",
        }),
      }),
      success: UsernameCheckoutStart,
      error: [BadRequest, Conflict, Forbidden, TooManyRequests],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Pay for a short username")
      .annotate(
        OpenApi.Description,
        "For a username of 6 characters or fewer. Keeps it for the caller for 30 minutes and answers where to send the browser to pay; the username is theirs when the payment settles, as a first username or as a change to the one they have. From a signed-in browser only. 400 for a username that is free, 409 `username_taken` when someone has it or is paying for it.",
      )
      .annotate(SuccessDescription, "Where to pay"),
    HttpApiEndpoint.get("usernameCheckout", "/username/checkout", {
      success: UsernameCheckout,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "The caller's username payment")
      .annotate(
        OpenApi.Description,
        "What the page shows someone who comes back from paying: the username still kept for them, and what came of their last payment.",
      )
      .annotate(SuccessDescription, "The hold and the last payment"),
    HttpApiEndpoint.put("setWorkspace", "/workspace", {
      payload: Schema.Struct({
        organizationId: Schema.NullOr(Schema.String).annotate({
          description: "An organisation the person belongs to, or null for none.",
        }),
      }),
      success: Schema.Struct({ workspace: Schema.NullOr(PersonalWorkspace) }),
      error: Forbidden,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Choose where the person's own repositories run")
      .annotate(
        OpenApi.Description,
        "Connects the person's own namespace to an organisation they belong to: its repositories then run CI and review agents there, on that organisation's plan and bill, with their own secrets and variables. Null disconnects it. From a signed-in browser only. 403 `not_a_member` for an organisation that is not theirs, 403 `username_required` before they have a username.",
      )
      .annotate(SuccessDescription, "The connection"),
    HttpApiEndpoint.post("startWorkspaceCheckout", "/workspace/checkout", {
      payload: Schema.Struct({
        name: Schema.String.annotate({
          description: "The organisation's name, 100 characters at most.",
        }),
        from: Schema.Literals(["onboarding", "settings"]).annotate({
          description:
            "The page that asks, and where the browser comes back to: the username page, or Settings > Organisations.",
        }),
        username: Schema.optional(Schema.String).annotate({
          description:
            "From `onboarding`: the username the person has chosen and not yet claimed, so the page still has it when they come back.",
        }),
        returnTo: Schema.optional(Schema.String).annotate({
          description:
            "From `onboarding`: a path on this site to go on to once the username is claimed.",
        }),
      }),
      success: WorkspaceCheckoutStart,
      error: [BadRequest, Conflict, Forbidden],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Set up a workspace")
      .annotate(
        OpenApi.Description,
        "For a person who belongs to no organisation: answers where to send the browser to pay for an Infrawrench organisation on the Pro plan, one seat, which they will own. Nothing is created until the payment is complete; the organisation is then theirs, and their own namespace runs CI and review agents in it. From a signed-in browser only. 400 `workspace_name_invalid` for a name that is empty or too long, 409 `already_in_organisation` for someone who belongs to one.",
      )
      .annotate(SuccessDescription, "Where to pay"),
  )
  .prefix("/api/session")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Session") {}
