/**
 * Instructions: what a reviewer sent to the agent that wrote the branch
 * (`git_instructions`, `db/instructions.ts`).
 *
 * - **Sending** takes a review thread, a finding or plain text. What the
 *   agent is told is written out when it is sent (the thread or the finding
 *   as it read then, and the reviewer's own words after it), so a later edit
 *   or a pruned version does not change what was asked. It is queued, and
 *   told to the agent at once when the branch's agent is one the forge can
 *   reach itself (`review/instructions.ts` `deliverInstructions`).
 * - **An agent** reads its instructions with `list`, says one reached it
 *   (`markDelivered`) and which version answers it (`markAnswered`; without
 *   a version, the next one pushed). That takes `write` on the repository: a
 *   person's token with `repo:write`, or a CI job's token for this
 *   repository that may write.
 * - **Only people** send and withdraw. A job's token does neither.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  GitApi,
  type Instruction,
  badRequest,
  forbidden,
  notFound,
  unprocessable,
} from "@infrawrench/git-contract";
import {
  type InstructionRow,
  answerInstruction,
  claimDelivery,
  dismissInstruction,
  getInstruction,
  insertInstruction,
  listInstructions,
} from "../../db/instructions";
import { type PullRequestWithThread, getPullRequest } from "../../db/pulls";
import { versionsForPull } from "../../db/review";
import {
  commentInstruction,
  deliverInstructions,
  findingInstruction,
} from "../../review/instructions";
import { type RepoCx, repoOp } from "../context";
import { iso, isoOrNull, peopleById } from "../views/repositories";

const pullOr404 = async (cx: RepoCx, number: number): Promise<PullRequestWithThread> => {
  const found = await getPullRequest(cx.repo.repository.id, number);
  if (!found) throw notFound("No such pull request");
  return found;
};

const instructionOr404 = async (
  found: PullRequestWithThread,
  instructionId: string,
): Promise<InstructionRow> => {
  const row = await getInstruction(found.pull.issueId, instructionId);
  if (!row) throw notFound("No such instruction");
  return row;
};

export const instructionViews = async (rows: readonly InstructionRow[]): Promise<Instruction[]> => {
  const person = await peopleById(
    rows.flatMap((row) => [row.createdByUserId, row.dismissedByUserId]),
  );
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    reviewCommentId: row.reviewCommentId,
    findingId: row.findingId,
    body: row.body,
    createdBy: person(row.createdByUserId),
    status: row.status,
    deliveredVia: row.deliveredVia,
    deliveredAt: isoOrNull(row.deliveredAt),
    answeredInVersion: row.answeredInVersionNumber,
    answeredAt: isoOrNull(row.answeredAt),
    dismissedBy: person(row.dismissedByUserId),
    dismissedAt: isoOrNull(row.dismissedAt),
    createdAt: iso(row.createdAt),
  }));
};

const view = async (row: InstructionRow): Promise<Instruction> =>
  (await instructionViews([row]))[0]!;

/** A job reads its instructions and answers them; a person decides what it is asked. */
const peopleOnly = (cx: RepoCx): void => {
  if (cx.principal.kind === "job") {
    throw forbidden("A CI job token reads and answers instructions; a person sends them");
  }
};

/**
 * A job token bound to one branch (an agent session's) answers for that
 * branch's pull request and no other: it has the repository's `write` for
 * the gate, and this is what keeps it to its own work.
 */
const ownBranchOnly = (cx: RepoCx, found: PullRequestWithThread): void => {
  const { principal } = cx;
  if (principal.kind !== "job" || principal.ref == null) return;
  const own =
    found.pull.headRepositoryId === cx.repo.repository.id &&
    principal.ref === `refs/heads/${found.pull.headRef}`;
  if (!own) throw forbidden("This token answers instructions on its own branch only");
};

export const InstructionsHandlers = HttpApiBuilder.group(GitApi, "instructions", (handlers) =>
  handlers
    .handle(
      "send",
      repoOp(async (cx, { params, payload }) => {
        peopleOnly(cx);
        const found = await pullOr404(cx, params.number);
        if (found.thread.state !== "open") {
          throw unprocessable("This pull request is not open: there is no work to send it to");
        }
        const extra = payload.body?.trim() ?? "";
        let body: string;
        let reviewCommentId: string | null = null;
        let findingId: string | null = null;
        if (payload.source === "text") {
          if (extra === "") throw badRequest("Say what the agent should do");
          body = extra;
        } else if (payload.source === "review_comment") {
          if (!payload.reviewCommentId) {
            throw badRequest("Name the review comment to send");
          }
          const composed = await commentInstruction(found, payload.reviewCommentId, extra);
          if (composed === null) throw unprocessable("No such review comment on this branch");
          ({ body, reviewCommentId } = composed);
        } else {
          if (!payload.findingId) throw badRequest("Name the finding to send");
          const composed = await findingInstruction(found, payload.findingId, extra);
          if (composed === null) throw unprocessable("No such finding on this branch");
          ({ body, findingId } = composed);
        }
        const row = await insertInstruction({
          repositoryId: found.pull.repositoryId,
          pullRequestId: found.pull.issueId,
          source: payload.source,
          reviewCommentId,
          findingId,
          body,
          createdByUserId: cx.userId,
        });
        // Told to the agent now when the forge can reach it. A failure leaves
        // it queued for the sweep, or for the agent to ask.
        await deliverInstructions(cx.env, found.pull.issueId).catch(() => undefined);
        return view((await getInstruction(found.pull.issueId, row.id)) ?? row);
      }),
    )
    .handle(
      "list",
      repoOp(async (cx, { params, query }) => {
        const found = await pullOr404(cx, params.number);
        return {
          instructions: await instructionViews(
            await listInstructions(found.pull.issueId, query.status),
          ),
        };
      }),
    )
    .handle(
      "markDelivered",
      repoOp(async (cx, { params, payload }) => {
        const found = await pullOr404(cx, params.number);
        ownBranchOnly(cx, found);
        const row = await instructionOr404(found, params.instructionId);
        if (row.status === "dismissed") throw unprocessable("That instruction was withdrawn");
        // Told twice is told once: the first delivery stands.
        if (row.status !== "queued") return view(row);
        const via = payload.via?.trim() || "mcp";
        const claimed = await claimDelivery(row.id, via);
        return view(claimed ?? (await instructionOr404(found, row.id)));
      }),
    )
    .handle(
      "markAnswered",
      repoOp(async (cx, { params, payload }) => {
        const found = await pullOr404(cx, params.number);
        ownBranchOnly(cx, found);
        const row = await instructionOr404(found, params.instructionId);
        if (row.status === "dismissed") throw unprocessable("That instruction was withdrawn");
        let version = null;
        if (payload.version !== undefined) {
          version =
            (await versionsForPull(found.pull)).find((each) => each.number === payload.version) ??
            null;
          if (version === null) {
            throw unprocessable(`This branch has no version ${payload.version}`);
          }
        }
        const answered = await answerInstruction(row, version);
        if (answered === null) throw unprocessable("That instruction was withdrawn");
        return view(answered);
      }),
    )
    .handle(
      "dismiss",
      repoOp(async (cx, { params }) => {
        peopleOnly(cx);
        const found = await pullOr404(cx, params.number);
        const row = await instructionOr404(found, params.instructionId);
        if (row.status === "dismissed") return view(row);
        const dismissed = await dismissInstruction(row.id, cx.userId);
        if (dismissed === null) {
          throw unprocessable("A version already answers that instruction");
        }
        return view(dismissed);
      }),
    ),
);
