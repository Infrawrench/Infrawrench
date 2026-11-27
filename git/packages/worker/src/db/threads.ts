/**
 * Threads: issues and the conversation half of pull requests (`git_issues`),
 * with their comments, labels, assignees, milestones and timeline events.
 *
 * Numbers come from `git_repositories.next_number`, taken in the transaction
 * that inserts the thread, so two people opening an issue and a pull request
 * at once get consecutive numbers and neither insert can fail on the other.
 * The denormalised counters (`open_issues_count`, `comments_count`, a
 * milestone's `open_count`) move in the same transaction as the row they
 * count.
 */
import { type SQL, and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type GitIssueState,
  type GitIssueStateReason,
  type GitTimelineEventPayload,
  type GitTimelineEventType,
  gitComments,
  gitIssueAssignees,
  gitIssueLabels,
  gitIssues,
  gitLabels,
  gitMilestones,
  gitRepositories,
  gitTimelineEvents,
} from "@infrawrench/server-core/db/schema";
import { type Db, db, isUniqueViolation, newId } from "./client";
import { type PageOf, afterCursor, cursorTime, decodeCursor, pageSize, toPage } from "./cursor";

export type IssueRow = typeof gitIssues.$inferSelect;
export type CommentRow = typeof gitComments.$inferSelect;
export type LabelRow = typeof gitLabels.$inferSelect;
export type MilestoneRow = typeof gitMilestones.$inferSelect;
export type TimelineEventRow = typeof gitTimelineEvents.$inferSelect;

/** The handle inside `db.transaction`, which the helpers below also accept. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Take the repository's next issue or pull request number. Call inside a transaction. */
export const allocateNumber = async (tx: Tx, repositoryId: string): Promise<number> => {
  const [row] = await tx
    .update(gitRepositories)
    .set({ nextNumber: sql`${gitRepositories.nextNumber} + 1` })
    .where(eq(gitRepositories.id, repositoryId))
    .returning({ next: gitRepositories.nextNumber });
  if (!row) throw new Error(`Repository ${repositoryId} not found`);
  return row.next - 1;
};

const openCountColumn = (isPullRequest: boolean) =>
  isPullRequest ? gitRepositories.openPullRequestsCount : gitRepositories.openIssuesCount;

/** Move the repository's open counter and the milestone's counters by one thread opening or closing. */
const countStateChange = async (
  tx: Tx,
  thread: Pick<IssueRow, "repositoryId" | "isPullRequest" | "milestoneId">,
  to: GitIssueState,
): Promise<void> => {
  const column = openCountColumn(thread.isPullRequest);
  const delta = to === "open" ? 1 : -1;
  await tx
    .update(gitRepositories)
    .set(
      thread.isPullRequest
        ? { openPullRequestsCount: sql`greatest(${column} + ${delta}, 0)` }
        : { openIssuesCount: sql`greatest(${column} + ${delta}, 0)` },
    )
    .where(eq(gitRepositories.id, thread.repositoryId));
  if (thread.milestoneId) {
    await tx
      .update(gitMilestones)
      .set({
        openCount: sql`greatest(${gitMilestones.openCount} + ${delta}, 0)`,
        closedCount: sql`greatest(${gitMilestones.closedCount} - ${delta}, 0)`,
      })
      .where(eq(gitMilestones.id, thread.milestoneId));
  }
};

export interface NewThread {
  readonly repositoryId: string;
  readonly isPullRequest: boolean;
  readonly title: string;
  readonly body: string;
  readonly authorUserId: string | null;
  readonly milestoneId?: string | null;
  readonly labelIds?: readonly string[];
  readonly assigneeUserIds?: readonly string[];
}

/**
 * Insert a thread with the next number. Call inside a transaction; a pull
 * request's caller inserts its `git_pull_requests` row with the returned id
 * in the same one (`db/pulls.ts`).
 */
