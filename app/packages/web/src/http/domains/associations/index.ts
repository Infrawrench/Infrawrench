/**
 * Associations: `/api/org/:orgId/associations`, the handlers.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, isNull, or } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  setLiteralSecretState,
  setOutputRefSecretState,
} from "@infrawrench/server-core/secret-states";
import { rerollCandidates, rerollSources } from "@infrawrench/client-core";
import { AssociationsApi, BadGateway, notFound, ok } from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { associations, resources } from "../../../db/schema";
import { loadPlugins } from "../../../plugins/loader";
import { getClientForAccount } from "../../../services/plugin-clients";
import { nextAssociationSyncVersion } from "../../../services/sync-versions";
import { makeDomain } from "../../domain";
import { legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";

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

/** The organization's row for `resourceId`, or null. */
const orgResource = (organizationId: string, resourceId: string) =>
  legacy(async () => {
    const [row] = await db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
      })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  });

/** A provider's refusal, carried out of the promise so it answers 502 rather than 500. */
class UpstreamRefused {
  constructor(readonly message: string) {}
}

const AssociationsHandlers = HttpApiBuilder.group(AssociationsApi, "associations", (handlers) =>
  handlers
    .handle("candidates", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const consumer = yield* orgResource(organizationId, query.resourceId);
        if (!consumer) return yield* notFound("Resource not found");
        return yield* legacy(async () => {
          const plugins = await loadPlugins();
          const sources = rerollSources(
            plugins.map((p) => ({
              pluginId: p.plugin.manifest.id,
              resourceTypes: p.plugin.resourceTypes,
            })),
            { pluginId: consumer.pluginId, resourceTypeId: consumer.resourceTypeId },
            query.fieldKey,
          );
          if (sources.length === 0) return [];
          const types = new Map<string, { pluginId: string; resourceTypeId: string }>();
          for (const s of sources) {
            types.set(`${s.pluginId}\u0000${s.resourceTypeId}`, s);
          }
          const rows = await db
            .select({
              id: resources.id,
              pluginId: resources.pluginId,
              resourceTypeId: resources.resourceTypeId,
              accountId: resources.accountId,
              displayName: resources.displayName,
              fields: resources.fieldsJson,
            })
            .from(resources)
            .where(
              and(
                eq(resources.organizationId, organizationId),
                isNull(resources.deletedAt),
                or(
                  ...[...types.values()].map((t) =>
                    and(
                      eq(resources.pluginId, t.pluginId),
                      eq(resources.resourceTypeId, t.resourceTypeId),
                    ),
                  ),
                ),
              ),
            );
          const logos = new Map(
            plugins.map((p) => [p.plugin.manifest.id, p.plugin.manifest.logoSvg]),
          );
          return rerollCandidates(sources, rows, consumer.id).map((c) => ({
            ...c,
            pluginLogoSvg: logos.get(c.pluginId) ?? "",
          }));
        });
      }),
    )
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
        const provider = yield* orgResource(organizationId, input.providerResourceId);
        if (!provider) return yield* notFound("Provider resource not found");

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
          // reconciler fills the cache on its next pass. The provider's plugin,
          // type and account come from its stored row, never from the body:
          // the reconciler resolves the output with them, so a body that
          // disagreed with the row would point the field (and any leaked-secret
          // match on it) at the wrong account.
          await setOutputRefSecretState(input.consumerResourceId, input.consumerFieldKey, {
            pluginId: provider.pluginId,
            resourceTypeId: provider.resourceTypeId,
            resourceId: provider.id,
            accountId: provider.accountId,
            outputKey: input.providerOutputKey,
          });
        });
        return ok;
      }),
    )
    .handle("literal", ({ payload: input }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resource = yield* orgResource(organizationId, input.resourceId);
        if (!resource) return yield* notFound("Resource not found");
        // Push to the provider first, so the store never holds a value the
        // provider has not accepted (resetting a Cloud SQL root password, say).
        // Plugins with nothing to push have no `applySecretReroll`. One `legacy`
        // call around the plugin call, so the egress scope covers it.
        yield* legacyTry(
          async () => {
            const ctx = await getClientForAccount(resource.accountId, organizationId);
            if (!ctx || ctx.plugin.manifest.id !== resource.pluginId) return;
            if (!ctx.client.applySecretReroll) return;
            try {
              await ctx.client.applySecretReroll(
                resource.resourceTypeId,
                resource.id,
                resource.accountId,
                input.fieldKey,
                input.plaintextValue,
              );
            } catch (err) {
              throw new UpstreamRefused(err instanceof Error ? err.message : String(err));
            }
          },
          (error) =>
            error instanceof UpstreamRefused
              ? new BadGateway({ error: `The provider refused the new value: ${error.message}` })
              : undefined,
        );
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
