/**
 * Per-object sharing: `/api/org/:orgId/sharing/:objectType/:objectId`, the
 * handlers, for cost reports, report folders, dashboards and the other
 * shareable objects. See `services/object-sharing.ts` for the model.
 *
 * Reading the document needs viewer on the object plus the object family's
 * read permission; replacing it needs owner on the object plus the family's
 * write permission. The family permission is checked here, after the type is
 * known; the object level is the service's, which throws the sharing errors
 * the error renderer answers (404 below viewer, 403 below owner, 400 for a
 * bad document).
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  OBJECT_ACCESS_LEVELS,
  ORG_ACCESS_LEVELS,
  SHAREABLE_OBJECT_TYPES,
  SHARING_GRANT_PRINCIPAL_KINDS,
  type ObjectSharingInput,
  type ShareableObjectType,
} from "@infrawrench/client-core";
import { badRequest, ObjectSharing, ok, SharingApi } from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  getObjectSharing,
  putObjectSharing,
  resetObjectSharing,
} from "../../../services/object-sharing";
import { makeDomain } from "../../domain";
import { readJsonOr } from "../../request-body";
import { fireAndForget, legacy } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

const READ_PERMISSION: Record<ShareableObjectType, string> = {
  cost_report: "costs:read",
  cost_report_folder: "costs:read",
  cost_canvas: "costs:read",
  kubernetes_efficiency_report: "costs:read",
  resource_report: "resources:read",
  network_flow_report: "costs:read",
  dashboard: "dashboards:read",
  savings_view: "resources:read",
};
const WRITE_PERMISSION: Record<ShareableObjectType, string> = {
  cost_report: "costs:write",
  cost_report_folder: "costs:write",
  cost_canvas: "costs:write",
  kubernetes_efficiency_report: "costs:write",
  resource_report: "resources:write",
  network_flow_report: "costs:write",
  dashboard: "dashboards:write",
  savings_view: "resources:write",
};

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    values.some((v) => v === value);

const isShareableType = oneOf(SHAREABLE_OBJECT_TYPES);
const isOrgAccess = oneOf(ORG_ACCESS_LEVELS);
const isGrantKind = oneOf(SHARING_GRANT_PRINCIPAL_KINDS);
const isAccessLevel = oneOf(OBJECT_ACCESS_LEVELS);

/** A property of a parsed JSON value: what `(value ?? {})[key]` read. */
const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined;

/** The type in the path, refused before any permission is looked at. */
const objectType = Effect.fnUntraced(function* (raw: string) {
  if (!isShareableType(raw)) return yield* badRequest("Unknown object type");
  return raw;
});

/** The sharing document, checked field by field with the sentences it always had. */
const parseInput = Effect.fnUntraced(function* (raw: unknown) {
  if (!Predicate.isObjectOrArray(raw)) return yield* badRequest("Expected a JSON object.");
  const orgAccess = field(raw, "orgAccess");
  if (!isOrgAccess(orgAccess)) {
    return yield* badRequest("orgAccess must be editor, viewer or none.");
  }
  const grants = field(raw, "grants") ?? [];
  if (!Array.isArray(grants)) return yield* badRequest("grants must be a list.");
  const parsed: ObjectSharingInput["grants"] = [];
  for (const grant of grants) {
    const kind = field(grant, "principalKind");
    const id = field(grant, "principalId");
    const level = field(grant, "level");
    if (!isGrantKind(kind)) {
      return yield* badRequest("Each grant's principalKind must be member or role.");
    }
    if (!Predicate.isString(id) || id.length === 0) {
      return yield* badRequest("Each grant needs a principalId.");
    }
    if (!isAccessLevel(level)) {
      return yield* badRequest("Each grant's level must be owner, editor or viewer.");
    }
    parsed.push({ principalKind: kind, principalId: id, level });
  }
  const input: ObjectSharingInput = { orgAccess, grants: parsed };
  return input;
});

const SharingHandlers = HttpApiBuilder.group(SharingApi, "sharing", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const type = yield* objectType(params.objectType);
        yield* requirePermission(READ_PERMISSION[type]);
        const { organizationId } = yield* OrgPrincipal;
        const sharing = yield* legacy(() =>
          getObjectSharing(organizationId, type, params.objectId),
        );
        return yield* respond(ObjectSharing)(sharing);
      }),
    )
    .handleRaw("replace", ({ params, request }) =>
      Effect.gen(function* () {
        const type = yield* objectType(params.objectType);
        yield* requirePermission(WRITE_PERMISSION[type]);
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* parseInput(yield* readJsonOr(request, null));
        const result = yield* legacy(() =>
          putObjectSharing(organizationId, type, params.objectId, input, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "sharing.update",
            entityType: type,
            entityId: params.objectId,
            metadata: { orgAccess: input.orgAccess, grants: input.grants.length },
          }),
        );
        return yield* respond(ObjectSharing)(result);
      }),
    )
    .handle("reset", ({ params }) =>
      Effect.gen(function* () {
        const type = yield* objectType(params.objectType);
        yield* requirePermission(WRITE_PERMISSION[type]);
        const { organizationId, session } = yield* OrgPrincipal;
        yield* legacy(() => resetObjectSharing(organizationId, type, params.objectId));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "sharing.reset",
            entityType: type,
            entityId: params.objectId,
            metadata: {},
          }),
        );
        return ok;
      }),
    ),
);

export const sharingDomain = makeDomain("sharing", SharingApi, SharingHandlers);
