/**
 * What Postgres adds to the commits a `RepoReader` answers: the Infrawrench
 * user an author's email belongs to (or the bot account, which needs no
 * lookup), and the commit's combined status.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { botUserForEmail, type CommitSummary, type UserRef } from "@infrawrench/git-contract";
import { gitNamespaces, gitUsers, users } from "@infrawrench/server-core/db/schema";
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
  const [people, states] = await Promise.all([
    usersByEmail(
      known.flatMap((commit) => [
        commit.author.email,
        commit.committer.email,
        ...coAuthorsOf_(commit).map((person) => person.email),
      ]),
    ),
    options.statuses
      ? combinedStatesFor(repositoryId, [...new Set(known.map((commit) => commit.oid))])
      : Promise.resolve(new Map<string, CommitSummary["status"]>()),
  ]);
  // A bot's address is the bot whatever the commit calls it, before any person.
  const user = (email: string) => botUserForEmail(email) ?? people.get(email.toLowerCase()) ?? null;
  const decorate = <C extends CommitSummary>(commit: C): C => ({
    ...commit,
    authorUser: user(commit.author.email),
    coAuthors: coAuthorsOf_(commit).map((person) => ({ ...person, user: user(person.email) })),
    ...("committerUser" in commit ? { committerUser: user(commit.committer.email) } : {}),
    status: states.get(commit.oid) ?? null,
  });
  return Object.assign(decorate, { user });
};