export const insertThread = async (tx: Tx, thread: NewThread): Promise<IssueRow> => {
  const number = await allocateNumber(tx, thread.repositoryId);
  const [row] = await tx
    .insert(gitIssues)
    .values({
      id: newId(),
      repositoryId: thread.repositoryId,
      number,
      isPullRequest: thread.isPullRequest,
      title: thread.title,
      body: thread.body,
      authorUserId: thread.authorUserId,
      milestoneId: thread.milestoneId ?? null,
    })
    .returning();
  const issue = row!;
  if (thread.labelIds?.length) {
    await tx
      .insert(gitIssueLabels)
      .values(thread.labelIds.map((labelId) => ({ issueId: issue.id, labelId })))
      .onConflictDoNothing();
  }
  if (thread.assigneeUserIds?.length) {
    await tx
      .insert(gitIssueAssignees)
      .values(thread.assigneeUserIds.map((userId) => ({ issueId: issue.id, userId })))
      .onConflictDoNothing();
  }
  await countStateChange(tx, issue, "open");
  return issue;
};

/** Open an issue. */
export const createIssue = (thread: Omit<NewThread, "isPullRequest">): Promise<IssueRow> =>
  db.transaction((tx) => insertThread(tx, { ...thread, isPullRequest: false }));

/** `#number` in a repository, whichever kind it is. */
export const getThread = async (repositoryId: string, number: number): Promise<IssueRow | null> => {
  const [row] = await db
    .select()
    .from(gitIssues)
    .where(and(eq(gitIssues.repositoryId, repositoryId), eq(gitIssues.number, number)))
    .limit(1);
  return row ?? null;
};

export interface ListThreadsOptions {
  readonly repositoryId: string;
  readonly isPullRequest: boolean;
  readonly state?: GitIssueState | "all";
  readonly authorUserId?: string | undefined;
  /** A user id, or `none` for unassigned. */
  readonly assignee?: string | "none" | undefined;
  /** A milestone id, or `none`. */
  readonly milestoneId?: string | "none" | undefined;
  /** Threads must carry every one of these labels. */
  readonly labelIds?: readonly string[] | undefined;
  /** Words to find in the title and body. */
  readonly q?: string | undefined;
  /** Conditions only the caller can write (a pull request's base, head, draft, reviewer). */
  readonly extra?: readonly SQL[] | undefined;
  readonly sort?: "created" | "updated" | "comments" | undefined;
  readonly direction?: "asc" | "desc" | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** `%` and `_` are literal in what a person typed. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

const threadFilters = (options: ListThreadsOptions): (SQL | undefined)[] => [
  eq(gitIssues.repositoryId, options.repositoryId),
  eq(gitIssues.isPullRequest, options.isPullRequest),
  options.authorUserId ? eq(gitIssues.authorUserId, options.authorUserId) : undefined,
  options.milestoneId === "none"
    ? sql`${gitIssues.milestoneId} is null`
    : options.milestoneId
      ? eq(gitIssues.milestoneId, options.milestoneId)
      : undefined,
  options.assignee === "none"
    ? sql`not exists (select 1 from ${gitIssueAssignees} where ${gitIssueAssignees.issueId} = ${gitIssues.id})`
    : options.assignee
      ? sql`exists (select 1 from ${gitIssueAssignees} where ${gitIssueAssignees.issueId} = ${gitIssues.id} and ${gitIssueAssignees.userId} = ${options.assignee})`
      : undefined,
  ...(options.labelIds ?? []).map(
    (labelId) =>
      sql`exists (select 1 from ${gitIssueLabels} where ${gitIssueLabels.issueId} = ${gitIssues.id} and ${gitIssueLabels.labelId} = ${labelId})`,
  ),
  ...(options.q ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map(
      (word) =>
        sql`(lower(${gitIssues.title}) like ${likePattern(word.toLowerCase())} or lower(${gitIssues.body}) like ${likePattern(word.toLowerCase())})`,
    ),
  ...(options.extra ?? []),
];

/**
 * One page of a repository's issues or pull requests, by creation, last
 * update or comment count.
 */
export const listThreads = async (options: ListThreadsOptions): Promise<PageOf<IssueRow>> => {
  const limit = pageSize(options.limit);
  const direction = options.direction ?? "desc";
  const order = direction === "desc" ? desc : asc;
  const cursor = decodeCursor(options.cursor);
  const state =
    options.state && options.state !== "all" ? eq(gitIssues.state, options.state) : undefined;
  if (options.sort === "comments") {
    // The cursor's number is the comment count here, not an instant.
    const after = cursor
      ? direction === "desc"
        ? sql`(${gitIssues.commentsCount}, ${gitIssues.id}) < (${cursor.at}, ${cursor.id})`
        : sql`(${gitIssues.commentsCount}, ${gitIssues.id}) > (${cursor.at}, ${cursor.id})`
      : undefined;
    const rows = await db
      .select()
      .from(gitIssues)
      .where(and(...threadFilters(options), state, after))
      .orderBy(order(gitIssues.commentsCount), order(gitIssues.id))
      .limit(limit + 1);
    return toPage(rows, limit, (row) => ({ at: row.commentsCount, id: row.id }));
  }
  const time = options.sort === "updated" ? gitIssues.updatedAt : gitIssues.createdAt;
  const rows = await db
    .select()
    .from(gitIssues)
    .where(
      and(...threadFilters(options), state, afterCursor(time, gitIssues.id, cursor, direction)),
    )
    .orderBy(order(cursorTime(time)), order(gitIssues.id))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({
    at: (options.sort === "updated" ? row.updatedAt : row.createdAt).getTime(),
    id: row.id,
  }));
};

/** How many threads match the list's filters in each state, for its Open and Closed tabs. */
export const countThreads = async (
  options: Omit<ListThreadsOptions, "state" | "cursor" | "limit" | "sort" | "direction">,
): Promise<{ open: number; closed: number }> => {
  const rows = await db
    .select({ state: gitIssues.state, count: sql<number>`count(*)::int` })
    .from(gitIssues)
    .where(and(...threadFilters(options)))
    .groupBy(gitIssues.state);
  const count = (state: GitIssueState) => rows.find((row) => row.state === state)?.count ?? 0;
  return { open: count("open"), closed: count("closed") };
};

export const updateThread = async (
  issueId: string,
  patch: { readonly title?: string; readonly body?: string },
): Promise<IssueRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitIssues)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body, bodyEditedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(gitIssues.id, issueId))
    .returning();
  return row ?? null;
};

