/**
 * One step of an issue import (`jobs/consumer.ts` runs it for an
 * `issue-import` message).
 *
 * A step claims the import, reads pages from GitHub until about twenty
 * seconds or forty requests have gone, and answers `again` so the consumer
 * sends the next message. Where it has got to (`phase`, `progress.page`) is
 * saved after every page, so the next step, or the same one after a
 * restart, carries on at the page after the last one written. A page read
 * twice writes the same rows (`store.ts`).
 *
 * The phases, in order:
 *
 * 1. `labels`: created where the repository has none of that name.
 * 2. `milestones`: matched by title, with state, due date and description.
 * 3. `issues`: oldest first. Pull requests (the list returns them, with a
 *    `pull_request` key) are skipped and counted nowhere. Before the first
 *    page the repository's next number is raised past the source's highest.
 * 4. `comments`: the repository-wide list, each attached to the imported
 *    issue its `issue_url` names; a pull request's comments find none and
 *    are skipped.
 * 5. `finish`: the counters are set from the rows, the token is removed.
 *
 * A rate limit is not a failure: the step saves, writes `resumeAt` and
 * answers `again` with the wait (at most {@link MAX_AGAIN_SECONDS}; a
 * message that comes back early asks again). A refused token or a missing
 * repository fails the import with a sentence written here. GitHub being
 * away is tried again a minute later, for up to three days.
 *
 * The token is opened here and handed to the client and nothing else. No
 * log line and no stored error holds it or anything GitHub answered.
 */
import type {
  GitIssueImportPhase,
  GitIssueImportProgress,
  GitIssueStateReason,
} from "@infrawrench/server-core/db/schema";
import type { Env } from "../env";
import { describeError } from "../http/log";
import type { JobOutcome } from "../jobs/consumer";
import {
  type GitHubAnswer,
  type GitHubClient,
  type GitHubFetch,
  type GitHubIssue,
  type GitHubUser,
  GitHubError,
  issueNumberOf,
  makeGitHubClient,
} from "./github";
import {
  type ImportTarget,
  type IssueImportRow,
  accountByEmail,
  accountByUsername,
  claimIssueImport,
  ensureLabels,
  failIssueImport,
  finishIssueImport,
  getIssueImport,
  importTarget,
  importedIssueIds,
  milestoneIdByTitle,
  openImportToken,
  raiseNextNumber,
  raiseNextNumberPastThreads,
  recountAfterImport,
  releaseIssueImport,
  saveIssueImportProgress,
  upsertComments,
  upsertIssue,
  upsertMilestone,
} from "./store";

/** A step stops starting pages after this long. */
const STEP_MS = 20_000;
/** And after this many requests. */
const STEP_REQUESTS = 40;
/** The longest `again` a step answers: a queue's delay is bounded, and the sweep covers the rest. */
export const MAX_AGAIN_SECONDS = 900;
/** How soon to try again when GitHub could not be reached. */
const RETRY_SECONDS = 60;
/** An import that still cannot reach GitHub this long after it began fails. */
const GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000;

/** The login shown for something whose author's account is gone, as GitHub shows it. */
const GHOST = "ghost";
const TITLE_MAX = 256;
const BODY_MAX = 262_144;

export interface IssueImportDeps {
  /** GitHub's `fetch`. The platform's unless a test passes its own. */
  readonly fetch?: GitHubFetch;
  readonly now?: () => number;
  /** Overrides the step's budget, for tests that want one page a step. */
  readonly maxRequests?: number;
}

/** Why a step stopped before its phase did. */
type Pause =
  | { readonly kind: "wait"; readonly until: number }
  | { readonly kind: "budget" }
  | { readonly kind: "stopped" };

class Paused extends Error {
  constructor(readonly pause: Pause) {
    super("paused");
  }
}

const FAILURES: Partial<Record<GitHubError["kind"], string>> = {
  unauthorized: "GitHub refused the token",
  forbidden: "GitHub refused the token: it is not allowed to read this repository's issues",
  not_found: "No such repository, or the token cannot read it",
  gone: "Issues are switched off in that repository",
  redirect: "That repository has moved. Start again with its current owner and name",
  invalid: "GitHub answered in a form that was not understood",
  unexpected: "GitHub answered in a way that was not expected",
};

const dateOr = (value: string | null | undefined, fallback: Date): Date => {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
};

const dateOrNull = (value: string | null | undefined): Date | null => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Only a page on github.com is kept as a link. */
const sourceUrl = (value: string | null | undefined): string | null =>
  typeof value === "string" && value.startsWith("https://github.com/") && value.length <= 2000
    ? value
    : null;

