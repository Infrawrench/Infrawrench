/**
 * Short usernames against a real Postgres: what is paid for and what is not,
 * the hold that keeps a name for the person paying (who it shuts out, that it
 * expires by itself, that a claim respects it), and what the app does when
 * the payment settles (server-core's `completeGitUsernamePurchase`, called
 * here as the app's Stripe webhook calls it): the name is claimed once, an
 * organisation chosen on the username page is connected, and a name that is
 * gone by then is marked for refund.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GIT_SHORT_USERNAME_PAYMENT_REQUIRED,
  GIT_SHORT_USERNAME_PRICE_CENTS,
  GIT_USERNAME_CHECKOUT_PATH,
  verifyGitUsernameCheckoutToken,
} from "@infrawrench/client-core";
import {
  gitNamespaces,
  gitUsernameHolds,
  gitUsernamePurchases,
  gitUsers,
} from "@infrawrench/server-core/db/schema";
import { GitForgeError, setGitForgeNamespace } from "@infrawrench/server-core/git/forge";
import {
  completeGitUsernamePurchase,
  markGitUsernamePurchaseRefunded,
} from "@infrawrench/server-core/git/short-usernames";
import { db } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

const KEY = "test-job-token-key-of-at-least-32-characters";

describe.skipIf(!configured)("short usernames", () => {
  let world: World;
  /** Signed in, no username yet. */
  let ada: Person, ben: Person, cy: Person;
  /** Has a long username already. */
  let dee: Person;
  let acme: { id: string; slug: string };
  let nameless: { id: string; slug: string };
  const sessions: string[] = [];
  /** Six characters or fewer, and this run's own. */
  const short = (letter: string) => `${letter}${randomUUID().slice(0, 4)}`;

  beforeAll(async () => {
    world = makeWorld();
    (world.env as { GIT_JOB_TOKEN_KEY: string }).GIT_JOB_TOKEN_KEY = KEY;
    [ada, ben, cy] = (await Promise.all(
      ["ada", "ben", "cy"].map((name) => world.person(name, { username: false })),
    )) as [Person, Person, Person];
    dee = await world.person("dee");
    acme = await world.organization("acme", { paid: true, members: [[ada, "member"]] });
    nameless = await world.organization("nameless", {
      paid: true,
      members: [[dee, "owner"]],
      namespace: false,
    });
  });
  afterAll(async () => {
    if (!world) return;
    if (sessions.length > 0) {
      await db
        .delete(gitUsernamePurchases)
        .where(inArray(gitUsernamePurchases.stripeCheckoutSessionId, sessions));
    }
    await world.cleanup();
  });

  const availability = async (username: string, as: Person) =>
    (
      await world.call(
        "GET",
        `/api/session/username-availability?username=${encodeURIComponent(username)}`,
        { as },
      )
    ).body;
  const start = (username: string, as: Person, body: Record<string, unknown> = {}) =>
    world.call("POST", "/api/session/username/checkout", { as, body: { username, ...body } });
  const usernameOf = async (person: Person) =>
    (
      await db
        .select({ slug: gitNamespaces.slug })
        .from(gitNamespaces)
        .where(eq(gitNamespaces.userId, person.id))
    )[0]?.slug ?? null;
  const holdOf = async (person: Person) =>
    (await db.select().from(gitUsernameHolds).where(eq(gitUsernameHolds.userId, person.id)))[0] ??
    null;
  const expire = (person: Person) =>
    db
      .update(gitUsernameHolds)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(gitUsernameHolds.userId, person.id));
  /** The payment settling, as the app's webhook reports it. */
  const settle = (person: Person, slug: string, holdId: string | null) => {
    const session = `cs_test_${randomUUID()}`;
    sessions.push(session);
    const payment = {
      userId: person.id,
      slug,
      holdId,
      stripeCheckoutSessionId: session,
      stripePaymentIntentId: `pi_${session}`,
      amountPaidCents: GIT_SHORT_USERNAME_PRICE_CENTS,
      currency: "usd",
    };
    return { payment, outcome: completeGitUsernamePurchase(payment) };
  };

  it("prices six characters or fewer, and nothing longer", async () => {
    const six = `${short("a")}x`;
    expect(six).toHaveLength(6);
    expect(await availability(six, ada)).toMatchObject({
      available: true,
      priceCents: GIT_SHORT_USERNAME_PRICE_CENTS,
    });
    expect(await availability(`${six}y`, ada)).toMatchObject({ available: true, priceCents: null });
  });

  it("refuses to claim a short username without the payment, and still claims a long one", async () => {
    const name = short("b");
    expect(
      await world.call("POST", "/api/session/username", { as: cy, body: { username: name } }),
    ).toMatchObject({
      status: 402,
      body: { code: "username_payment_required", error: GIT_SHORT_USERNAME_PAYMENT_REQUIRED },
    });
    expect(await usernameOf(cy)).toBeNull();
    // A free name is not sent to the payment page.
    expect((await start(`long-name-${world.suffix}`, cy)).status).toBe(400);
  });

  it("keeps the name for the person paying, and sends them to the app with a token for that hold", async () => {
    const name = short("c");
    // Never with a token: a username is the person's account.
    expect(
      (
        await world.call("POST", "/api/session/username/checkout", {
          as: ada,
          scopes: ["repo:read", "repo:write"],
          body: { username: name },
        })
      ).status,
    ).toBe(403);
    // An organisation that is not theirs is refused before anything is held.
    expect((await start(name, ada, { workspaceOrganizationId: nameless.id })).status).toBe(403);
    expect(await holdOf(ada)).toBeNull();

    const started = await start(name, ada, {
      workspaceOrganizationId: acme.id,
      returnTo: "/acme/infra",
    });
    expect(started.status).toBe(200);
    const hold = (await holdOf(ada))!;
    expect(hold).toMatchObject({
      slug: name,
      workspaceOrganizationId: acme.id,
      returnPath: "/onboarding/username?returnTo=%2Facme%2Finfra",
    });
    const url = new URL(started.body.checkoutUrl);
    expect(url.origin + url.pathname).toBe(`https://app.example.test${GIT_USERNAME_CHECKOUT_PATH}`);
    expect(await verifyGitUsernameCheckoutToken(KEY, url.searchParams.get("token")!)).toMatchObject(
      { ok: true, claims: { holdId: hold.id, userId: ada.id } },
    );
    expect((await world.call("GET", "/api/session/username/checkout", { as: ada })).body).toEqual({
      hold: { username: name, expiresAt: hold.expiresAt.toISOString() },
      purchase: null,
    });

    // Everyone else finds it taken: a person, another payment, an organisation here and in the app.
    expect(await availability(name, ben)).toMatchObject({ available: false, reason: "taken" });
    expect(await availability(name.toUpperCase(), ben)).toMatchObject({ available: false });
    expect(await start(name, ben)).toMatchObject({ status: 409, body: { code: "username_taken" } });
    expect(
      await world.call("POST", `/api/orgs/${nameless.id}/namespace`, {
        as: dee,
        body: { slug: name },
      }),
    ).toMatchObject({ status: 409 });
    await expect(setGitForgeNamespace(nameless.id, name, dee.id)).rejects.toBeInstanceOf(
      GitForgeError,
    );
    // Its holder still sees it as theirs to pay for.
    expect(await availability(name, ada)).toMatchObject({
      available: true,
      priceCents: GIT_SHORT_USERNAME_PRICE_CENTS,
    });

    // A second choice replaces the first: one hold a person.
    const other = short("c");
    expect((await start(other, ada, { workspaceOrganizationId: acme.id })).status).toBe(200);
    expect((await holdOf(ada))!.slug).toBe(other);
    expect(await availability(name, ben)).toMatchObject({ available: true });
  });

  it("lets an expired hold go by itself", async () => {
    const held = (await holdOf(ada))!;
    await expire(ada);
    expect((await world.call("GET", "/api/session/username/checkout", { as: ada })).body.hold).toBe(
      null,
    );
    expect(await availability(held.slug, ben)).toMatchObject({ available: true });
    // Someone else can now hold it, over the expired row.
    expect((await start(held.slug, ben)).status).toBe(200);
    expect((await holdOf(ben))!.slug).toBe(held.slug);
    expect(await holdOf(ada)).toBeNull();
    expect(await availability(held.slug, ada)).toMatchObject({ available: false });
  });

  it("claims the name when the payment settles, once, and connects the organisation chosen", async () => {
    const name = short("d");
    expect((await start(name, ada, { workspaceOrganizationId: acme.id })).status).toBe(200);
    const hold = (await holdOf(ada))!;
    const { payment, outcome } = settle(ada, name, hold.id);
    expect(await outcome).toMatchObject({
      status: "claimed",
      first: true,
      connectedOrganizationId: acme.id,
      returnPath: "/onboarding/username",
    });
    // The rows the forge's own claim writes.
    const [namespace] = await db
      .select()
      .from(gitNamespaces)
      .where(eq(gitNamespaces.userId, ada.id));
    expect(namespace).toMatchObject({
      slug: name,
      kind: "user",
      claimedByUserId: ada.id,
      displayName: "ada",
      workspaceOrganizationId: acme.id,
    });
    const [gitUser] = await db.select().from(gitUsers).where(eq(gitUsers.userId, ada.id));
    expect(gitUser!.onboardedAt).not.toBeNull();
    expect(await holdOf(ada)).toBeNull();

    // Stripe delivers again, and the browser's return races it: nothing more happens.
    expect(await completeGitUsernamePurchase(payment)).toMatchObject({
      status: "claimed",
      first: false,
    });
    const purchases = await db
      .select()
      .from(gitUsernamePurchases)
      .where(eq(gitUsernamePurchases.userId, ada.id));
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      slug: name,
      kind: "claim",
      status: "claimed",
      amountPaidCents: GIT_SHORT_USERNAME_PRICE_CENTS,
      currency: "usd",
      stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
    });
    const me = (await world.call("GET", "/api/session", { as: ada })).body;
    expect(me.user.username).toBe(name);
    expect(me.onboarding.needsUsername).toBe(false);
    expect(me.personal.workspace).toMatchObject({ id: acme.id });
  });

  it("marks the payment for refund when the name went to someone else first", async () => {
    // Ben's hold lapses while he is at the payment page, and an organisation claims the name.
    const held = (await holdOf(ben))!;
    await expire(ben);
    expect(
      (
        await world.call("POST", `/api/orgs/${nameless.id}/namespace`, {
          as: dee,
          body: { slug: held.slug },
        })
      ).status,
    ).toBe(200);
    const { payment, outcome } = settle(ben, held.slug, held.id);
    expect(await outcome).toMatchObject({ status: "refund_due", first: true });
    expect(await usernameOf(ben)).toBeNull();
    // A redelivery before the refund went through asks for it again.
    expect(await completeGitUsernamePurchase(payment)).toMatchObject({
      status: "refund_due",
      first: false,
    });
    await markGitUsernamePurchaseRefunded(payment.stripeCheckoutSessionId);
    expect(await completeGitUsernamePurchase(payment)).toMatchObject({ status: "refunded" });
    expect(
      (await world.call("GET", "/api/session/username/checkout", { as: ben })).body.purchase,
    ).toMatchObject({ username: held.slug, status: "refunded" });

    // And when someone else is paying for it by then.
    const name = short("e");
    expect((await start(name, ben)).status).toBe(200);
    const lapsed = (await holdOf(ben))!;
    await expire(ben);
    expect((await start(name, cy)).status).toBe(200);
    expect(await settle(ben, name, lapsed.id).outcome).toMatchObject({ status: "refund_due" });
    // Cy's own payment still gets it.
    expect(await settle(cy, name, (await holdOf(cy))!.id).outcome).toMatchObject({
      status: "claimed",
    });
    expect(await usernameOf(cy)).toBe(name);
  });

  it("still claims for a payment whose hold lapsed, while the name is free", async () => {
    const name = short("f");
    expect((await start(name, ben)).status).toBe(200);
    const hold = (await holdOf(ben))!;
    await expire(ben);
    expect(await settle(ben, name, hold.id).outcome).toMatchObject({ status: "claimed" });
    expect(await usernameOf(ben)).toBe(name);
  });

  it("charges for a change to a short username, not for keeping one or changing its case", async () => {
    const rename = (username: string, as: Person) =>
      world.call("PUT", "/api/session/username", { as, body: { username } });
    const name = short("g");
    expect(await rename(name, dee)).toMatchObject({
      status: 402,
      body: { code: "username_payment_required" },
    });
    expect(await usernameOf(dee)).toBe(dee.username);

    expect((await start(name, dee, { workspaceOrganizationId: acme.id })).status).toBe(200);
    const hold = (await holdOf(dee))!;
    // A change keeps where the namespace runs, and goes back to Settings.
    expect(hold).toMatchObject({ workspaceOrganizationId: null, returnPath: "/settings" });
    const { outcome } = settle(dee, name, hold.id);
    expect(await outcome).toMatchObject({ status: "claimed", connectedOrganizationId: null });
    expect(await usernameOf(dee)).toBe(name);
    const [purchase] = await db
      .select()
      .from(gitUsernamePurchases)
      .where(eq(gitUsernamePurchases.userId, dee.id));
    expect(purchase).toMatchObject({ kind: "rename", status: "claimed" });

    // The name they hold costs nothing again, in any case.
    expect(await availability(name.toUpperCase(), dee)).toMatchObject({ priceCents: null });
    expect((await rename(name.toUpperCase(), dee)).status).toBe(200);
    expect(await usernameOf(dee)).toBe(name.toUpperCase());
    // A second payment for it is refunded.
    expect(await settle(dee, name, null).outcome).toMatchObject({ status: "refund_due" });
  });

  it("gives up the hold when the person claims a free name instead", async () => {
    const eve = await world.person("eve", { username: false });
    expect((await start(short("h"), eve)).status).toBe(200);
    expect(await holdOf(eve)).not.toBeNull();
    const long = `eve-long-${world.suffix}`;
    expect(
      (await world.call("POST", "/api/session/username", { as: eve, body: { username: long } }))
        .status,
    ).toBe(200);
    expect(await holdOf(eve)).toBeNull();
    expect(await usernameOf(eve)).toBe(long);
  });
});
