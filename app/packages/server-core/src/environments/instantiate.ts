/**
 * Instantiate and tear down an ephemeral environment.
 *
 * Two invariants govern this file.
 *
 * **Nothing is created before it is recorded.** The instance row and every
 * member row are written `pending` in one transaction before the first
 * provider call, and a member is marked `created` with its resource id the
 * instant `createResource` returns. A partial failure therefore always leaves
 * an inspectable, tearable-down instance — never a cloud resource with no row
 * pointing at it, which is the one failure mode this feature could produce
 * that costs real money indefinitely.
 *
 * That guarantee needs a second layer, because the confirming write can itself
 * fail. Two things provide it: a failure record carries the created id in the
 * **same** statement that records the failure (`buildMemberFailureRecord`), and
 * teardown treats a member that was *attempted* but carries no id as needing a
 * provider check (`classifyTeardownMember` → `checkMemberAgainstProvider`)
 * rather than as already handled. A missing id never means "nothing was
 * created".
 *
 * And a third, for when the failure record itself cannot be written after
 * retries: an id that lands in no row is invisible to every pass that keys off
 * `resource_id`, so the resource is deleted rather than left running
 * unrecorded — identity is certain, the provider returned the id moments
 * earlier — and if even that fails, the id is carried into the instance-level
 * error, a separate write with its own chance of landing and the last durable
 * place a human can recover it from.
 *
 * **No member runs without an expiry**, and the way to check that claim is to
 * enumerate the states a member row can end a run in. `status` × `resource_id`
 * × `lease_id`, against whether a provider resource actually exists:
 *
 * | # | status  | res id | lease | resource | how it happens                       | what covers it |
 * |---|---------|--------|-------|----------|--------------------------------------|----------------|
 * | 1 | pending | –      | –     | no       | run never reached it                 | nothing exists; teardown marks it done |
 * | 2 | pending | –      | –     | maybe    | process died mid-create              | `failStalledInstantiations` → visible; teardown verifies |
 * | 3 | created | set    | set   | yes      | happy path                           | **lease** |
 * | 4 | created | set    | –     | yes      | lease landed, id-write failed        | `repairMissingMemberLeases` adopts it |
 * | 5 | failed  | –      | –     | no       | create threw                         | nothing exists |
 * | 6 | failed  | set    | –     | yes      | create ok, lease failed, rollback failed | `repairMissingMemberLeases` leases it, or retries the rollback |
 * | 7 | failed  | –      | –     | no       | rollback succeeded                   | nothing exists |
 * | 8 | failed  | set    | set   | yes      | lease attached, a later step threw   | **lease** |
 * | 9 | failed  | set    | set   | yes      | teardown delete failed               | **lease** (kept on purpose) |
 * |10 | failed  | –      | –     | maybe    | recovery could not prove ownership   | reported by name on a `partial` instance |
 * |11 | deleted | any    | any   | no       | torn down or auto-deleted            | terminal |
 *
 * Every row is leased, provably empty, or visible. **State 6 is the one that
 * was neither** — the repair pass filtered on `status = "created"`, so a member
 * whose rollback failed ran past its TTL with nothing watching it. That is why
 * the pass keys on `resource_id is not null`, which is the actual question,
 * rather than on a status that only correlates with it.
 *
 * The same miss exists one layer up, so the instance statuses get the same
 * treatment — "might this still own live resources?":
 *
 * | status         | owns live resources?                                  |
 * |----------------|-------------------------------------------------------|
 * | `creating`     | yes — in flight, or stalled                            |
 * | `active`       | yes                                                    |
 * | `partial`      | yes                                                    |
 * | `tearing-down` | yes — in flight, or a teardown whose process died      |
 * | `failed`       | **yes** — a member can survive a failed rollback       |
 * | `deleted`      | no — reaching it requires every member to be `deleted` |
 *
 * Three passes each hand-enumerated this and **none of the three lists was
 * complete** (`["active","partial"]`, `["creating","active","partial"]`,
 * `"creating"`). `instanceMayOwnLiveResources` states it once as the
 * complement of `deleted`; lease repair does not consult instance status at
 * all, because the member predicate already is the question.
 *
 * State 10 is the deliberate one: see the identity rule below. It is the price
 * of never deleting the wrong thing, and it is paid in visibility rather than
 * silence.
 *
 * **Our own rows say nothing about provider state unless they say it
 * positively.** The third bug of this shape found here, after state 6 and the
 * ownership signals. A `resources` row that is *soft-deleted* records a
 * deletion we performed and does confirm the resource is gone; a row that is
 * *missing* confirms nothing at all — it is the ordinary residue of a failed
 * upsert, which is the same failure that stranded the member. Reconciliation
 * read the second as the first and marked such members `deleted`, which is
 * terminal: they left lease repair and teardown for good while the resource
 * billed on. `inventoryDisposition` now names the three cases and
 * `mayConcludeMemberDeleted` accepts only the positive one. The same
 * discipline applies to failures: the repair pass branches on what the
 * inventory actually says rather than treating any thrown error as proof the
 * row is absent, because answering a transient database error by deleting a
 * live resource is the worse mistake.
 *
 * **Delete only when identity is certain; where it is not, report and leave.**
 * Asymmetric on purpose — an orphan costs money, a wrong delete costs data.
 * Taken to its endpoint, that rule means **recovery does not delete at all**:
 * `checkMemberAgainstProvider` reports what it finds and leaves it running,
 * because a display name is not an identity and every signal that looked like
 * it might upgrade one turned out to be a proxy for a creation time we do not
 * reliably have (`classifyRecoveryCandidates` lists all three and why).
 * Deletion lives only where identity is certain: rolling back a resource the
 * provider handed back seconds earlier, and members whose `resource_id` was
 * actually recorded — which is what the two-layer id capture above is for. It
 * makes recovery the rare fallback rather than a load-bearing path.
 *
 * **Everything goes through the ordinary paths.** Creates run through the same
 * `createResource` + `upsertCreatedResource` + secret-state persistence the
 * create form uses; deletes run through the same `deleteResource`; the TTL is
 * an ordinary `resource_leases` row with `autoDelete`, so expiry is executed by
 * the existing lease pass — two announcements, freeze-deferring, retries,
 * audit, all of it — rather than by a second teardown scheduler that would
 * have to relearn the same lessons.
 */
