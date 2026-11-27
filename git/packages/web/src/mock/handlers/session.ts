import {
  namespaceSlugProblem,
  nameProblemMessage,
  NAME_MAX_LENGTH,
  SHORT_USERNAME_PAYMENT_REQUIRED,
  SHORT_USERNAME_PRICE_CENTS,
  USERNAME_CHECKOUT_PARAM,
  USERNAME_HOLD_MINUTES,
  WORKSPACE_CHECKOUT_PARAM,
  usernamePriceCents,
  workspaceNameProblem,
  type UsernameCheckout,
} from "@infrawrench/git-contract";
import { badRequest, conflict, defineMockHandlers, mockError } from "../define";
import {
  claimUsername,
  currentUser,
  namespaces,
  requireUser,
  session,
  setMyWorkspace,
  setScenario,
  setUpMyWorkspace,
} from "../db";

const taken = (username: string): boolean =>
  namespaces.some(
    (n) => n.slug.toLowerCase() === username.toLowerCase() && n.userId !== currentUser()?.id,
  );

/** The last payment the stub checkout took, as `usernameCheckout` answers it. */
let lastPurchase: UsernameCheckout["purchase"] = null;

function check(username: string) {
  const user = requireUser();
  const problem = namespaceSlugProblem(username);
  if (problem !== null) {
    throw badRequest(
      nameProblemMessage(problem, NAME_MAX_LENGTH),
      problem === "reserved" ? "username_reserved" : "username_invalid",
    );
  }
  if (taken(username)) throw conflict("That username is taken", "username_taken");
  return usernamePriceCents(username, user.username);
}

/** Claim or change to a free username; a short one is paid for first. */
function claim(username: string) {
  if (check(username) !== null) {
    throw mockError(402, SHORT_USERNAME_PAYMENT_REQUIRED, "username_payment_required");
  }
  return { namespace: claimUsername(username) };
}

export default defineMockHandlers({
  session: {
    me: () => session(),
    signOut: () => {
      setScenario("signed-out");
      return { ok: true, redirectTo: "/" };
    },
    usernameAvailability: ({ query }) => {
      requireUser();
      const problem = namespaceSlugProblem(query.username);
      if (problem !== null) {
        return {
          username: query.username,
          available: false,
          reason: problem === "reserved" ? "reserved" : "invalid",
          message: nameProblemMessage(problem, NAME_MAX_LENGTH),
          priceCents: null,
        };
      }
      if (taken(query.username)) {
        return {
          username: query.username,
          available: false,
          reason: "taken",
          message: "That username is taken",
          priceCents: null,
        };
      }
      return {
        username: query.username,
        available: true,
        reason: null,
        message: null,
        priceCents: usernamePriceCents(query.username, currentUser()?.username),
      };
    },
    claimUsername: ({ payload }) => {
      const claimed = claim(payload.username);
      setMyWorkspace(payload.workspaceOrganizationId ?? null);
      return claimed;
    },
    renameUsername: ({ payload }) => claim(payload.username),
    // There is no payment page in the mock: the username is theirs at once, as
    // if they had paid, and the "payment page" is the page they come back to.
    startUsernameCheckout: ({ payload }) => {
      const first = requireUser().username === null;
      if (check(payload.username) === null) {
        throw badRequest("That username is free: it is claimed without paying");
      }
      claimUsername(payload.username);
      if (first) setMyWorkspace(payload.workspaceOrganizationId ?? null);
      lastPurchase = {
        username: payload.username,
        status: "claimed",
        amountCents: SHORT_USERNAME_PRICE_CENTS,
        at: new Date().toISOString(),
      };
      const back = first
        ? `/onboarding/username?${payload.returnTo ? `returnTo=${encodeURIComponent(payload.returnTo)}&` : ""}`
        : "/settings?";
      return {
        username: payload.username,
        checkoutUrl: `${back}${USERNAME_CHECKOUT_PARAM}=return`,
        expiresAt: new Date(Date.now() + USERNAME_HOLD_MINUTES * 60_000).toISOString(),
      };
    },
    usernameCheckout: () => {
      requireUser();
      return { hold: null, purchase: lastPurchase };
    },
    // No payment page here either: the organisation is theirs at once, as if
    // they had paid, and the browser "comes back" to the page that asked.
    startWorkspaceCheckout: ({ payload }) => {
      requireUser();
      const name = payload.name.trim();
      const problem = workspaceNameProblem(name);
      if (problem !== null) throw badRequest(problem, "workspace_name_invalid");
      if (session().organizations.length > 0) {
        throw conflict("You already belong to an organisation", "already_in_organisation");
      }
      setUpMyWorkspace(name);
      const query = new URLSearchParams();
      if (payload.from === "onboarding") {
        if (payload.username !== undefined) query.set("username", payload.username);
        if (payload.returnTo !== undefined) query.set("returnTo", payload.returnTo);
      }
      query.set(WORKSPACE_CHECKOUT_PARAM, "return");
      const page =
        payload.from === "onboarding" ? "/onboarding/username" : "/settings/organisations";
      return { checkoutUrl: `${page}?${query.toString()}` };
    },
    setWorkspace: ({ payload }) => {
      requireUser();
      return { workspace: setMyWorkspace(payload.organizationId) };
    },
  },
});
