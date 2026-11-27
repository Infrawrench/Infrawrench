/**
 * Commit emails: the extra addresses a person's commits carry in one place
 * on git.infrawrench.com (`git_commit_emails`): one organisation they are a
 * member of, or their own namespace (a null `organization_id`). In that
 * place's repositories a commit with one is shown as theirs; anywhere else
 * the same address reads as it always did.
 *
 * - **An address counts once it is proved.** The person asks on the forge
 *   (Settings > Organisations, or Settings > Profile for their own
 *   repositories), a code is mailed to the address, and they type it back
 *   while signed in. Whoever only holds the mailbox cannot
 *   finish it for them, and whoever only holds the account cannot take an
 *   address they do not read.
 * - **The forge asks and the app sends.** The forge's Worker holds no mail
 *   key, so it stamps `send_requested_at`; {@link runGitCommitEmailPass}, a
 *   pass of the app's poller, makes the code, stores its hash and mails it.
 *   The code never crosses between the two, and nothing but its hash is kept.
 * - **It counts only while the person is a member.** Every read that turns
 *   an organisation's address into a person joins `organization_members`,
 *   and the pass deletes the rows of people who have left.
 * - **One member per address.** An address that is another member's account
 *   email, or one they have proved, is refused; the partial unique index
 *   settles two people proving the same one at once.
 * - **A person's own namespace has nobody else in it**, so the only address
 *   refused there for being someone else's is the one on another person's
 *   account, anywhere on the site: nobody shows that person's commits as
 *   their own. The two kinds never meet: an address proved in a person's own
 *   namespace does not stop anyone proving it in an organisation, nor the
 *   other way round.
 *
 * Postgres and the mail transport only, and imported by the forge's Worker:
 * nothing here may reach plugin code or a socket driver.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { gitBotForEmail } from "@infrawrench/client-core";

import { gitBaseUrl } from "../ci/source.js";
import { db } from "../db/client.js";
import { gitCommitEmails, organizationMembers, organizations, users } from "../db/schema.js";
import {
  type EmailMessage,
  isEmailConfigured,
  normalizeEmailAddress,
  sendEmails,
} from "../email.js";

/** How many addresses one person keeps in one organisation, or in their own namespace, proved or not. */
export const GIT_COMMIT_EMAIL_LIMIT = 10;
/** How long a mailed code works. */
export const GIT_COMMIT_EMAIL_CODE_TTL_MS = 24 * 60 * 60 * 1000;
/** Wrong codes allowed against one code before another must be sent. */
export const GIT_COMMIT_EMAIL_CODE_ATTEMPTS = 5;
/** How soon another code may be asked for. */
export const GIT_COMMIT_EMAIL_RESEND_MS = 60 * 1000;
/** A request the app could not send is tried again for this long, then left for the person to ask again. */
const SEND_WINDOW_MS = 15 * 60 * 1000;

/** Letters and digits nobody confuses on a screen: no I, L, O, U, 0 or 1. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

export interface GitCommitEmail {
  id: string;
  /** The organisation the address counts in. Null: the person's own namespace. */
  organizationId: string | null;
  email: string;
  verifiedAt: Date | null;
  /** When a code was last mailed. Null while the first one is on its way. */
  sentAt: Date | null;
  createdAt: Date;
}

export type GitCommitEmailRefusalCode =
  "email_invalid" | "email_taken" | "code_invalid" | "not_a_member" | "not_found" | "too_soon";

/** Why a request was refused, as the API words it in `error`. */
export interface GitCommitEmailRefusal {
  status: 400 | 403 | 404 | 409;
  code: GitCommitEmailRefusalCode;
  message: string;
}

export type GitCommitEmailResult =
  { ok: true; email: GitCommitEmail } | { ok: false; refusal: GitCommitEmailRefusal };

const refuse = (
  status: GitCommitEmailRefusal["status"],
  code: GitCommitEmailRefusalCode,
  message: string,
): GitCommitEmailResult => ({ ok: false, refusal: { status, code, message } });

