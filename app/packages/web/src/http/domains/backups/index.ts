/**
 * Backup coverage: `/api/org/:orgId/backups`, the handlers.
 *
 * The coverage is assembled in server-core (`backups/feed.ts`) so the web API
 * and the weekly digest share one computation: a read over already-synced
 * state, no provider API calls. It quotes orphaned backups' spend, so it runs
 * inside the caller's cost visibility (`OrgAuth`). Policy and drill changes
 * are audited.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { listBackupCoverage } from "@infrawrench/server-core/backups/feed";
import {
  RestoreDrillInputError,
  createRestoreDrill,
  deleteRestoreDrill,
  listDrillCoverage,
  listRestoreDrills,
} from "@infrawrench/server-core/backups/drills";
import {
  DRILL_OUTCOMES,
  type BackupPolicyInput,
  type DrillOutcome,
} from "@infrawrench/client-core";
import {
  BackupPolicyInputError,
  createBackupPolicy,
  deleteBackupPolicy,
  listBackupPolicies,
  updateBackupPolicy,
} from "@infrawrench/server-core/backups/store";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal } from "../../refusals";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  BackupCoverageResponse,
  BackupPolicy,
  BackupPolicyList,
  BackupsApi,
  DrillCoverageResponse,
  RestoreDrill,
  RestoreDrillLog,
} from "./api";

type Body = { readonly [key: string]: unknown };
type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * One optional nullable integer, distinguishing "absent" (leave alone) from
 * `null` (clear), which is the whole point of a PATCH here, since clearing an
 * RPO is a legitimate edit.
 */
function readNullableInt(body: Body, key: string): Read<number | null | undefined> {
  if (!(key in body)) return { ok: true, value: undefined };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (!Predicate.isNumber(raw) || !Number.isInteger(raw)) {
    return { ok: false, error: `${key} must be a whole number or null` };
  }
  return { ok: true, value: raw };
}

function readNullableString(body: Body, key: string): Read<string | null | undefined> {
  if (!(key in body)) return { ok: true, value: undefined };
  const raw = body[key];
  if (raw === null) return { ok: true, value: null };
  if (!Predicate.isString(raw)) return { ok: false, error: `${key} must be a string or null` };
  return { ok: true, value: raw };
}

function readTypeIds(body: Body): Read<string[] | undefined> {
  if (!("resourceTypeIds" in body)) return { ok: true, value: undefined };
  const raw: unknown = body["resourceTypeIds"];
  if (!Array.isArray(raw)) {
    return { ok: false, error: "resourceTypeIds must be an array of strings" };
  }
  const ids: unknown[] = raw;
  if (!ids.every(Predicate.isString)) {
    return { ok: false, error: "resourceTypeIds must be an array of strings" };
  }
  return { ok: true, value: ids };
}

const isDrillOutcome = (value: unknown): value is DrillOutcome =>
  DRILL_OUTCOMES.some((outcome) => outcome === value);

