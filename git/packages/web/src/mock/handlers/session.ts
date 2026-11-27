import {
  namespaceSlugProblem,
  nameProblemMessage,
  NAME_MAX_LENGTH,
} from "@infrawrench/git-contract";
import { badRequest, conflict, defineMockHandlers } from "../define";
import {
  claimUsername,
  currentUser,
  namespaces,
  requireUser,
  session,
  setMyWorkspace,
  setScenario,
} from "../db";

const taken = (username: string): boolean =>
  namespaces.some(
    (n) => n.slug.toLowerCase() === username.toLowerCase() && n.userId !== currentUser()?.id,
  );

function claim(username: string) {
  requireUser();
  const problem = namespaceSlugProblem(username);
  if (problem !== null) {
    throw badRequest(
      nameProblemMessage(problem, NAME_MAX_LENGTH),
      problem === "reserved" ? "username_reserved" : "username_invalid",
    );
  }
  if (taken(username)) throw conflict("That username is taken", "username_taken");
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
        };
      }
      if (taken(query.username)) {
        return {
          username: query.username,
          available: false,
          reason: "taken",
          message: "That username is taken",
        };
      }
      return { username: query.username, available: true, reason: null, message: null };
    },
    claimUsername: ({ payload }) => {
      const claimed = claim(payload.username);
      setMyWorkspace(payload.workspaceOrganizationId ?? null);
      return claimed;
    },
    renameUsername: ({ payload }) => claim(payload.username),
    setWorkspace: ({ payload }) => {
      requireUser();
      return { workspace: setMyWorkspace(payload.organizationId) };
    },
  },
});