const NOT_FOUND = refuse(404, "not_found", "No such address");
const NOT_A_MEMBER = refuse(403, "not_a_member", "You are not a member of that organisation");
const TAKEN = "That address belongs to another member of the organisation";
const TAKEN_PERSONAL = "That address is on another person's account";
const takenMessage = (organizationId: string | null): string =>
  organizationId === null ? TAKEN_PERSONAL : TAKEN;

/** The rows of one place: an organisation's, or (null) a person's own namespace's. */
const inScope = (organizationId: string | null) =>
  organizationId === null
    ? isNull(gitCommitEmails.organizationId)
    : eq(gitCommitEmails.organizationId, organizationId);

const columns = {
  id: gitCommitEmails.id,
  organizationId: gitCommitEmails.organizationId,
  email: gitCommitEmails.email,
  verifiedAt: gitCommitEmails.verifiedAt,
  sentAt: gitCommitEmails.sentAt,
  createdAt: gitCommitEmails.createdAt,
};

/** Postgres's unique violation, as the driver or drizzle's wrapper reports it. */
function isUniqueViolation(error: unknown): boolean {
  for (let e = error, depth = 0; e !== null && typeof e === "object" && depth < 4; depth++) {
    if ("code" in e && e.code === "23505") return true;
    e = "cause" in e ? e.cause : null;
  }
  return false;
}

/** Everyone is in their own namespace; an organisation asks its members. */
const isMember = async (organizationId: string | null, userId: string): Promise<boolean> => {
  if (organizationId === null) return true;
  const [row] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/** A row's owner is still in its organisation. A person's own namespace is never left. */
const stillMember = sql`(${gitCommitEmails.organizationId} is null or exists (
  select 1 from ${organizationMembers}
  where ${organizationMembers.organizationId} = ${gitCommitEmails.organizationId}
    and ${organizationMembers.userId} = ${gitCommitEmails.userId}
))`;

/**
 * Whether `email` is another member's in the organisation: the address on
 * their account, or one they have proved. Someone who has left is no member,
 * whatever rows they left. In a person's own namespace (null) it is whether
 * the address is on anyone else's account at all.
 */
const takenByAnotherMember = async (
  organizationId: string | null,
  userId: string,
  email: string,
): Promise<boolean> => {
  if (organizationId === null) {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(ne(users.id, userId), eq(sql`lower(${users.email})`, email)))
      .limit(1);
    return other !== undefined;
  }
  const [account] = await db
    .select({ id: users.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        ne(organizationMembers.userId, userId),
        eq(sql`lower(${users.email})`, email),
      ),
    )
    .limit(1);
  if (account !== undefined) return true;
  const [proved] = await db
    .select({ id: gitCommitEmails.id })
    .from(gitCommitEmails)
    .where(
      and(
        eq(gitCommitEmails.organizationId, organizationId),
        eq(gitCommitEmails.email, email),
        ne(gitCommitEmails.userId, userId),
        isNotNull(gitCommitEmails.verifiedAt),
        stillMember,
      ),
    )
    .limit(1);
  return proved !== undefined;
};

/** The rows people who have left an organisation kept for an address: they hold it for nobody. */
const dropDeparted = async (organizationId?: string, email?: string): Promise<void> => {
  await db
    .delete(gitCommitEmails)
    .where(
      and(
        organizationId === undefined
          ? undefined
          : eq(gitCommitEmails.organizationId, organizationId),
        email === undefined ? undefined : eq(gitCommitEmails.email, email),
        sql`not ${stillMember}`,
      ),
    );
};

/** A person's addresses in their own namespace and in these organisations, the oldest first. */
export async function listGitCommitEmails(
  userId: string,
  organizationIds: readonly string[],
): Promise<GitCommitEmail[]> {
  return db
    .select(columns)
    .from(gitCommitEmails)
    .where(
      and(
        eq(gitCommitEmails.userId, userId),
        organizationIds.length === 0
          ? isNull(gitCommitEmails.organizationId)
          : or(
              isNull(gitCommitEmails.organizationId),
              inArray(gitCommitEmails.organizationId, [...organizationIds]),
            ),
      ),
    )
    .orderBy(gitCommitEmails.createdAt, gitCommitEmails.id);
}