/**
 * Close or reopen a thread. Null when it was already in that state, so two
 * people closing at once produce one change, one timeline event and one
 * counter move. Call inside a transaction when a pull request's merge fields
 * change with it.
 */
export const setThreadState = async (
  tx: Tx,
  issueId: string,
  state: GitIssueState,
  by: { readonly userId: string | null; readonly reason?: GitIssueStateReason | null },
): Promise<IssueRow | null> => {
  const now = new Date();
  const [row] = await tx
    .update(gitIssues)
    .set(
      state === "closed"
        ? {
            state,
            stateReason: by.reason ?? null,
            closedAt: now,
            closedByUserId: by.userId,
            updatedAt: now,
          }
        : { state, stateReason: null, closedAt: null, closedByUserId: null, updatedAt: now },
    )
    .where(and(eq(gitIssues.id, issueId), sql`${gitIssues.state} <> ${state}`))
    .returning();
  if (!row) return null;
  await countStateChange(tx, row, state);
  return row;
};

export const setThreadLock = async (
  issueId: string,
  locked: boolean,
  reason: string | null,
): Promise<void> => {
  await db
    .update(gitIssues)
    .set({ locked, lockReason: locked ? reason : null, updatedAt: new Date() })
    .where(eq(gitIssues.id, issueId));
};

/** Move a thread to another milestone (or none), keeping both milestones' counters right. */
export const setThreadMilestone = async (
  issueId: string,
  milestoneId: string | null,
): Promise<void> => {
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(gitIssues).where(eq(gitIssues.id, issueId)).limit(1);
    if (!before || before.milestoneId === milestoneId) return;
    const column = (state: GitIssueState) =>
      state === "open" ? gitMilestones.openCount : gitMilestones.closedCount;
    const bump = (id: string, delta: number) =>
      tx
        .update(gitMilestones)
        .set(
          before.state === "open"
            ? { openCount: sql`greatest(${column("open")} + ${delta}, 0)` }
            : { closedCount: sql`greatest(${column("closed")} + ${delta}, 0)` },
        )
        .where(eq(gitMilestones.id, id));
    if (before.milestoneId) await bump(before.milestoneId, -1);
    if (milestoneId) await bump(milestoneId, 1);
    await tx
      .update(gitIssues)
      .set({ milestoneId, updatedAt: new Date() })
      .where(eq(gitIssues.id, issueId));
  });
};

