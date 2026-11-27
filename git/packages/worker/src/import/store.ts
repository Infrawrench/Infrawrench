/**
 * An issue import's rows: the import itself (`git_issue_imports`) and what
 * it writes (labels, milestones, issues, comments).
 *
 * - **The token** is sealed with server-core's `encrypt` under
 *   `ENCRYPTION_MASTER_KEY`, bound to its row
 *   (`gitIssueImport:<id>:token`), and both columns are nulled by whatever
 *   ends the import: finishing, failing and cancelling.
 * - **One step at a time.** A step claims the row by stamping `updatedAt`
 *   and holds it by stamping it again with every page it saves; a second
 *   message for the same import finds the stamp fresh and does nothing. A
 *   step that ends lets go by writing a stamp a minute old
 *   ({@link RELEASED_MS}), so the message that follows it claims at once and
 *   the sweep (`jobs/sweep.ts`) still sees an import nobody has touched for
 *   three minutes two minutes later.
 * - **Writes are keyed by the source's ids** (`git_issues_import_idx`,
 *   `git_comments_import_idx`), so a page read twice, or the whole import
 *   run again, updates the rows it finds and adds none.
 * - **No counter is incremented.** {@link recountAfterImport} sets the
 *   counters the forge keeps (`comments_count`, a milestone's open and
 *   closed, the repository's open issues) from the rows, when an import
 *   ends however it ends.
 * - **Nothing else happens.** These are inserts and updates: no timeline
 *   event, no mention, no notification, no CI. The handlers do those
 *   (`api/handlers/issues.ts`), and an import does not go through them.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  type GitIssueImportPhase,
  type GitIssueImportProgress,
  type GitIssueState,
  type GitIssueStateReason,
  gitCollaborators,
  gitComments,
  gitCommitEmails,
  gitIssueAssignees,
  gitIssueImports,
  gitIssueLabels,
  gitIssues,
  gitLabels,
  gitMilestones,
  gitNamespaces,
  gitRepositories,
  organizationMembers,
  users,
} from "@infrawrench/server-core/db/schema";
import { buildAad, decrypt, encrypt } from "@infrawrench/server-core/encryption";
import { db, newId } from "../db/client";

export type IssueImportRow = typeof gitIssueImports.$inferSelect;

const SOURCE = "github" as const;
const ACTIVE = ["queued", "running"] as const;

/** How long a claim holds without a page being saved. Longer than a page can take. */
export const CLAIM_MS = 45_000;
/** How old a step's last stamp is written, so the next message claims at once. */
export const RELEASED_MS = 60_000;
/** What the sweep calls untouched. */
const SWEEP_AFTER_MS = 3 * 60_000;

const aad = (id: string): string => buildAad("gitIssueImport", id, "token");

const EMPTY_PROGRESS: GitIssueImportProgress = {
  page: 1,
  since: null,
  labels: 0,
  milestones: 0,
  issues: 0,
  comments: 0,
  authors: {},
};

// ---------------------------------------------------------------------------
// The import's own row
// ---------------------------------------------------------------------------

/**
 * Start an import. Null when the repository has one queued or running: the
 * repository's row is locked while that is checked, so two requests at once
 * make one import.
 *
 * A run after one that finished reads only what changed at the source since
 * that one began (`progress.since`).
 */
export const createIssueImport = async (input: {
  readonly repositoryId: string;
  readonly sourceRepository: string;
  readonly token: string;
  readonly startedByUserId: string | null;
}): Promise<IssueImportRow | null> => {
  const id = newId();
  const sealed = await encrypt(input.token, aad(id));
  return db.transaction(async (tx) => {
    await tx
      .select({ id: gitRepositories.id })
      .from(gitRepositories)
      .where(eq(gitRepositories.id, input.repositoryId))
      .for("update");
    const [active] = await tx
      .select({ id: gitIssueImports.id })
      .from(gitIssueImports)
      .where(
        and(
          eq(gitIssueImports.repositoryId, input.repositoryId),
          inArray(gitIssueImports.status, ACTIVE),
        ),
      )
      .limit(1);
    if (active) return null;
    const [previous] = await tx
      .select({ createdAt: gitIssueImports.createdAt })
      .from(gitIssueImports)
      .where(
        and(
          eq(gitIssueImports.repositoryId, input.repositoryId),
          eq(gitIssueImports.source, SOURCE),
          eq(gitIssueImports.status, "done"),
          sql`lower(${gitIssueImports.sourceRepository}) = ${input.sourceRepository.toLowerCase()}`,
        ),
      )
      .orderBy(desc(gitIssueImports.createdAt))
      .limit(1);
    const [row] = await tx
      .insert(gitIssueImports)
      .values({
        id,
        repositoryId: input.repositoryId,
        source: SOURCE,
        sourceRepository: input.sourceRepository,
        tokenEncrypted: sealed.ciphertext,
        tokenIv: sealed.iv,
        progress: { ...EMPTY_PROGRESS, since: previous?.createdAt.toISOString() ?? null },
        startedByUserId: input.startedByUserId,
      })
      .returning();
    return row!;
  });
};

