/**
 * Changes an issue and a pull request share (title, body, state, labels,
 * assignees, milestone, lock), each written with its timeline event.
 */
import { and, eq, sql } from "drizzle-orm";
import { accessAtLeast, forbidden, unprocessable } from "@infrawrench/git-contract";
import {
  type GitIssueStateReason,
  gitIssues,
  gitTimelineEvents,
} from "@infrawrench/server-core/db/schema";
import { db } from "../db/client";
import {
  type IssueRow,
  addTimelineEvent,
  getMilestone,
  labelsByName,
  listLabels,
  milestonesById,
  setThreadAssignees,
  setThreadLabels,
  setThreadMilestone,
  setThreadState,
  updateThread,
} from "../db/threads";
import { userByUsername } from "../db/users";
import type { RepoCx } from "./context";

export const isAuthor = (cx: RepoCx, thread: IssueRow): boolean =>
  cx.userId !== null && thread.authorUserId === cx.userId;

export const canTriage = (cx: RepoCx): boolean => accessAtLeast(cx.access, "triage");

export const requireTriage = (cx: RepoCx): void => {
  if (!canTriage(cx)) throw forbidden("This needs triage access to the repository");
};

/** Label ids for these names. An unknown name is the caller's mistake. */
export const labelIdsFor = async (
  repositoryId: string,
  names: readonly string[],
): Promise<string[]> => {
  const found = await labelsByName(repositoryId, names);
  const missing = names.find(
    (name) => !found.some((label) => label.nameLower === name.toLowerCase()),
  );
  if (missing !== undefined) throw unprocessable(`There is no label named ${missing}`);
  return found.map((label) => label.id);
};

/** User ids for these usernames. */
export const userIdsFor = async (usernames: readonly string[]): Promise<string[]> => {
  const ids: string[] = [];
  for (const username of [...new Set(usernames)]) {
    const person = await userByUsername(username);
    if (!person) throw unprocessable(`There is nobody named ${username}`);
    ids.push(person.id);
  }
  return ids;
};

/** The milestone id for a number, or null for none. */
export const milestoneIdFor = async (
  repositoryId: string,
  number: number | null,
): Promise<string | null> => {
  if (number === null) return null;
  const milestone = await getMilestone(repositoryId, number);
  if (!milestone) throw unprocessable(`There is no milestone ${number}`);
  return milestone.id;
};

export interface TriageEdit {
  readonly labels?: readonly string[] | undefined;
  readonly assignees?: readonly string[] | undefined;
  readonly milestone?: number | null | undefined;
}

export const hasTriageEdit = (edit: TriageEdit): boolean =>
  edit.labels !== undefined || edit.assignees !== undefined || edit.milestone !== undefined;

/** Replace a thread's labels, assignees and milestone, as far as `edit` names them. */
export const applyTriage = async (
  cx: RepoCx,
  thread: IssueRow,
  edit: TriageEdit,
): Promise<void> => {
  const repositoryId = cx.repo.repository.id;
  const event = { issueId: thread.id, repositoryId, actorUserId: cx.userId };

  if (edit.labels !== undefined) {
    const ids = await labelIdsFor(repositoryId, edit.labels);
    const all = new Map((await listLabels(repositoryId)).map((label) => [label.id, label]));
    const { added, removed } = await setThreadLabels(thread.id, ids);
    for (const [type, changed] of [
      ["labeled", added],
      ["unlabeled", removed],
    ] as const) {
      for (const labelId of changed) {
        const label = all.get(labelId);
        await addTimelineEvent(db, {
          ...event,
          type,
          payload: { labelId, labelName: label?.name ?? "", labelColor: label?.color ?? "" },
        });
      }
    }
  }

  if (edit.assignees !== undefined) {
    const ids = await userIdsFor(edit.assignees);
    const { added, removed } = await setThreadAssignees(thread.id, ids);
    for (const assigneeUserId of added) {
      await addTimelineEvent(db, { ...event, type: "assigned", payload: { assigneeUserId } });
    }
    for (const assigneeUserId of removed) {
      await addTimelineEvent(db, { ...event, type: "unassigned", payload: { assigneeUserId } });
    }
  }

  if (edit.milestone !== undefined) {
    const milestoneId = await milestoneIdFor(repositoryId, edit.milestone);
    if (milestoneId !== thread.milestoneId) {
      const titles = await milestonesById(
        [thread.milestoneId, milestoneId].filter((id): id is string => id !== null),
      );
      await setThreadMilestone(thread.id, milestoneId);
      if (thread.milestoneId) {
        await addTimelineEvent(db, {
          ...event,
          type: "demilestoned",
          payload: { milestoneTitle: titles.get(thread.milestoneId)?.title ?? "" },
        });
      }
      if (milestoneId) {
        await addTimelineEvent(db, {
          ...event,
          type: "milestoned",
          payload: { milestoneTitle: titles.get(milestoneId)?.title ?? "" },
        });
      }
    }
  }
};

