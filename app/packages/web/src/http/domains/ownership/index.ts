/**
 * Resource ownership: `/api/org/:orgId/ownership`, the handlers. Read by the
 * orphan finder (which annotates every flagged row with its owner) and by the
 * alert notifier (which routes a resource-scoped alert to the owning person).
 *
 * There is one write endpoint, an upsert keyed by resource: the caller knows
 * which resource it is editing, not whether a row already exists.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { ResourceOwnershipPatch } from "@infrawrench/client-core";
import {
  OwnershipInputError,
  deleteOwnership,
  getOwnershipByResource,
  listOwnerCandidates,
  listOwnership,
  upsertOwnership,
} from "@infrawrench/server-core/ownership/store";
import {
  badRequest,
  notFound,
  OwnerCandidateListResponse,
  OwnershipApi,
  ResourceOwnershipEnvelope,
  ResourceOwnershipListResponse,
  SavedOwnership,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refusalCall, inputRefusals, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

type Body = { readonly [key: string]: unknown };

const ownershipStore = refusalsOf(OwnershipInputError, {
  logPrefix: "[ownership]",
  failure: "Ownership operation failed",
});

/**
 * A nullable string field on the patch: absent keeps, `null` clears, a string
 * sets. The three cases are distinguishable in JSON and all three are
 * meaningful, so the boundary must not collapse them.
 */
function readNullableString(
  body: Body,
  key: string,
): { ok: true; value?: string | null } | { ok: false } {
  if (!(key in body)) return { ok: true };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false };
}

const OwnershipHandlers = HttpApiBuilder.group(OwnershipApi, "ownership", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const list = yield* legacy(() => listOwnership(organizationId));
        return yield* respond(ResourceOwnershipListResponse)(list);
      }),
    )
    /**
     * People an owner can be set to. On `resources:read` rather than
     * `team:read`: recording who owns a resource must not be a privilege
     * reserved for whoever can also see roles and membership dates. The
     * projection is correspondingly minimal: id, name, email, nothing else.
     */
    .handle("members", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const members = yield* legacy(() => listOwnerCandidates(organizationId));
        return yield* respond(OwnerCandidateListResponse)({ members });
      }),
    )
    /** The (unique) ownership record for `?resourceId=`, or null. */
    .handle("resource", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        if (!query.resourceId) return yield* badRequest("Missing resourceId");
        const ownership = yield* legacy(() =>
          getOwnershipByResource(organizationId, query.resourceId),
        );
        return yield* respond(ResourceOwnershipEnvelope)({ ownership });
      }),
    )
    /**
     * Upsert one resource's ownership. Answers 200 with `null` when the patch
     * left the record empty, because clearing every field deletes the row
     * (see the store): the response is the new truth, and inventing an
     * all-null record to return would contradict what the next GET says.
     */
    .handleRaw("set", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const resourceId = body["resourceId"];
        if (typeof resourceId !== "string" || !resourceId) {
          return yield* badRequest("resourceId is required");
        }
        const ownerUserId = readNullableString(body, "ownerUserId");
        const ownerLabel = readNullableString(body, "ownerLabel");
        const purpose = readNullableString(body, "purpose");
        const ticketUrl = readNullableString(body, "ticketUrl");
        if (!ownerUserId.ok || !ownerLabel.ok || !purpose.ok || !ticketUrl.ok) {
          return yield* badRequest(
            "ownerUserId, ownerLabel, purpose and ticketUrl must be strings",
          );
        }
        const patch: ResourceOwnershipPatch = {
          resourceId,
          ...("value" in ownerUserId ? { ownerUserId: ownerUserId.value } : {}),
          ...("value" in ownerLabel ? { ownerLabel: ownerLabel.value } : {}),
          ...("value" in purpose ? { purpose: purpose.value } : {}),
          ...("value" in ticketUrl ? { ticketUrl: ticketUrl.value } : {}),
        };
        const saved = yield* refusalCall(ownershipStore, inputRefusals, () =>
          upsertOwnership(organizationId, patch, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: saved ? "resource_ownership.set" : "resource_ownership.clear",
            entityType: "resource_ownership",
            entityId: patch.resourceId,
            metadata: {
              ownerUserId: saved?.ownerUserId ?? null,
              ownerLabel: saved?.ownerLabel ?? null,
              ticketUrl: saved?.ticketUrl ?? null,
            },
          }),
        );
        return yield* respond(SavedOwnership)(saved);
      }),
    )
    /** Drop `?resourceId=`'s record entirely. */
    .handle("clear", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const resourceId = query.resourceId;
        if (!resourceId) return yield* badRequest("Missing resourceId");
        const removed = yield* refusalCall(ownershipStore, inputRefusals, () =>
          deleteOwnership(organizationId, resourceId),
        );
        if (!removed) return yield* notFound("No ownership recorded for this resource");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "resource_ownership.clear",
            entityType: "resource_ownership",
            entityId: resourceId,
          }),
        );
      }),
    ),
);

export const ownershipDomain = makeDomain("ownership", OwnershipApi, OwnershipHandlers);
