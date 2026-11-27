/**
 * Setting up a workspace from git.infrawrench.com, the handlers: two
 * redirects (`services/git-workspace-checkout.ts` does the work). Every
 * answer is a redirect, to Stripe or back to the forge, since a browser
 * following a link is the only caller.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { GitWorkspaceCheckoutApi } from "@infrawrench/api-contract";
import {
  gitWorkspaceReturnUrl,
  openGitWorkspaceCheckout,
  returnFromGitWorkspaceCheckout,
} from "../../../services/git-workspace-checkout";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";

/** 303, so the browser fetches the page whatever brought it here. */
const seeOther = (url: string) => HttpServerResponse.redirect(url, { status: 303 });

const GitWorkspaceCheckoutHandlers = HttpApiBuilder.group(
  GitWorkspaceCheckoutApi,
  "gitWorkspaceCheckout",
  (handlers) =>
    handlers
      .handle("open", ({ query }) =>
        Effect.gen(function* () {
          if (!query.token) return seeOther(gitWorkspaceReturnUrl(null, "expired"));
          const token = query.token;
          return seeOther(yield* legacy(() => openGitWorkspaceCheckout(token)));
        }),
      )
      .handle("return", ({ query }) =>
        Effect.gen(function* () {
          if (!query.session_id) return seeOther(gitWorkspaceReturnUrl(null, "cancelled"));
          const sessionId = query.session_id;
          return seeOther(yield* legacy(() => returnFromGitWorkspaceCheckout(sessionId)));
        }),
      ),
);

export const gitWorkspaceCheckoutDomain = makeDomain(
  "git-workspace-checkout",
  GitWorkspaceCheckoutApi,
  GitWorkspaceCheckoutHandlers,
);