/** Replace a thread's labels. Answers what was added and removed, for the timeline. */
export const setThreadLabels = async (
  issueId: string,
  labelIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> =>
  db.transaction(async (tx) => {
    const current = (
      await tx
        .select({ labelId: gitIssueLabels.labelId })
        .from(gitIssueLabels)
        .where(eq(gitIssueLabels.issueId, issueId))
    ).map((row) => row.labelId);
    const added = labelIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !labelIds.includes(id));
    if (removed.length > 0) {
      await tx
        .delete(gitIssueLabels)
        .where(and(eq(gitIssueLabels.issueId, issueId), inArray(gitIssueLabels.labelId, removed)));
    }
    if (added.length > 0) {
      await tx
        .insert(gitIssueLabels)
        .values(added.map((labelId) => ({ issueId, labelId })))
        .onConflictDoNothing();
    }
    return { added, removed };
  });

/** Replace a thread's assignees. Answers who was added and removed, for the timeline. */
export const setThreadAssignees = async (
  issueId: string,
  userIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> =>
  db.transaction(async (tx) => {
    const current = (
      await tx
        .select({ userId: gitIssueAssignees.userId })
        .from(gitIssueAssignees)
        .where(eq(gitIssueAssignees.issueId, issueId))
    ).map((row) => row.userId);
    const added = userIds.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !userIds.includes(id));
    if (removed.length > 0) {
      await tx
        .delete(gitIssueAssignees)
        .where(
          and(eq(gitIssueAssignees.issueId, issueId), inArray(gitIssueAssignees.userId, removed)),
        );
    }
    if (added.length > 0) {
      await tx
        .insert(gitIssueAssignees)
        .values(added.map((userId) => ({ issueId, userId })))
        .onConflictDoNothing();
    }
    return { added, removed };
  });

/** The labels and assignees of a page of threads, by thread id: two queries for the whole page. */
export const threadDecorations = async (
  issueIds: readonly string[],
): Promise<{ labels: Map<string, LabelRow[]>; assignees: Map<string, string[]> }> => {
  const labels = new Map<string, LabelRow[]>();
  const assignees = new Map<string, string[]>();
  if (issueIds.length === 0) return { labels, assignees };
  const ids = [...issueIds];
  const [labelRows, assigneeRows] = await Promise.all([
    db
      .select({ issueId: gitIssueLabels.issueId, label: gitLabels })
      .from(gitIssueLabels)
      .innerJoin(gitLabels, eq(gitLabels.id, gitIssueLabels.labelId))
      .where(inArray(gitIssueLabels.issueId, ids))
      .orderBy(asc(gitLabels.nameLower)),
    db
      .select()
      .from(gitIssueAssignees)
      .where(inArray(gitIssueAssignees.issueId, ids))
      .orderBy(asc(gitIssueAssignees.createdAt)),
  ]);
  for (const row of labelRows)
    labels.set(row.issueId, [...(labels.get(row.issueId) ?? []), row.label]);
  for (const row of assigneeRows) {
    assignees.set(row.issueId, [...(assignees.get(row.issueId) ?? []), row.userId]);
  }
  return { labels, assignees };
};

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const addComment = async (comment: {
  readonly issueId: string;
  readonly repositoryId: string;
  readonly authorUserId: string | null;
  readonly body: string;
}): Promise<CommentRow> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gitComments)
      .values({ id: newId(), ...comment })
      .returning();
    await tx
      .update(gitIssues)
      .set({ commentsCount: sql`${gitIssues.commentsCount} + 1`, updatedAt: new Date() })
      .where(eq(gitIssues.id, comment.issueId));
    return row!;
  });

