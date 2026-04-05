"use server";

import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { associations, secretFieldStates, resources } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt } from "@/services/encryption";
import { v4 as uuidv4 } from "uuid";

/**
 * Create or update an association between two resources.
 * Called when the user picks a provider in the AssociationPicker (reroll) modal.
 */
export async function upsertAssociation(input: {
  consumerResourceId: string;
  consumerFieldKey: string;
  providerResourceId: string;
  providerOutputKey: string;
  providerPluginId: string;
  providerResourceTypeId: string;
  providerAccountId: string;
}) {
  const { organizationId } = await requireAuth();

  // Verify consumer resource belongs to this org
  const [consumer] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(eq(resources.id, input.consumerResourceId), eq(resources.organizationId, organizationId)),
    )
    .limit(1);
  if (!consumer) throw new Error("Resource not found");

  const now = new Date();
  const assocId = uuidv4();

  // Upsert association row
  await db
    .insert(associations)
    .values({
      id: assocId,
      consumerResourceId: input.consumerResourceId,
      consumerFieldKey: input.consumerFieldKey,
      providerResourceId: input.providerResourceId,
      providerOutputKey: input.providerOutputKey,
    })
    .onConflictDoUpdate({
      target: [associations.consumerResourceId, associations.consumerFieldKey],
      set: {
        providerResourceId: input.providerResourceId,
        providerOutputKey: input.providerOutputKey,
        updatedAt: now,
      },
    });

  // Upsert secret field state as output-ref
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
        // Clear stale cache when the association changes
        cachedEncryptedValue: null,
        cachedValueIv: null,
        cachedAt: null,
        updatedAt: now,
      },
    });
}

/**
 * Set a secret field to a literal value (e.g. user pastes a kubeconfig).
 */
export async function setLiteralSecret(input: {
  resourceId: string;
  fieldKey: string;
  plaintextValue: string;
}) {
  const { organizationId } = await requireAuth();

  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(eq(resources.id, input.resourceId), eq(resources.organizationId, organizationId)),
    )
    .limit(1);
  if (!resource) throw new Error("Resource not found");

  const { ciphertext, iv } = await encrypt(input.plaintextValue);

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

  // Remove any existing association for this field
  await db
    .delete(associations)
    .where(
      and(
        eq(associations.consumerResourceId, input.resourceId),
        eq(associations.consumerFieldKey, input.fieldKey),
      ),
    );
}