import { and, eq, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import {
  attemptedPositionCeiling,
  buildInstantiationPlan,
  buildMemberFailureRecord,
  classifyRecoveryCandidates,
  classifyTeardownMember,
  expectedMemberDisplayName,
  instanceMayOwnLiveResources,
  inventoryDisposition,
  mayConcludeMemberDeleted,
  leaseDeadlineFor,
  leaseShouldBeCancelled,
  memberNeedsLeaseRepair,
  resolveMemberFields,
  resolveParameterValues,
  slugifyEnvironmentName,
  validateParameterValues,
  validateTemplate,
  validateTtlHours,
  ENVIRONMENT_LIMITS,
  type CreatedMemberState,
  type EnvironmentCostEstimate,
  type EnvironmentInstance,
  type EnvironmentInstanceStatus,
  type EnvironmentInstantiateInput,
  type EnvironmentTemplate,
  type EnvironmentTemplateMember,
  type MemberTeardownOutcome,
} from "@infrawrench/client-core";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { normalizeResourceCreateResult, parseOutputRef } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import {
  environmentInstanceMembers,
  environmentInstances,
  resourceLeases,
  resources,
} from "../db/schema";
import { upsertCreatedResource } from "../created-resource";
import { getOrgAccountClient } from "../org-accounts";
import { setLiteralSecretState } from "../secret-states";
import { createLeaseRecord, getLeaseRecordByResource } from "../leases/store";
import {
  EnvironmentInputError,
  countLiveInstances,
  deleteEnvironmentInstanceRecord,
  getEnvironmentInstance,
  getEnvironmentTemplate,
  getEnvironmentSettings,
  getInstanceMemberRows,
  getInstanceRow,
  insertInstanceWithMembers,
  markMemberCreated,
  markMemberFailed,
  markMemberLease,
  markMemberStatus,
  setInstanceStatus,
  type InstanceMemberRow,
  type InstanceRow,
} from "./store";

export interface InstantiateContext {
  userId?: string | undefined;
  /**
   * Per-member account override, keyed by member key. Lets a template captured
   * from staging be stamped into a scratch account without editing it.
   */
  accountOverrides?: Record<string, string> | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Retry a bookkeeping write a couple of times before treating it as fatal. */
async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

/**
 * Attach the member's TTL. Retried, and **fatal when it cannot be done** — the
 * caller rolls the resource back rather than letting it run without an expiry.
 *
 * A lease that already exists for the resource is adopted rather than
 * duplicated: `createLeaseRecord` 409s on an active lease, and the only way to
 * reach that here is a previous attempt whose lease landed but whose id we
 * failed to record.
 */
async function attachMemberLease(input: {
  organizationId: string;
  instanceId: string;
  memberKey: string;
  resourceId: string;
  accountId: string;
  expiresAt: Date;
  environmentName: string;
  userId?: string | undefined;
}): Promise<void> {
  const leaseId = await withRetry(async () => {
    const existing = await getLeaseRecordByResource(input.organizationId, input.resourceId);
    if (existing && existing.status === "active") return existing.id;
    const lease = await createLeaseRecord(
      input.organizationId,
      {
        resourceId: input.resourceId,
        accountId: input.accountId,
        expiresAt: input.expiresAt.toISOString(),
        autoDelete: true,
        note: `Ephemeral environment "${input.environmentName}"`,
      },
      input.userId,
    );
    return lease.id;
  });
  await withRetry(() => markMemberLease(input.instanceId, input.memberKey, leaseId));
}

/** Whether a resource already carries an active lease. */
async function memberHasLease(organizationId: string, resourceId: string): Promise<boolean> {
  const lease = await getLeaseRecordByResource(organizationId, resourceId).catch(() => null);
  return lease !== null && lease.status === "active";
}

/**
 * Undo a member whose TTL could not be attached.
 *
 * Returns whether the resource is gone. Deleting here is safe in a way the
 * teardown recovery path is not: this id came straight back from the provider
 * moments ago, so there is no inference and nothing to mistake it for.
 */
async function rollbackCreatedMember(
  organizationId: string,
  target: { accountId: string; pluginId: string; resourceTypeId: string; resourceId: string },
): Promise<boolean> {
  try {
    const ctxClient = await getOrgAccountClient(target.accountId, organizationId);
    if (!ctxClient?.client.deleteResource) return false;
    try {
      await ctxClient.client.deleteResource(
        target.resourceTypeId,
        target.resourceId,
        target.accountId,
      );
    } catch (error) {
      if (!looksAlreadyGone(error)) throw error;
    }
    await db
      .update(resources)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(resources.organizationId, organizationId),
          eq(resources.id, target.resourceId),
          isNull(resources.deletedAt),
        ),
      )
      .catch(() => undefined);
    return true;
  } catch (error) {
    console.error("[environments] failed to roll back a member with no TTL:", error);
    return false;
  }
}

