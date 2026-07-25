import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { associations, secretFieldStates, resources } from "../../db/schema";
import { encrypt, buildAad } from "../../services/encryption";
import { requirePermission } from "../../auth/permissions";
import { nextAssociationSyncVersion } from "../../services/sync-versions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/associations — create or update an association */
app.post("/", async (c) => {
  requirePermission(c, "secrets:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    consumerResourceId: string;
    consumerFieldKey: string;
    providerResourceId: string;
    providerOutputKey: string;
    providerPluginId: string;
    providerResourceTypeId: string;
    providerAccountId: string;
  }>();

  const [consumer] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(eq(resources.id, input.consumerResourceId), eq(resources.organizationId, organizationId)),
    )
    .limit(1);
  if (!consumer) return c.json({ error: "Resource not found" }, 404);

  // The provider needs the same org check as the consumer. `provider_resource_id`
  // is a foreign key with ON DELETE RESTRICT, so an unvalidated one lets a
  // caller pin a row in someone else's organization: the owning org then can't
  // hard-delete that resource (see the agent-session teardown in
  // `api/routes/agents.ts`), and the failure lands after the cloud resource is
  // already gone.
  const [provider] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(eq(resources.id, input.providerResourceId), eq(resources.organizationId, organizationId)),
    )
    .limit(1);
  if (!provider) return c.json({ error: "Provider resource not found" }, 404);

  const now = new Date();
  const assocId = uuidv4();

  await db
    .insert(associations)
    .values({
      id: assocId,
      consumerResourceId: input.consumerResourceId,
      consumerFieldKey: input.consumerFieldKey,
      providerResourceId: input.providerResourceId,
      providerOutputKey: input.providerOutputKey,
      syncVersion: nextAssociationSyncVersion(organizationId),
    })
    .onConflictDoUpdate({
      target: [associations.consumerResourceId, associations.consumerFieldKey],
      set: {
        providerResourceId: input.providerResourceId,
        providerOutputKey: input.providerOutputKey,
        syncVersion: nextAssociationSyncVersion(organizationId),
        updatedAt: now,
      },
    });

  await db
    .insert(secretFieldStates)
    .values({
      id: uuidv4(),
      resourceId: input.consumerResourceId,
      fieldKey: input.consumerFieldKey,
      resolutionKind: "output-ref",
      sourcePluginId: input.providerPluginId,
      sourceResourceTypeId: input.providerResourceTypeId,
      sourceResourceId: input.providerResourceId,
      sourceAccountId: input.providerAccountId,
      sourceOutputKey: input.providerOutputKey,
    })
    .onConflictDoUpdate({
      target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
      set: {
        resolutionKind: "output-ref",
        sourcePluginId: input.providerPluginId,
        sourceResourceTypeId: input.providerResourceTypeId,
        sourceResourceId: input.providerResourceId,
        sourceAccountId: input.providerAccountId,
        sourceOutputKey: input.providerOutputKey,
        cachedEncryptedValue: null,
        cachedValueIv: null,
        cachedAt: null,
        updatedAt: now,
      },
    });

  return c.json({ ok: true });
});

/** POST /api/associations/literal — set a secret field to a literal value */
app.post("/literal", async (c) => {
  requirePermission(c, "secrets:write");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    resourceId: string;
    fieldKey: string;
    plaintextValue: string;
  }>();

  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, input.resourceId), eq(resources.organizationId, organizationId)))
    .limit(1);
  if (!resource) return c.json({ error: "Resource not found" }, 404);

  const { ciphertext, iv } = await encrypt(
    input.plaintextValue,
    buildAad("secretField", `${input.resourceId}:${input.fieldKey}`, "value"),
  );

  await db
    .insert(secretFieldStates)
    .values({
      id: uuidv4(),
      resourceId: input.resourceId,
      fieldKey: input.fieldKey,
      resolutionKind: "literal",
      encryptedValue: ciphertext,
      valueIv: iv,
    })
    .onConflictDoUpdate({
      target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
      set: {
        resolutionKind: "literal",
        encryptedValue: ciphertext,
        valueIv: iv,
        sourcePluginId: null,
        sourceResourceTypeId: null,
        sourceResourceId: null,
        sourceAccountId: null,
        sourceOutputKey: null,
        cachedEncryptedValue: null,
        cachedValueIv: null,
        cachedAt: null,
        updatedAt: new Date(),
      },
    });

  await db
    .delete(associations)
    .where(
      and(
        eq(associations.consumerResourceId, input.resourceId),
        eq(associations.consumerFieldKey, input.fieldKey),
      ),
    );

  return c.json({ ok: true });
});

export { app as associationRoutes };