/** Change a thread's title or body; a new title is a `renamed` event. */
export const applyText = async (
  cx: RepoCx,
  thread: IssueRow,
  edit: { readonly title?: string | undefined; readonly body?: string | undefined },
): Promise<void> => {
  const title = edit.title !== undefined && edit.title !== thread.title ? edit.title : undefined;
  const body = edit.body !== undefined && edit.body !== thread.body ? edit.body : undefined;
  if (title === undefined && body === undefined) return;
  await updateThread(thread.id, {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  if (title !== undefined) {
    await addTimelineEvent(db, {
      issueId: thread.id,
      repositoryId: thread.repositoryId,
      actorUserId: cx.userId,
      type: "renamed",
      payload: { from: thread.title, to: title },
    });
  }
  if (body !== undefined) await noteMentions(thread, body, cx.userId);
};

/**
 * Close or reopen a thread, with its event, as one change: two people
 * closing at once write one event. False when it was already there.
 */
export const applyState = async (
  thread: Pick<IssueRow, "id" | "repositoryId">,
  state: "open" | "closed",
  by: {
    readonly userId: string | null;
    readonly reason?: GitIssueStateReason | null;
    /** The commit whose message closed it. */
    readonly commitOid?: string;
    /** When the timeline says it happened; now when left out. */
    readonly at?: Date;
  },
): Promise<boolean> =>
  db.transaction(async (tx) => {
    const changed = await setThreadState(tx, thread.id, state, by);
    if (!changed) return false;
    await addTimelineEvent(tx, {
      issueId: thread.id,
      repositoryId: thread.repositoryId,
      actorUserId: by.userId,
      type: state === "closed" ? "closed" : "reopened",
      ...(by.at ? { at: by.at } : {}),
      payload:
        state === "closed"
          ? {
              stateReason: by.reason ?? null,
              ...(by.commitOid ? { commitOid: by.commitOid } : {}),
            }
          : {},
    });
    return true;
  });

/** The `#12` a text mentions, as numbers, without repeats and capped. */
export const mentionedNumbers = (text: string): number[] => {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?:^|[^\w&/])#(\d{1,9})\b/g)) {
    found.add(Number(match[1]));
    if (found.size >= 20) break;
  }
  return [...found];
};

/**
 * Note on each thread a text mentions that `source` mentioned it: a
 * `cross_referenced` event, once per pair however often it is mentioned.
 */
export const noteMentions = async (
  source: Pick<IssueRow, "id" | "repositoryId" | "number">,
  text: string,
  actorUserId: string | null,
): Promise<void> => {
  for (const number of mentionedNumbers(text)) {
    if (number === source.number) continue;
    const [target] = await db
      .select({ id: gitIssues.id })
      .from(gitIssues)
      .where(and(eq(gitIssues.repositoryId, source.repositoryId), eq(gitIssues.number, number)))
      .limit(1);
    if (!target) continue;
    const [seen] = await db
      .select({ id: gitTimelineEvents.id })
      .from(gitTimelineEvents)
      .where(
        and(
          eq(gitTimelineEvents.issueId, target.id),
          eq(gitTimelineEvents.type, "cross_referenced"),
          sql`${gitTimelineEvents.payload}->>'sourceIssueId' = ${source.id}`,
        ),
      )
      .limit(1);
    if (seen) continue;
    await addTimelineEvent(db, {
      issueId: target.id,
      repositoryId: source.repositoryId,
      actorUserId,
      type: "cross_referenced",
      payload: { sourceIssueId: source.id },
    });
  }
};