/** A repository's imports, the newest first. */
export const listIssueImports = (repositoryId: string, limit = 20): Promise<IssueImportRow[]> =>
  db
    .select()
    .from(gitIssueImports)
    .where(eq(gitIssueImports.repositoryId, repositoryId))
    .orderBy(desc(gitIssueImports.createdAt))
    .limit(limit);

export const getIssueImport = async (id: string): Promise<IssueImportRow | null> => {
  const [row] = await db.select().from(gitIssueImports).where(eq(gitIssueImports.id, id)).limit(1);
  return row ?? null;
};

/** The import's token, or null when it is gone or was sealed under another key. */
export const openImportToken = async (row: IssueImportRow): Promise<string | null> => {
  if (row.tokenEncrypted === null || row.tokenIv === null) return null;
  try {
    return await decrypt(row.tokenEncrypted, row.tokenIv, aad(row.id));
  } catch {
    return null;
  }
};

/**
 * The imports owed a step that no message is carrying: queued or running,
 * not waiting on a rate limit, and untouched for three minutes.
 */
export const issueImportsDue = async (now = new Date()): Promise<string[]> => {
  const rows = await db
    .select({ id: gitIssueImports.id })
    .from(gitIssueImports)
    .where(
      and(
        inArray(gitIssueImports.status, ACTIVE),
        or(isNull(gitIssueImports.resumeAt), lte(gitIssueImports.resumeAt, now)),
        lt(gitIssueImports.updatedAt, new Date(now.getTime() - SWEEP_AFTER_MS)),
      ),
    )
    .orderBy(gitIssueImports.updatedAt)
    .limit(50);
  return rows.map((row) => row.id);
};

/** Mark an import as owed a step now: its message could not be sent, so the next sweep takes it. */
export const markIssueImportDue = async (id: string): Promise<void> => {
  await db
    .update(gitIssueImports)
    .set({ updatedAt: new Date(Date.now() - SWEEP_AFTER_MS - RELEASED_MS) })
    .where(and(eq(gitIssueImports.id, id), inArray(gitIssueImports.status, ACTIVE)));
};

/**
 * Take the import for one step. Null when it has ended, or when another
 * step holds it (it stamped the row within {@link CLAIM_MS}).
 */
