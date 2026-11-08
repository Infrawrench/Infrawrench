/**
 * Associations: `/api/org/:orgId/associations`, the handlers.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  setLiteralSecretState,
  setOutputRefSecretState,
} from "@infrawrench/server-core/secret-states";
import { db } from "../../../db/client";
import { associations, resources } from "../../../db/schema";
import { nextAssociationSyncVersion } from "../../../services/sync-versions";
import { makeDomain } from "../../domain";
import { notFound } from "../../errors";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { ok } from "../../schemas/common";
import { AssociationsApi } from "./api";

/** True when `resourceId` is one of the organization's resources. */
const resourceInOrg = (organizationId: string, resourceId: string) =>
  legacy(async () => {
    const [row] = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
      .limit(1);
    return row !== undefined;
  });

const AssociationsHandlers = HttpApiBuilder.group(AssociationsApi, "associations", (handlers) =>
  handlers
    .handle("create", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        if (!(yield* resourceInOrg(organizationId, input.consumerResourceId))) {
          return yield* notFound("Resource not found");
        }
        // The provider needs the same org check as the consumer.
        // `provider_resource_id` is a foreign key with ON DELETE RESTRICT, so an
        // unvalidated one lets a caller pin a row in someone else's
        // organization: the owning org then can't hard-delete that resource
        // (see the agent-session teardown in `http/domains/agents/sessions.ts`), and the
        // failure lands after the cloud resource is already gone.
        if (!(yield* resourceInOrg(organizationId, input.providerResourceId))) {
          return yield* notFound("Provider resource not found");
        }

        yield* legacy(async () => {
          await db
            .insert(associations)
            .values({
              id: uuidv4(),
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
                updatedAt: new Date(),
              },
            });

          // No cached value: this route sets the reference blind, and the
          // reconciler fills the cache on its next pass.
          await setOutputRefSecretState(input.consumerResourceId, input.consumerFieldKey, {
            pluginId: input.providerPluginId,
            resourceTypeId: input.providerResourceTypeId,
            resourceId: input.providerResourceId,
            accountId: input.providerAccountId,
            outputKey: input.providerOutputKey,
          });
        });
        return ok;
      }),
    )
    .handle("literal", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        if (!(yield* resourceInOrg(organizationId, input.resourceId))) {
          return yield* notFound("Resource not found");
        }
        yield* legacy(async () => {
          await setLiteralSecretState(input.resourceId, input.fieldKey, input.plaintextValue);
          await db
            .delete(associations)
            .where(
              and(
                eq(associations.consumerResourceId, input.resourceId),
                eq(associations.consumerFieldKey, input.fieldKey),
              ),
            );
        });
        return ok;
      }),
    ),
);

export const associationsDomain = makeDomain("associations", AssociationsApi, AssociationsHandlers);
