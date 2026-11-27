/**
 * Getting an instruction to the agent that writes a branch.
 *
 * **Delivery is one function, {@link deliverInstructions}, over rows.**
 * Whoever queues an instruction (a reviewer through the API, the review
 * runner for a must-fix finding) inserts a `queued` row and calls it with the
 * pull request; it does not matter who made the row. What it does depends on
 * the branch's agent (`git_agent_links.kind`):
 *
 * - `t3`: the forge tells the T3 Code thread itself (`t3/work.ts`), and the
 *   row is `delivered` via `t3`.
 * - `infrawrench`, `mcp` and a branch with no agent named: nothing is pushed.
 *   The agent asks (`instructions.list`, the forge's MCP `list_instructions`)
 *   and marks what it took `delivered` itself. An Infrawrench agent session
 *   is a terminal on a machine of the organisation's, with no way to be sent
 *   a message from outside it, so its first prompt tells it to read its
 *   instructions through the API with the job token it was started with.
 *
 * A row is claimed before the agent is told (`claimDelivery`, one
 * conditional update), so two callers never tell it twice, and released when
 * telling it failed. {@link sweepInstructions} is the backstop: the cron
 * trigger calls it for rows that have waited (a caller that did not deliver,
 * an environment that was away), so a queued row with a reachable agent is
 * never stuck on whoever created it.
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  type GitAgentKind,
  gitReviewComments,
  gitReviewFindings,
  gitReviews,
} from "@infrawrench/server-core/db/schema";
import { db } from "../db/client";
import {
  type InstructionRow,
  claimDelivery,
  listInstructions,
  pullRequestsAwaitingDelivery,
  releaseDelivery,
} from "../db/instructions";
import { type PullRequestWithThread, getPullRequestByIssueId } from "../db/pulls";
import { type RepositoryWithOwner, getRepositoryById } from "../db/repositories";
import { type AgentLinkRow, getAgentLink } from "../db/review";
import type { Env } from "../env";
import { describeError } from "../http/log";

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

const lines = (start: number | null, end: number | null): string =>
  end === null ? "" : start !== null && start !== end ? ` lines ${start}-${end}` : ` line ${end}`;

/**
 * A review thread as an instruction: where it is, what was said (every
 * comment of the thread that has been submitted), then the reviewer's own
 * words. Null when the comment is not one of this pull request's, or is
 * still in somebody's pending review.
 */
export const commentInstruction = async (
  found: PullRequestWithThread,
  commentId: string,
  extra: string,
): Promise<{ body: string; reviewCommentId: string } | null> => {
  const [named] = await db
    .select({ id: gitReviewComments.id, inReplyToId: gitReviewComments.inReplyToId })
    .from(gitReviewComments)
    .where(
      and(
        eq(gitReviewComments.id, commentId),
        eq(gitReviewComments.pullRequestId, found.pull.issueId),
      ),
    )
    .limit(1);
  if (!named) return null;
  const rootId = named.inReplyToId ?? named.id;
  const thread = await db
    .select({ comment: gitReviewComments })
    .from(gitReviewComments)
    .innerJoin(gitReviews, eq(gitReviews.id, gitReviewComments.reviewId))
    .where(
      and(
        eq(gitReviewComments.pullRequestId, found.pull.issueId),
        or(eq(gitReviewComments.id, rootId), eq(gitReviewComments.inReplyToId, rootId)),
        sql`${gitReviews.state} <> 'pending'`,
      ),
    )
    .orderBy(asc(gitReviewComments.createdAt));
  const root = thread.find((row) => row.comment.id === rootId)?.comment;
  // The thread's first comment is not submitted yet: there is nothing to send.
  if (!root) return null;
  const where = `\`${root.path}\`${lines(root.originalStartLine, root.originalLine)}`;
  const version = root.versionNumber === null ? "" : ` (written on v${root.versionNumber})`;
  const said = thread.map((row) => quote(row.comment.body)).join("\n>\n");
  return {
    reviewCommentId: rootId,
    body: [`Review comment on ${where}${version}:`, said, extra]
      .filter((part) => part !== "")
      .join("\n\n"),
  };
};