/**
 * Add an address for a member, or (a null organisation) for a person's own
 * namespace, and ask for its code. Adding one that is already waiting asks
 * again instead (as {@link resendGitCommitEmail}).
 */
export async function addGitCommitEmail(input: {
  organizationId: string | null;
  userId: string;
  email: string;
  now?: Date;
}): Promise<GitCommitEmailResult> {
  const now = input.now ?? new Date();
  let email: string;
  try {
    email = normalizeEmailAddress(input.email);
  } catch (error) {
    return refuse(400, "email_invalid", error instanceof Error ? error.message : "Invalid address");
  }
  if (gitBotForEmail(email) !== null) {
    return refuse(400, "email_invalid", "That address belongs to a bot account");
  }
  const [me] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!me || !(await isMember(input.organizationId, input.userId))) return NOT_A_MEMBER;
  if (me.email.toLowerCase() === email) {
    return refuse(400, "email_invalid", "That is the address on your account already");
  }
  if (await takenByAnotherMember(input.organizationId, input.userId, email)) {
    return refuse(409, "email_taken", takenMessage(input.organizationId));
  }
  const mine = await db
    .select({ ...columns, sendRequestedAt: gitCommitEmails.sendRequestedAt })
    .from(gitCommitEmails)
    .where(and(inScope(input.organizationId), eq(gitCommitEmails.userId, input.userId)));
  const existing = mine.find((row) => row.email === email);
  if (existing !== undefined) {
    if (existing.verifiedAt !== null) {
      return refuse(409, "email_taken", "You have added that address already");
    }
    return resendGitCommitEmail({ id: existing.id, userId: input.userId, now });
  }
  if (mine.length >= GIT_COMMIT_EMAIL_LIMIT) {
    return refuse(
      400,
      "email_invalid",
      input.organizationId === null
        ? `Your own repositories take at most ${GIT_COMMIT_EMAIL_LIMIT} commit emails`
        : `An organisation takes at most ${GIT_COMMIT_EMAIL_LIMIT} commit emails per member`,
    );
  }
  const [row] = await db
    .insert(gitCommitEmails)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      email,
      sendRequestedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning(columns);
  // Lost a race with the same request: the row is there, and its code is on its way.
  if (!row) return refuse(409, "email_taken", "You have added that address already");
  return { ok: true, email: row };
}

/** Ask for another code for an address that is still waiting. */
export async function resendGitCommitEmail(input: {
  id: string;
  userId: string;
  now?: Date;
}): Promise<GitCommitEmailResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ ...columns, sendRequestedAt: gitCommitEmails.sendRequestedAt })
    .from(gitCommitEmails)
    .where(and(eq(gitCommitEmails.id, input.id), eq(gitCommitEmails.userId, input.userId)))
    .limit(1);
  if (!row) return NOT_FOUND;
  if (row.verifiedAt !== null) {
    return refuse(409, "email_taken", "That address is verified already");
  }
  if (!(await isMember(row.organizationId, input.userId))) return NOT_A_MEMBER;
  if (
    row.sendRequestedAt !== null &&
    now.getTime() - row.sendRequestedAt.getTime() < GIT_COMMIT_EMAIL_RESEND_MS
  ) {
    return refuse(409, "too_soon", "A code was sent less than a minute ago");
  }
  const [updated] = await db
    .update(gitCommitEmails)
    .set({ sendRequestedAt: now })
    .where(and(eq(gitCommitEmails.id, row.id), isNull(gitCommitEmails.verifiedAt)))
    .returning(columns);
  return updated ? { ok: true, email: updated } : NOT_FOUND;
}

/** A code as typed: any case, with or without the dash or spaces it was shown with. */
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

