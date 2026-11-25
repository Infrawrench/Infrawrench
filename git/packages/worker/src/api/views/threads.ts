/**
 * Thread rows (issues, and the conversation half of pull requests) as the
 * contract's shapes, a page at a time: one lookup for the people, one for
 * the labels and assignees, one for the milestones.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  type Issue,
  type IssueSummary,
  type Label,
  type Milestone,
  type ThreadComment,
  type UserRef,
  accessAtLeast,
} from "@infrawrench/git-contract";
import { gitCollaborators, organizationMembers } from "@infrawrench/server-core/db/schema";
import { db } from "../../db/client";
import {
  type CommentRow,
  type IssueRow,
  type LabelRow,
  type MilestoneRow,
  milestonesById,
  threadDecorations,
} from "../../db/threads";
import type { RepoCx } from "../context";
import { iso, isoOrNull, peopleById } from "./repositories";

export const labelView = (row: LabelRow): Label => ({
  id: row.id,
  name: row.name,
  color: row.color,
  description: row.description,
});

export const milestoneView = (row: MilestoneRow): Milestone => ({
  id: row.id,
  number: row.number,
  title: row.title,
  description: row.description,
  state: row.state,
  dueOn: row.dueOn,
  openCount: row.openCount,
  closedCount: row.closedCount,
  createdAt: iso(row.createdAt),
  closedAt: isoOrNull(row.closedAt),
});

/** The fields an issue and a pull request share, for each thread of a page. */
export const threadFieldsFor = async (rows: readonly IssueRow[]) => {
  const ids = rows.map((row) => row.id);
  const [{ labels, assignees }, milestones] = await Promise.all([
    threadDecorations(ids),
    milestonesById(rows.flatMap((row) => (row.milestoneId ? [row.milestoneId] : []))),
  ]);
  const person = await peopleById([
    ...rows.flatMap((row) => [row.authorUserId, row.closedByUserId]),
    ...[...assignees.values()].flat(),
  ]);
  const fields = (row: IssueRow) => {
    const milestone = row.milestoneId ? milestones.get(row.milestoneId) : undefined;
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      author: person(row.authorUserId),
      labels: (labels.get(row.id) ?? []).map(labelView),
      assignees: (assignees.get(row.id) ?? []).flatMap((id): UserRef[] => {
        const found = person(id);
        return found ? [found] : [];
      }),
      milestone: milestone
        ? { id: milestone.id, number: milestone.number, title: milestone.title }
        : null,
      commentCount: row.commentsCount,
      locked: row.locked,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      closedAt: isoOrNull(row.closedAt),
    };
  };
  return { fields, person };
};

export const issueSummaries = async (rows: readonly IssueRow[]): Promise<IssueSummary[]> => {
  const { fields } = await threadFieldsFor(rows);
  return rows.map((row) => ({ ...fields(row), state: row.state, stateReason: row.stateReason }));
};

/** What the viewer may do to a thread. */
export const threadViewer = (cx: RepoCx, row: IssueRow) => {
  const isAuthor = cx.userId !== null && row.authorUserId === cx.userId;
  const canTriage = accessAtLeast(cx.access, "triage");
  const signedIn = cx.userId !== null && cx.username !== null;
  return {
    canEdit: signedIn && (isAuthor || canTriage),
    canTriage,
    canComment: signedIn && !cx.repo.repository.archived && (!row.locked || canTriage),
    canClose: signedIn && (isAuthor || canTriage),
  };
};

/** The body half of a thread, which an issue and a pull request both carry. */
export const threadBody = (row: IssueRow, person: (id: string | null) => UserRef | null) => ({
  body: row.body,
  bodyEditedAt: isoOrNull(row.bodyEditedAt),
  closedBy: person(row.closedByUserId),
  lockReason: row.lockReason,
});

export const issueDetail = async (cx: RepoCx, row: IssueRow): Promise<Issue> => {
  const { fields, person } = await threadFieldsFor([row]);
  return {
    ...fields(row),
    state: row.state,
    stateReason: row.stateReason,
    ...threadBody(row, person),
    viewer: threadViewer(cx, row),
  };
};

/** Which of these people are the repository's owner, a member of its organisation, or a collaborator. */
const authorBadges = async (
  cx: RepoCx,
  userIds: readonly string[],
): Promise<
  (userId: string | null, threadAuthorId: string | null) => ThreadComment["authorAccess"]
> => {
  const unique = [...new Set(userIds)];
  const { repository, owner } = cx.repo;
  const [members, collaborators] =
    unique.length === 0
      ? [[], []]
      : await Promise.all([
          owner.organizationId === null
            ? Promise.resolve([])
            : db
                .select({ userId: organizationMembers.userId })
                .from(organizationMembers)
                .where(
                  and(
                    eq(organizationMembers.organizationId, owner.organizationId),
                    inArray(organizationMembers.userId, unique),
                  ),
                ),
          db
            .select({ userId: gitCollaborators.userId })
            .from(gitCollaborators)
            .where(
              and(
                eq(gitCollaborators.repositoryId, repository.id),
                inArray(gitCollaborators.userId, unique),
              ),
            ),
        ]);
  const memberIds = new Set(members.map((row) => row.userId));
  const collaboratorIds = new Set(collaborators.map((row) => row.userId));
  return (userId, threadAuthorId) => {
    if (userId === null) return null;
    if (owner.userId === userId) return "owner";
    if (memberIds.has(userId)) return "member";
    if (collaboratorIds.has(userId)) return "collaborator";
    return userId === threadAuthorId ? "author" : null;
  };
};

/** Whether the viewer may edit or delete something `authorUserId` wrote: its author, or `write`. */
export const mayChangeOwn = (cx: RepoCx, authorUserId: string | null): boolean =>
  cx.userId !== null &&
  !cx.repo.repository.archived &&
  (authorUserId === cx.userId || accessAtLeast(cx.access, "write"));

export const commentViews = async (
  cx: RepoCx,
  thread: IssueRow,
  rows: readonly CommentRow[],
): Promise<ThreadComment[]> => {
  const authorIds = rows.flatMap((row) => (row.authorUserId ? [row.authorUserId] : []));
  const [person, badge] = await Promise.all([peopleById(authorIds), authorBadges(cx, authorIds)]);
  return rows.map((row) => {
    const mine = mayChangeOwn(cx, row.authorUserId);
    return {
      id: row.id,
      author: person(row.authorUserId),
      body: row.body,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      edited: row.editedAt !== null,
      authorAccess: badge(row.authorUserId, thread.authorUserId),
      viewerCanEdit: mine,
      viewerCanDelete: mine,
    };
  });
};