/**
 * Does this failure mean "the thing is already gone"?
 *
 * Providers disagree on the wording but agree on the vocabulary, and the
 * alternative — treating every delete failure as fatal — makes teardown
 * non-idempotent, which is exactly what a retry needs it to be.
 */
function looksAlreadyGone(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("notfound") ||
    message.includes("404") ||
    message.includes("does not exist") ||
    message.includes("no such") ||
    message.includes("already deleted") ||
    message.includes("nosuchentity") ||
    message.includes("nosuchbucket")
  );
}

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

/**
 * Stamp out a copy of a template.
 *
 * Runs synchronously with the request: a v1 environment is a handful of
 * resources, and a caller that gets an instance back knows whether it worked.
 * The bookkeeping is written as it goes, so a request that is abandoned
 * half-way still leaves the same recoverable state a failed member does.
 */
export async function instantiateEnvironment(
  organizationId: string,
  templateId: string,
  input: EnvironmentInstantiateInput,
  ctx: InstantiateContext = {},
): Promise<EnvironmentInstance> {
  const template = await getEnvironmentTemplate(organizationId, templateId);
  if (!template) throw new EnvironmentInputError("Template not found", 404);

  const templateProblem = validateTemplate({
    name: template.name,
    parameters: template.parameters,
    members: template.members,
  });
  if (templateProblem) throw new EnvironmentInputError(templateProblem);

  const name = (input.name ?? "").trim();
  if (name === "") throw new EnvironmentInputError("Give this environment a name");
  if (name.length > ENVIRONMENT_LIMITS.maxNameLength) {
    throw new EnvironmentInputError(
      `Environment names are limited to ${ENVIRONMENT_LIMITS.maxNameLength} characters`,
    );
  }
  const namePrefix = slugifyEnvironmentName(name);
  if (namePrefix === "") {
    throw new EnvironmentInputError("That name has no letters or digits to build a prefix from");
  }
  if (input.note && input.note.length > ENVIRONMENT_LIMITS.maxNoteLength) {
    throw new EnvironmentInputError(
      `Notes are limited to ${ENVIRONMENT_LIMITS.maxNoteLength} characters`,
    );
  }

  const settings = await getEnvironmentSettings(organizationId);
  const ttlProblem = validateTtlHours(input.ttlHours, settings);
  if (ttlProblem) throw new EnvironmentInputError(ttlProblem);

  const parameterProblem = validateParameterValues(template, input.parameters ?? {});
  if (parameterProblem) throw new EnvironmentInputError(parameterProblem);
  const parameters = resolveParameterValues(template, input.parameters ?? {});

  const live = await countLiveInstances(organizationId);
  if (live >= ENVIRONMENT_LIMITS.maxLiveInstancesPerOrg) {
    throw new EnvironmentInputError(
      `Organizations are limited to ${ENVIRONMENT_LIMITS.maxLiveInstancesPerOrg} live environments — tear one down first`,
      409,
    );
  }

  const plan = buildInstantiationPlan(template.members);
  if (plan.steps.length !== template.members.length) {
    // validateTemplate already rejects cycles and dangling references; this is
    // the belt to that pair of braces, because a short plan would silently
    // create a subset of the environment.
    throw new EnvironmentInputError("This template's resources cannot be put in an order");
  }

  const accountFor = (member: EnvironmentTemplateMember): string =>
    ctx.accountOverrides?.[member.key] ?? member.accountId;

  const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
  const instance = await insertInstanceWithMembers({
    organizationId,
    templateId: template.id,
    templateName: template.name,
    name,
    namePrefix,
    parameters,
    expiresAt,
    note: input.note ?? null,
    createdByUserId: ctx.userId,
    members: plan.steps.map((step) => ({
      memberKey: step.member.key,
      pluginId: step.member.pluginId,
      resourceTypeId: step.member.resourceTypeId,
      accountId: accountFor(step.member),
      // The name the resource is expected to end up with, not the captured
      // one: teardown verification looks a member up by this when the run
      // failed before an id was recorded.
      displayName: expectedMemberDisplayName(step.member, parameters, namePrefix),
    })),
  });

  const created: Record<string, CreatedMemberState> = {};
  let failure: string | null = null;

  for (const step of plan.steps) {
    const member = step.member;
    const accountId = accountFor(member);
    // Held outside the try so the catch can still see a resource the provider
    // handed back before something downstream — including the write that was
    // meant to confirm it — threw.
    let createdRecord: {
      resourceId: string;
      externalId: string | null;
      displayName: string;
    } | null = null;
    try {
      const resolved = resolveMemberFields(member, { parameters, created, namePrefix });
      if (resolved.problem) throw new Error(resolved.problem);

      const ctxClient = await getOrgAccountClient(accountId, organizationId);
      if (!ctxClient) throw new Error("That account is no longer connected");
      if (!ctxClient.client.createResource) {
        throw new Error(`The ${member.pluginId} plugin cannot create ${member.resourceTypeId}`);
      }

      // Output references captured as encoded refs would be meaningless here —
      // the template already carries the reference structurally — but a
      // literal that happens to be an encoded ref is flattened for the plugin
      // exactly as the create route does.
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(resolved.fields!)) {
        const ref = parseOutputRef(value);
        fields[key] = ref ? ref.value : value;
      }

      const outcome = normalizeResourceCreateResult(
        await ctxClient.client.createResource(member.resourceTypeId, accountId, fields),
      );
      const resource = outcome.resource;

      // Recorded first, and before anything else can throw: from here on the
      // resource can always be found and torn down. `createdRecord` is set
      // *before* the write, so even a failure of this very write carries the id
      // into the failure record rather than losing a running resource. Retried,
      // because the alternative to a landed write is the whole rollback path —
      // a transient blip should not cost a freshly created resource.
      createdRecord = {
        resourceId: resource.id,
        externalId: resource.externalId ?? null,
        displayName: resource.displayName,
      };
      await withRetry(() => markMemberCreated(instance.id, member.key, createdRecord!));

      // The resource row has to exist before a lease can point at it
      // (`createLeaseRecord` validates it), so this is retried rather than
      // swallowed: losing it used to take the TTL down with it, silently.
      await withRetry(() =>
        upsertCreatedResource({
          organizationId,
          pluginId: member.pluginId,
          resourceTypeId: member.resourceTypeId,
          accountId,
          resource,
        }),
      );

      // The TTL, attached before anything optional runs. A member without a
      // lease is the "forever" branch this feature exists to not have, so a
      // lease that cannot be attached rolls the member back rather than
      // leaving a resource running with no clock on it.
      await attachMemberLease({
        organizationId,
        instanceId: instance.id,
        memberKey: member.key,
        resourceId: resource.id,
        accountId,
        expiresAt,
        environmentName: name,
        userId: ctx.userId,
      });

      for (const state of resource.secretStates ?? []) {
        if (state.resolution.kind !== "plaintext") continue;
        await setLiteralSecretState(resource.id, state.fieldKey, state.resolution.value).catch(
          (error: unknown) => {
            console.error("[environments] failed to persist secret state:", error);
          },
        );
      }

      // Resolve exactly the outputs later members ask for — no more, because
      // each one is a provider round-trip.
      const outputs: Record<string, string> = { ...(resource.resolvedOutputs ?? {}) };
      for (const outputKey of plan.outputsNeeded[member.key] ?? []) {
        if (outputs[outputKey] !== undefined) continue;
        outputs[outputKey] = await ctxClient.client.resolveOutput(
          member.resourceTypeId,
          resource.id,
          outputKey,
          accountId,
        );
      }
      created[member.key] = { externalId: resource.externalId ?? resource.id, outputs };
    } catch (error) {
      failure = `${member.sourceName}: ${errorMessage(error)}`;

      // A member that got as far as a resource but not as far as a TTL must not
      // be left running. Identity is *certain* here — the provider handed the
      // id back seconds ago — which is what makes deleting it the safe move,
      // unlike the name-based recovery teardown has to do.
      if (createdRecord && !(await memberHasLease(organizationId, createdRecord.resourceId))) {
        const rolledBack = await rollbackCreatedMember(organizationId, {
          accountId,
          pluginId: member.pluginId,
          resourceTypeId: member.resourceTypeId,
          resourceId: createdRecord.resourceId,
        });
        if (rolledBack) {
          failure = `${member.sourceName}: ${errorMessage(error)} (the resource was rolled back)`;
          createdRecord = null;
        } else {
          failure =
            `${member.sourceName}: ${errorMessage(error)} — it has no expiry and could not be ` +
            `rolled back, so tear this environment down`;
        }
      }

      // One statement, carrying the created id when there is one. A separate
      // "record the failure" write that dropped the id is how a successful
      // create became an untracked, billing resource: teardown saw a member
      // with no id and had nothing to delete.
      try {
        await withRetry(() =>
          markMemberFailed(
            instance.id,
            member.key,
            buildMemberFailureRecord(errorMessage(error), createdRecord),
          ),
        );
      } catch (writeError) {
        console.error("[environments] failed to record member failure:", writeError);
        // The retried write is gone, and if `createdRecord` is still set the id
        // it carries now exists nowhere durable — the one state every repair
        // pass keys off `resource_id` and cannot see. Identity is still certain
        // (the provider handed this id back moments ago), so the safe order is:
        // delete the resource rather than let it run unrecorded, and if even
        // that fails, carry the id into the instance-level error — a separate
        // write with its own chance of landing, and the last durable place a
        // human can recover it from.
        if (createdRecord && !(await memberHasLease(organizationId, createdRecord.resourceId))) {
          const rolledBack = await rollbackCreatedMember(organizationId, {
            accountId,
            pluginId: member.pluginId,
            resourceTypeId: member.resourceTypeId,
            resourceId: createdRecord.resourceId,
          });
          if (rolledBack) {
            failure = `${member.sourceName}: ${errorMessage(error)} (the resource was rolled back)`;
            createdRecord = null;
          } else {
            failure =
              `${member.sourceName}: ${errorMessage(error)} — its resource ` +
              `${createdRecord.externalId ?? createdRecord.resourceId} ` +
              `("${createdRecord.displayName}") could not be recorded or rolled back. It has ` +
              `no expiry: delete it in the provider, then tear this environment down`;
          }
        }
      }
      break;
    }
  }

  if (failure) {
    const anyCreated = Object.keys(created).length > 0;
    await setInstanceStatus(instance.id, anyCreated ? "partial" : "failed", {
      error: failure,
      completedAt: anyCreated ? null : new Date(),
    });
  } else {
    await setInstanceStatus(instance.id, "active", { error: null });
  }
  return (await getEnvironmentInstance(organizationId, instance.id))!;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Delete every resource an instance created, newest first.
 *
 * Reverse creation order because a dependency has to outlive its dependents.
 * Idempotent by construction: a member already marked deleted, a resource row
 * that is already soft-deleted and a provider that answers "not found" all take
 * the same quiet success path, so re-running a teardown — or running one after
 * the lease pass already got there — is a no-op rather than an error.
 *
 * A member with **no** resource id is not one of those cases. It is either a
 * member the run never reached (nothing can exist) or one it attempted and
 * failed to record, which the provider may well be holding a resource for; the
 * two are told apart by position, and the second is verified against the
 * provider before anything is concluded.
 *
 * A member whose delete **failed** keeps its lease: the lease pass is the retry
 * machinery, and cancelling it here is what would turn a transient provider
 * error into a resource that bills until somebody retries by hand.
 */