const hashCode = async (id: string, code: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${id}:${normalizeCode(code)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Compared without stopping at the first difference. */
const sameHash = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
};

/**
 * Prove an address with the code mailed to it. The code works once, until it
 * expires, for {@link GIT_COMMIT_EMAIL_CODE_ATTEMPTS} wrong tries; after any
 * of those another must be sent.
 */
export async function verifyGitCommitEmail(input: {
  id: string;
  userId: string;
  code: string;
  now?: Date;
}): Promise<GitCommitEmailResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({
      ...columns,
      codeHash: gitCommitEmails.codeHash,
      codeExpiresAt: gitCommitEmails.codeExpiresAt,
      codeAttempts: gitCommitEmails.codeAttempts,
    })
    .from(gitCommitEmails)
    .where(and(eq(gitCommitEmails.id, input.id), eq(gitCommitEmails.userId, input.userId)))
    .limit(1);
  if (!row) return NOT_FOUND;
  const { codeHash, codeExpiresAt, codeAttempts, ...view } = row;
  if (row.verifiedAt !== null) return { ok: true, email: view };
  if (!(await isMember(row.organizationId, input.userId))) return NOT_A_MEMBER;
  if (codeHash === null || codeExpiresAt === null || codeExpiresAt.getTime() <= now.getTime()) {
    return refuse(400, "code_invalid", "That code has expired. Send another");
  }
  if (codeAttempts >= GIT_COMMIT_EMAIL_CODE_ATTEMPTS) {
    return refuse(400, "code_invalid", "Too many wrong codes. Send another");
  }
  if (!sameHash(codeHash, await hashCode(row.id, input.code))) {
    await db
      .update(gitCommitEmails)
      .set({ codeAttempts: sql`${gitCommitEmails.codeAttempts} + 1` })
      .where(and(eq(gitCommitEmails.id, row.id), eq(gitCommitEmails.codeHash, codeHash)));
    return refuse(400, "code_invalid", "That code is not right");
  }
  // Someone may have joined with the address, or proved it, since it was added.
  if (await takenByAnotherMember(row.organizationId, input.userId, row.email)) {
    return refuse(409, "email_taken", takenMessage(row.organizationId));
  }
  // Nobody leaves their own namespace: only an organisation has rows to drop.
  if (row.organizationId !== null) await dropDeparted(row.organizationId, row.email);
  try {
    // The hash in the condition is what makes the code single-use: a second
    // request with it finds nothing to update.
    const [verified] = await db
      .update(gitCommitEmails)
      .set({ verifiedAt: now, codeHash: null, codeExpiresAt: null, codeAttempts: 0 })
      .where(
        and(
          eq(gitCommitEmails.id, row.id),
          isNull(gitCommitEmails.verifiedAt),
          eq(gitCommitEmails.codeHash, codeHash),
        ),
      )
      .returning(columns);
    if (!verified) return refuse(400, "code_invalid", "That code has been used. Send another");
    return { ok: true, email: verified };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return refuse(409, "email_taken", takenMessage(row.organizationId));
    }
    throw error;
  }
}

/** Remove one of a person's addresses, proved or not. False when it is not theirs. */
export async function removeGitCommitEmail(input: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const removed = await db
    .delete(gitCommitEmails)
    .where(and(eq(gitCommitEmails.id, input.id), eq(gitCommitEmails.userId, input.userId)))
    .returning({ id: gitCommitEmails.id });
  return removed.length > 0;
}

/** A fresh code, as it is shown: `ABCD-EFGH`. */
export const newGitCommitEmailCode = (): string => {
  // 240 is the largest multiple of the alphabet's 30 letters in a byte: no letter is likelier.
  const letters: string[] = [];
  while (letters.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
      if (byte < 240 && letters.length < CODE_LENGTH) letters.push(CODE_ALPHABET[byte % 30]!);
    }
  }
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
};

