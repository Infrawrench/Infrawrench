/**
 * An agent's token for one branch's markers (`iwj_`, the `agent` claim of
 * client-core's `git-job-token.ts`): what an agent working outside the app
 * holds, in a T3 Code thread for one, so that it can record its trace,
 * answer its instructions and report findings without a person signing it
 * in through a browser.
 *
 * - **Minted by exchange** (`agents.token`): a person, a personal access
 *   token or an API key with `write` on the repository asks for one for a
 *   branch page. The token can do nothing its asker could not, so the
 *   exchange narrows a credential and never widens one. The forge sends it
 *   nowhere: a T3 Code thread asks with the Git credential its machine
 *   already pushes with (`t3/work.ts` `markerSetup`).
 * - **Six hours**, the longest a job token lives. Asking again is the
 *   renewal.
 * - **What it reaches** is {@link AGENT_ENDPOINTS} and nothing else, on its
 *   own branch and no other (its page to read; its trace, instructions and
 *   findings to work with): the middleware holds it to those endpoints,
 *   {@link ownPageOnly} (from `pageOr404`) to its branch's page, and
 *   {@link ownBranchOnly} to its branch's trace. Git never authenticates
 *   one, nor the archive, raw files or Terraform, so it clones and pushes
 *   nothing: the thread pushes with its own machine's credentials.
 */
import { forbidden, unprocessable } from "@infrawrench/git-contract";
import { isGitJobTokenRef } from "@infrawrench/client-core";
import { JOB_TOKEN_MAX_TTL_SECONDS, mintJobToken } from "../auth/job-token";
import type { Principal } from "../auth/principal";
import type { PullRequestWithThread } from "../db/pulls";
import type { RepoCx } from "./context";

/** Every endpoint an agent's token calls, by group. */
export const AGENT_ENDPOINTS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Its own branch's page, which every MCP tool reads first to find the page.
  branches: new Set(["get"]),
  traces: new Set(["record", "list"]),
  instructions: new Set(["list", "markDelivered", "markAnswered"]),
  findings: new Set(["list", "report"]),
};

/** The branch an agent's token is for (`refs/heads/...`), or null for any other principal. */
export const agentRefOf = (principal: Principal): string | null =>
  principal.kind === "job" ? (principal.agentRef ?? null) : null;

/** Whether the principal, when it is an agent's token, may call this endpoint at all. */
export const agentMayCall = (principal: Principal, group: string, endpoint: string): boolean =>
  agentRefOf(principal) === null || AGENT_ENDPOINTS[group]?.has(endpoint) === true;

/** Whether the principal is an agent's token and this is one of its endpoints. */
export const isAgentEndpoint = (principal: Principal, group: string, endpoint: string): boolean =>
  agentRefOf(principal) !== null && AGENT_ENDPOINTS[group]?.has(endpoint) === true;

const OTHER_BRANCH = "This token is for another branch's markers";

/** Refuses an agent's token on a branch page that is not its branch's. */
export const ownPageOnly = (cx: RepoCx, found: PullRequestWithThread): void => {
  const ref = agentRefOf(cx.principal);
  if (ref === null) return;
  const own =
    found.pull.repositoryId === cx.repo.repository.id &&
    found.pull.headRepositoryId === cx.repo.repository.id &&
    ref === `refs/heads/${found.pull.headRef}`;
  if (!own) throw forbidden(OTHER_BRANCH);
};

/** Refuses an agent's token on a branch (by name) that is not its own. */
export const ownBranchOnly = (cx: RepoCx, branch: string): void => {
  const ref = agentRefOf(cx.principal);
  if (ref !== null && ref !== `refs/heads/${branch}`) throw forbidden(OTHER_BRANCH);
};

export const AGENT_TOKEN_TTL_SECONDS = JOB_TOKEN_MAX_TTL_SECONDS;

/**
 * A token for the markers of `found`'s branch. The caller has `write` (the
 * endpoint's gate); this refuses who may not hold one and what has no
 * markers to write.
 */
export const mintAgentToken = async (
  cx: RepoCx,
  found: PullRequestWithThread,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string; branch: string }> => {
  const { principal } = cx;
  // A person or a key narrows what it has. A job, a deploy key and an
  // agent's own token do not mint: a token never renews itself.
  if (principal.kind !== "user" && principal.kind !== "api-key") {
    throw forbidden("A person, a personal access token or an API key asks for an agent's token");
  }
  const { pull } = found;
  if (found.thread.state !== "open") {
    throw unprocessable("This branch page is not open: there is no work to record");
  }
  // A fork's branch is the fork's: its agent records there, with access to the fork.
  if (pull.headRepositoryId !== cx.repo.repository.id) {
    throw unprocessable("This branch is a fork's: ask on the fork");
  }
  const ref = `refs/heads/${pull.headRef}`;
  if (pull.headRef === cx.repo.repository.defaultBranch || !isGitJobTokenRef(ref)) {
    throw unprocessable("An agent's token cannot name this branch");
  }
  const seconds = Math.floor(now.getTime() / 1000);
  const token = await mintJobToken(cx.env.GIT_JOB_TOKEN_KEY, {
    repositoryId: cx.repo.repository.id,
    write: true,
    // Who asked, for the audit trail: nothing is decided from it.
    runId: `agent:${principal.userId}`,
    ttlSeconds: AGENT_TOKEN_TTL_SECONDS,
    now: seconds,
    agent: ref,
  });
  return {
    token,
    expiresAt: new Date((seconds + AGENT_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    branch: pull.headRef,
  };
};
