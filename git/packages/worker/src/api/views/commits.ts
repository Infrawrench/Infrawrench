/**
 * What Postgres adds to the commits a `RepoReader` answers: the Infrawrench
 * user an author's email belongs to (or the bot account, which needs no
 * lookup; or, in an organisation's repository, the member who added the
 * address there), and the commit's combined status.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { botUserForEmail, type CommitSummary, type UserRef } from "@infrawrench/git-contract";
import { alias } from "drizzle-orm/pg-core";
import {
  gitCommitEmails,
  gitNamespaces,
  gitRepositories,
  gitUsers,
  organizationMembers,
  users,
} from "@infrawrench/server-core/db/schema";
import { db } from "../../db/client";
import { combinedStatesFor } from "../../db/policy";

/**
 * People on the forge by the email address on their Infrawrench account,
 * lowercased. Only people with a username, whose profile is public here: an
 * Infrawrench user who never claimed one is not named (nor their id or
 * display name) because a commit someone wrote carries their address.
 */
export const usersByEmail = async (emails: readonly string[]): Promise<Map<string, UserRef>> => {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      email: sql<string>`lower(${users.email})`,
      id: users.id,
      username: gitNamespaces.slug,
      displayName: sql<string | null>`coalesce(${gitNamespaces.displayName}, ${users.displayName})`,
      avatarUrl: sql<string | null>`coalesce(${gitNamespaces.avatarUrl}, ${gitUsers.avatarUrl})`,
    })
    .from(users)
    .innerJoin(gitNamespaces, eq(gitNamespaces.userId, users.id))
    .leftJoin(gitUsers, eq(gitUsers.userId, users.id))
    .where(inArray(sql`lower(${users.email})`, unique));
  return new Map(rows.map(({ email, ...user }) => [email, user]));
};

/**
 * People by the commit emails they have added for the repository's
 * namespace (`git_commit_emails`, server-core `git/commit-emails.ts`): in an
 * organisation's repository, its members' addresses there; in a person's own,
 * the addresses that person added for their own repositories, and nobody
 * else's. An address counts whether or not it was verified; only a row that
 * waits for its code (`active` false, another member has the address) does
 * not. An organisation's addresses never count in a person's repository,
 * connected to that organisation or not, and a person's never count in an
 * organisation's or in someone else's. Someone who has left the organisation
 * is not found, whatever rows they left, and as with {@link usersByEmail}
 * only people with a username are named.
 */
export const usersByCommitEmail = async (
  repositoryId: string,
  emails: readonly string[],
): Promise<Map<string, UserRef>> => {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  // The repository's namespace (an organisation's or a person's) and the person's own (their username).
  const owner = alias(gitNamespaces, "owner");
  const rows = await db
    .select({
      email: gitCommitEmails.email,
      id: users.id,
      username: gitNamespaces.slug,
      displayName: sql<string | null>`coalesce(${gitNamespaces.displayName}, ${users.displayName})`,
      avatarUrl: sql<string | null>`coalesce(${gitNamespaces.avatarUrl}, ${gitUsers.avatarUrl})`,
    })
    .from(gitRepositories)
    .innerJoin(owner, eq(owner.id, gitRepositories.namespaceId))
    .innerJoin(
      gitCommitEmails,
      and(
        eq(gitCommitEmails.active, true),
        or(
          and(
            eq(owner.kind, "org"),
            eq(gitCommitEmails.organizationId, owner.organizationId),
            sql`exists (
              select 1 from ${organizationMembers}
              where ${organizationMembers.organizationId} = ${gitCommitEmails.organizationId}
                and ${organizationMembers.userId} = ${gitCommitEmails.userId}
            )`,
          ),
          and(
            eq(owner.kind, "user"),
            isNull(gitCommitEmails.organizationId),
            eq(gitCommitEmails.userId, owner.userId),
          ),
        ),
      ),
    )
    .innerJoin(users, eq(users.id, gitCommitEmails.userId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.userId, users.id))
    .leftJoin(gitUsers, eq(gitUsers.userId, users.id))
    .where(and(eq(gitRepositories.id, repositoryId), inArray(gitCommitEmails.email, unique)));
  return new Map(rows.map(({ email, ...user }) => [email, user]));
};

export interface CommitDecorator {
  <C extends CommitSummary>(commit: C): C;
  /** The person an email belongs to. */
  user(email: string): UserRef | null;
}

/**
 * Look up everything these commits need at once, and answer each decorated.
 * `statuses` is for lists a person reads as history. A listing names the
 * commits it wants them for (a folder's own newest commit, which its header
 * shows) and leaves the rest null, as the contract allows.
 */
/** A summary written down before `coAuthors` existed (a stored timeline) has none. */
const coAuthorsOf_ = (commit: CommitSummary): CommitSummary["coAuthors"] =>
  (commit.coAuthors as CommitSummary["coAuthors"] | undefined) ?? [];

export const commitDecorator = async (
  repositoryId: string,
  commits: ReadonlyArray<CommitSummary | null | undefined>,
  options: { readonly statuses: boolean | readonly string[] } = { statuses: true },
): Promise<CommitDecorator> => {
  const known = commits.filter((commit): commit is CommitSummary => Boolean(commit));
  // A bot's address needs no lookup, and is never a person's.
  const emails = known
    .flatMap((commit) => [
      commit.author.email,
      commit.committer.email,
      ...coAuthorsOf_(commit).map((person) => person.email),
    ])
    .filter((email) => botUserForEmail(email) === null);
  // One query each for the whole page, whatever its length.
  const [people, aliases, states] = await Promise.all([
    usersByEmail(emails),
    usersByCommitEmail(repositoryId, emails),
    // One query for the page, whatever its length; none when nothing is asked for.
    options.statuses === false
      ? Promise.resolve(new Map<string, CommitSummary["status"]>())
      : combinedStatesFor(
          repositoryId,
          options.statuses === true
            ? [...new Set(known.map((commit) => commit.oid))]
            : [...new Set(options.statuses)],
        ),
  ]);
  // A bot's address is the bot whatever the commit calls it; then the person
  // whose account has the address; then whoever added it for the
  // repository's namespace: a member in an organisation's, the owner in their own.
  const user = (email: string) => {
    const lower = email.toLowerCase();
    return botUserForEmail(email) ?? people.get(lower) ?? aliases.get(lower) ?? null;
  };
  const decorate = <C extends CommitSummary>(commit: C): C => ({
    ...commit,
    authorUser: user(commit.author.email),
    coAuthors: coAuthorsOf_(commit).map((person) => ({ ...person, user: user(person.email) })),
    ...("committerUser" in commit ? { committerUser: user(commit.committer.email) } : {}),
    status: states.get(commit.oid) ?? null,
  });
  return Object.assign(decorate, { user });
};