export async function tearDownEnvironment(
  organizationId: string,
  instanceId: string,
  ctx: { userId?: string | undefined } = {},
): Promise<EnvironmentInstance> {
  void ctx;
  const row = await getInstanceRow(organizationId, instanceId);
  if (!row) throw new EnvironmentInputError("Environment not found", 404);
  if (row.status === "deleted") {
    return (await getEnvironmentInstance(organizationId, instanceId))!;
  }

  await setInstanceStatus(instanceId, "tearing-down");
  const members = (await getInstanceMemberRows(instanceId)).slice().reverse();

  // Everything at or before this position may have reached the provider, even
  // if the row never got an id written to it.
  const attemptedCeiling = attemptedPositionCeiling(members);
  const listCache = new Map<string, ResourceInstance[]>();

  const failures: string[] = [];
  for (const member of members) {
    const action = classifyTeardownMember(member, attemptedCeiling);
    if (action === "skip") continue;
    if (action === "unattempted") {
      // The run never reached this member, so no provider call went out and
      // nothing can exist for it.
      await markMemberStatus(instanceId, member.memberKey, "deleted", null);
      continue;
    }

    let outcome: MemberTeardownOutcome;
    let detail: string | null = null;
    try {
      if (action === "delete") {
        outcome = await deleteMemberResource(organizationId, member);
      } else {
        const verified = await checkMemberAgainstProvider(organizationId, member, listCache);
        outcome = verified.outcome;
        detail = verified.detail ?? null;
      }
    } catch (error) {
      outcome = "failed";
      detail = errorMessage(error);
    }

    if (outcome === "deleted" || outcome === "already-gone") {
      await markMemberStatus(instanceId, member.memberKey, "deleted", null);
    } else {
      failures.push(`${member.displayName}: ${detail ?? "could not be deleted"}`);
      await markMemberStatus(instanceId, member.memberKey, "failed", detail);
    }

    // Only a confirmed outcome releases the lease. A failed delete keeps it, so
    // the lease pass — which retries, defers through freezes and reports when
    // it gives up — still owns the resource instead of it billing until a
    // human happens to retry the teardown.
    if (leaseShouldBeCancelled(outcome)) await cancelMemberLease(organizationId, member);
  }

  const now = new Date();
  if (failures.length > 0) {
    await setInstanceStatus(instanceId, "partial", { error: failures.join("; ") });
  } else {
    await setInstanceStatus(instanceId, "deleted", { error: null, completedAt: now });
  }
  return (await getEnvironmentInstance(organizationId, instanceId))!;
}

