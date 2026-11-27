/**
 * Naming the agent behind a branch, and starting it where the forge
 * can (`agents.set`, `agents.startWork`).
 *
 * - **`infrawrench`** (the default): an agent session in the app. The forge
 *   does not start it: the app links to the forge and never the other way
 *   round, so the link carries `startUrl`, the app's Agents page for this
 *   branch (`?git=<owner>/<repo>&branch=<key>`), and the person opens it. The app starts the session
 *   (cloning this repository with a job token bound to the one branch) and
 *   writes the link's `sessionId` itself, on the row both sides read.
 *   Only a repository of an organisation has an app to start it in.
 * - **`t3`**: a thread in one of the caller's own T3 Code environments.
 *   Given a `threadId` it names that thread. Without one the forge starts a
 *   thread for the work (`t3/work.ts`): the environment's project for the
 *   repository is found or cloned first, before anything is made on the
 *   forge, and the thread is launched once the branch's page exists, with
 *   the model the person chose (`t3Model`) or, with none, the project's
 *   default or one picked here (`t3/work.ts` `launchThread`). The link says
 *   which model the thread got. A launch that fails leaves the link with
 *   `launchError`; setting the agent again tries again, and finds the same
 *   thread if it was made after all.
 * - **`mcp`**: any agent that reaches the forge itself. Nothing to start.
 */
import type { AgentLinkSet } from "@infrawrench/git-contract";
import { unprocessable } from "@infrawrench/git-contract";
import type { RepoCx } from "../api/context";
import { pageKey } from "../db/branch-pages";
import type { PullRequestWithThread } from "../db/pulls";
import { type AgentLinkRow, getAgentLink, setAgentLink } from "../db/review";
import { appOrigin } from "../env";
import { type EnvironmentRow, errorSentence, getEnvironment, t3Deps } from "../t3/environments";
import { T3Error } from "../t3/http";
import { FORGE_REFS, T3_REFS, projectFor, startThread } from "../t3/work";

/** What was settled before the branch and its page were made. */
export interface PreparedAgent {
  readonly environment: EnvironmentRow | null;
  /** The T3 Code project the thread will start in. */
  readonly projectId: string | null;
}

const refuse = (error: unknown): never => {
  if (error instanceof T3Error) throw unprocessable(error.message);
  throw error;
};

const ownEnvironment = async (cx: RepoCx, agent: AgentLinkSet): Promise<EnvironmentRow | null> => {
  const environmentId = agent.t3EnvironmentId ?? null;
  if (environmentId === null) return null;
  const row = cx.userId ? await getEnvironment(cx.userId, environmentId) : null;
  if (!row) throw unprocessable("That is not one of your T3 Code environments");
  return row;
};

/** Whether this is a T3 Code agent the forge is to start, rather than a thread it is told about. */
const startsThread = (agent: AgentLinkSet, environment: EnvironmentRow | null): boolean =>
  agent.kind === "t3" && environment !== null && !agent.externalRefs?.[T3_REFS.thread];

/**
 * Everything about the agent that can be refused, checked and done before
 * the forge makes a branch: the environment is the caller's and signed in,
 * and it has the repository as a project (cloned now if it did not).
 */
export const prepareAgent = async (cx: RepoCx, agent: AgentLinkSet): Promise<PreparedAgent> => {
  // A session that already runs can be named anywhere; one the app is to
  // start needs an organisation to start it in.
  if (
    agent.kind === "infrawrench" &&
    cx.repo.owner.organizationId === null &&
    !agent.externalRefs?.["sessionId"]
  ) {
    throw unprocessable(
      "Infrawrench agents run in an organisation. This repository is a person's: choose another agent",
    );
  }
  const environment = await ownEnvironment(cx, agent);
  if (!startsThread(agent, environment)) return { environment, projectId: null };
  if (environment!.status !== "connected") {
    throw unprocessable("Sign in to that T3 Code environment first");
  }
  try {
    const { projectId } = await projectFor(t3Deps(cx.env, cx.request), environment!, {
      owner: cx.repo.owner.slug,
      name: cx.repo.repository.name,
    });
    return { environment, projectId };
  } catch (error) {
    return refuse(error);
  }
};

/** The app's Agents page, asked to start a session for this branch's page (its key). */
export const appStartUrl = (cx: RepoCx, organizationId: string, key: string): string => {
  const url = new URL(`/org/${encodeURIComponent(organizationId)}/agents`, appOrigin(cx.env));
  url.searchParams.set("git", `${cx.repo.owner.slug}/${cx.repo.repository.name}`);
  url.searchParams.set("branch", key);
  return url.href;
};

/**
 * Name the branch's agent, starting it when it is a T3 Code thread the
 * forge is to start. `prepared` is {@link prepareAgent}'s answer when the
 * caller asked before making the branch and its page.
 */
export const connectAgent = async (
  cx: RepoCx,
  found: PullRequestWithThread,
  agent: AgentLinkSet,
  prepared?: PreparedAgent,
): Promise<AgentLinkRow> => {
  const ready = prepared ?? (await prepareAgent(cx, agent));
  const refs: Record<string, string> = { ...(agent.externalRefs ?? {}) };
  // Never what a client sent: these are the forge's to say.
  for (const key of FORGE_REFS) delete refs[key];

  if (agent.kind === "infrawrench") {
    const organizationId = cx.repo.owner.organizationId;
    // A session the app already started for this branch stays named.
    const existing = await getAgentLink(found.pull.issueId);
    if (
      existing?.kind === "infrawrench" &&
      existing.externalRefs["sessionId"] &&
      !refs["sessionId"]
    ) {
      refs["sessionId"] = existing.externalRefs["sessionId"];
    }
    if (organizationId !== null) {
      refs["organizationId"] = organizationId;
      refs["startUrl"] = appStartUrl(cx, organizationId, await pageKey(found.pull));
    }
  }

  if (startsThread(agent, ready.environment) && ready.projectId !== null) {
    try {
      const started = await startThread(
        t3Deps(cx.env, cx.request),
        ready.environment!,
        ready.projectId,
        {
          repository: { owner: cx.repo.owner.slug, name: cx.repo.repository.name },
          pullRequestId: found.pull.issueId,
          key: await pageKey(found.pull),
          title: found.thread.title,
          ask: found.thread.body ?? "",
          branch: found.pull.headRef,
          baseRef: found.pull.baseRef,
          model: agent.t3Model,
        },
      );
      refs[T3_REFS.thread] = started.threadId;
      refs[T3_REFS.project] = started.projectId;
      if (started.link !== null) refs[T3_REFS.link] = started.link;
      if (started.model !== null) {
        refs[T3_REFS.modelProvider] = started.model.providerId;
        refs[T3_REFS.model] = started.model.modelId;
        refs[T3_REFS.modelName] = started.model.name;
        if (started.model.reasoningLevel !== null) {
          refs[T3_REFS.reasoning] = started.model.reasoningLevel;
        }
        if (started.model.picked) refs[T3_REFS.modelPickedBy] = "forge";
      }
    } catch (error) {
      // The page stands. The link says why there is no thread, and
      // setting the agent again tries again.
      refs[T3_REFS.project] = ready.projectId;
      refs[T3_REFS.launchError] = errorSentence(error);
    }
  }

  return setAgentLink({
    pullRequestId: found.pull.issueId,
    repositoryId: found.pull.repositoryId,
    kind: agent.kind,
    displayName: agent.displayName,
    externalRefs: refs,
    t3EnvironmentId: ready.environment?.id ?? null,
    connectedByUserId: cx.userId,
  });
};