const labelColor = (value: string | null | undefined): string =>
  typeof value === "string" && /^[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : "ededed";

/**
 * GitHub's state as the forge's. `duplicate` has no counterpart and is
 * `not_planned`, which is how GitHub itself groups it; `reopened` belongs
 * to an open issue, which has no reason here.
 */
export const stateOf = (
  issue: Pick<GitHubIssue, "state" | "state_reason">,
): { readonly state: "open" | "closed"; readonly stateReason: GitIssueStateReason | null } => {
  if (issue.state !== "closed") return { state: "open", stateReason: null };
  const reason = issue.state_reason;
  return {
    state: "closed",
    stateReason: reason === "not_planned" || reason === "duplicate" ? "not_planned" : "completed",
  };
};

const loginOf = (user: GitHubUser | null | undefined): string => user?.login ?? GHOST;

interface Step {
  readonly row: IssueImportRow;
  readonly target: ImportTarget;
  readonly github: GitHubClient;
  readonly startedAt: number;
  readonly now: () => number;
  readonly maxRequests: number;
  phase: GitIssueImportPhase;
  progress: GitIssueImportProgress;
}

const overBudget = (step: Step): boolean =>
  step.now() - step.startedAt >= STEP_MS || step.github.requests() >= step.maxRequests;

/** An answer's value, or the step pauses on its wait. */
const valueOf = <T>(answer: GitHubAnswer<T>): { readonly value: T; readonly more: boolean } => {
  if (answer.kind === "wait") throw new Paused({ kind: "wait", until: answer.until });
  return answer;
};

const save = async (step: Step): Promise<void> => {
  if (!(await saveIssueImportProgress(step.row.id, step.phase, step.progress))) {
    throw new Paused({ kind: "stopped" });
  }
};

/** Move to the next page of this phase, or to the first of the next. */
const advance = async (
  step: Step,
  more: boolean,
  next: GitIssueImportPhase,
  counted: Partial<Pick<GitIssueImportProgress, "labels" | "milestones" | "issues" | "comments">>,
): Promise<void> => {
  step.progress = {
    ...step.progress,
    ...counted,
    page: more ? step.progress.page + 1 : 1,
  };
  if (!more) step.phase = next;
  await save(step);
};

/**
 * The accounts here behind these logins, looked up once per login for the
 * whole import (`progress.authors`). A login is someone's when the address
 * on their GitHub profile is an account's here, or when it is the username
 * of someone who already reaches the repository (`store.ts`).
 *
 * What has been looked up is saved before a pause, so the page that is read
 * again does not ask again.
 */
const resolveAuthors = async (step: Step, users: readonly (GitHubUser | null | undefined)[]) => {
  const known: Record<string, string | null> = { ...step.progress.authors };
  const flush = async () => {
    step.progress = { ...step.progress, authors: known };
    await save(step);
  };
  const pending = new Map<string, GitHubUser>();
  for (const user of users) {
    if (!user || user.login === GHOST) continue;
    const key = user.login.toLowerCase();
    if (!(key in known) && !pending.has(key)) pending.set(key, user);
  }
  let looked = 0;
  for (const [key, user] of pending) {
    let email: string | null = null;
    // A bot or an app has no profile address to read.
    if (user.type === undefined || user.type === null || user.type === "User") {
      if (looked > 0 && overBudget(step)) {
        await flush();
        throw new Paused({ kind: "budget" });
      }
      const answer = await step.github.user(user.login);
      looked++;
      if (answer.kind === "wait") {
        await flush();
        throw new Paused({ kind: "wait", until: answer.until });
      }
      email = answer.value?.email ?? null;
    }
    known[key] =
      (email === null ? null : await accountByEmail(step.target, email)) ??
      (await accountByUsername(step.target, user.login));
  }
  if (pending.size > 0) step.progress = { ...step.progress, authors: known };
  return (user: GitHubUser | null | undefined): string | null =>
    user ? (known[user.login.toLowerCase()] ?? null) : null;
};

const labelsPage = async (step: Step): Promise<void> => {
  const { value, more } = valueOf(
    await step.github.labels(step.row.sourceRepository, step.progress.page),
  );
  await ensureLabels(
    step.target.repositoryId,
    value.map((label) => ({
      name: label.name.slice(0, 50),
      color: labelColor(label.color),
      description: label.description?.slice(0, 200) ?? null,
    })),
  );
  await advance(step, more, "milestones", { labels: step.progress.labels + value.length });
};

const milestonesPage = async (step: Step): Promise<void> => {
  const { value, more } = valueOf(
    await step.github.milestones(step.row.sourceRepository, step.progress.page),
  );
  for (const milestone of value) {
    await upsertMilestone(step.target.repositoryId, {
      title: milestone.title.slice(0, 200),
      description: milestone.description?.slice(0, 5000) ?? null,
      state: milestone.state === "closed" ? "closed" : "open",
      dueOn: /^\d{4}-\d{2}-\d{2}/.test(milestone.due_on ?? "")
        ? milestone.due_on!.slice(0, 10)
        : null,
      createdAt: dateOrNull(milestone.created_at),
      closedAt: dateOrNull(milestone.closed_at),
    });
  }
  await advance(step, more, "issues", { milestones: step.progress.milestones + value.length });
};

const issuesPage = async (step: Step): Promise<void> => {
  const repository = step.row.sourceRepository;
  const { repositoryId } = step.target;
  if (step.progress.page === 1) {
    // The newest issue or pull request has the highest number: reserve up to it.
    const newest = valueOf(await step.github.newestIssue(repository)).value;
    if (newest) await raiseNextNumber(repositoryId, newest.number + 1);
  }
  const { value, more } = valueOf(
    await step.github.issues(repository, {
      page: step.progress.page,
      since: step.progress.since,
    }),
  );
  const issues = value.filter((issue) => issue.pull_request === undefined);
  const account = await resolveAuthors(
    step,
    issues.flatMap((issue) => [issue.user, ...(issue.assignees ?? [])]),
  );
  const now = new Date(step.now());
  const labelNames = (issue: GitHubIssue): string[] =>
    (issue.labels ?? []).map((label) =>
      (typeof label === "string" ? label : label.name).slice(0, 50),
    );
  // The labels phase made these; one added at the source since is made here, uncoloured.
  const labelIdByName = await ensureLabels(
    repositoryId,
    issues.flatMap(labelNames).map((name) => ({ name, color: "ededed", description: null })),
  );
  const milestoneIds = new Map<string, string>();
  const milestoneIdFor = async (title: string): Promise<string> => {
    const known = milestoneIds.get(title);
    if (known !== undefined) return known;
    const id =
      (await milestoneIdByTitle(repositoryId, title)) ??
      // Made at the source after the milestones were read.
      (await upsertMilestone(repositoryId, {
        title,
        description: null,
        state: "open",
        dueOn: null,
        createdAt: null,
        closedAt: null,
      }));
    milestoneIds.set(title, id);
    return id;
  };
  for (const issue of issues) {
    const milestoneId = issue.milestone
      ? await milestoneIdFor(issue.milestone.title.slice(0, 200))
      : null;
    const createdAt = dateOr(issue.created_at, now);
    await upsertIssue(repositoryId, {
      importId: String(issue.id),
      number: issue.number,
      title: issue.title.slice(0, TITLE_MAX) || `#${issue.number}`,
      body: (issue.body ?? "").slice(0, BODY_MAX),
      ...stateOf(issue),
      author: loginOf(issue.user),
      authorUserId: account(issue.user),
      url: sourceUrl(issue.html_url),
      locked: issue.locked === true,
      lockReason: issue.active_lock_reason ?? null,
      milestoneId,
      labelIds: labelNames(issue).flatMap((name) => {
        const id = labelIdByName.get(name.toLowerCase());
        return id === undefined ? [] : [id];
      }),
      assigneeUserIds: (issue.assignees ?? []).flatMap((user) => {
        const id = account(user);
        return id === null ? [] : [id];
      }),
      createdAt,
      updatedAt: dateOr(issue.updated_at, createdAt),
      closedAt: dateOrNull(issue.closed_at),
    });
  }
  if (!more) await raiseNextNumberPastThreads(repositoryId);
  await advance(step, more, "comments", { issues: step.progress.issues + issues.length });
};

const commentsPage = async (step: Step): Promise<void> => {
  const { repositoryId } = step.target;
  const { value, more } = valueOf(
    await step.github.comments(step.row.sourceRepository, {
      page: step.progress.page,
      since: step.progress.since,
    }),
  );
  const numbered = value.flatMap((comment) => {
    const number = issueNumberOf(comment.issue_url);
    return number === null ? [] : [{ comment, number }];
  });
  const issueIds = await importedIssueIds(
    repositoryId,
    numbered.map((entry) => entry.number),
  );
  // A pull request's comments name a number no imported issue has.
  const ours = numbered.flatMap(({ comment, number }) => {
    const issueId = issueIds.get(number);
    return issueId === undefined ? [] : [{ comment, issueId }];
  });
  const account = await resolveAuthors(
    step,
    ours.map(({ comment }) => comment.user),
  );
  const now = new Date(step.now());
  await upsertComments(
    repositoryId,
    ours.map(({ comment, issueId }) => {
      const createdAt = dateOr(comment.created_at, now);
      return {
        importId: String(comment.id),
        issueId,
        body: (comment.body ?? "").slice(0, BODY_MAX),
        author: loginOf(comment.user),
        authorUserId: account(comment.user),
        url: sourceUrl(comment.html_url),
        createdAt,
        updatedAt: dateOr(comment.updated_at, createdAt),
      };
    }),
  );
  await advance(step, more, "finish", { comments: step.progress.comments + ours.length });
};

const PAGES: Record<Exclude<GitIssueImportPhase, "finish">, (step: Step) => Promise<void>> = {
  labels: labelsPage,
  milestones: milestonesPage,
  issues: issuesPage,
  comments: commentsPage,
};

const secondsUntil = (until: number, now: number): number =>
  Math.min(MAX_AGAIN_SECONDS, Math.max(1, Math.ceil((until - now) / 1000)));

/** End an import that cannot go on, leaving the counters right for what it wrote. */
const fail = async (row: IssueImportRow, sentence: string): Promise<JobOutcome> => {
  await failIssueImport(row.id, sentence);
  await recountAfterImport(row.repositoryId);
  return {};
};

/**
 * Run one step of an import. `{ again }` while there is more to do (the
 * next page at once, or after a rate limit's wait), `{}` once it has ended
 * or when another step has it.
 */
export const runIssueImportJob = async (
  _env: Env,
  importId: string,
  deps: IssueImportDeps = {},
): Promise<JobOutcome> => {
  const now = deps.now ?? Date.now;
  const before = await getIssueImport(importId);
  if (!before || (before.status !== "queued" && before.status !== "running")) return {};
  if (before.resumeAt !== null && before.resumeAt.getTime() > now()) {
    return { again: secondsUntil(before.resumeAt.getTime(), now()) };
  }
  const row = await claimIssueImport(importId, new Date(now()));
  if (!row) return {};

  const [token, target] = await Promise.all([openImportToken(row), importTarget(row.repositoryId)]);
  if (target === null) return fail(row, "The repository is gone");
  if (token === null) return fail(row, "The token is no longer held. Start the import again");

  const step: Step = {
    row,
    target,
    github: makeGitHubClient({
      token,
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      now,
    }),
    startedAt: now(),
    now,
    maxRequests: deps.maxRequests ?? STEP_REQUESTS,
    phase: row.phase,
    progress: row.progress,
  };

  try {
    while (step.phase !== "finish") {
      if (overBudget(step)) throw new Paused({ kind: "budget" });
      await PAGES[step.phase](step);
    }
    await raiseNextNumberPastThreads(target.repositoryId);
    await recountAfterImport(target.repositoryId);
    await finishIssueImport(row.id);
    return {};
  } catch (error) {
    if (error instanceof Paused) {
      const { pause } = error;
      if (pause.kind === "stopped") {
        // Cancelled while it ran: what it wrote stays, counted.
        await recountAfterImport(target.repositoryId);
        return {};
      }
      if (pause.kind === "budget") {
        await releaseIssueImport(row.id);
        return { again: 0 };
      }
      await releaseIssueImport(row.id, new Date(pause.until));
      return { again: secondsUntil(pause.until, now()) };
    }
    if (error instanceof GitHubError) {
      if (error.kind === "unavailable") {
        if (now() - row.createdAt.getTime() > GIVE_UP_MS) {
          return fail(row, "GitHub could not be reached");
        }
        await releaseIssueImport(row.id, new Date(now() + RETRY_SECONDS * 1000));
        return { again: RETRY_SECONDS };
      }
      return fail(row, FAILURES[error.kind] ?? "GitHub answered in a way that was not expected");
    }
    // Ours (the database, a bug): let go so the retry can claim, and let the consumer log it.
    await releaseIssueImport(row.id).catch((releaseError: unknown) =>
      console.error(
        `[git] issue import ${row.id} could not be released: ${describeError(releaseError)}`,
      ),
    );
    throw error;
  }
};
