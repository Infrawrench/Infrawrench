/**
 * Virtual tags: `/api/org/:orgId/virtual-tags`, the handlers. The logic lives
 * in server-core's `cost/virtual-tags` and `cost/virtual-tag-pass`, run
 * through `legacy` inside the request's scopes.
 *
 * Every mutation is audit-logged with the rules it stored, so "why did this
 * team's number move on Tuesday" has an answer.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { VirtualTag as VirtualTagValue } from "@infrawrench/client-core";
import {
  VirtualTagError,
  VirtualTagInUseError,
  VirtualTagKeyConflictError,
  createVirtualTag,
  deleteVirtualTag,
  getVirtualTag,
  listVirtualTags,
  reprocessVirtualTag,
  updateVirtualTag,
} from "@infrawrench/server-core/cost/virtual-tags";
import { previewVirtualTag } from "@infrawrench/server-core/cost/virtual-tag-pass";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, HttpFailure, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { isCostScoped, OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { VirtualTag, VirtualTagStats, VirtualTagsApi } from "./api";

/**
 * A write, its refusals answered as the Hono route's `writeError` did: a key
 * already taken and a tag still referenced are 409s (the second naming every
 * reference), any other rule the service enforces a 400.
 */
const virtualTagWrite = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof VirtualTagKeyConflictError) {
          throw new HttpFailure(409, { error: error.message });
        }
        if (error instanceof VirtualTagInUseError) {
          throw new HttpFailure(409, { error: error.message, references: error.references });
        }
        throw error;
      }
    },
    (error) =>
      error instanceof VirtualTagError ? new BadRequest({ error: error.message }) : undefined,
  );

/**
 * The stored processing stats are whole-org money (totals, unmatched spend,
 * spend per rule, top values by spend) with no cost row left to test a
 * visibility scope against, so a cost-scoped caller gets the tag and its
 * status without them. The live preview needs no such step: it reads through
 * the scoped cost readers.
 */
const forCaller = (scoped: boolean, tag: VirtualTagValue): VirtualTagValue => {
  const stats = tag.status.stats;
  if (!scoped || !stats) return tag;
  return { ...tag, status: { ...tag.status, stats: { ...stats, currencies: [] } } };
};

const VirtualTagsHandlers = HttpApiBuilder.group(VirtualTagsApi, "virtualTags", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const scoped = yield* isCostScoped;
        const tags = yield* legacy(() => listVirtualTags(organizationId));
        return yield* respond(Schema.Array(VirtualTag))(tags.map((t) => forCaller(scoped, t)));
      }),
    )
    /**
     * Evaluate an unsaved definition over the trailing 30 days (spend per
     * rule, unmatched spend, top values), so the editor can show what a rule
     * would do before anything is stored.
     */
    .handle("preview", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const stats = yield* virtualTagWrite(() => previewVirtualTag(organizationId, payload));
        return yield* respond(VirtualTagStats)(stats);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const scoped = yield* isCostScoped;
        const tag = yield* legacy(() => getVirtualTag(organizationId, params.id));
        if (!tag) return yield* notFound();
        return yield* respond(VirtualTag)(forCaller(scoped, tag));
      }),
    )
    // Processing is queued at once.
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const tag = yield* virtualTagWrite(() =>
          createVirtualTag(organizationId, payload, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "virtual_tag.create",
            entityType: "virtual_tag",
            entityId: tag.id,
            metadata: {
              key: tag.key,
              name: tag.name,
              rules: tag.rules,
              defaultValue: tag.defaultValue,
            },
          }),
        );
        return yield* respond(VirtualTag)(tag);
      }),
    )
    // A full replace, rule order included. The key cannot change (400 naming
    // why); saving re-queues processing.
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const tag = yield* virtualTagWrite(() =>
          updateVirtualTag(organizationId, params.id, payload),
        );
        if (!tag) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "virtual_tag.update",
            entityType: "virtual_tag",
            entityId: tag.id,
            metadata: {
              key: tag.key,
              name: tag.name,
              rules: tag.rules,
              defaultValue: tag.defaultValue,
            },
          }),
        );
        return yield* respond(VirtualTag)(tag);
      }),
    )
    // Re-run the backfill evaluation now.
    .handle("reprocess", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const tag = yield* legacy(() => reprocessVirtualTag(organizationId, params.id));
        if (!tag) return yield* notFound();
        return yield* respond(VirtualTag)(tag);
      }),
    )
    /**
     * Refused with a 409 naming every saved filter, budget, report, alert,
     * allocation rule, export or metric that still references the key:
     * deleting it would make those fail.
     */
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* virtualTagWrite(() => deleteVirtualTag(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "virtual_tag.delete",
            entityType: "virtual_tag",
            entityId: params.id,
          }),
        );
        return ok;
      }),
    ),
);

export const virtualTagsDomain = makeDomain("virtual-tags", VirtualTagsApi, VirtualTagsHandlers);
