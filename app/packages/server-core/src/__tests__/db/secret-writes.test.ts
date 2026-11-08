/**
 * The foreign key from `secret_field_states` to `resources` is what #588 was about,
 * and a fake cannot enforce one, so these run against a real Postgres. Same rules as
 * postgres.test.ts: skipped unless DATABASE_URL is set, migrations already applied,
 * scratch databases only. Every import is dynamic for the reason given there.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const configured = !!process.env["DATABASE_URL"];

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-account-${randomUUID()}`;

function instance(id: string): ResourceInstance {
  return {
    id,
    pluginId: "fake",
    resourceTypeId: "thing",
    accountId,
    displayName: "Thing",
    externalId: id.split(":").at(-1) ?? id,
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };
}

describe.skipIf(!configured)("a stored secret and its resource's row", () => {
  beforeAll(async () => {
    process.env["ENCRYPTION_MASTER_KEY"] ??= randomBytes(32).toString("base64");
    const { db } = await import("../../db/client");
    const { accounts, organizations } = await import("../../db/schema");
    await db.insert(organizations).values({ id: orgId, displayName: "Secret writes" });
    await db.insert(accounts).values({
      id: accountId,
      organizationId: orgId,
      pluginId: "fake",
      displayName: "Fake",
      encryptedCredentials: "x",
      credentialsIv: "y",
    });
  });

  afterAll(async () => {
    if (!configured) return;
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { organizations } = await import("../../db/schema");
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.$client.end();
  });

  async function services() {
    const { buildPluginHostServices } = await import("../../host-services");
    const built = await buildPluginHostServices({ id: "fake" } as never, {}, { accountId });
    return built!.secrets!;
  }

  async function rowOf(id: string) {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { resources } = await import("../../db/schema");
    const [row] = await db.select().from(resources).where(eq(resources.id, id));
    return row;
  }

  const newId = () => `${accountId}:thing:${randomUUID()}`;

  it("refuses a plain write with no row, which is the foreign key this is all about", async () => {
    const { setLiteralSecretState } = await import("../../secret-states");
    await expect(setLiteralSecretState(newId(), "token", "shh")).rejects.toThrow();
  });

  it("holds a write made during a create, and stores it after the upsert", async () => {
    const { holdSecretWrites } = await import("../../secret-states");
    const { upsertCreatedResource } = await import("../../created-resource");
    const secrets = await services();
    const id = newId();
    const held = holdSecretWrites();
    const seen = await held.run(async () => {
      await secrets.setPlaintext!(id, "token", "shh");
      return secrets.getPlaintext(id, "token");
    });
    expect(seen).toBe("shh");
    expect(await rowOf(id)).toBeUndefined();

    await upsertCreatedResource({
      organizationId: orgId,
      pluginId: "fake",
      resourceTypeId: "thing",
      accountId,
      resource: instance(id),
    });
    await held.flush();

    await expect(secrets.getPlaintext(id, "token")).resolves.toBe("shh");
    expect((await rowOf(id))?.deletedAt).toBeNull();
  });

  it("keeps a held secret when the upsert failed, for the sync to find", async () => {
    const { holdSecretWrites } = await import("../../secret-states");
    const secrets = await services();
    const id = newId();
    const held = holdSecretWrites();
    await held.run(() => secrets.setPlaintext!(id, "token", "shh"));
    await held.flush();
    await expect(secrets.getPlaintext(id, "token")).resolves.toBe("shh");
  });

  it("stores a rotated secret on a resource with no row, unlisted until a sync revives it", async () => {
    const { upsertCreatedResource } = await import("../../created-resource");
    const secrets = await services();
    const id = newId();
    await secrets.setPlaintext!(id, "token", "rotated");
    await expect(secrets.getPlaintext(id, "token")).resolves.toBe("rotated");
    const anchored = await rowOf(id);
    expect(anchored?.deletedAt).toBeInstanceOf(Date);
    expect(anchored).toMatchObject({
      organizationId: orgId,
      pluginId: "fake",
      resourceTypeId: "thing",
      accountId,
    });

    await upsertCreatedResource({
      organizationId: orgId,
      pluginId: "fake",
      resourceTypeId: "thing",
      accountId,
      resource: instance(id),
    });
    expect((await rowOf(id))?.deletedAt).toBeNull();
    await expect(secrets.getPlaintext(id, "token")).resolves.toBe("rotated");
  });

  it("leaves a row that is already there alone", async () => {
    const { upsertCreatedResource } = await import("../../created-resource");
    const secrets = await services();
    const id = newId();
    await upsertCreatedResource({
      organizationId: orgId,
      pluginId: "fake",
      resourceTypeId: "thing",
      accountId,
      resource: instance(id),
    });
    await secrets.setPlaintext!(id, "token", "shh");
    expect(await rowOf(id)).toMatchObject({ displayName: "Thing", deletedAt: null });
  });

  it("does not hand a failed query's text, ciphertext included, to whoever called", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storeAccountSecret } = await import("../../secret-states");
    const err: unknown = await storeAccountSecret(
      "no-such-account",
      "no-such-account:t:x",
      "f",
      "s",
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String(err)).toContain(`could not store the secret "f"`);
    expect(String(err)).not.toContain("insert into");
    consoleError.mockRestore();
  });

  it("moves a resource an edit gave a new id, and retires the old row", async () => {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("../../db/client");
    const { dashboards, dashboardPins } = await import("../../db/schema");
    const { upsertCreatedResource, supersedeResource } = await import("../../created-resource");
    const before = newId();
    const after = newId();
    await upsertCreatedResource({
      organizationId: orgId,
      pluginId: "fake",
      resourceTypeId: "thing",
      accountId,
      resource: instance(before),
    });
    const dashboardId = randomUUID();
    const pinId = randomUUID();
    await db.insert(dashboards).values({ id: dashboardId, organizationId: orgId, name: "Main" });
    await db.insert(dashboardPins).values({ id: pinId, dashboardId, resourceId: before });

    await supersedeResource({
      organizationId: orgId,
      pluginId: "fake",
      resourceTypeId: "thing",
      accountId,
      previousId: before,
      resource: { ...instance(after), displayName: "Second version" },
    });

    expect((await rowOf(before))?.deletedAt).toBeInstanceOf(Date);
    expect(await rowOf(after)).toMatchObject({ displayName: "Second version", deletedAt: null });
    // A pin is something a person attached, so it follows the edit.
    const [pin] = await db.select().from(dashboardPins).where(eq(dashboardPins.id, pinId));
    expect(pin?.resourceId).toBe(after);
  });
});
