/**
 * Instructions (`git_instructions`): what a reviewer sent to the agent that
 * wrote a branch, and where each one stands.
 *
 * `queued` until it reaches the agent, `delivered` once it has, `answered`
 * when the agent says a version answers it, `dismissed` when a person takes
 * it back. An instruction the agent answered without naming a version is
 * `answered` with no version number yet: the next version pushed to the
 * branch is the one (`settleAnswered`, called where versions are recorded).
 *
 * Every transition is one conditional `UPDATE`, so two deliveries or a
 * delivery and a dismissal racing leave one winner and no half state.
 */
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  type GitInstructionSource,
  type GitInstructionStatus,
  gitAgentLinks,
  gitInstructions,
  gitReviewComments,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "./client";
import type { VersionRow } from "./review";

export type InstructionRow = typeof gitInstructions.$inferSelect;

export interface NewInstruction {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly source: GitInstructionSource;
  readonly reviewCommentId: string | null;
  readonly findingId: string | null;
  readonly body: string;
  readonly createdByUserId: string | null;
}

/** Queue an instruction. Delivery is `review/instructions.ts` `deliverInstructions`. */
export const insertInstruction = async (instruction: NewInstruction): Promise<InstructionRow> => {
  const [row] = await db
    .insert(gitInstructions)
    .values({ id: newId(), ...instruction })
    .returning();
  return row!;
};

/** A pull request's instructions, oldest first. */
export const listInstructions = (
  pullRequestId: string,
  status?: GitInstructionStatus,
): Promise<InstructionRow[]> =>
  db
    .select()
    .from(gitInstructions)
    .where(
      and(
        eq(gitInstructions.pullRequestId, pullRequestId),
        status === undefined ? undefined : eq(gitInstructions.status, status),
      ),
    )
    .orderBy(asc(gitInstructions.createdAt), asc(gitInstructions.id));

/** An instruction, only if it belongs to the pull request in the path. */
export const getInstruction = async (
  pullRequestId: string,
  instructionId: string,
): Promise<InstructionRow | null> => {
  const [row] = await db
    .select()
    .from(gitInstructions)
    .where(
      and(eq(gitInstructions.id, instructionId), eq(gitInstructions.pullRequestId, pullRequestId)),
    )
    .limit(1);
  return row ?? null;
};

/**
 * `queued` to `delivered`. Null when it was not queued any more: somebody
 * else delivered it, or it was dismissed. Whoever gets the row back is the
 * one that tells the agent.
 */
export const claimDelivery = async (
  instructionId: string,
  via: string,
  at: Date = new Date(),
): Promise<InstructionRow | null> => {
  const [row] = await db
    .update(gitInstructions)
    .set({ status: "delivered", deliveredVia: via, deliveredAt: at, updatedAt: at })
    .where(and(eq(gitInstructions.id, instructionId), eq(gitInstructions.status, "queued")))
    .returning();
  return row ?? null;
};

/** Back to `queued`: the agent could not be told after all. Leaves an answer or a dismissal alone. */
export const releaseDelivery = async (instructionId: string): Promise<void> => {
  await db
    .update(gitInstructions)
    .set({ status: "queued", deliveredVia: null, deliveredAt: null, updatedAt: new Date() })
    .where(and(eq(gitInstructions.id, instructionId), eq(gitInstructions.status, "delivered")));
};

/**
 * Say which version answers an instruction, or (`version` null) that the
 * next one pushed will. Null when it was dismissed. An instruction answered
 * before it was marked delivered was delivered by being answered.
 */
export const answerInstruction = async (
  instruction: InstructionRow,
  version: VersionRow | null,
  at: Date = new Date(),
): Promise<InstructionRow | null> => {
  const [row] = await db
    .update(gitInstructions)
    .set({
      status: "answered",
      answeredInVersionId: version?.id ?? null,
      answeredInVersionNumber: version?.number ?? null,
      answeredAt: at,
      // The same instant the columns beside it get, as the driver would write it.
      deliveredAt: sql`coalesce(${gitInstructions.deliveredAt}, ${at.toISOString()}::timestamp)`,
      updatedAt: at,
    })
    .where(
      and(
        eq(gitInstructions.id, instruction.id),
        inArray(gitInstructions.status, ["queued", "delivered", "answered"]),
      ),
    )
    .returning();
  if (row && version) await answerCommentThreads([row], version.number);
  return row ?? null;
};

/**
 * Take an instruction back. Null when a version already answers it: that is
 * on the record. One the agent has only promised to answer can still go.
 */
export const dismissInstruction = async (
  instructionId: string,
  userId: string | null,
  at: Date = new Date(),
): Promise<InstructionRow | null> => {
  const [row] = await db
    .update(gitInstructions)
    .set({
      status: "dismissed",
      dismissedByUserId: userId,
      dismissedAt: at,
      answeredAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(gitInstructions.id, instructionId),
        or(
          inArray(gitInstructions.status, ["queued", "delivered"]),
          and(
            eq(gitInstructions.status, "answered"),
            isNull(gitInstructions.answeredInVersionNumber),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
};

/**
 * The review threads these instructions came from say which version answered
 * them, where a push has not already said so (`reanchorThread`).
 */
const answerCommentThreads = async (
  rows: readonly InstructionRow[],
  versionNumber: number,
): Promise<void> => {
  const roots = rows
    .map((row) => row.reviewCommentId)
    .filter((id): id is string => typeof id === "string");
  if (roots.length === 0) return;
  await db
    .update(gitReviewComments)
    .set({ answeredInVersion: versionNumber })
    .where(
      and(
        or(inArray(gitReviewComments.id, roots), inArray(gitReviewComments.inReplyToId, roots)),
        isNull(gitReviewComments.answeredInVersion),
      ),
    );
};

/**
 * A version was recorded for a pull request: the instructions its agent
 * answered without naming a version are answered by this one. Only those
 * answered before the version was pushed; one marked afterwards waits for
 * the next. Safe to repeat: a settled instruction is not waiting any more.
 */
export const settleAnswered = async (version: VersionRow): Promise<InstructionRow[]> => {
  if (version.pullRequestId === null) return [];
  const rows = await db
    .update(gitInstructions)
    .set({
      answeredInVersionId: version.id,
      answeredInVersionNumber: version.number,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gitInstructions.pullRequestId, version.pullRequestId),
        eq(gitInstructions.status, "answered"),
        isNull(gitInstructions.answeredInVersionNumber),
        lte(gitInstructions.answeredAt, version.createdAt),
      ),
    )
    .returning();
  await answerCommentThreads(rows, version.number);
  return rows;
};

/** Agent kinds the forge tells itself, rather than waiting to be asked (`review/instructions.ts`). */
export const PUSH_KINDS = ["t3"] as const;

/**
 * Pull requests with an instruction that has waited since before `before`
 * and an agent the forge can tell itself: what the delivery sweep takes.
 */
export const pullRequestsAwaitingDelivery = async (
  before: Date,
  limit: number,
): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ pullRequestId: gitInstructions.pullRequestId })
    .from(gitInstructions)
    .innerJoin(gitAgentLinks, eq(gitAgentLinks.pullRequestId, gitInstructions.pullRequestId))
    .where(
      and(
        eq(gitInstructions.status, "queued"),
        lt(gitInstructions.createdAt, before),
        inArray(gitAgentLinks.kind, [...PUSH_KINDS]),
      ),
    )
    .limit(limit);
  return rows.map((row) => row.pullRequestId);
};
