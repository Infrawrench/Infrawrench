/**
 * What Postgres adds to the commits a `RepoReader` answers: the Infrawrench
 * user an author's email belongs to (or the bot account, which needs no
 * lookup; or, in an organisation's repository, the member who verified the
 * address there), and the commit's combined status.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
 * People by the commit emails they have verified in the repository's
 * organisation (`git_commit_emails`, server-core `git/commit-emails.ts`).
 * Empty for a repository in a person's own namespace, connected to an
 * organisation or not: an address counts in the organisation's own
 * repositories and nowhere else. Someone who has left the organisation is
 * not found, whatever rows they left, and as with {@link usersByEmail} only
 * people with a username are named.
 */
export const usersByCommitEmail = async (
  repositoryId: string,
  emails: readonly string[],
): Promise<Map<string, UserRef>> => {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  // The repository's namespace (an organisation's) and the person's own (their username).
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
        eq(gitCommitEmails.organizationId, owner.organizationId),
        isNotNull(gitCommitEmails.verifiedAt),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, gitCommitEmails.organizationId),
        eq(organizationMembers.userId, gitCommitEmails.userId),
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
 * `statuses` is for lists a person reads as history; a tree listing leaves
 * them null, as the contract allows.
 */
/** A summary written down before `coAuthors` existed (a stored timeline) has none. */
const coAuthorsOf_ = (commit: CommitSummary): CommitSummary["coAuthors"] =>
  (commit.coAuthors as CommitSummary["coAuthors"] | undefined) ?? [];

export const commitDecorator = async (
  repositoryId: string,
  commits: ReadonlyArray<CommitSummary | null | undefined>,
  options: { readonly statuses: boolean } = { statuses: true },
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
    options.statuses
      ? combinedStatesFor(repositoryId, [...new Set(known.map((commit) => commit.oid))])
      : Promise.resolve(new Map<string, CommitSummary["status"]>()),
  ]);
  // A bot's address is the bot whatever the commit calls it; then the person
  // whose account has the address; then whoever verified it in the
  // repository's organisation.
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
