/**
 * Resource leases: `/api/org/:orgId/leases`, the handlers. The store is
 * promise code and runs through `legacy`; the write bodies are checked here,
 * field by field, with the sentences the routes always answered with.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  LeaseInputError,
  cancelLeaseRecord,
  createLeaseRecord,
  deleteLeaseRecord,
  getLeaseRecord,
  getLeaseWire,
  getLeaseWireByResource,
  listLeases,
  updateLeaseRecord,
  type LeaseCreateInput,
  type LeaseUpdateInput,
} from "@infrawrench/server-core/leases/store";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, NotFound, badRequest } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { refusalCall, type RefusalCallOptions } from "../input-refusals";
import {
  LeaseConflict,
  LeasesApi,
  ResourceLease,
  ResourceLeaseList,
  ResourceLeaseLookup,
} from "./api";

const store: RefusalCallOptions<LeaseInputError> = {
  isInputError: (error): error is LeaseInputError => error instanceof LeaseInputError,
  logPrefix: "[leases]",
  failure: "Lease operation failed",
};

const badRequestOr404 = {
  400: (error: string) => new BadRequest({ error }),
  404: (error: string) => new NotFound({ error }),
};

const LeasesHandlers = HttpApiBuilder.group(LeasesApi, "leases", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const leases = yield* legacy(() => listLeases(organizationId));
        return yield* respond(ResourceLeaseList)(leases);
      }),
    )
    .handle("resource", ({ query }) =>
      Effect.gen(function* () {
        if (!query.resourceId) return yield* badRequest("Missing resourceId");
        const { organizationId } = yield* OrgPrincipal;
        const lease = yield* legacy(() => getLeaseWireByResource(organizationId, query.resourceId));
        return yield* respond(ResourceLeaseLookup)({ lease });
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const body = parsed.body;
        const resourceId = body["resourceId"];
        const accountId = body["accountId"];
        const expiresAt = body["expiresAt"];
        const autoDelete = body["autoDelete"];
        const note = body["note"];
        if (!Predicate.isString(resourceId) || !Predicate.isString(accountId)) {
          return yield* invalidBody("resourceId and accountId are required");
        }
        if (!Predicate.isString(expiresAt)) {
          return yield* invalidBody("expiresAt is required (ISO 8601)");
        }
        if (autoDelete !== undefined && !Predicate.isBoolean(autoDelete)) {
          return yield* invalidBody("autoDelete must be a boolean");
        }
        if (note !== undefined && !Predicate.isString(note)) {
          return yield* invalidBody("note must be a string");
        }
        // An auto-delete lease is a standing deletion: it needs the same
        // permission the direct delete endpoint gates on.
        if (autoDelete === true) yield* requirePermission("resources:delete");

        const { organizationId, session } = yield* OrgPrincipal;
        const input: LeaseCreateInput = {
          resourceId,
          accountId,
          expiresAt,
          ...(autoDelete !== undefined ? { autoDelete } : {}),
          ...(note !== undefined ? { note } : {}),
        };
        const wire = yield* refusalCall(
          store,
          { ...badRequestOr404, 409: (error: string) => new LeaseConflict({ error }) },
          async () => {
            const created = await createLeaseRecord(organizationId, input, session.userId);
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "resource_lease.create",
              entityType: "resource_lease",
              entityId: created.id,
              metadata: {
                resourceId: created.resourceId,
                pluginId: created.pluginId,
                resourceTypeId: created.resourceTypeId,
                expiresAt: created.expiresAt.toISOString(),
                autoDelete: created.autoDelete,
              },
            });
            return getLeaseWire(organizationId, created.id);
          },
        );
        return yield* respond(ResourceLease, { status: 201 })(wire);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const body = parsed.body;

        const patch: LeaseUpdateInput = {};
        const expiresAt = body["expiresAt"];
        if (expiresAt !== undefined) {
          if (!Predicate.isString(expiresAt)) {
            return yield* invalidBody("expiresAt must be a string (ISO 8601)");
          }
          patch.expiresAt = expiresAt;
        }
        const autoDelete = body["autoDelete"];
        if (autoDelete !== undefined) {
          if (!Predicate.isBoolean(autoDelete)) {
            return yield* invalidBody("autoDelete must be a boolean");
          }
          patch.autoDelete = autoDelete;
        }
        const note = body["note"];
        if (note !== undefined) {
          if (note !== null && !Predicate.isString(note)) {
            return yield* invalidBody("note must be a string or null");
          }
          patch.note = note;
        }
        if (Object.keys(patch).length === 0) return yield* invalidBody("No changes supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        // resources:delete gates auto-delete by *effective* state: turning it
        // on, and reshaping a lease that stays armed because the patch omits
        // the flag, otherwise resources:write could re-arm a delete with a new
        // deadline.
        if (patch.autoDelete === true) {
          yield* requirePermission("resources:delete");
        } else if (patch.autoDelete === undefined) {
          const existing = yield* legacy(() => getLeaseRecord(organizationId, params.leaseId));
          if (existing?.autoDelete) yield* requirePermission("resources:delete");
        }

        const wire = yield* refusalCall(store, badRequestOr404, async () => {
          const updated = await updateLeaseRecord(organizationId, params.leaseId, patch);
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "resource_lease.update",
            entityType: "resource_lease",
            entityId: updated.id,
            metadata: { resourceId: updated.resourceId, patch: { ...patch } },
          });
          return getLeaseWire(organizationId, updated.id);
        });
        return yield* respond(ResourceLease)(wire);
      }),
    )
    .handle("cancel", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const wire = yield* refusalCall(store, badRequestOr404, async () => {
          const canceled = await cancelLeaseRecord(organizationId, params.leaseId);
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "resource_lease.cancel",
            entityType: "resource_lease",
            entityId: canceled.id,
            metadata: { resourceId: canceled.resourceId, pluginId: canceled.pluginId },
          });
          return getLeaseWire(organizationId, canceled.id);
        });
        return yield* respond(ResourceLease)(wire);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* refusalCall(store, { 404: (error: string) => new NotFound({ error }) }, async () => {
          const deleted = await deleteLeaseRecord(organizationId, params.leaseId);
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "resource_lease.delete",
            entityType: "resource_lease",
            entityId: deleted.id,
            metadata: { resourceId: deleted.resourceId, pluginId: deleted.pluginId },
          });
        });
      }),
    ),
);

export const leasesDomain = makeDomain("leases", LeasesApi, LeasesHandlers);