export const claimIssueImport = async (
  id: string,
  now = new Date(),
): Promise<IssueImportRow | null> => {
  const [row] = await db
    .update(gitIssueImports)
    .set({ status: "running", resumeAt: null, updatedAt: now })
    .where(
      and(
        eq(gitIssueImports.id, id),
        or(
          eq(gitIssueImports.status, "queued"),
          and(
            eq(gitIssueImports.status, "running"),
            lt(gitIssueImports.updatedAt, new Date(now.getTime() - CLAIM_MS)),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
};

/**
 * Write where the import has got to, and keep the claim. False when it is
 * no longer running (cancelled, or the repository is gone): the step stops.
 */
export const saveIssueImportProgress = async (
  id: string,
  phase: GitIssueImportPhase,
  progress: GitIssueImportProgress,
): Promise<boolean> => {
  const saved = await db
    .update(gitIssueImports)
    .set({ phase, progress, updatedAt: new Date() })
    .where(and(eq(gitIssueImports.id, id), eq(gitIssueImports.status, "running")))
    .returning({ id: gitIssueImports.id });
  return saved.length > 0;
};

/** End a step with more to do: let go of the claim, and say when not to come back before. */
export const releaseIssueImport = async (
  id: string,
  resumeAt: Date | null = null,
): Promise<void> => {
  await db
    .update(gitIssueImports)
    .set({ resumeAt, updatedAt: new Date(Date.now() - RELEASED_MS) })
    .where(and(eq(gitIssueImports.id, id), eq(gitIssueImports.status, "running")));
};

const ended = { tokenEncrypted: null, tokenIv: null, resumeAt: null } as const;

export const finishIssueImport = async (id: string): Promise<void> => {
  const now = new Date();
  await db
    .update(gitIssueImports)
    .set({ ...ended, status: "done", error: null, updatedAt: now, finishedAt: now })
    .where(and(eq(gitIssueImports.id, id), eq(gitIssueImports.status, "running")));
};

/** `error` is a sentence written here: never a response, never the token. */
export const failIssueImport = async (id: string, error: string): Promise<void> => {
  const now = new Date();
  await db
    .update(gitIssueImports)
    .set({ ...ended, status: "failed", error, updatedAt: now, finishedAt: now })
    .where(and(eq(gitIssueImports.id, id), inArray(gitIssueImports.status, ACTIVE)));
};

/** Cancel a repository's import. The row as it is afterwards, or null when it is not this repository's. */
export const cancelIssueImport = async (
  repositoryId: string,
  id: string,
): Promise<IssueImportRow | null> => {
  const now = new Date();
  await db
    .update(gitIssueImports)
    .set({ ...ended, status: "cancelled", updatedAt: now, finishedAt: now })
    .where(
      and(
        eq(gitIssueImports.id, id),
        eq(gitIssueImports.repositoryId, repositoryId),
        inArray(gitIssueImports.status, ACTIVE),
      ),
    );
  const [row] = await db
    .select()
    .from(gitIssueImports)
    .where(and(eq(gitIssueImports.id, id), eq(gitIssueImports.repositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
};

// ---------------------------------------------------------------------------
// Who wrote it
// ---------------------------------------------------------------------------

/** The repository an import writes to, with what decides whose account a login is. */
export interface ImportTarget {
  readonly repositoryId: string;
  /** The person whose namespace owns it, or null for an organisation's. */
  readonly ownerUserId: string | null;
  /** The organisation whose namespace owns it, or null for a person's. */
  readonly organizationId: string | null;
}

export const importTarget = async (repositoryId: string): Promise<ImportTarget | null> => {
  const [row] = await db
    .select({
      repositoryId: gitRepositories.id,
      ownerUserId: gitNamespaces.userId,
      organizationId: gitNamespaces.organizationId,
    })
    .from(gitRepositories)
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(eq(gitRepositories.id, repositoryId))
    .limit(1);
  return row ?? null;
};

/** Whether the person already reaches the repository: its owner, a member of its organisation, or a collaborator. */
const reachesRepository = async (target: ImportTarget, userId: string): Promise<boolean> => {
  if (target.ownerUserId === userId) return true;
  if (target.organizationId !== null) {
    const [member] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, target.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (member) return true;
  }
  const [collaborator] = await db
    .select({ id: gitCollaborators.id })
    .from(gitCollaborators)
    .where(
      and(
        eq(gitCollaborators.repositoryId, target.repositoryId),
        eq(gitCollaborators.userId, userId),
      ),
    )
    .limit(1);
  return collaborator !== undefined;
};

/**
 * The account an address belongs to: the one it is the account address of,
 * or the one that verified it as a commit email where this repository
 * counts those (its organisation's, for a member still in it; its owner's
 * own, in a person's namespace). Null for none, or for more than one.
 */
export const accountByEmail = async (
  target: ImportTarget,
  email: string,
): Promise<string | null> => {
  const address = email.trim().toLowerCase();
  if (address === "" || !address.includes("@")) return null;
  const accounts = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${address}`)
    .limit(2);
  if (accounts.length === 1) return accounts[0]!.id;
  if (accounts.length > 1) return null;
  const verified = and(
    eq(gitCommitEmails.email, address),
    eq(gitCommitEmails.active, true),
    isNotNull(gitCommitEmails.verifiedAt),
  );
  if (target.organizationId !== null) {
    const [row] = await db
      .select({ userId: gitCommitEmails.userId })
      .from(gitCommitEmails)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, gitCommitEmails.organizationId),
          eq(organizationMembers.userId, gitCommitEmails.userId),
        ),
      )
      .where(and(verified, eq(gitCommitEmails.organizationId, target.organizationId)))
      .limit(1);
    return row?.userId ?? null;
  }
  if (target.ownerUserId === null) return null;
  const [row] = await db
    .select({ userId: gitCommitEmails.userId })
    .from(gitCommitEmails)
    .where(
      and(
        verified,
        isNull(gitCommitEmails.organizationId),
        eq(gitCommitEmails.userId, target.ownerUserId),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
};

/**
 * The person whose username here is the login, only if they already reach
 * the repository. Without that condition anyone could take a stranger's
 * issues by registering the stranger's GitHub name here.
 */
export const accountByUsername = async (
  target: ImportTarget,
  login: string,
): Promise<string | null> => {
  const [namespace] = await db
    .select({ userId: gitNamespaces.userId })
    .from(gitNamespaces)
    .where(and(eq(gitNamespaces.slugLower, login.toLowerCase()), eq(gitNamespaces.kind, "user")))
    .limit(1);
  const userId = namespace?.userId ?? null;
  if (userId === null) return null;
  return (await reachesRepository(target, userId)) ? userId : null;
};

// ---------------------------------------------------------------------------
// Labels and milestones
// ---------------------------------------------------------------------------

export interface ImportedLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

/**
 * The ids of these labels by lowercased name, creating the ones the
 * repository lacks. A label that exists is left as it is: its colour and
 * description may have been chosen here.
 */
export const ensureLabels = async (
  repositoryId: string,
  labels: readonly ImportedLabel[],
): Promise<Map<string, string>> => {
  const wanted = new Map(labels.map((label) => [label.name.toLowerCase(), label]));
  const ids = new Map<string, string>();
  if (wanted.size === 0) return ids;
  const read = async () => {
    const rows = await db
      .select({ id: gitLabels.id, nameLower: gitLabels.nameLower })
      .from(gitLabels)
      .where(
        and(
          eq(gitLabels.repositoryId, repositoryId),
          inArray(gitLabels.nameLower, [...wanted.keys()]),
        ),
      );
    for (const row of rows) ids.set(row.nameLower, row.id);
  };
  await read();
  const missing = [...wanted].filter(([nameLower]) => !ids.has(nameLower));
  if (missing.length > 0) {
    await db
      .insert(gitLabels)
      .values(
        missing.map(([nameLower, label]) => ({
          id: newId(),
          repositoryId,
          name: label.name,
          nameLower,
          color: label.color,
          description: label.description,
        })),
      )
      .onConflictDoNothing();
    await read();
  }
  return ids;
};

export interface ImportedMilestone {
  readonly title: string;
  readonly description: string | null;
  readonly state: "open" | "closed";
  /** `YYYY-MM-DD`. */
  readonly dueOn: string | null;
  readonly createdAt: Date | null;
  readonly closedAt: Date | null;
}

/** The id of the repository's milestone of this title (its first, by number), or null. */
export const milestoneIdByTitle = async (
  repositoryId: string,
  title: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ id: gitMilestones.id })
    .from(gitMilestones)
    .where(and(eq(gitMilestones.repositoryId, repositoryId), eq(gitMilestones.title, title)))
    .orderBy(gitMilestones.number)
    .limit(1);
  return row?.id ?? null;
};

/**
 * The repository's milestone of this title, made or brought up to the
 * source's state, due date and description. Its id.
 */
export const upsertMilestone = async (
  repositoryId: string,
  milestone: ImportedMilestone,
): Promise<string> =>
  db.transaction(async (tx) => {
    // The repository's row is the lock: two steps cannot both find no milestone of this title.
    const [counter] = await tx
      .select({ next: gitRepositories.nextMilestoneNumber })
      .from(gitRepositories)
      .where(eq(gitRepositories.id, repositoryId))
      .for("update");
    if (!counter) throw new Error(`Repository ${repositoryId} not found`);
    const [existing] = await tx
      .select({ id: gitMilestones.id })
      .from(gitMilestones)
      .where(
        and(eq(gitMilestones.repositoryId, repositoryId), eq(gitMilestones.title, milestone.title)),
      )
      .orderBy(gitMilestones.number)
      .limit(1);
    const fields = {
      description: milestone.description,
      state: milestone.state,
      dueOn: milestone.dueOn,
      closedAt: milestone.state === "closed" ? (milestone.closedAt ?? new Date()) : null,
    };
    if (existing) {
      await tx
        .update(gitMilestones)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(gitMilestones.id, existing.id));
      return existing.id;
    }
    await tx
      .update(gitRepositories)
      .set({ nextMilestoneNumber: counter.next + 1 })
      .where(eq(gitRepositories.id, repositoryId));
    const id = newId();
    await tx.insert(gitMilestones).values({
      id,
      repositoryId,
      number: counter.next,
      title: milestone.title,
      ...fields,
      ...(milestone.createdAt ? { createdAt: milestone.createdAt } : {}),
    });
    return id;
  });

// ---------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------

/**
 * Raise the repository's next number to at least `atLeast`. Done before the
 * first issue is written, with one past the highest number at the source, so
 * that a thread opened here meanwhile, and an imported issue whose number
 * was taken, are numbered past everything the source has and never land in
 * a gap that is a pull request there.
 */
export const raiseNextNumber = async (repositoryId: string, atLeast: number): Promise<void> => {
  await db
    .update(gitRepositories)
    .set({ nextNumber: sql`greatest(${gitRepositories.nextNumber}, ${atLeast})` })
    .where(eq(gitRepositories.id, repositoryId));
};

/** Raise the next number to one past the highest in use. */
export const raiseNextNumberPastThreads = async (repositoryId: string): Promise<void> => {
  await db
    .update(gitRepositories)
    .set({
      nextNumber: sql`greatest(${gitRepositories.nextNumber}, (select coalesce(max(${gitIssues.number}), 0) + 1 from ${gitIssues} where ${gitIssues.repositoryId} = ${repositoryId}))`,
    })
    .where(eq(gitRepositories.id, repositoryId));
};

export interface ImportedIssue {
  /** The source's own id for it, as text. */
  readonly importId: string;
  /** Its number at the source. */
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: GitIssueState;
  readonly stateReason: GitIssueStateReason | null;
  readonly author: string;
  readonly authorUserId: string | null;
  readonly url: string | null;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly milestoneId: string | null;
  readonly labelIds: readonly string[];
  readonly assigneeUserIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

/**
 * Write one issue: the row the source's id already has here, brought up to
 * date, or a new one.
 *
 * A new issue takes its number at the source when no thread here has it,
 * and the repository's next number otherwise. The repository's row is
 * locked first, which is what `allocateNumber` (`db/threads.ts`) also
 * takes, so a thread opened at the same moment is numbered before or after
 * this, never the same. An issue that is already here keeps its number.
 */
export const upsertIssue = async (
  repositoryId: string,
  issue: ImportedIssue,
): Promise<{ readonly id: string; readonly created: boolean }> =>
  db.transaction(async (tx) => {
    const [repository] = await tx
      .select({ next: gitRepositories.nextNumber })
      .from(gitRepositories)
      .where(eq(gitRepositories.id, repositoryId))
      .for("update");
    if (!repository) throw new Error(`Repository ${repositoryId} not found`);
    const [existing] = await tx
      .select({ id: gitIssues.id, authorUserId: gitIssues.authorUserId })
      .from(gitIssues)
      .where(
        and(
          eq(gitIssues.repositoryId, repositoryId),
          eq(gitIssues.importSource, SOURCE),
          eq(gitIssues.importId, issue.importId),
        ),
      )
      .limit(1);
    const fields = {
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      milestoneId: issue.milestoneId,
      locked: issue.locked,
      lockReason: issue.locked ? issue.lockReason : null,
      closedAt: issue.state === "closed" ? (issue.closedAt ?? issue.updatedAt) : null,
      importAuthor: issue.author,
      importUrl: issue.url,
      importNumber: issue.number,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await tx
        .update(gitIssues)
        .set({ ...fields, authorUserId: issue.authorUserId ?? existing.authorUserId })
        .where(eq(gitIssues.id, id));
      await tx.delete(gitIssueLabels).where(eq(gitIssueLabels.issueId, id));
      await tx.delete(gitIssueAssignees).where(eq(gitIssueAssignees.issueId, id));
    } else {
      const [taken] = await tx
        .select({ id: gitIssues.id })
        .from(gitIssues)
        .where(and(eq(gitIssues.repositoryId, repositoryId), eq(gitIssues.number, issue.number)))
        .limit(1);
      const number = taken ? repository.next : issue.number;
      if (number >= repository.next) {
        await tx
          .update(gitRepositories)
          .set({ nextNumber: number + 1 })
          .where(eq(gitRepositories.id, repositoryId));
      }
      id = newId();
      await tx.insert(gitIssues).values({
        id,
        repositoryId,
        number,
        isPullRequest: false,
        authorUserId: issue.authorUserId,
        importSource: SOURCE,
        importId: issue.importId,
        ...fields,
      });
    }
    if (issue.labelIds.length > 0) {
      await tx
        .insert(gitIssueLabels)
        .values([...new Set(issue.labelIds)].map((labelId) => ({ issueId: id, labelId })))
        .onConflictDoNothing();
    }
    if (issue.assigneeUserIds.length > 0) {
      await tx
        .insert(gitIssueAssignees)
        .values([...new Set(issue.assigneeUserIds)].map((userId) => ({ issueId: id, userId })))
        .onConflictDoNothing();
    }
    return { id, created: !existing };
  });

/** The imported issues with these numbers at the source, by that number. */
export const importedIssueIds = async (
  repositoryId: string,
  sourceNumbers: readonly number[],
): Promise<Map<number, string>> => {
  const unique = [...new Set(sourceNumbers)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: gitIssues.id, importNumber: gitIssues.importNumber })
    .from(gitIssues)
    .where(
      and(
        eq(gitIssues.repositoryId, repositoryId),
        eq(gitIssues.importSource, SOURCE),
        inArray(gitIssues.importNumber, unique),
      ),
    );
  return new Map(
    rows.flatMap((row) => (row.importNumber === null ? [] : [[row.importNumber, row.id]])),
  );
};

export interface ImportedComment {
  readonly importId: string;
  readonly issueId: string;
  readonly body: string;
  readonly author: string;
  readonly authorUserId: string | null;
  readonly url: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Write a page of comments: each updates the row its source id has here, or is added. */
export const upsertComments = async (
  repositoryId: string,
  comments: readonly ImportedComment[],
): Promise<void> => {
  if (comments.length === 0) return;
  const existing = new Map(
    (
      await db
        .select({
          id: gitComments.id,
          importId: gitComments.importId,
          authorUserId: gitComments.authorUserId,
        })
        .from(gitComments)
        .where(
          and(
            eq(gitComments.repositoryId, repositoryId),
            eq(gitComments.importSource, SOURCE),
            inArray(
              gitComments.importId,
              comments.map((comment) => comment.importId),
            ),
          ),
        )
    ).map((row) => [row.importId, row]),
  );
  const edited = (comment: ImportedComment) =>
    comment.updatedAt.getTime() > comment.createdAt.getTime() ? comment.updatedAt : null;
  const fresh: (typeof gitComments.$inferInsert)[] = [];
  for (const comment of comments) {
    const found = existing.get(comment.importId);
    if (!found) {
      fresh.push({
        id: newId(),
        issueId: comment.issueId,
        repositoryId,
        authorUserId: comment.authorUserId,
        body: comment.body,
        editedAt: edited(comment),
        importSource: SOURCE,
        importId: comment.importId,
        importAuthor: comment.author,
        importUrl: comment.url,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      });
      continue;
    }
    await db
      .update(gitComments)
      .set({
        body: comment.body,
        authorUserId: comment.authorUserId ?? found.authorUserId,
        editedAt: edited(comment),
        importAuthor: comment.author,
        importUrl: comment.url,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })
      .where(eq(gitComments.id, found.id));
  }
  if (fresh.length > 0) await db.insert(gitComments).values(fresh).onConflictDoNothing();
};

/**
 * Set the counters an import's rows are counted in from the rows
 * themselves: each imported issue's comments, every milestone's open and
 * closed threads, and the repository's open issues. Run when an import ends,
 * so one that is run again, or stopped half way, leaves them right.
 */
export const recountAfterImport = async (repositoryId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: gitRepositories.id })
      .from(gitRepositories)
      .where(eq(gitRepositories.id, repositoryId))
      .for("update");
    await tx.execute(sql`
      update ${gitIssues} set comments_count = (
        select count(*)::int from ${gitComments} where ${gitComments.issueId} = ${gitIssues.id}
      )
      where ${gitIssues.repositoryId} = ${repositoryId} and ${gitIssues.importSource} is not null
    `);
    await tx.execute(sql`
      update ${gitMilestones} set
        open_count = (
          select count(*)::int from ${gitIssues}
          where ${gitIssues.milestoneId} = ${gitMilestones.id} and ${gitIssues.state} = 'open'
        ),
        closed_count = (
          select count(*)::int from ${gitIssues}
          where ${gitIssues.milestoneId} = ${gitMilestones.id} and ${gitIssues.state} = 'closed'
        )
      where ${gitMilestones.repositoryId} = ${repositoryId}
    `);
    await tx.execute(sql`
      update ${gitRepositories} set open_issues_count = (
        select count(*)::int from ${gitIssues}
        where ${gitIssues.repositoryId} = ${repositoryId}
          and ${gitIssues.isPullRequest} = false and ${gitIssues.state} = 'open'
      )
      where ${gitRepositories.id} = ${repositoryId}
    `);
  });
};
