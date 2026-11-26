/**
 * The agent behind a branch, starting work from an ask, and a repository's
 * review settings.
 *
 * Starting work makes the branch at the base's commit and opens a draft
 * pull request whose body is the ask. The branch has nothing of its own yet,
 * so the storage records no version for it (`repo/do/versions.ts`); the
 * agent's first push is version 1.
 *
 * Naming an agent can also start it (`review/agent-connect.ts`): a T3 Code
 * thread is launched in the caller's environment, and an Infrawrench agent's
 * link carries where the app starts its session. A T3 Code thread's state is
 * read from its environment when the agent is asked for (`externalRefs`
 * `threadStatus`), and only there: the branch page's state stays a read of
 * Postgres.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  GitApi,
  REVIEWER_KINDS,
  badRequest,
  conflict,
  isValidRefName,
  notFound,
  ok,
  unprocessable,
} from "@infrawrench/git-contract";
import { principalActor } from "../../auth/principal";
import { listProtectedBranches, protectionFor } from "../../db/policy";
import { type PullRequestWithThread, createPullRequest, getPullRequest } from "../../db/pulls";
import {
  type ReviewSettingsValue,
  getAgentLink,
  getReviewSettings,
  removeAgentLink,
  updateReviewSettings,
} from "../../db/review";
import { connectAgent, prepareAgent } from "../../review/agent-connect";
import { threadState } from "../../t3/work";
import { RepoReaderError } from "../../repo/reader";
import { type RepoCx, repoOp } from "../context";
import { mayPush } from "../protection";
import { noteMentions } from "../thread-edits";
import { pullDetail } from "../views/pulls";
import { agentLinkView } from "../views/review";

const pullOr404 = async (cx: RepoCx, number: number): Promise<PullRequestWithThread> => {
  const found = await getPullRequest(cx.repo.repository.id, number);
  if (!found) throw notFound("No such pull request");
  return found;
};

/** The ask's first line, without Markdown's heading marks, as a title. */
const titleFrom = (ask: string): string => {
  const line =
    ask
      .split("\n")
      .map((each) => each.replace(/^#+\s*/, "").trim())
      .find((each) => each !== "") ?? "Work";
  return line.length > 256 ? `${line.slice(0, 255)}…` : line;
};

/** A branch name from a title: `work/add-rate-limits`. */
const branchFrom = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `work/${slug === "" ? "branch" : slug}`;
};

/** Names tried for a generated branch before giving up. */
const NAME_ATTEMPTS = 6;

export const AgentsHandlers = HttpApiBuilder.group(GitApi, "agents", (handlers) =>
  handlers
    .handle(
      "get",
      repoOp(async (cx, { params }) => {
        const found = await pullOr404(cx, params.number);
        const row = await getAgentLink(found.pull.issueId);
        if (!row) return { agent: null };
        const agent = await agentLinkView(row);
        // What a T3 Code thread is doing, asked of its environment and kept a few
        // seconds. Only for somebody signed in: a visitor to a public repository
        // does not get to make this site call a person's machine.
        const status =
          row.kind === "t3" && cx.userId !== null
            ? await threadState(cx.env, row.pullRequestId)
            : null;
        return {
          agent:
            status === null
              ? agent
              : { ...agent, externalRefs: { ...agent.externalRefs, threadStatus: status } },
        };
      }),
    )
    .handle(
      "set",
      repoOp(async (cx, { params, payload }) => {
        const found = await pullOr404(cx, params.number);
        return { agent: await agentLinkView(await connectAgent(cx, found, payload)) };
      }),
    )
    .handle(
      "remove",
      repoOp(async (cx, { params }) => {
        const found = await pullOr404(cx, params.number);
        await removeAgentLink(found.pull.issueId);
        return ok;
      }),
    )
    .handle(
      "startWork",
      repoOp(async (cx, { payload }) => {
        const { repository } = cx.repo;
        if (!repository.hasPullRequests) throw unprocessable("Pull requests are switched off here");
        const baseName = payload.base ?? repository.defaultBranch;
        const base = await cx.git.getBranch(baseName);
        if (!base) throw unprocessable(`There is no branch named ${baseName}`, "ref_not_found");
        const title = payload.title ?? titleFrom(payload.ask);
        if (payload.branch !== undefined && !isValidRefName(payload.branch)) {
          throw badRequest("That is not a valid branch name", "name_invalid");
        }
        // Whatever the agent can refuse, it refuses before a branch exists.
        const prepared = payload.agent ? await prepareAgent(cx, payload.agent) : undefined;
        const rules = await listProtectedBranches(repository.id);
        const generated = branchFrom(title);
        let branch: string | null = null;
        for (let attempt = 0; attempt < NAME_ATTEMPTS && branch === null; attempt++) {
          const name =
            payload.branch ?? (attempt === 0 ? generated : `${generated}-${attempt + 1}`);
          if (!mayPush(protectionFor(rules, name), cx.access, cx.userId)) {
            throw unprocessable("A protected-branch rule reserves that name", "protected_branch");
          }
          try {
            await cx.git.createBranch({
              name,
              from: base.commit.oid,
              actor: principalActor(cx.principal),
            });
            branch = name;
          } catch (error) {
            if (!(error instanceof RepoReaderError) || error.code !== "ref_exists") throw error;
            // A name the person chose is theirs to change; a generated one is tried again.
            if (payload.branch !== undefined) {
              throw conflict(`There is already a branch named ${name}`, "ref_exists");
            }
          }
        }
        if (branch === null) throw conflict("Could not find a free branch name", "ref_exists");

        const created = await createPullRequest({
          repositoryId: repository.id,
          title,
          body: payload.ask,
          authorUserId: cx.userId,
          labelIds: [],
          assigneeUserIds: [],
          milestoneId: null,
          baseRef: baseName,
          headRepositoryId: repository.id,
          headRef: branch,
          headOid: base.commit.oid,
          baseOid: base.commit.oid,
          mergeBaseOid: base.commit.oid,
          draft: true,
          commitsCount: 0,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
        });
        await cx.git.setPullRef({
          number: created.thread.number,
          headRepositoryId: repository.id,
          oid: base.commit.oid,
        });
        await noteMentions(created.thread, `${title}\n${payload.ask}`, cx.userId);
        const agent = payload.agent
          ? await connectAgent(cx, created, payload.agent, prepared)
          : null;
        return {
          pullRequest: await pullDetail(cx, created),
          branch,
          agent: agent ? await agentLinkView(agent) : null,
        };
      }),
    ),
);

const settingsView = (settings: ReviewSettingsValue) => ({
  autoOpenBranchPages: settings.autoOpenBranchPages,
  reviewAgentsEnabled: settings.reviewAgentsEnabled,
  reviewerKinds: [...settings.reviewerKinds],
  mustFixBlocksMerge: settings.mustFixBlocksMerge,
  availableReviewerKinds: [...REVIEWER_KINDS],
});

export const ReviewSettingsHandlers = HttpApiBuilder.group(GitApi, "reviewSettings", (handlers) =>
  handlers
    .handle(
      "get",
      repoOp(async (cx) => settingsView(await getReviewSettings(cx.repo.repository.id))),
    )
    .handle(
      "update",
      repoOp(async (cx, { payload }) =>
        settingsView(
          await updateReviewSettings(
            cx.repo.repository.id,
            {
              ...(payload.autoOpenBranchPages !== undefined
                ? { autoOpenBranchPages: payload.autoOpenBranchPages }
                : {}),
              ...(payload.reviewAgentsEnabled !== undefined
                ? { reviewAgentsEnabled: payload.reviewAgentsEnabled }
                : {}),
              ...(payload.reviewerKinds !== undefined
                ? { reviewerKinds: [...new Set(payload.reviewerKinds)] }
                : {}),
              ...(payload.mustFixBlocksMerge !== undefined
                ? { mustFixBlocksMerge: payload.mustFixBlocksMerge }
                : {}),
            },
            cx.userId,
          ),
        ),
      ),
    ),
);
