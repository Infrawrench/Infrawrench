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
import { BadRequest, Conflict, Forbidden, TooManyRequests } from "../http/errors";
import { NamespaceRef, Session, UsernameAvailability } from "../schemas/people";

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
      payload: UsernameBody,
      success: Schema.Struct({ namespace: NamespaceRef }),
      // git-feature-flag: Forbidden (`signups_closed`) is the flag's; remove with it.
      error: [BadRequest, Conflict, Forbidden],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Claim a username")
      .annotate(
        OpenApi.Description,
        "Creates the person's namespace. 409 `username_taken` when someone has it, 409 `namespace_already_claimed` when the person already has one (use `renameUsername`). 403 `signups_closed` while sign-ups are not open to this person.",
      )
      .annotate(SuccessDescription, "The namespace"),
    HttpApiEndpoint.put("renameUsername", "/username", {
      payload: UsernameBody,
      success: Schema.Struct({ namespace: NamespaceRef }),
      error: [BadRequest, Conflict, TooManyRequests],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Change username")
      .annotate(
        OpenApi.Description,
        "Repositories keep their ids, so nothing moves; old URLs stop resolving.",
      )
      .annotate(SuccessDescription, "The namespace"),
  )
  .prefix("/api/session")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Session") {}
