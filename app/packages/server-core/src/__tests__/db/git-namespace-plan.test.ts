/**
 * An organisation's namespace on git.infrawrench.com needs a paid plan,
 * against a real Postgres: the app's `setGitForgeNamespace` refuses a first
 * claim by an organisation that is not on one, in client-core's sentence,
 * takes it from one that is (a subscription, complimentary, an unexpired
 * trial), and never asks again for a rename.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes three organisations and their namespaces, and deletes them
 * after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GIT_FORGE_NAMESPACE_PLAN_REQUIRED } from "@infrawrench/client-core";

const configured = !!process.env["DATABASE_URL"];

const suffix = randomUUID().slice(0, 8);
const freeOrg = `test-org-free-${suffix}`;
const paidOrg = `test-org-paid-${suffix}`;
const trialOrg = `test-org-trial-${suffix}`;

describe.skipIf(!configured)("claiming an organisation's namespace by its plan", () => {
  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const forge = await import("../../git/forge");
    const quota = await import("../../git/quota");
    return { db, schema, forge, quota };
  }

  afterAll(async () => {
    if (!configured) return;
    const { db, schema } = await modules();
    const { inArray } = await import("drizzle-orm");
    const all = [freeOrg, paidOrg, trialOrg];
    await db.delete(schema.gitNamespaces).where(inArray(schema.gitNamespaces.organizationId, all));
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, all));
  });

  it("refuses a first claim on the free plan and takes it once the organisation pays", async () => {
    const { db, schema, forge, quota } = await modules();
    const { eq } = await import("drizzle-orm");
    await db.insert(schema.organizations).values({ id: freeOrg, displayName: "Free" });

    expect(await quota.gitOrganizationClaimRefusal(freeOrg)).toBe(
      GIT_FORGE_NAMESPACE_PLAN_REQUIRED,
    );
    await expect(forge.setGitForgeNamespace(freeOrg, `free-${suffix}`, null)).rejects.toMatchObject(
      { status: 402, code: "plan_required", message: GIT_FORGE_NAMESPACE_PLAN_REQUIRED },
    );
    expect(
      await db
        .select()
        .from(schema.gitNamespaces)
        .where(eq(schema.gitNamespaces.organizationId, freeOrg)),
    ).toHaveLength(0);
    // The name rules still answer first: a bad name is a bad name on any plan.
    await expect(forge.setGitForgeNamespace(freeOrg, "-nope", null)).rejects.toMatchObject({
      status: 400,
      code: "name_invalid",
    });

    await db
      .update(schema.organizations)
      .set({ complimentary: true })
      .where(eq(schema.organizations.id, freeOrg));
    expect(await quota.gitOrganizationClaimRefusal(freeOrg)).toBeNull();
    const claimed = await forge.setGitForgeNamespace(freeOrg, `free-${suffix}`, null);
    expect(claimed).toMatchObject({ change: "claimed", namespace: { slug: `free-${suffix}` } });
  });

  it("lets an organisation whose plan lapsed keep and rename the namespace it has", async () => {
    const { db, schema, forge } = await modules();
    const { eq } = await import("drizzle-orm");
    await db
      .insert(schema.organizations)
      .values({ id: paidOrg, displayName: "Paid", complimentary: true });
    await forge.setGitForgeNamespace(paidOrg, `paid-${suffix}`, null);
    await db
      .update(schema.organizations)
      .set({ complimentary: false })
      .where(eq(schema.organizations.id, paidOrg));

    const renamed = await forge.setGitForgeNamespace(paidOrg, `lapsed-${suffix}`, null);
    expect(renamed).toMatchObject({
      change: "renamed",
      from: `paid-${suffix}`,
      namespace: { slug: `lapsed-${suffix}` },
    });
    expect((await forge.gitForgeOverview(paidOrg)).namespace?.slug).toBe(`lapsed-${suffix}`);
  });

  it("counts an unexpired trial as a paid plan, and an expired one as none", async () => {
    const { db, schema, forge } = await modules();
    const { eq } = await import("drizzle-orm");
    await db.insert(schema.organizations).values({
      id: trialOrg,
      displayName: "Trial",
      trialExpiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      forge.setGitForgeNamespace(trialOrg, `trial-${suffix}`, null),
    ).rejects.toMatchObject({ code: "plan_required" });
    await db
      .update(schema.organizations)
      .set({ trialExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(schema.organizations.id, trialOrg));
    expect((await forge.setGitForgeNamespace(trialOrg, `trial-${suffix}`, null)).change).toBe(
      "claimed",
    );
  });
});