/** The policy fields both create and update read, each checked in turn. */
const readPolicyFields = (body: Body) =>
  Effect.gen(function* () {
    const typeIds = readTypeIds(body);
    if (!typeIds.ok) return yield* badRequest(typeIds.error);
    const tagKey = readNullableString(body, "tagKey");
    if (!tagKey.ok) return yield* badRequest(tagKey.error);
    const tagValue = readNullableString(body, "tagValue");
    if (!tagValue.ok) return yield* badRequest(tagValue.error);
    const maxRpoHours = readNullableInt(body, "maxRpoHours");
    if (!maxRpoHours.ok) return yield* badRequest(maxRpoHours.error);
    const minRetentionDays = readNullableInt(body, "minRetentionDays");
    if (!minRetentionDays.ok) return yield* badRequest(minRetentionDays.error);
    const enabled = body["enabled"];
    if (enabled !== undefined && !Predicate.isBoolean(enabled)) {
      return yield* badRequest("enabled must be a boolean");
    }
    return {
      ...(typeIds.value !== undefined ? { resourceTypeIds: typeIds.value } : {}),
      ...(tagKey.value !== undefined ? { tagKey: tagKey.value } : {}),
      ...(tagValue.value !== undefined ? { tagValue: tagValue.value } : {}),
      ...(maxRpoHours.value !== undefined ? { maxRpoHours: maxRpoHours.value } : {}),
      ...(minRetentionDays.value !== undefined ? { minRetentionDays: minRetentionDays.value } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
  });

const policyRefusal = (error: unknown) =>
  error instanceof BackupPolicyInputError ? inputRefusal(error) : undefined;

const BackupsHandlers = HttpApiBuilder.group(BackupsApi, "backups", (handlers) =>
  handlers
    /** What protects the org's stateful resources, what does not, and which backups protect nothing. */
    .handle("coverage", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const coverage = yield* legacy(() => listBackupCoverage(organizationId));
        return yield* respond(BackupCoverageResponse)(coverage);
      }),
    )
    .handle("listPolicies", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const policies = yield* legacy(() => listBackupPolicies(organizationId));
        return yield* respond(BackupPolicyList)({ policies });
      }),
    )
    .handleRaw("createPolicy", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const name = read.body["name"];
        if (!Predicate.isString(name)) return yield* badRequest("name is required");
        const fields = yield* readPolicyFields(read.body);
        const input: BackupPolicyInput = { name, ...fields };

        const { organizationId, session } = yield* OrgPrincipal;
        const userId = session.userId;
        const policy = yield* legacyTry(
          () => createBackupPolicy(organizationId, input, userId ?? null),
          policyRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId,
            action: "backup_policy.create",
            entityType: "backup_policy",
            entityId: policy.id,
            metadata: {
              name: policy.name,
              maxRpoHours: policy.maxRpoHours,
              minRetentionDays: policy.minRetentionDays,
            },
          }),
        );
        return yield* respond(BackupPolicy)(policy);
      }),
    )
    .handleRaw("updatePolicy", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const name = read.body["name"];
        if (name !== undefined && !Predicate.isString(name)) {
          return yield* badRequest("name must be a string");
        }
        const fields = yield* readPolicyFields(read.body);
        const patch: Partial<BackupPolicyInput> = {
          ...(name !== undefined ? { name } : {}),
          ...fields,
        };
        if (Object.keys(patch).length === 0) return yield* badRequest("No changes supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        const policy = yield* legacyTry(
          () => updateBackupPolicy(organizationId, params.policyId, patch),
          policyRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "backup_policy.update",
            entityType: "backup_policy",
            entityId: policy.id,
            metadata: {
              name: policy.name,
              maxRpoHours: policy.maxRpoHours,
              minRetentionDays: policy.minRetentionDays,
              enabled: policy.enabled,
            },
          }),
        );
        return yield* respond(BackupPolicy)(policy);
      }),
    )
    .handle("deletePolicy", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const policyId = params.policyId;
        const removed = yield* legacy(() => deleteBackupPolicy(organizationId, policyId));
        if (!removed) return yield* notFound("No such backup policy");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "backup_policy.delete",
            entityType: "backup_policy",
            entityId: policyId,
          }),
        );
      }),
    )
    /** Where every protected resource stands on restore, plus the org's drill log. */
    .handle("drillCoverage", ({ query }) =>
      Effect.gen(function* () {
        const raw = query.validDays;
        const validDays = raw === undefined ? undefined : Number(raw);
        if (
          validDays !== undefined &&
          (!Number.isInteger(validDays) || validDays < 7 || validDays > 730)
        ) {
          return yield* badRequest("validDays must be a whole number between 7 and 730");
        }
        const { organizationId } = yield* OrgPrincipal;
        const coverage = yield* legacy(() =>
          listDrillCoverage(organizationId, validDays === undefined ? {} : { validDays }),
        );
        return yield* respond(DrillCoverageResponse)(coverage);
      }),
    )
    .handle("drillLog", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resourceId = query.resourceId;
        const drills = yield* legacy(() =>
          listRestoreDrills(organizationId, { ...(resourceId ? { resourceId } : {}) }),
        );
        return yield* respond(RestoreDrillLog)({ drills });
      }),
    )
    /** Record that somebody tried. */
    .handleRaw("recordDrill", ({ request }) =>
      Effect.gen(function* () {
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const resourceId = body["resourceId"];
        const performedAt = body["performedAt"];
        const outcome = body["outcome"];
        if (!Predicate.isString(resourceId)) return yield* badRequest("resourceId is required");
        if (!Predicate.isString(performedAt)) return yield* badRequest("performedAt is required");
        if (!Predicate.isString(outcome) || !isDrillOutcome(outcome)) {
          return yield* badRequest(`outcome must be one of ${DRILL_OUTCOMES.join(", ")}`);
        }
        const rto = readNullableInt(body, "rtoMinutes");
        if (!rto.ok) return yield* badRequest(rto.error);
        const restoredFrom = readNullableString(body, "restoredFrom");
        if (!restoredFrom.ok) return yield* badRequest(restoredFrom.error);
        const notes = readNullableString(body, "notes");
        if (!notes.ok) return yield* badRequest(notes.error);

        const { organizationId, session } = yield* OrgPrincipal;
        const drill = yield* legacyTry(
          () =>
            createRestoreDrill(
              organizationId,
              {
                resourceId,
                performedAt,
                outcome,
                ...(rto.value !== undefined ? { rtoMinutes: rto.value } : {}),
                ...(restoredFrom.value !== undefined ? { restoredFrom: restoredFrom.value } : {}),
                ...(notes.value !== undefined ? { notes: notes.value } : {}),
              },
              session.userId ?? null,
            ),
          (error) => (error instanceof RestoreDrillInputError ? inputRefusal(error) : undefined),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "restore_drill.record",
            entityType: "restore_drill",
            entityId: drill.id,
            metadata: {
              resourceId: drill.resourceId,
              outcome: drill.outcome,
              rtoMinutes: drill.rtoMinutes,
            },
          }),
        );
        return yield* respond(RestoreDrill)(drill);
      }),
    )
    /**
     * For a drill recorded against the wrong resource or the wrong date.
     * Audited: deleting evidence that a restore failed is exactly the edit a
     * reviewer would want to know about.
     */
    .handle("deleteDrill", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const drillId = params.drillId;
        const removed = yield* legacy(() => deleteRestoreDrill(organizationId, drillId));
        if (!removed) return yield* notFound("No such drill");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "restore_drill.delete",
            entityType: "restore_drill",
            entityId: drillId,
          }),
        );
      }),
    ),
);

export const backupsDomain = makeDomain("backups", BackupsApi, BackupsHandlers);
