/**
 * Paying for a short username on git.infrawrench.com, the handlers: two
 * redirects (`services/git-username-checkout.ts` does the work). Every answer
 * is a redirect, to Stripe or back to the forge, since a browser following a
 * link is the only caller.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { GitUsernameCheckoutApi } from "@infrawrench/api-contract";
import {
  gitUsernameReturnUrl,
  openGitUsernameCheckout,
  returnFromGitUsernameCheckout,
} from "../../../services/git-username-checkout";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";

/** 303, so the browser fetches the page whatever brought it here. */
const seeOther = (url: string) => HttpServerResponse.redirect(url, { status: 303 });

const GitUsernameCheckoutHandlers = HttpApiBuilder.group(
  GitUsernameCheckoutApi,
  "gitUsernameCheckout",
  (handlers) =>
    handlers
      .handle("open", ({ query }) =>
        Effect.gen(function* () {
          if (!query.token) return seeOther(gitUsernameReturnUrl(null, "expired"));
          const token = query.token;
          return seeOther(yield* legacy(() => openGitUsernameCheckout(token)));
        }),
      )
      .handle("return", ({ query }) =>
        Effect.gen(function* () {
          if (!query.session_id) return seeOther(gitUsernameReturnUrl(null, "cancelled"));
          const sessionId = query.session_id;
          return seeOther(yield* legacy(() => returnFromGitUsernameCheckout(sessionId)));
        }),
      ),
);

export const gitUsernameCheckoutDomain = makeDomain(
  "git-username-checkout",
  GitUsernameCheckoutApi,
  GitUsernameCheckoutHandlers,
);