/** The message a code travels in. Says who asked, so a stranger's request reads as one. */
export function gitCommitEmailMessage(input: {
  to: string;
  code: string;
  /** The organisation's name. Null: the requester's own repositories. */
  organization: string | null;
  requester: string;
  requesterEmail: string;
  forgeUrl: string;
}): EmailMessage {
  const host = input.forgeUrl.replace(/^https?:\/\//, "");
  const personal = input.organization === null;
  return {
    to: input.to,
    subject: personal
      ? `Confirm ${input.to} for commits in your own repositories`
      : `Confirm ${input.to} for commits in ${input.organization}`,
    text: [
      personal
        ? `${input.requester} (${input.requesterEmail}) asked for commits made with ${input.to} to be shown as theirs in their own repositories on ${host}.`
        : `${input.requester} (${input.requesterEmail}) asked for commits made with ${input.to} to be shown as theirs in ${input.organization}'s repositories on ${host}.`,
      "",
      `The code is ${input.code}`,
      "",
      personal
        ? `Enter it under Settings > Profile: ${input.forgeUrl}/settings`
        : `Enter it under Settings > Organisations: ${input.forgeUrl}/settings/organisations`,
      "It works for 24 hours.",
      "",
      "If you did not ask for this, ignore this message. Nothing changes without the code.",
    ].join("\n"),
  };
}

export interface GitCommitEmailPassOptions {
  now?: Date;
  /** At most this many codes a pass. */
  limit?: number;
  /** In place of the mail transport: answers whether the message left. Tests read the code here. */
  send?: (message: EmailMessage) => Promise<boolean>;
}

/**
 * The poller's pass: drop the addresses of people who have left their
 * organisation, then mail a code to every address that is owed one. A row is
 * taken by stamping `sent_at` in the statement that stores the code's hash,
 * so two instances never mail one request twice; a send that fails gives the
 * row back, and it is tried again until the request is fifteen minutes old.
 * Returns how many codes left.
 */
export async function runGitCommitEmailPass(
  options: GitCommitEmailPassOptions = {},
): Promise<number> {
  const now = options.now ?? new Date();
  await dropDeparted();
  // Without a mail provider nothing can be sent: the rows wait, and the forge says a code is on its way.
  if (options.send === undefined && !isEmailConfigured()) return 0;
  const send =
    options.send ??
    (async (message: EmailMessage) =>
      (await sendEmails([message], "git commit email")).succeeded === 1);
  const owed = and(
    isNull(gitCommitEmails.verifiedAt),
    isNotNull(gitCommitEmails.sendRequestedAt),
    or(isNull(gitCommitEmails.sentAt), lt(gitCommitEmails.sentAt, gitCommitEmails.sendRequestedAt)),
  );
  const rows = await db
    .select({
      id: gitCommitEmails.id,
      email: gitCommitEmails.email,
      sendRequestedAt: gitCommitEmails.sendRequestedAt,
      organization: organizations.displayName,
      requester: users.displayName,
      requesterEmail: users.email,
    })
    .from(gitCommitEmails)
    // Left: a person's own namespace has no organisation to name.
    .leftJoin(organizations, eq(organizations.id, gitCommitEmails.organizationId))
    .innerJoin(users, eq(users.id, gitCommitEmails.userId))
    .where(and(owed, gt(gitCommitEmails.sendRequestedAt, new Date(now.getTime() - SEND_WINDOW_MS))))
    .orderBy(gitCommitEmails.sendRequestedAt)
    .limit(options.limit ?? 20);
  let sent = 0;
  for (const row of rows) {
    const code = newGitCommitEmailCode();
    const [taken] = await db
      .update(gitCommitEmails)
      .set({
        codeHash: await hashCode(row.id, code),
        codeExpiresAt: new Date(now.getTime() + GIT_COMMIT_EMAIL_CODE_TTL_MS),
        codeAttempts: 0,
        // Never before the request, whatever the two clocks say, or it would be owed for ever.
        sentAt:
          row.sendRequestedAt !== null && row.sendRequestedAt > now ? row.sendRequestedAt : now,
      })
      .where(and(eq(gitCommitEmails.id, row.id), owed))
      .returning({ id: gitCommitEmails.id });
    if (!taken) continue;
    const left = await send(
      gitCommitEmailMessage({
        to: row.email,
        code,
        organization: row.organization,
        requester: row.requester ?? row.requesterEmail,
        requesterEmail: row.requesterEmail,
        forgeUrl: gitBaseUrl(),
      }),
    ).catch(() => false);
    if (left) sent += 1;
    else {
      // Given back: no code that nobody received stays good.
      await db
        .update(gitCommitEmails)
        .set({ sentAt: null, codeHash: null, codeExpiresAt: null })
        .where(and(eq(gitCommitEmails.id, row.id), isNull(gitCommitEmails.verifiedAt)));
    }
  }
  return sent;
}
