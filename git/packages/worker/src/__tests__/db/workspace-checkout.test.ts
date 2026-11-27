/**
 * Setting up a workspace against a real Postgres: who is offered one, what
 * the forge signs and that it writes nothing, and what the app does when the
 * payment is complete (server-core's `provisionGitWorkspace`, called here as
 * the app's Stripe webhook and return route call it): one organisation with
 * the person as its owner, the rows `POST /api/orgs` creates, its
 * subscription row, and the person's namespace connected to it. Then the
 * forge's own half of the hand-off: the username claimed into it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GIT_WORKSPACE_CHECKOUT_PATH,
  verifyGitWorkspaceCheckoutToken,
} from "@infrawrench/client-core";
import {
  dashboards,
  gitNamespaces,
  organizationMembers,
  organizations,
  roles,
  subscriptions,
} from "@infrawrench/server-core/db/schema";
import {
  gitWorkspaceOfferFor,
  provisionGitWorkspace,
} from "@infrawrench/server-core/git/workspace-checkout";
import { gitWorkspaceOf } from "@infrawrench/server-core/git/workspace";
import { db } from "../../db/client";
import { type Person, type World, configured, makeWorld } from "./world";

const KEY = "test-job-token-key-of-at-least-32-characters";

describe.skipIf(!configured)("setting up a workspace", () => {
  let world: World;
  /** Signed in, no username yet, in no organisation. */
  let ada: Person;
  /** Has a username, in no organisation. */
  let ben: Person;
  /** Already in an organisation. */
  let cy: Person;
  let acme: { id: string; slug: string };
  const created: string[] = [];

  beforeAll(async () => {
    world = makeWorld();
    (world.env as { GIT_JOB_TOKEN_KEY: string }).GIT_JOB_TOKEN_KEY = KEY;
    ada = await world.person("ada", { username: false });
    ben = await world.person("ben");
    cy = await world.person("cy");
    acme = await world.organization("acme", { paid: true, members: [[cy, "member"]] });
  });
  afterAll(async () => {
    if (!world) return;
    if (created.length > 0) {
      await db.delete(organizations).where(inArray(organizations.id, created));
    }
    await world.cleanup();
  });

  const start = (as: Person, body: Record<string, unknown>, scopes?: string[]) =>
    world.call("POST", "/api/session/workspace/checkout", {
      as,
      body,
      ...(scopes ? { scopes: scopes as Array<"repo:read" | "repo:write"> } : {}),
    });
  const claimsOf = async (checkoutUrl: string) => {
    const url = new URL(checkoutUrl);
    expect(url.origin + url.pathname).toBe(
      `https://app.example.test${GIT_WORKSPACE_CHECKOUT_PATH}`,
    );
    const verified = await verifyGitWorkspaceCheckoutToken(KEY, url.searchParams.get("token")!);
    if (!verified.ok) throw new Error(`the token was refused: ${verified.reason}`);
    return verified.claims;
  };
  /** The payment completing, as the app reports it. */
  const pay = (claims: { organizationId: string; name: string; userId: string }) => {
    created.push(claims.organizationId);
    return provisionGitWorkspace({
      organizationId: claims.organizationId,
      name: claims.name,
      userId: claims.userId,
      stripeCustomerId: `cus_test_${claims.organizationId}`,
    });
  };
  const rowsOf = async (organizationId: string) => ({
    organization: (
      await db.select().from(organizations).where(eq(organizations.id, organizationId))
    )[0],
    members: await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId)),
    roles: await db.select().from(roles).where(eq(roles.organizationId, organizationId)),
    dashboards: await db
      .select()
      .from(dashboards)
      .where(eq(dashboards.organizationId, organizationId)),
    subscriptions: await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, organizationId)),
  });
  const organizationsOf = async (person: Person) =>
    (await world.call("GET", "/api/session", { as: person })).body.organizations as Array<{
      id: string;
      name: string;
      paid: boolean;
    }>;

  it("offers one to someone in no organisation, and never to someone in one", async () => {
    expect(await gitWorkspaceOfferFor(ada.id)).toEqual({ status: "ok", email: ada.email });
    expect(await gitWorkspaceOfferFor(cy.id)).toEqual({ status: "has_organization" });
    expect(await gitWorkspaceOfferFor(`nobody-${world.suffix}`)).toEqual({ status: "no_user" });

    expect(await start(cy, { name: "Cy's workspace", from: "settings" })).toMatchObject({
      status: 409,
      body: { code: "already_in_organisation" },
    });
  });

  it("is asked from a signed-in browser, with a name", async () => {
    // Never with a token: it would choose who pays and who owns.
    expect(
      (
        await start(ada, { name: "Ada's workspace", from: "onboarding" }, [
          "repo:read",
          "repo:write",
        ])
      ).status,
    ).toBe(403);
    expect(
      (
        await world.call("POST", "/api/session/workspace/checkout", {
          body: { name: "Nobody's", from: "onboarding" },
        })
      ).status,
    ).toBe(401);
    for (const name of ["", "   ", "a".repeat(101)]) {
      expect(await start(ada, { name, from: "onboarding" })).toMatchObject({
        status: 400,
        body: { code: "workspace_name_invalid" },
      });
    }
  });

  it("signs who, what and where to come back to, and writes nothing", async () => {
    const before = await organizationsOf(ada);
    const started = await start(ada, {
      name: "  Ada's workspace ",
      from: "onboarding",
      username: `ada-lovelace-${world.suffix}`,
      returnTo: "/new",
    });
    expect(started.status).toBe(200);
    const claims = await claimsOf(started.body.checkoutUrl);
    expect(claims).toMatchObject({
      userId: ada.id,
      name: "Ada's workspace",
      returnPath: `/onboarding/username?username=ada-lovelace-${world.suffix}&returnTo=%2Fnew`,
    });
    // A new id each time, and no organisation by it: nothing exists until it is paid for.
    const again = await claimsOf(
      (await start(ada, { name: "Ada's workspace", from: "onboarding" })).body.checkoutUrl,
    );
    expect(again.organizationId).not.toBe(claims.organizationId);
    expect(again.returnPath).toBe("/onboarding/username");
    expect((await rowsOf(claims.organizationId)).organization).toBeUndefined();
    expect(await organizationsOf(ada)).toEqual(before);
    expect(await gitWorkspaceOfferFor(ada.id)).toMatchObject({ status: "ok" });

    // Never a page off the site, and never a username that is not one.
    const odd = await claimsOf(
      (
        await start(ada, {
          name: "Ada's workspace",
          from: "onboarding",
          username: "not a username",
          returnTo: "https://evil.example/",
        })
      ).body.checkoutUrl,
    );
    expect(odd.returnPath).toBe("/onboarding/username");
    // A return too long to carry is left out; the username stays.
    const long = await claimsOf(
      (
        await start(ada, {
          name: "Ada's workspace",
          from: "onboarding",
          username: "ada-lovelace",
          returnTo: `/${"a".repeat(450)}`,
        })
      ).body.checkoutUrl,
    );
    expect(long.returnPath).toBe("/onboarding/username?username=ada-lovelace");
    expect(
      (await claimsOf((await start(ben, { name: "Ben's", from: "settings" })).body.checkoutUrl))
        .returnPath,
    ).toBe("/settings/organisations");
  });

  it("creates one organisation when the payment completes, however often it is reported", async () => {
    const claims = await claimsOf(
      (await start(ada, { name: "Ada's workspace", from: "onboarding" })).body.checkoutUrl,
    );
    // The webhook and the browser's return, at once, and a redelivery after.
    const outcomes = await Promise.all([pay(claims), pay(claims), pay(claims)]);
    outcomes.push(await pay(claims));
    expect(outcomes.every((outcome) => outcome.status === "provisioned")).toBe(true);
    expect(outcomes.filter((o) => o.status === "provisioned" && o.first)).toHaveLength(1);
    // No username yet: the forge's own claim connects it.
    expect(outcomes.every((o) => o.status === "provisioned" && o.connectedNamespace === null)).toBe(
      true,
    );

    const rows = await rowsOf(claims.organizationId);
    expect(rows.organization).toMatchObject({
      id: claims.organizationId,
      displayName: "Ada's workspace",
      complimentary: false,
      trialExpiresAt: null,
    });
    // What `POST /api/orgs` creates: the three system roles, the owner, the Home dashboard.
    expect(rows.roles.map((role) => role.systemKey).sort()).toEqual(["admin", "member", "owner"]);
    const ownerRole = rows.roles.find((role) => role.systemKey === "owner")!;
    expect(rows.members).toHaveLength(1);
    expect(rows.members[0]).toMatchObject({ userId: ada.id, role: "owner", roleId: ownerRole.id });
    expect(rows.dashboards).toHaveLength(1);
    expect(rows.dashboards[0]).toMatchObject({ name: "Home", isDefault: true });
    // The row the webhook's subscription write finds the organisation by.
    expect(rows.subscriptions).toHaveLength(1);
    expect(rows.subscriptions[0]).toMatchObject({
      stripeCustomerId: `cus_test_${claims.organizationId}`,
      stripeSubscriptionId: null,
    });

    // In one now: not offered another.
    expect(await gitWorkspaceOfferFor(ada.id)).toEqual({ status: "has_organization" });
    expect((await start(ada, { name: "Another", from: "onboarding" })).status).toBe(409);
  });

  it("finishes onboarding: the username is claimed into the new organisation", async () => {
    const [organization] = await organizationsOf(ada);
    expect(organization).toMatchObject({ name: "Ada's workspace", paid: false });
    // The subscription the webhook records (`applyCheckoutSubscription`).
    await db
      .update(subscriptions)
      .set({ stripeSubscriptionId: `sub_test_${world.suffix}`, status: "active" })
      .where(eq(subscriptions.organizationId, organization!.id));
    expect((await organizationsOf(ada))[0]).toMatchObject({ paid: true });

    const username = `ada-lovelace-${world.suffix}`;
    expect(
      (
        await world.call("POST", "/api/session/username", {
          as: ada,
          body: { username, workspaceOrganizationId: organization!.id },
        })
      ).status,
    ).toBe(200);
    expect((await world.call("GET", "/api/session", { as: ada })).body.personal.workspace).toEqual({
      id: organization!.id,
      name: "Ada's workspace",
    });
    expect(await gitWorkspaceOf(ada.id)).toBe(organization!.id);
  });

  it("connects the namespace of someone who already has a username, once", async () => {
    const claims = await claimsOf(
      (await start(ben, { name: "Ben & co", from: "settings" })).body.checkoutUrl,
    );
    expect(await gitWorkspaceOf(ben.id)).toBeNull();
    const first = await pay(claims);
    const [namespace] = await db
      .select({ id: gitNamespaces.id, slug: gitNamespaces.slug })
      .from(gitNamespaces)
      .where(and(eq(gitNamespaces.userId, ben.id), eq(gitNamespaces.kind, "user")));
    expect(first).toEqual({
      status: "provisioned",
      first: true,
      organizationId: claims.organizationId,
      connectedNamespace: namespace,
    });
    expect(await gitWorkspaceOf(ben.id)).toBe(claims.organizationId);
    expect((await world.call("GET", "/api/session", { as: ben })).body.personal.workspace).toEqual({
      id: claims.organizationId,
      name: "Ben & co",
    });

    // Where it runs afterwards is theirs to change: a late redelivery leaves it.
    await world.call("PUT", "/api/session/workspace", { as: ben, body: { organizationId: null } });
    expect(await pay(claims)).toMatchObject({ first: false, connectedNamespace: null });
    expect(await gitWorkspaceOf(ben.id)).toBeNull();
    expect((await rowsOf(claims.organizationId)).members).toHaveLength(1);
  });

  it("never adds an owner to an organisation that is someone else's", async () => {
    const dee = await world.person("dee", { username: false });
    expect(
      await provisionGitWorkspace({
        organizationId: acme.id,
        name: "Mine now",
        userId: dee.id,
        stripeCustomerId: "cus_test_dee",
      }),
    ).toEqual({ status: "refused", reason: "taken" });
    const rows = await rowsOf(acme.id);
    expect(rows.organization?.displayName).toBe("acme");
    expect(rows.members.map((member) => member.userId)).toEqual([cy.id]);
    expect(rows.subscriptions).toHaveLength(0);
    expect(await gitWorkspaceOfferFor(dee.id)).toMatchObject({ status: "ok" });
  });

  it("creates nothing for an account that is gone", async () => {
    const organizationId = randomUUID();
    expect(
      await provisionGitWorkspace({
        organizationId,
        name: "Ghost",
        userId: `nobody-${world.suffix}`,
        stripeCustomerId: "cus_test_ghost",
      }),
    ).toEqual({ status: "refused", reason: "no_user" });
    expect((await rowsOf(organizationId)).organization).toBeUndefined();
  });
});