/** A comment, only if it belongs to the repository in the path. */
export const getComment = async (
  repositoryId: string,
  commentId: string,
): Promise<CommentRow | null> => {
  const [row] = await db
    .select()
    .from(gitComments)
    .where(and(eq(gitComments.id, commentId), eq(gitComments.repositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
};

export const editComment = async (commentId: string, body: string): Promise<CommentRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitComments)
    .set({ body, editedAt: now, updatedAt: now })
    .where(eq(gitComments.id, commentId))
    .returning();
  return row ?? null;
};

export const deleteComment = async (commentId: string): Promise<boolean> =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .delete(gitComments)
      .where(eq(gitComments.id, commentId))
      .returning({ issueId: gitComments.issueId });
    if (!row) return false;
    await tx
      .update(gitIssues)
      .set({ commentsCount: sql`greatest(${gitIssues.commentsCount} - 1, 0)` })
      .where(eq(gitIssues.id, row.issueId));
    return true;
  });

export const listComments = async (
  issueId: string,
  options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<PageOf<CommentRow>> => {
  const limit = pageSize(options.limit);
  const rows = await db
    .select()
    .from(gitComments)
    .where(
      and(
        eq(gitComments.issueId, issueId),
        afterCursor(gitComments.createdAt, gitComments.id, decodeCursor(options.cursor), "asc"),
      ),
    )
    .orderBy(asc(cursorTime(gitComments.createdAt)), asc(gitComments.id))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({ at: row.createdAt.getTime(), id: row.id }));
};

// ---------------------------------------------------------------------------
// Timeline events
// ---------------------------------------------------------------------------

/** Record something that happened to a thread. Accepts a transaction, so the event lands with its cause. */
export const addTimelineEvent = async (
  handle: Tx | Db,
  event: {
    readonly issueId: string;
    readonly repositoryId: string;
    readonly actorUserId: string | null;
    readonly type: GitTimelineEventType;
    readonly payload?: GitTimelineEventPayload;
    readonly at?: Date;
  },
): Promise<TimelineEventRow> => {
  const [row] = await handle
    .insert(gitTimelineEvents)
    .values({
      id: newId(),
      issueId: event.issueId,
      repositoryId: event.repositoryId,
      actorUserId: event.actorUserId,
      type: event.type,
      payload: event.payload ?? {},
      ...(event.at ? { createdAt: event.at } : {}),
    })
    .returning();
  return row!;
};

/**
 * A thread's events, oldest first. The timeline the API serves merges these
 * with comments (and, for a pull request, reviews) by `createdAt`; the
 * handler reads each from the same instant onward and interleaves them.
 */
