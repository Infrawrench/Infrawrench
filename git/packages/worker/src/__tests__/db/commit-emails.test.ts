/**
 * Who a commit's addresses are, against a real Postgres: the bot accounts,
 * then the person whose account has the address, then the member who added
 * it in the repository's organisation (and nowhere else), or, in a person's
 * own repository, that person's own addresses. An address counts from the
 * moment it is added. And the way one gets verified, which is optional:
 * asked for on the forge, mailed by the app's pass (server-core's
 * `runGitCommitEmailPass`, called here as the poller calls it), typed back
 * once, in time, by the person who asked; in an organisation that takes the
 * address over from a member who only added it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommitSummary } from "@infrawrench/git-contract";
import {
  gitCommitEmails,
  gitNamespaces,
  organizationMembers,
  users,
} from "@infrawrench/server-core/db/schema";
import {
  GIT_COMMIT_EMAIL_CODE_ATTEMPTS,
  GIT_COMMIT_EMAIL_CODE_TTL_MS,
  GIT_COMMIT_EMAIL_LIMIT,
  runGitCommitEmailPass,
} from "@infrawrench/server-core/git/commit-emails";
import type { EmailMessage } from "@infrawrench/server-core/email";
import { commitDecorator } from "../../api/views/commits";
import { db } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

const commit = (
  oid: string,
  authorEmail: string,
  options: { committer?: string; coAuthors?: Array<[string, string]> } = {},
): CommitSummary => {
  const signature = (name: string, email: string) => ({
    name,
    email,
    when: "2026-11-27T00:00:00.000Z",
    timezoneOffset: 0,
  });
  return {
    oid: oid.repeat(40).slice(0, 40),
    summary: "A change",
    hasBody: false,
    author: signature("As written", authorEmail),
    committer: signature("As written", options.committer ?? authorEmail),
    authorUser: null,
    coAuthors: (options.coAuthors ?? []).map(([name, email]) => ({ name, email, user: null })),
    parents: [],
    status: null,
  };
};

describe.skipIf(!configured)("commit emails", () => {
  let world: World;
  let ada: Person, ben: Person, cy: Person;
  /** Signed in, no username: named nowhere, as with an account address. */
  let nameless: Person;
  let acme: { id: string; slug: string };
  let other: { id: string; slug: string };
  let inAcme: { id: string; path: string };
  let inOther: { id: string; path: string };
  let adasOwn: { id: string; path: string };
  let bensOwn: { id: string; path: string };
  const address = (name: string) => `${name}-${world.suffix}@old.example.test`;

  /** What the app's pass mailed, newest last. */
  const outbox: EmailMessage[] = [];
  const pass = (now?: Date) =>
    runGitCommitEmailPass({
      ...(now ? { now } : {}),
      // This run's rows only: the database may hold another suite's.
      send: async (message) => {
        if (!message.to.includes(world.suffix)) return false;
        outbox.push(message);
        return true;
      },
    });
  const codeFor = (email: string): string => {
    const message = [...outbox].reverse().find((sent) => sent.to === email);
    const code = /The code is ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(message?.text ?? "")?.[1];
    if (!code) throw new Error(`No code was mailed to ${email}`);
    return code;
  };
  /** A null organisation is the person's own namespace. */
  const add = (as: Person, organizationId: string | null, email: string) =>
    world.call("POST", "/api/user/commit-emails", { as, body: { organizationId, email } });
  const verify = (as: Person, id: string, code: string) =>
    world.call("POST", `/api/user/commit-emails/${id}/verify`, { as, body: { code } });
  const list = async (as: Person): Promise<Array<Record<string, any>>> =>
    (await world.call("GET", "/api/user/commit-emails", { as })).body.emails;
  const remove = (as: Person, id: string) =>
    world.call("DELETE", `/api/user/commit-emails/${id}`, { as });
  /** Ask for a code, which adding an address does not. */
  const send = (as: Person, id: string) =>
    world.call("POST", `/api/user/commit-emails/${id}/send`, { as });
  /** Add and verify in one go. */
  const proved = async (as: Person, organizationId: string | null, email: string) => {
    const added = await add(as, organizationId, email);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect((await send(as, added.body.id)).status).toBe(200);
    await pass();
    const done = await verify(as, added.body.id, codeFor(email));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return added.body.id as string;
  };
  const who = async (repositoryId: string, email: string) =>
    (await commitDecorator(repositoryId, [commit("a", email)], { statuses: false }))(
      commit("a", email),
    ).authorUser;

  beforeAll(async () => {
    world = makeWorld();
    [ada, ben, cy] = (await Promise.all(
      ["ada", "ben", "cy"].map((name) => world.person(name)),
    )) as [Person, Person, Person];
    nameless = await world.person("nameless", { username: false });
    acme = await world.organization("acme", {
      paid: true,
      members: [
        [ada, "owner"],
        [ben, "member"],
        [nameless, "member"],
      ],
    });
    other = await world.organization("other", {
      paid: true,
      members: [
        [ada, "owner"],
        [cy, "member"],
      ],
    });
    inAcme = await world.repository(ada, acme.slug, "infra");
    inOther = await world.repository(ada, other.slug, "infra");
    adasOwn = await world.repository(ada, ada.username, "notes");
    bensOwn = await world.repository(ben, ben.username, "notes");
  });
  afterAll(async () => {
    if (!world) return;
    await world.cleanup();
  });

  it("names the bot accounts whatever the commit wrote, with no person looked for", async () => {
    const commits = [
      commit("b", "NoReply@Anthropic.com", {
        coAuthors: [
          ["Cursor", "cursoragent@cursor.com"],
          ["Ada", ada.email],
        ],
      }),
      commit("c", ada.email, {
        committer: "cursoragent@cursor.com",
        coAuthors: [["Claude Opus 5.5", "noreply@anthropic.com"]],
      }),
    ];
    const decorate = await commitDecorator(inAcme.id, commits, { statuses: false });
    const first = decorate(commits[0]!);
    expect(first.authorUser).toEqual({
      id: "bot:claude",
      username: "claude",
      displayName: "Claude",
      avatarUrl: "/assets/bots/claude-icon.svg",
      kind: "bot",
    });
    expect(first.coAuthors.map((person) => person.user?.username)).toEqual([
      "cursor",
      ada.username,
    ]);
    expect(first.coAuthors[0]!.user?.kind).toBe("bot");
    expect(decorate(commits[1]!).coAuthors[0]!.user?.displayName).toBe("Claude");
    expect(decorate.user("CURSORAGENT@cursor.com")?.id).toBe("bot:cursor");
    // The same in a person's own repository: a bot is sitewide.
    expect((await who(adasOwn.id, "noreply@anthropic.com"))?.username).toBe("claude");
  });

  it("keeps the bots' usernames from a person and from an organisation", async () => {
    const fresh = await world.person("fresh", { username: false });
    for (const username of ["claude", "Cursor"]) {
      const asked = await world.call(
        "GET",
        `/api/session/username-availability?username=${username}`,
        { as: fresh },
      );
      expect(asked.body.available).toBe(false);
      expect(asked.body.message).toBe("That name belongs to a bot account");
      const claimed = await world.call("POST", "/api/session/username", {
        as: fresh,
        body: { username },
      });
      expect(claimed.status).toBe(400);
    }
    const unnamed = await world.organization("unnamed", {
      paid: true,
      members: [[ada, "owner"]],
      namespace: false,
    });
    // A platform admin is let past `reserved`, never past a bot's name.
    (
      world.env as { INFRAWRENCH_PLATFORM_ADMIN_EMAILS?: string }
    ).INFRAWRENCH_PLATFORM_ADMIN_EMAILS = ada.email;
    const taken = await world.call("POST", `/api/orgs/${unnamed.id}/namespace`, {
      as: ada,
      body: { slug: "claude" },
    });
    delete (world.env as { INFRAWRENCH_PLATFORM_ADMIN_EMAILS?: string })
      .INFRAWRENCH_PLATFORM_ADMIN_EMAILS;
    expect(taken.status).toBe(400);
    expect(taken.body.error).toBe("That name belongs to a bot account");
  });

  it("counts an address from the moment it is added, and verifies it only when asked", async () => {
    const email = address("ada-added");
    const added = await add(ada, acme.id, ` ${email.toUpperCase()} `);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      organizationId: acme.id,
      email,
      active: true,
      verifiedAt: null,
      codeRequestedAt: null,
      codeSentAt: null,
    });
    // Hers at once, whatever the case, and nothing is mailed.
    expect((await who(inAcme.id, email.toUpperCase()))?.username).toBe(ada.username);
    expect(await pass()).toBe(0);
    expect(outbox.some((sent) => sent.to === email)).toBe(false);

    // Verifying is asked for, and the address goes on counting meanwhile.
    const asked = await send(ada, added.body.id);
    expect(asked.status).toBe(200);
    expect(asked.body.codeRequestedAt).not.toBeNull();
    expect(await pass()).toBe(1);
    expect(
      (await list(ada)).find((row) => row["id"] === added.body.id)?.["codeSentAt"],
    ).not.toBeNull();
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    const message = outbox.at(-1)!;
    expect(message.to).toBe(email);
    expect(message.subject).toBe(`Verify ${email} for commits in acme`);
    expect(message.text).toContain(ada.email);
    // The pass does not mail the same request twice.
    expect(await pass()).toBe(0);

    const done = await verify(ada, added.body.id, codeFor(email).toLowerCase().replace("-", " "));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ active: true });
    expect(done.body.verifiedAt).not.toBeNull();
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    // Verified already: no more codes.
    expect((await send(ada, added.body.id)).status).toBe(409);
  });

  it("resolves an address in its organisation's repositories and nowhere else", async () => {
    const email = address("ada-scoped");
    await proved(ada, acme.id, email);
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    // Ada is in the other organisation too, and owns the third repository: not there.
    expect(await who(inOther.id, email)).toBeNull();
    expect(await who(adasOwn.id, email)).toBeNull();

    // Author, committer and co-author alike, and beside an account address.
    const one = commit("d", ben.email, { committer: email, coAuthors: [["Old Ada", email]] });
    const decorate = await commitDecorator(inAcme.id, [one], { statuses: false });
    const seen = decorate({ ...one, committerUser: null } as CommitSummary) as CommitSummary & {
      committerUser: { username: string } | null;
    };
    expect(seen.authorUser?.username).toBe(ben.username);
    expect(seen.committerUser?.username).toBe(ada.username);
    expect(seen.coAuthors[0]!.user?.username).toBe(ada.username);
  });

  it("lets the same address be someone else's in another organisation", async () => {
    const email = address("shared");
    await proved(ben, acme.id, email);
    await proved(cy, other.id, email);
    expect((await who(inAcme.id, email))?.username).toBe(ben.username);
    expect((await who(inOther.id, email))?.username).toBe(cy.username);
  });

  it("puts the account's address before an alias", async () => {
    // Cy is no member of Acme, so Ben may add Cy's address there.
    const stolen = await add(ben, acme.id, cy.email);
    expect(stolen.status).toBe(200);
    expect(stolen.body.active).toBe(true);
    // The address is on Cy's account: it is Cy everywhere.
    expect((await who(inAcme.id, cy.email))?.username).toBe(cy.username);
    await remove(ben, stolen.body.id);
  });

  it("refuses an address that is another member's, a bot's or not an address", async () => {
    const refused = async (as: Person, email: string) => {
      const answer = await add(as, acme.id, email);
      return [answer.status, answer.body.code, answer.body.error];
    };
    expect(await refused(ben, ada.email)).toEqual([
      409,
      "email_taken",
      "That address belongs to another member of the organisation",
    ]);
    // Whatever its case, and a member with no username counts.
    expect((await refused(ben, nameless.email.toUpperCase()))[0]).toBe(409);
    const email = address("ada-held");
    await proved(ada, acme.id, email);
    // Verified, it is hers alone.
    expect(await refused(ben, email)).toEqual([
      409,
      "email_taken",
      "That address belongs to another member of the organisation",
    ]);
    expect(await refused(ada, email)).toEqual([
      409,
      "email_taken",
      "You have added that address already",
    ]);
    expect(await refused(ben, ben.email)).toEqual([
      400,
      "email_invalid",
      "That is the address on your account already",
    ]);
    for (const bot of ["noreply@anthropic.com", "CursorAgent@cursor.com"]) {
      expect(await refused(ben, bot)).toEqual([
        400,
        "email_invalid",
        "That address belongs to a bot account",
      ]);
    }
    expect((await refused(ben, "not an address"))[1]).toBe("email_invalid");
    // Not a member: nothing is added, whatever the address.
    expect((await add(cy, acme.id, address("cy")))?.status).toBe(403);
    // Signed out, and with a token: an account's addresses are set from a signed-in browser.
    expect((await world.call("GET", "/api/user/commit-emails")).status).toBe(401);
    expect(
      (await world.call("GET", "/api/user/commit-emails", { as: ada, scopes: ["repo:write"] }))
        .status,
    ).toBe(403);
  });

  it("gives an address to the member who added it first, and to whoever verifies it", async () => {
    const email = address("contested");
    const first = await add(ada, acme.id, email);
    expect(first.body).toMatchObject({ active: true, codeRequestedAt: null });
    // Ben's waits, with a code on its way: verifying is the only way it will count.
    const second = await add(ben, acme.id, email);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ active: false, verifiedAt: null });
    expect(second.body.codeRequestedAt).not.toBeNull();
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    // One active row an address in an organisation, whatever the code above does.
    await expect(
      db
        .update(gitCommitEmails)
        .set({ active: true })
        .where(eq(gitCommitEmails.id, second.body.id)),
    ).rejects.toThrow();
    expect(await pass()).toBe(1);
    expect(outbox.at(-1)!.to).toBe(email);
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);

    // Verified, it is Ben's, and what Ada added is gone.
    const done = await verify(ben, second.body.id, codeFor(email));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ active: true });
    expect(done.body.verifiedAt).not.toBeNull();
    expect((await who(inAcme.id, email))?.username).toBe(ben.username);
    expect((await list(ada)).some((row) => row["id"] === first.body.id)).toBe(false);
    // Nobody adds it now, and it stays Ben's.
    const late = await add(ada, acme.id, email);
    expect([late.status, late.body.code]).toEqual([409, "email_taken"]);
    expect((await who(inAcme.id, email))?.username).toBe(ben.username);
  });

  it("removes what was waiting when the member who has the address verifies it", async () => {
    const email = address("kept");
    const first = await add(ada, acme.id, email);
    const second = await add(ben, acme.id, email);
    expect(second.body.active).toBe(false);
    expect((await send(ada, first.body.id)).status).toBe(200);
    await pass();
    // Two codes went out, one each: the newest is Ada's, and Ben's does not open her row.
    const codes = outbox
      .filter((sent) => sent.to === email)
      .map((sent) => /The code is (\S+)/.exec(sent.text)![1]!);
    expect(codes).toHaveLength(2);
    expect((await verify(ada, first.body.id, codes[0]!)).status).toBe(400);
    expect((await verify(ada, first.body.id, codes[1]!)).status).toBe(200);
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    expect((await list(ben)).some((row) => row["id"] === second.body.id)).toBe(false);
    // Ben's code is for a row that is gone.
    expect((await verify(ben, second.body.id, codes[0]!)).status).toBe(404);
  });

  it("lets the oldest waiting address count when the member who had it removes it", async () => {
    const email = address("handed-on");
    const first = await add(ada, acme.id, email);
    const second = await add(ben, acme.id, email);
    expect(second.body.active).toBe(false);
    // Removing a row that waits changes nothing for the one that counts.
    expect((await remove(ben, second.body.id)).status).toBe(200);
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    const again = await add(ben, acme.id, email);
    expect(again.body.active).toBe(false);
    expect((await remove(ada, first.body.id)).status).toBe(200);
    expect((await who(inAcme.id, email))?.username).toBe(ben.username);
    expect((await list(ben)).find((row) => row["id"] === again.body.id)).toMatchObject({
      active: true,
      verifiedAt: null,
    });
    await pass();
  });

  it("takes a code once, in time, for a few tries, from the person who asked", async () => {
    const email = address("ben-code");
    const added = await add(ben, acme.id, email);
    expect((await send(ben, added.body.id)).status).toBe(200);
    const sentAt = new Date();
    await pass(sentAt);
    const code = codeFor(email);
    // Somebody else with the code and the id: not theirs to verify.
    expect((await verify(ada, added.body.id, code)).status).toBe(404);

    // A wrong code says so, and is counted.
    const wrong = await verify(ben, added.body.id, "AAAA-AAAA");
    expect([wrong.status, wrong.body.code, wrong.body.error]).toEqual([
      400,
      "code_invalid",
      "That code is not right",
    ]);
    for (let tries = 1; tries < GIT_COMMIT_EMAIL_CODE_ATTEMPTS; tries++) {
      await verify(ben, added.body.id, "AAAA-AAAA");
    }
    // Now even the right one is refused: another must be sent.
    const spent = await verify(ben, added.body.id, code);
    expect([spent.status, spent.body.error]).toEqual([400, "Too many wrong codes. Send another"]);

    // Asking again too soon is refused; a minute later another is mailed, and the old one is dead.
    const soon = await send(ben, added.body.id);
    expect(soon.status).toBe(409);
    await db
      .update(gitCommitEmails)
      .set({
        sendRequestedAt: new Date(Date.now() - 5 * 60_000),
        sentAt: new Date(Date.now() - 5 * 60_000),
      })
      .where(eq(gitCommitEmails.id, added.body.id));
    const again = await send(ben, added.body.id);
    expect(again.status).toBe(200);
    expect(await pass()).toBe(1);
    const fresh = codeFor(email);
    expect(fresh).not.toBe(code);
    expect((await verify(ben, added.body.id, code)).status).toBe(400);

    // Past its day, the fresh one is refused too.
    await db
      .update(gitCommitEmails)
      .set({ codeExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(gitCommitEmails.id, added.body.id));
    const late = await verify(ben, added.body.id, fresh);
    expect([late.status, late.body.error]).toEqual([400, "That code has expired. Send another"]);
    await db
      .update(gitCommitEmails)
      .set({ codeExpiresAt: new Date(Date.now() + GIT_COMMIT_EMAIL_CODE_TTL_MS) })
      .where(eq(gitCommitEmails.id, added.body.id));

    // In time it works, once: nothing of the code is kept, and using it again changes nothing.
    expect((await verify(ben, added.body.id, fresh)).status).toBe(200);
    const [row] = await db
      .select()
      .from(gitCommitEmails)
      .where(eq(gitCommitEmails.id, added.body.id));
    expect(row).toMatchObject({ codeHash: null, codeExpiresAt: null });
    // The code was never stored, only its hash.
    expect(JSON.stringify(row)).not.toContain(fresh.replace("-", ""));
    const verifiedAt = row!.verifiedAt;
    expect((await verify(ben, added.body.id, fresh)).status).toBe(200);
    const [after] = await db
      .select()
      .from(gitCommitEmails)
      .where(eq(gitCommitEmails.id, added.body.id));
    expect(after!.verifiedAt).toEqual(verifiedAt);
  });

  it("gives a row back when the message does not leave, and stops trying after a while", async () => {
    const email = address("ada-bounce");
    const added = await add(ada, acme.id, email);
    expect((await send(ada, added.body.id)).status).toBe(200);
    const failing = () =>
      runGitCommitEmailPass({
        send: async (message) => {
          if (message.to !== email) return false;
          throw new Error("the mail provider is down");
        },
      });
    expect(await failing()).toBe(0);
    const [row] = await db
      .select()
      .from(gitCommitEmails)
      .where(eq(gitCommitEmails.id, added.body.id));
    // Owed still, and no code that nobody received is good. The address counts all the same.
    expect(row).toMatchObject({ sentAt: null, codeHash: null, active: true });
    expect((await who(inAcme.id, email))?.username).toBe(ada.username);
    expect(await pass()).toBe(1);
    expect(outbox.at(-1)!.to).toBe(email);

    // A request the app could not send for a quarter of an hour is left for the person to repeat.
    const stale = address("ada-stale");
    const old = await add(ada, acme.id, stale);
    await send(ada, old.body.id);
    await db
      .update(gitCommitEmails)
      .set({ sendRequestedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(gitCommitEmails.id, old.body.id));
    expect(await pass()).toBe(0);
  });

  it("holds a member to a few addresses an organisation", async () => {
    const before = (await list(cy)).length;
    for (let n = before; n < GIT_COMMIT_EMAIL_LIMIT; n++) {
      expect((await add(cy, other.id, address(`cy-${n}`))).status).toBe(200);
    }
    const over = await add(cy, other.id, address("cy-over"));
    expect([over.status, over.body.error]).toEqual([
      400,
      `An organisation takes at most ${GIT_COMMIT_EMAIL_LIMIT} commit emails per member`,
    ]);
    // Removing one makes room, and only its owner removes it.
    const mine = await list(cy);
    expect(
      (await world.call("DELETE", `/api/user/commit-emails/${mine[0]!["id"]}`, { as: ada })).status,
    ).toBe(404);
    expect(
      (await world.call("DELETE", `/api/user/commit-emails/${mine[0]!["id"]}`, { as: cy })).status,
    ).toBe(200);
    expect((await add(cy, other.id, address("cy-over"))).status).toBe(200);
  });

  it("stops counting an address when its person leaves the organisation", async () => {
    const leaver = await world.person("leaver");
    await db.insert(organizationMembers).values({
      id: `m-${world.suffix}`,
      userId: leaver.id,
      organizationId: acme.id,
      role: "member",
    });
    const email = address("leaver");
    // Added and never verified: it counts while they are a member.
    const id = (await add(leaver, acme.id, email)).body.id as string;
    expect((await who(inAcme.id, email))?.username).toBe(leaver.username);
    const waiting = await add(ben, acme.id, email);
    expect(waiting.body.active).toBe(false);
    const verified = address("leaver-verified");
    const verifiedId = await proved(leaver, acme.id, verified);

    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, leaver.id),
          eq(organizationMembers.organizationId, acme.id),
        ),
      );
    // At once, with the rows still there, verified or not.
    expect(await who(inAcme.id, email)).toBeNull();
    expect(await who(inAcme.id, verified)).toBeNull();
    expect(await list(leaver)).toEqual([]);
    expect(
      (
        await db
          .select()
          .from(gitCommitEmails)
          .where(inArray(gitCommitEmails.id, [id, verifiedId]))
      ).length,
    ).toBe(2);
    // The verified one is free for a member: the row they left holds it for nobody.
    const taken = await add(ada, acme.id, verified);
    expect(taken.body).toMatchObject({ active: true });
    expect((await who(inAcme.id, verified))?.username).toBe(ada.username);
    // The pass removes what people who left kept.
    const kept = await add(ada, acme.id, address("sweep-me"));
    await db
      .update(gitCommitEmails)
      .set({ userId: leaver.id })
      .where(eq(gitCommitEmails.id, kept.body.id));
    await pass();
    expect(
      (
        await db
          .select()
          .from(gitCommitEmails)
          .where(inArray(gitCommitEmails.id, [id, verifiedId, kept.body.id]))
      ).length,
    ).toBe(0);
    // And the address Ben was waiting for is his.
    expect((await list(ben)).find((row) => row["id"] === waiting.body.id)).toMatchObject({
      active: true,
    });
    expect((await who(inAcme.id, email))?.username).toBe(ben.username);
  });

  describe("in a person's own namespace", () => {
    it("counts an address in the person's own repositories and nowhere else", async () => {
      const email = address("ada-own");
      const added = await add(ada, null, ` ${email.toUpperCase()} `);
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body).toMatchObject({
        organizationId: null,
        email,
        active: true,
        verifiedAt: null,
        codeRequestedAt: null,
      });
      // Hers at once, with nothing mailed.
      expect((await who(adasOwn.id, email))?.username).toBe(ada.username);
      expect(await pass()).toBe(0);
      expect((await send(ada, added.body.id)).status).toBe(200);
      expect(await pass()).toBe(1);
      const message = outbox.at(-1)!;
      expect(message.to).toBe(email);
      expect(message.subject).toBe(`Verify ${email} for commits in your own repositories`);
      expect(message.text).toContain(ada.email);
      expect(message.text).toContain("their own repositories");
      expect(message.text).toContain("Settings > Profile: ");
      expect(message.text).not.toContain("organisations");

      expect((await verify(ada, added.body.id, codeFor(email))).status).toBe(200);
      expect((await who(adasOwn.id, email.toUpperCase()))?.username).toBe(ada.username);
      // Not in an organisation she owns, nor in anyone else's own repositories.
      expect(await who(inAcme.id, email)).toBeNull();
      expect(await who(inOther.id, email)).toBeNull();
      expect(await who(bensOwn.id, email)).toBeNull();
      // Listed beside her organisations' addresses, under no organisation.
      expect((await list(ada)).find((row) => row["id"] === added.body.id)).toMatchObject({
        organizationId: null,
        email,
      });
      // The pass drops what people who left an organisation kept: nobody leaves their own namespace.
      await pass();
      expect((await who(adasOwn.id, email))?.username).toBe(ada.username);
    });

    it("keeps an organisation's address out of a person's repository, connected to it or not", async () => {
      const email = address("ada-connected");
      await proved(ada, acme.id, email);
      await db
        .update(gitNamespaces)
        .set({ workspaceOrganizationId: acme.id })
        .where(eq(gitNamespaces.userId, ada.id));
      try {
        expect(await who(adasOwn.id, email)).toBeNull();
        expect((await who(inAcme.id, email))?.username).toBe(ada.username);
      } finally {
        await db
          .update(gitNamespaces)
          .set({ workspaceOrganizationId: null })
          .where(eq(gitNamespaces.userId, ada.id));
      }
    });

    it("refuses a bot's address, the person's own and one on anyone else's account", async () => {
      const refused = async (as: Person, email: string) => {
        const answer = await add(as, null, email);
        return [answer.status, answer.body.code, answer.body.error];
      };
      for (const bot of ["noreply@anthropic.com", "CursorAgent@cursor.com"]) {
        expect(await refused(ada, bot)).toEqual([
          400,
          "email_invalid",
          "That address belongs to a bot account",
        ]);
      }
      expect(await refused(ada, ada.email.toUpperCase())).toEqual([
        400,
        "email_invalid",
        "That is the address on your account already",
      ]);
      // Cy shares one organisation with Ada, the stranger none, and the
      // nameless one has no username: an account's address is refused sitewide.
      const stranger = await world.person("stranger");
      for (const taken of [cy.email, stranger.email.toUpperCase(), nameless.email]) {
        expect(await refused(ada, taken)).toEqual([
          409,
          "email_taken",
          "That address is on another person's account",
        ]);
      }
      expect((await refused(ada, "not an address"))[1]).toBe("email_invalid");
      const email = address("ada-own-twice");
      await proved(ada, null, email);
      expect(await refused(ada, email)).toEqual([
        409,
        "email_taken",
        "You have added that address already",
      ]);
      // Signed out, and with a token: set from a signed-in browser only.
      expect(
        (
          await world.call("POST", "/api/user/commit-emails", {
            body: { organizationId: null, email },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await world.call("POST", "/api/user/commit-emails", {
            as: ada,
            scopes: ["repo:write"],
            body: { organizationId: null, email: address("ada-token") },
          })
        ).status,
      ).toBe(403);
    });

    it("refuses the code when the address has become someone's account address since", async () => {
      const email = address("claimed-later");
      const added = await add(ada, null, email);
      await send(ada, added.body.id);
      await pass();
      const late = await world.person("latecomer");
      await db.update(users).set({ email }).where(eq(users.id, late.id));
      const answer = await verify(ada, added.body.id, codeFor(email));
      expect([answer.status, answer.body.code]).toEqual([409, "email_taken"]);
      expect(await who(adasOwn.id, email)).toMatchObject({ username: late.username });
    });

    it("neither blocks nor is blocked by the same address in an organisation or in someone else's namespace", async () => {
      // Hers first, then a member's in the organisation: each counts at once, unverified.
      const first = address("both-ways-1");
      expect((await add(ada, null, first)).body.active).toBe(true);
      expect((await add(ben, acme.id, first)).body.active).toBe(true);
      // The organisation's first, then hers; and Ben's own as well.
      const second = address("both-ways-2");
      await proved(ben, acme.id, second);
      await proved(ada, null, second);
      // Another person's own namespace is another place: nothing waits there.
      expect((await add(ben, null, second)).body.active).toBe(true);
      for (const email of [first, second]) {
        expect((await who(adasOwn.id, email))?.username).toBe(ada.username);
        expect((await who(inAcme.id, email))?.username).toBe(ben.username);
      }
      expect((await who(bensOwn.id, second))?.username).toBe(ben.username);
      expect(await who(bensOwn.id, first)).toBeNull();
      // The same person may keep one address in both places: two rows.
      const third = address("both-ways-3");
      await proved(ada, null, third);
      await proved(ada, acme.id, third);
      expect((await list(ada)).filter((row) => row["email"] === third)).toHaveLength(2);
    });

    it("puts the account's address before the owner's alias", async () => {
      // Added before the address was anyone's account's: the account still wins.
      const email = address("ada-then-account");
      await add(ada, null, email);
      const late = await world.person("account-first");
      await db.update(users).set({ email }).where(eq(users.id, late.id));
      expect((await who(adasOwn.id, email))?.username).toBe(late.username);
    });

    it("holds a person to a few addresses of their own, counted apart from an organisation's", async () => {
      const packer = await world.person("packer");
      for (let n = 0; n < GIT_COMMIT_EMAIL_LIMIT; n++) {
        expect((await add(packer, null, address(`packer-${n}`))).status).toBe(200);
      }
      const over = await add(packer, null, address("packer-over"));
      expect([over.status, over.body.error]).toEqual([
        400,
        `Your own repositories take at most ${GIT_COMMIT_EMAIL_LIMIT} commit emails`,
      ]);
      // An organisation's are its own ten.
      await db.insert(organizationMembers).values({
        id: `m-packer-${world.suffix}`,
        userId: packer.id,
        organizationId: acme.id,
        role: "member",
      });
      expect((await add(packer, acme.id, address("packer-over"))).status).toBe(200);
      // Removing one makes room, and only its owner removes it.
      const mine = (await list(packer)).filter((row) => row["organizationId"] === null);
      expect(mine).toHaveLength(GIT_COMMIT_EMAIL_LIMIT);
      expect(
        (await world.call("DELETE", `/api/user/commit-emails/${mine[0]!["id"]}`, { as: ada }))
          .status,
      ).toBe(404);
      expect(
        (await world.call("DELETE", `/api/user/commit-emails/${mine[0]!["id"]}`, { as: packer }))
          .status,
      ).toBe(200);
      expect((await add(packer, null, address("packer-over"))).status).toBe(200);
      // Leaving the organisation takes its address and leaves theirs.
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, packer.id),
            eq(organizationMembers.organizationId, acme.id),
          ),
        );
      await pass();
      const left = await list(packer);
      expect(left).toHaveLength(GIT_COMMIT_EMAIL_LIMIT);
      expect(left.every((row) => row["organizationId"] === null)).toBe(true);
    });

    it("resolves a page of a person's repository in the same two lookups", async () => {
      const email = address("ada-own-page");
      await proved(ada, null, email);
      const page = Array.from({ length: 50 }, (_, n) =>
        commit(n.toString(16).padStart(2, "0"), n % 2 === 0 ? email : ben.email, {
          coAuthors: [["Claude", "noreply@anthropic.com"]],
        }),
      );
      const decorate = await commitDecorator(adasOwn.id, page, { statuses: false });
      const seen = page.map((one) => decorate(one));
      expect(new Set(seen.map((one) => one.authorUser?.username))).toEqual(
        new Set([ada.username, ben.username]),
      );
      expect(seen.every((one) => one.coAuthors[0]!.user?.kind === "bot")).toBe(true);
    });
  });

  it("looks people up once a page, whatever its length", async () => {
    const email = address("ada-page");
    await proved(ada, acme.id, email);
    const page = Array.from({ length: 50 }, (_, n) =>
      commit(n.toString(16).padStart(2, "0"), n % 2 === 0 ? email : ben.email, {
        coAuthors: [["Claude", "noreply@anthropic.com"]],
      }),
    );
    const decorate = await commitDecorator(inAcme.id, page, { statuses: false });
    const seen = page.map((one) => decorate(one));
    expect(new Set(seen.map((one) => one.authorUser?.username))).toEqual(
      new Set([ada.username, ben.username]),
    );
    expect(seen.every((one) => one.coAuthors[0]!.user?.kind === "bot")).toBe(true);
  });
});