async function deleteMemberResource(
  organizationId: string,
  member: InstanceMemberRow,
  resourceIdOverride?: string,
): Promise<MemberTeardownOutcome> {
  const resourceId = resourceIdOverride ?? member.resourceId!;
  const [stored] = await db
    .select({ id: resources.id, deletedAt: resources.deletedAt })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  // Already reaped — by the lease pass, by a hand delete, by a previous
  // teardown. Nothing to do, and nothing to complain about.
  if (stored && stored.deletedAt !== null) return "already-gone";

  const ctxClient = await getOrgAccountClient(member.accountId, organizationId).catch(() => null);
  if (!ctxClient) throw new Error("That account is no longer connected");
  if (!ctxClient.client.deleteResource) {
    throw new Error(`The ${member.pluginId} plugin cannot delete ${member.resourceTypeId}`);
  }

  let outcome: MemberTeardownOutcome = "deleted";
  try {
    await ctxClient.client.deleteResource(member.resourceTypeId, resourceId, member.accountId);
  } catch (error) {
    if (!looksAlreadyGone(error)) throw error;
    outcome = "already-gone";
  }

  await db
    .update(resources)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.id, resourceId),
        isNull(resources.deletedAt),
      ),
    )
    .catch((error: unknown) => {
      console.error("[environments] failed to soft-delete resource row:", error);
    });
  return outcome;
}