export const listTimelineEvents = async (
  issueId: string,
  options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<PageOf<TimelineEventRow>> => {
  const limit = pageSize(options.limit);
  const rows = await db
    .select()
    .from(gitTimelineEvents)
    .where(
      and(
        eq(gitTimelineEvents.issueId, issueId),
        afterCursor(
          gitTimelineEvents.createdAt,
          gitTimelineEvents.id,
          decodeCursor(options.cursor),
          "asc",
        ),
      ),
    )
    .orderBy(asc(cursorTime(gitTimelineEvents.createdAt)), asc(gitTimelineEvents.id))
    .limit(limit + 1);
  return toPage(rows, limit, (row) => ({ at: row.createdAt.getTime(), id: row.id }));
};

// ---------------------------------------------------------------------------
// Labels and milestones
// ---------------------------------------------------------------------------

export const listLabels = (repositoryId: string): Promise<LabelRow[]> =>
  db
    .select()
    .from(gitLabels)
    .where(eq(gitLabels.repositoryId, repositoryId))
    .orderBy(asc(gitLabels.nameLower));

/** The labels with these names (any case) in a repository. Unknown names are simply absent. */
export const labelsByName = async (
  repositoryId: string,
  names: readonly string[],
): Promise<LabelRow[]> => {
  if (names.length === 0) return [];
  return db
    .select()
    .from(gitLabels)
    .where(
      and(
        eq(gitLabels.repositoryId, repositoryId),
        inArray(
          gitLabels.nameLower,
          names.map((name) => name.toLowerCase()),
        ),
      ),
    );
};

/** Create a label. Null when the repository has one of that name. */
export const createLabel = async (label: {
  readonly repositoryId: string;
  readonly name: string;
  readonly color: string;
  readonly description?: string | null;
}): Promise<LabelRow | null> => {
  try {
    const [row] = await db
      .insert(gitLabels)
      .values({
        id: newId(),
        repositoryId: label.repositoryId,
        name: label.name,
        nameLower: label.name.toLowerCase(),
        color: label.color.toLowerCase(),
        description: label.description ?? null,
      })
      .returning();
    return row!;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

/** Edit a label. `conflict` when the new name is taken, null when the label is gone. */
export const updateLabel = async (
  repositoryId: string,
  labelId: string,
  patch: {
    readonly name?: string;
    readonly color?: string;
    readonly description?: string | null;
  },
): Promise<LabelRow | "conflict" | null> => {
  try {
    const [row] = await db
      .update(gitLabels)
      .set({
        ...(patch.name !== undefined
          ? { name: patch.name, nameLower: patch.name.toLowerCase() }
          : {}),
        ...(patch.color !== undefined ? { color: patch.color.toLowerCase() } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      })
      .where(and(eq(gitLabels.id, labelId), eq(gitLabels.repositoryId, repositoryId)))
      .returning();
    return row ?? null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return "conflict";
  }
};

export const deleteLabel = async (repositoryId: string, labelId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitLabels)
    .where(and(eq(gitLabels.id, labelId), eq(gitLabels.repositoryId, repositoryId)))
    .returning({ id: gitLabels.id });
  return deleted.length > 0;
};

export const listMilestones = (
  repositoryId: string,
  state: "open" | "closed" | "all" = "open",
): Promise<MilestoneRow[]> =>
  db
    .select()
    .from(gitMilestones)
    .where(
      and(
        eq(gitMilestones.repositoryId, repositoryId),
        state === "all" ? undefined : eq(gitMilestones.state, state),
      ),
    )
    .orderBy(sql`${gitMilestones.dueOn} asc nulls last`, asc(gitMilestones.number));

export const getMilestone = async (
  repositoryId: string,
  number: number,
): Promise<MilestoneRow | null> => {
  const [row] = await db
    .select()
    .from(gitMilestones)
    .where(and(eq(gitMilestones.repositoryId, repositoryId), eq(gitMilestones.number, number)))
    .limit(1);
  return row ?? null;
};

export const createMilestone = async (milestone: {
  readonly repositoryId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly dueOn?: string | null;
}): Promise<MilestoneRow> =>
  db.transaction(async (tx) => {
    const [counter] = await tx
      .update(gitRepositories)
      .set({ nextMilestoneNumber: sql`${gitRepositories.nextMilestoneNumber} + 1` })
      .where(eq(gitRepositories.id, milestone.repositoryId))
      .returning({ next: gitRepositories.nextMilestoneNumber });
    if (!counter) throw new Error(`Repository ${milestone.repositoryId} not found`);
    const [row] = await tx
      .insert(gitMilestones)
      .values({
        id: newId(),
        repositoryId: milestone.repositoryId,
        number: counter.next - 1,
        title: milestone.title,
        description: milestone.description ?? null,
        dueOn: milestone.dueOn ?? null,
      })
      .returning();
    return row!;
  });

export const updateMilestone = async (
  milestoneId: string,
  patch: {
    readonly title?: string;
    readonly description?: string | null;
    readonly dueOn?: string | null;
    readonly state?: "open" | "closed";
  },
): Promise<MilestoneRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitMilestones)
    .set({
      ...patch,
      ...(patch.state !== undefined ? { closedAt: patch.state === "closed" ? now : null } : {}),
      updatedAt: now,
    })
    .where(eq(gitMilestones.id, milestoneId))
    .returning();
  return row ?? null;
};

export const deleteMilestone = async (milestoneId: string): Promise<boolean> => {
  const deleted = await db
    .delete(gitMilestones)
    .where(eq(gitMilestones.id, milestoneId))
    .returning({ id: gitMilestones.id });
  return deleted.length > 0;
};

/** Milestones by id, for a page of threads. */
export const milestonesById = async (
  ids: readonly string[],
): Promise<Map<string, MilestoneRow>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(gitMilestones).where(inArray(gitMilestones.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
};

/** Threads by id. */
export const threadsById = async (ids: readonly string[]): Promise<Map<string, IssueRow>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(gitIssues).where(inArray(gitIssues.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
};
