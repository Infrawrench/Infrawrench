/**
 * `/api/workspace`: a person's work across repositories. The home page of
 * someone in agent mode in one call, the lists behind it, and the comments
 * that mention them. Rows come from `db/workspace.ts`, which keeps every
 * query to the repositories the viewer has a tie to.
 */
import { HttpApiBuilder } from "effect/http-api";
import {
  type ChangeState,
  type ChangeSummary,
  GitApi,
  type SuggestionReason,
} from "@infrawrench/git-contract";
import { decodeCursor, pageSize } from "../../db/cursor";
import { avatarOfNamespace, getNamespaceBySlug } from "../../db/namespaces";
import {
  type ChangeRow,
  type SuggestedRow,
  type WorkspaceScope,
  activitySince,
  countOpenChanges,
  listChanges,
  listMentions,
  listThreads,
  mentionPattern,
  pushedSince,
  suggestedReviews,
} from "../../db/workspace";
import { type Cx, op } from "../context";
import { iso, peopleById } from "../views/repositories";

/** How many of each list the home page shows. */
const HOME_ROWS = 5;
const HOME_ACTIVITY = 20;
const SUMMARY_LENGTH = 160;
const EXCERPT_LENGTH = 200;

const shorten = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

/** The first line of a description that says something, without its Markdown marks. */
export const summaryOf = (body: string): string | null => {
  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (line !== "" && !/^[-=]{3,}$/.test(line)) return shorten(line, SUMMARY_LENGTH);
  }
  return null;
};

export const changeStateOf = (row: ChangeRow): ChangeState =>
  row.mergedAt
    ? "merged"
    : row.threadState !== "open"
      ? "closed"
      : row.working
        ? "agent_working"
        : row.verdict === "changes_requested" || row.mustFixOpen > 0
          ? "changes_requested"
          : row.verdict === "approved"
            ? "approved"
            : "needs_review";

/** The line of a comment that names the viewer. */
export const excerptOf = (body: string, username: string): string => {
  const pattern = new RegExp(mentionPattern(username), "i");
  const line = body.split("\n").find((candidate) => pattern.test(candidate)) ?? body;
  return shorten(line.trim(), EXCERPT_LENGTH);
};

type Person = Awaited<ReturnType<typeof peopleById>>;

const changeView = (row: ChangeRow, person: Person): ChangeSummary => ({
  repository: {
    id: row.repositoryId,
    owner: row.owner,
    name: row.repositoryName,
    visibility: row.visibility,
  },
  number: row.number,
  title: row.title,
  branch: row.branch,
  draft: row.draft,
  state: changeStateOf(row),
  summary: summaryOf(row.body),
  headOid: row.headOid,
  author: person(row.authorUserId),
  agent:
    row.agentKind && row.agentName ? { kind: row.agentKind, displayName: row.agentName } : null,
  latestVersion: row.latestVersion,
  mustFixOpen: row.mustFixOpen,
  size: {
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
  },
  updatedAt: iso(row.updatedAt),
});

/** Why a branch is suggested, the strongest first. */
export const reasonsOf = (row: SuggestedRow): SuggestionReason[] => {
  const reasons: SuggestionReason[] = [];
  if (row.assigned) reasons.push({ kind: "assigned", version: null });
  if (row.reviewedVersion !== null) {
    reasons.push({ kind: "reviewed_before", version: row.reviewedVersion });
  }
  if (row.commented) reasons.push({ kind: "commented", version: row.commentedVersion });
  if (row.pushes) reasons.push({ kind: "pushes_to_repository", version: null });
  return reasons;
};

const scopeOf = async (cx: Cx, namespace: string | undefined): Promise<WorkspaceScope> => ({
  viewer: { ...(await cx.viewer()), userId: cx.userId! },
  namespace,
});