/**
 * Check on a member whose creation was **attempted but never confirmed** — and
 * report, never delete.
 *
 * The row carries no resource id, which does not mean no resource exists: a
 * create can return right before the write recording it fails, or the process
 * can die mid-call. So the provider is asked. But a match is only ever
 * *reported*, because a display name is not an identity and no signal
 * available here upgrades it into one — see `classifyRecoveryCandidates` for
 * the three that were tried and why each turned out to be a proxy for a
 * creation time we do not reliably have.
 *
 * Deleting is left to the paths where identity is certain: the rollback of a
 * resource the provider handed back seconds earlier, and any member whose
 * `resource_id` was actually recorded. The id found here is deliberately **not**
 * written to the member row either — doing so would make the next teardown
 * classify it as `delete` and destroy it through the back door.
 *
 * A failed listing is a failure, never an absence.
 */
async function checkMemberAgainstProvider(
  organizationId: string,
  member: InstanceMemberRow,
  listCache: Map<string, ResourceInstance[]>,
): Promise<{ outcome: MemberTeardownOutcome; detail?: string }> {
  const cacheKey = `${member.accountId}:${member.resourceTypeId}`;
  let listed = listCache.get(cacheKey);
  if (!listed) {
    const ctxClient = await getOrgAccountClient(member.accountId, organizationId).catch(() => null);
    if (!ctxClient) throw new Error("That account is no longer connected");
    listed = await ctxClient.client.listResources(member.resourceTypeId, member.accountId);
    listCache.set(cacheKey, listed);
  }

  const matches = listed
    .filter((candidate) => candidate.displayName === member.displayName)
    .map((candidate) => ({
      externalId: candidate.externalId ?? null,
      displayName: candidate.displayName,
    }));

  const finding = classifyRecoveryCandidates(matches);
  if (finding.action === "already-gone") return { outcome: "already-gone" };
  return {
    outcome: "needs-attention",
    detail:
      `${finding.reason}. It has been left running — delete it yourself if it is not wanted, ` +
      `then tear this environment down again to close it out`,
  };
}

/**
 * Stop the member's lease chasing a resource that is already gone. Best effort:
 * the lease pass itself treats a missing resource as a quiet completion, so a
 * failure here is bookkeeping, not correctness.
 */