/** A finding as an instruction. Null when it is not one of this pull request's. */
export const findingInstruction = async (
  found: PullRequestWithThread,
  findingId: string,
  extra: string,
): Promise<{ body: string; findingId: string } | null> => {
  const [finding] = await db
    .select()
    .from(gitReviewFindings)
    .where(
      and(
        eq(gitReviewFindings.id, findingId),
        eq(gitReviewFindings.pullRequestId, found.pull.issueId),
      ),
    )
    .limit(1);
  if (!finding) return null;
  return { findingId: finding.id, body: findingBody(finding, extra) };
};

/** What a finding asks for, in the words an agent is sent. Also for whoever queues one itself. */
export const findingBody = (
  finding: Pick<
    typeof gitReviewFindings.$inferSelect,
    "severity" | "title" | "body" | "path" | "startLine" | "endLine" | "versionNumber"
  >,
  extra = "",
): string => {
  const where =
    finding.path === null
      ? ""
      : ` in \`${finding.path}\`${lines(finding.startLine, finding.endLine ?? finding.startLine)}`;
  return [
    `Review finding (${finding.severity.replace("_", " ")})${where}, raised on v${finding.versionNumber}: ${finding.title}`,
    finding.body.trim(),
    extra,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryTarget {
  readonly link: AgentLinkRow;
  readonly pull: PullRequestWithThread;
  readonly repo: RepositoryWithOwner;
}

/**
 * Tells one kind of agent an instruction. Rejects when it could not be
 * told; the row then goes back to `queued`.
 */
export type InstructionSender = (
  env: Env,
  target: DeliveryTarget,
  instruction: InstructionRow,
) => Promise<void>;

export type InstructionSenders = Partial<Record<GitAgentKind, InstructionSender>>;

/** The senders this Worker has. Loaded on first use: the T3 Code client is not start-up work. */
const defaultSenders = async (): Promise<InstructionSenders> => ({
  t3: (await import("../t3/work")).sendInstructionToThread,
});

export interface DeliveryResult {
  readonly delivered: number;
  /** Left queued: the agent asks for them, or it could not be told this time. */
  readonly queued: number;
}

/**
 * Tell the branch's agent every instruction that is waiting, oldest first.
 * Stops at the first that cannot be told, so they arrive in order. Never
 * rejects for an agent that is away: the rows stay queued.
 */
export const deliverInstructions = async (
  env: Env,
  pullRequestId: string,
  options: { readonly senders?: InstructionSenders } = {},
): Promise<DeliveryResult> => {
  const waiting = await listInstructions(pullRequestId, "queued");
  if (waiting.length === 0) return { delivered: 0, queued: 0 };
  const link = await getAgentLink(pullRequestId);
  const send = link ? (options.senders ?? (await defaultSenders()))[link.kind] : undefined;
  if (!link || !send) return { delivered: 0, queued: waiting.length };
  const pull = await getPullRequestByIssueId(pullRequestId);
  const repo = pull ? await getRepositoryById(pull.pull.repositoryId) : null;
  if (!pull || !repo || pull.thread.state !== "open") {
    return { delivered: 0, queued: waiting.length };
  }

  let delivered = 0;
  for (const row of waiting) {
    const claimed = await claimDelivery(row.id, link.kind);
    // Somebody else told the agent, or the instruction was withdrawn.
    if (!claimed) continue;
    try {
      await send(env, { link, pull, repo }, claimed);
      delivered++;
    } catch (error) {
      await releaseDelivery(claimed.id);
      console.error(`[git] delivering an instruction failed: ${describeError(error)}`);
      break;
    }
  }
  return { delivered, queued: waiting.length - delivered };
};

/** Pull requests one sweep takes. More wait for the next. */
const SWEEP_BATCH = 50;
/** A row younger than this is its creator's to deliver. */
const SWEEP_AFTER_MS = 30_000;

/** The backstop: deliver what has waited, whoever queued it. */
export const sweepInstructions = async (
  env: Env,
  options: { readonly now?: Date; readonly senders?: InstructionSenders } = {},
): Promise<DeliveryResult> => {
  const before = new Date((options.now ?? new Date()).getTime() - SWEEP_AFTER_MS);
  let delivered = 0;
  let queued = 0;
  for (const pullRequestId of await pullRequestsAwaitingDelivery(before, SWEEP_BATCH)) {
    const result = await deliverInstructions(env, pullRequestId, options);
    delivered += result.delivered;
    queued += result.queued;
  }
  return { delivered, queued };
};