export const WorkspaceHandlers = HttpApiBuilder.group(GitApi, "workspace", (handlers) =>
  handlers
    .handle(
      "home",
      op(async (cx, { query }) => {
        const scope = await scopeOf(cx, query.namespace);
        const days = Number(query.days ?? "7");
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const open = { ...scope, state: "open", cursor: null, limit: HOME_ROWS } as const;
        const [namespace, counts, yours, team, suggested, pushed, activity] = await Promise.all([
          query.namespace === undefined ? null : getNamespaceBySlug(query.namespace),
          countOpenChanges(scope),
          listChanges({ ...open, author: "mine" }),
          listChanges({ ...open, author: "team" }),
          suggestedReviews(scope, HOME_ROWS),
          pushedSince(scope, since),
          activitySince(scope, since, HOME_ACTIVITY),
        ]);
        const person = await peopleById([
          ...[...yours.items, ...team.items, ...suggested.items].map((row) => row.authorUserId),
          ...activity.map((row) => row.actorUserId),
        ]);
        return {
          namespace: namespace
            ? {
                slug: namespace.slug,
                kind: namespace.kind,
                displayName: namespace.displayName,
                avatarUrl: await avatarOfNamespace(namespace),
              }
            : null,
          shared: namespace?.kind === "org" || counts.team > 0,
          activeBranches: counts.mine + counts.team,
          agentsWorking: counts.working,
          pushed: {
            days,
            versions: pushed.reduce((sum, row) => sum + row.versions, 0),
            repositories: pushed.slice(0, 6).map((row) => ({
              id: row.id,
              owner: row.owner,
              name: row.name,
              visibility: row.visibility,
            })),
          },
          yours: { count: counts.mine, items: yours.items.map((row) => changeView(row, person)) },
          team: { count: counts.team, items: team.items.map((row) => changeView(row, person)) },
          suggested: {
            count: suggested.count,
            items: suggested.items.map((row) => ({
              ...changeView(row, person),
              reviewedVersion: row.reviewedVersion,
              reasons: reasonsOf(row),
            })),
          },
          activity: activity.map((row) => ({
            id: row.id,
            type: row.type,
            at: iso(row.at),
            actor: person(row.actorUserId),
            agent: row.agent,
            repository: {
              id: row.repositoryId,
              owner: row.owner,
              name: row.repositoryName,
              visibility: row.visibility,
            },
            number: row.number,
            title: row.title,
            version: row.version,
            findings: row.found === null ? null : { found: row.found, mustFix: row.mustFix ?? 0 },
          })),
        };
      }),
    )
    .handle(
      "changes",
      op(async (cx, { query }) => {
        const page = await listChanges({
          ...(await scopeOf(cx, query.namespace)),
          state: query.state ?? "open",
          author: query.author ?? "all",
          cursor: decodeCursor(query.cursor),
          limit: pageSize(query.limit),
        });
        const person = await peopleById(page.items.map((row) => row.authorUserId));
        return {
          items: page.items.map((row) => changeView(row, person)),
          nextCursor: page.nextCursor,
        };
      }),
    )
    .handle(
      "threads",
      op(async (cx, { query }) => {
        const page = await listThreads({
          viewer: { ...(await cx.viewer()), userId: cx.userId! },
          username: cx.username,
          kind: query.kind,
          involvement: query.involvement,
          state: query.state ?? "open",
          cursor: decodeCursor(query.cursor),
          limit: pageSize(query.limit),
        });
        const person = await peopleById(page.items.map((row) => row.authorUserId));
        return {
          items: page.items.map((row) => ({
            id: row.id,
            repository: {
              id: row.repositoryId,
              owner: row.owner,
              name: row.repositoryName,
              visibility: row.visibility,
            },
            number: row.number,
            title: row.title,
            isPullRequest: row.isPullRequest,
            state: row.mergedAt
              ? ("merged" as const)
              : row.threadState === "open"
                ? ("open" as const)
                : ("closed" as const),
            draft: row.draft ?? false,
            author: person(row.authorUserId),
            commentCount: row.commentsCount,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          })),
          nextCursor: page.nextCursor,
        };
      }),
    )
    .handle(
      "mentions",
      op(async (cx, { query }) => {
        // Nobody is named before they have a name.
        if (cx.username === null) return { items: [], nextCursor: null };
        const username = cx.username;
        const page = await listMentions({ ...(await cx.viewer()), userId: cx.userId! }, username, {
          cursor: decodeCursor(query.cursor),
          limit: pageSize(query.limit),
        });
        const person = await peopleById(page.items.map((row) => row.authorUserId));
        return {
          items: page.items.map((row) => ({
            id: row.id,
            kind: row.kind,
            repository: {
              id: row.repositoryId,
              owner: row.owner,
              name: row.repositoryName,
              visibility: row.visibility,
            },
            number: row.number,
            title: row.title,
            isPullRequest: row.isPullRequest,
            author: person(row.authorUserId),
            excerpt: excerptOf(row.body, username),
            createdAt: iso(row.createdAt),
          })),
          nextCursor: page.nextCursor,
        };
      }),
    ),
);