async function cancelMemberLease(organizationId: string, member: InstanceMemberRow): Promise<void> {
  if (!member.resourceId) return;
  try {
    const lease = await getLeaseRecordByResource(organizationId, member.resourceId);
    if (!lease || lease.status !== "active") return;
    await db
      .update(resourceLeases)
      .set({
        status: "canceled",
        nextCheckAt: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(resourceLeases.id, lease.id));
  } catch (error) {
    console.error("[environments] failed to cancel member lease:", error);
  }
}

/** Forget a torn-down instance's row. Live instances refuse. */
export async function forgetEnvironmentInstance(
  organizationId: string,
  instanceId: string,
): Promise<void> {
  await deleteEnvironmentInstanceRecord(organizationId, instanceId);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Catch instances up with what the lease pass already did.
 *
 * Expiry is executed per member by the lease pass, which knows nothing about
 * environments — so an instance whose members have all been auto-deleted would
 * otherwise sit at "active" forever and lie on the page. This walks the
 * expired-and-still-live instances, marks members whose resource row is gone,
 * and closes the instance when nothing is left. Cheap and bounded: only
 * instances past their own deadline are considered.
 */
export async function reconcileEnvironmentInstances(organizationId: string): Promise<void> {
  await failStalledInstantiations(organizationId);

  const rows = (await db
    .select({ id: environmentInstances.id, status: environmentInstances.status })
    .from(environmentInstances)
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        // `deleted` is the only finished status; everything else may still
        // hold something. The old `["active","partial"]` list left a `failed`
        // or `creating` instance whose leases had done their work sitting
        // there claiming to be live forever.
        ne(environmentInstances.status, "deleted"),
        lte(environmentInstances.expiresAt, new Date()),
      ),
    )
    .limit(50)) as { id: string; status: EnvironmentInstanceStatus }[];

  for (const row of rows) {
    if (!instanceMayOwnLiveResources(row.status)) continue;
    const members = await getInstanceMemberRows(row.id);
    // Keyed on holding a resource id, not on `status === "created"` — the same
    // correction the lease-repair pass needed. A `failed` member with a live
    // resource is exactly the case that must still be followed up.
    const holders = members.filter((m) => m.status !== "deleted" && m.resourceId);
    if (holders.length === 0) {
      // An instance closes only when every member is *itself* `deleted`. A
      // member that failed without ever recording an id may still correspond
      // to something the provider holds (teardown reports it by name), and
      // closing the instance over it would hide exactly that.
      if (members.every((m) => m.status === "deleted")) {
        await setInstanceStatus(row.id, "deleted", { completedAt: new Date() });
      }
      continue;
    }

    // Soft-deleted rows are deliberately **included**: their `deleted_at` is
    // the record of a deletion we performed, which is the only thing here that
    // can confirm a resource is gone. Filtering them out would leave "row
    // missing" and "row deleted" indistinguishable — and a missing row means
    // our upsert failed, not that the provider dropped the resource.
    const rows = await db
      .select({ id: resources.id, deletedAt: resources.deletedAt })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(
            resources.id,
            holders.map((m) => m.resourceId!),
          ),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));

    let unresolved = 0;
    for (const member of holders) {
      const disposition = inventoryDisposition(byId.get(member.resourceId!));
      if (mayConcludeMemberDeleted(disposition)) {
        await markMemberStatus(row.id, member.memberKey, "deleted", null);
        continue;
      }
      unresolved += 1;
      if (disposition === "unknown") {
        // Never terminal. The member keeps its id, so lease repair still
        // reaches it and teardown will still ask the provider about it.
        console.warn(
          `[environments] instance ${row.id} member ${member.memberKey} has no inventory row; ` +
            "leaving it reconcilable rather than assuming its resource is gone",
        );
      }
    }
    // Close only when nothing is left open: every holder confirmed gone, and
    // every other member already `deleted`. A member with no id that never
    // reached `deleted` is unresolved too — teardown has yet to ask the
    // provider about it.
    const othersSettled = members
      .filter((m) => !holders.includes(m))
      .every((m) => m.status === "deleted");
    if (unresolved === 0 && othersSettled) {
      await setInstanceStatus(row.id, "deleted", { completedAt: new Date() });
    }
  }
}

/**
 * Give one stranded member back its TTL. Called by the repair pass **after it
 * has claimed the row**, so this does no claiming of its own.
 *
 * Throwing is the contract for anything the caller should retry and record:
 * the pass writes the message to `repair_error` and backs the member off,
 * rather than logging it where nobody will look. Returning normally means the
 * member no longer needs repair — either it has a lease now, or its resource
 * was confirmed gone.
 */
export async function repairClaimedMember(member: {
  organizationId: string;
  instanceId: string;
  memberKey: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  expiresAt: Date;
  instanceName: string;
}): Promise<void> {
  try {
    await attachMemberLease({
      organizationId: member.organizationId,
      instanceId: member.instanceId,
      memberKey: member.memberKey,
      resourceId: member.resourceId,
      accountId: member.accountId,
      // A member found after its instance already expired cannot be given a
      // deadline in the past — `validateLeaseInput` rejects it — so it gets a
      // short one instead. The lease pass still announces before it deletes.
      expiresAt: leaseDeadlineFor(member.expiresAt),
      environmentName: member.instanceName,
    });
    return;
  } catch (error) {
    // Branch on the *fact*, not on the failure. A throw here could be a
    // transient database error or the org's lease cap, and answering either of
    // those by deleting a live resource is a far worse mistake than retrying.
    const [stored] = await db
      .select({ deletedAt: resources.deletedAt })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, member.organizationId),
          eq(resources.id, member.resourceId),
        ),
      )
      .limit(1);
    const disposition = inventoryDisposition(stored);

    if (mayConcludeMemberDeleted(disposition)) {
      // Already reaped, and we hold the record of doing it.
      await markMemberStatus(member.instanceId, member.memberKey, "deleted", null);
      return;
    }
    if (disposition === "present") {
      // A lease *can* point at this row, so the failure was incidental. Hand
      // it back to the pass to record and retry rather than destroying the
      // resource over a transient error.
      throw error;
    }

    // `unknown`: no row for a lease to reference, so this resource can never be
    // given a TTL. It was already marked for rollback once, so retry that —
    // identity is certain, the id came back from the provider during the run.
    const rolledBack = await rollbackCreatedMember(member.organizationId, {
      accountId: member.accountId,
      pluginId: member.pluginId,
      resourceTypeId: member.resourceTypeId,
      resourceId: member.resourceId,
    });
    if (!rolledBack) {
      throw new Error(
        `no inventory row to attach a lease to, and the resource could not be rolled back: ${errorMessage(error)}`,
      );
    }
    await markMemberStatus(member.instanceId, member.memberKey, "deleted", null);
  }
}

/**
 * Surface a run that stopped without finishing.
 *
 * A process that dies mid-instantiation leaves the instance at `creating` and
 * its in-flight member at `pending` with no id — the one state no lease can
 * cover, because there is nothing recorded to attach a lease to. A process that
 * dies mid-*teardown* leaves it at `tearing-down`, which is the same lie told
 * from the other end and was missed by the original `creating`-only filter.
 *
 * Both become `partial`: a state the page shows and teardown acts on. Resource
 * safety does not depend on this — `repairMissingMemberLeases` covers any
 * member holding a resource regardless of instance status — but a status that
 * has stopped being true is its own defect.
 */
async function failStalledInstantiations(organizationId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60_000);
  await db
    .update(environmentInstances)
    .set({
      status: "partial",
      error:
        "This run stopped before it finished. Tear the environment down — any resources it " +
        "created will be checked against the provider.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        inArray(environmentInstances.status, ["creating", "tearing-down"]),
        lte(environmentInstances.updatedAt, cutoff),
      ),
    )
    .catch((error: unknown) => {
      console.error("[environments] failed to fail a stalled run:", error);
    });
}

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

/**
 * What this instantiation would cost per month, before it runs.
 *
 * Same rule the rest of the estimate machinery keeps: **`null` is not `$0`**. A
 * member the plugin cannot price is counted in `unpricedCount` and the whole
 * estimate goes `partial`, so the surface says "at least $X/mo" rather than
 * quoting a number that is missing a cluster.
 */
export async function estimateEnvironmentInstantiation(
  organizationId: string,
  templateId: string,
  parameterValues: Record<string, string>,
  accountOverrides: Record<string, string> = {},
): Promise<EnvironmentCostEstimate> {
  const template = await getEnvironmentTemplate(organizationId, templateId);
  if (!template) throw new EnvironmentInputError("Template not found", 404);
  const problem = validateParameterValues(template, parameterValues);
  if (problem) throw new EnvironmentInputError(problem);
  const parameters = resolveParameterValues(template, parameterValues);

  const members: EnvironmentCostEstimate["members"] = [];
  const clients = new Map<string, Awaited<ReturnType<typeof getOrgAccountClient>>>();
  let total = 0;
  let currency: string | null = null;
  let unpricedCount = 0;
  let priced = false;
  // A member the plugin could only *partly* price makes the whole total a
  // floor, exactly as `CostEstimate.partial` does one level down.
  let sawPartial = false;

  for (const member of template.members) {
    const accountId = accountOverrides[member.key] ?? member.accountId;
    const fields = estimateFields(member, parameters);
    let ctxClient = clients.get(accountId);
    if (ctxClient === undefined) {
      ctxClient = await getOrgAccountClient(accountId, organizationId).catch(() => null);
      clients.set(accountId, ctxClient);
    }
    const estimate = ctxClient?.client.estimateCost
      ? await ctxClient.client.estimateCost(member.resourceTypeId, fields).catch(() => null)
      : null;

    if (!estimate) {
      unpricedCount += 1;
      members.push({
        memberKey: member.key,
        displayName: member.sourceName,
        monthlyAmount: null,
        currency: null,
      });
      continue;
    }
    // Mixed currencies cannot be summed, and converting behind the user's back
    // would invent an exchange rate. The first currency wins and the rest are
    // reported unpriced.
    if (currency === null) currency = estimate.currency;
    if (estimate.currency !== currency) {
      unpricedCount += 1;
      members.push({
        memberKey: member.key,
        displayName: member.sourceName,
        monthlyAmount: estimate.monthlyAmount,
        currency: estimate.currency,
      });
      continue;
    }
    priced = true;
    sawPartial ||= estimate.partial === true;
    total += estimate.monthlyAmount;
    members.push({
      memberKey: member.key,
      displayName: member.sourceName,
      monthlyAmount: estimate.monthlyAmount,
      currency: estimate.currency,
    });
  }

  return {
    monthlyAmount: priced ? Math.round(total * 100) / 100 : null,
    currency: priced ? currency : null,
    partial: unpricedCount > 0 || sawPartial,
    unpricedCount,
    members,
  };
}

/**
 * The fields to price a not-yet-created member with: literals and parameters
 * only. A field that will hold another member's id or output is not something
 * a price depends on, and there is nothing to put there yet.
 */
function estimateFields(
  member: EnvironmentTemplateMember,
  parameters: Record<string, string>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(member.fields)) {
    if (value.kind === "literal") fields[key] = value.value;
    else if (value.kind === "parameter" && parameters[value.parameter] !== undefined) {
      fields[key] = parameters[value.parameter]!;
    }
  }
  return fields;
}

export type { EnvironmentTemplate };
