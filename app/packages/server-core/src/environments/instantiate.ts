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
 * provider check (`classifyTeardownMember` → `verifyAndDeleteMember`) rather
 * than as already handled. A missing id never means "nothing was created".
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
 * |10 | failed  | –      | –     | maybe    | teardown declined to identify it     | reported by name on a `partial` instance |
 * |11 | deleted | any    | any   | no       | torn down or auto-deleted            | terminal |
 *
 * Every row is leased, provably empty, or visible. **State 6 is the one that
 * was neither** — the repair pass filtered on `status = "created"`, so a member
 * whose rollback failed ran past its TTL with nothing watching it. That is why
 * the pass keys on `resource_id is not null`, which is the actual question,
 * rather than on a status that only correlates with it.
 *
 * State 10 is the deliberate one: see the identity rule below. It is the price
 * of never deleting the wrong thing, and it is paid in visibility rather than
 * silence.
 *
 * **Delete only when identity is certain; where it is not, report and leave.**
 * The rule that settles the two ways this could destroy something it did not
 * create, and it is asymmetric on purpose — an orphan costs money, a wrong
 * delete costs data. Rolling a member back is a *certain* identity (the
 * provider returned the id seconds earlier), so it deletes. Recovering a member
 * with no recorded id is an *inferred* identity, and a display name is not an
 * identity, so it deletes only when `classifyRecoveryCandidate` finds
 * corroboration and otherwise reports the resource for a human.
 *
 * **Everything goes through the ordinary paths.** Creates run through the same
 * `createResource` + `upsertCreatedResource` + secret-state persistence the
 * create form uses; deletes run through the same `deleteResource`; the TTL is
 * an ordinary `resource_leases` row with `autoDelete`, so expiry is executed by
 * the existing lease pass — two announcements, freeze-deferring, retries,
 * audit, all of it — rather than by a second teardown scheduler that would
 * have to relearn the same lessons.
 */
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import {
  attemptedPositionCeiling,
  buildInstantiationPlan,
  buildMemberFailureRecord,
  classifyRecoveryCandidate,
  classifyTeardownMember,
  expectedMemberDisplayName,
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
  type EnvironmentInstantiateInput,
  type EnvironmentTemplate,
  type EnvironmentTemplateMember,
  type MemberTeardownOutcome,
  type RecoveryCandidate,
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
  markMemberResourceId,
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
      // into the failure record rather than losing a running resource.
      createdRecord = {
        resourceId: resource.id,
        externalId: resource.externalId ?? null,
        displayName: resource.displayName,
      };
      await markMemberCreated(instance.id, member.key, createdRecord);

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
      await markMemberFailed(
        instance.id,
        member.key,
        buildMemberFailureRecord(errorMessage(error), createdRecord),
      ).catch((writeError: unknown) => {
        // Even this can fail. The member row still exists at its position, and
        // teardown verifies any attempted member that carries no id against
        // the provider, so the resource is still reachable.
        console.error("[environments] failed to record member failure:", writeError);
      });
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
        const verified = await verifyAndDeleteMember(organizationId, row, member, listCache);
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
 * Tear down a member whose creation was **attempted but never confirmed**.
 *
 * The row carries no resource id, which does not mean no resource exists — a
 * create can return right before the write that records it fails, or the
 * process can die mid-call. Concluding "nothing to do" from a missing id is
 * exactly how a resource ends up running with nothing pointing at it, so ask
 * the provider instead.
 *
 * The lookup starts from the name the member would have been given
 * (`expectedMemberDisplayName`, resolved at insert time), using only
 * `listResources` — no provider-specific search. **A name is not an identity**,
 * so a single match is only a candidate: `classifyRecoveryCandidate` then
 * requires our own inventory and the provider's own timestamp to agree that it
 * did not exist before this environment did. Anything short of that is
 * reported for a human rather than deleted, because an orphan costs money and
 * a wrong delete costs data. A failed listing is a failure, never an absence.
 */
async function verifyAndDeleteMember(
  organizationId: string,
  instance: InstanceRow,
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

  const matches = listed.filter((candidate) => candidate.displayName === member.displayName);
  const evidence = await gatherRecoveryEvidence(organizationId, instance.id, matches);
  const decision = classifyRecoveryCandidate(evidence, instance.createdAt.toISOString());

  if (decision.action === "already-gone") return { outcome: "already-gone" };
  if (decision.action === "ambiguous") {
    return {
      outcome: "ambiguous",
      detail: `${matches.length} resources are named "${member.displayName}" — delete the right one by hand`,
    };
  }
  if (decision.action === "needs-attention") {
    return {
      outcome: "needs-attention",
      detail: `a resource named "${member.displayName}" was left alone because ${decision.reason} — check it by hand`,
    };
  }

  const found = matches[0]!;
  // Record what the run failed to before deleting it, so a teardown that dies
  // here leaves the id behind rather than making the next attempt re-derive it.
  await markMemberResourceId(instance.id, member.memberKey, {
    resourceId: found.id,
    externalId: found.externalId ?? null,
  }).catch((error: unknown) => {
    console.error("[environments] failed to record a recovered resource id:", error);
  });
  return { outcome: await deleteMemberResource(organizationId, member, found.id) };
}

/**
 * Everything the identity rule needs that the provider cannot fabricate: when
 * *we* first saw the resource, and whether another environment already claims
 * it. Both come from our own tables.
 */
async function gatherRecoveryEvidence(
  organizationId: string,
  instanceId: string,
  matches: ResourceInstance[],
): Promise<RecoveryCandidate[]> {
  if (matches.length === 0) return [];
  const ids = matches.map((match) => match.id);

  const [known, claimed] = await Promise.all([
    db
      .select({ id: resources.id, createdAt: resources.createdAt })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, ids))),
    db
      .select({ resourceId: environmentInstanceMembers.resourceId })
      .from(environmentInstanceMembers)
      .where(
        and(
          eq(environmentInstanceMembers.organizationId, organizationId),
          inArray(environmentInstanceMembers.resourceId, ids),
        ),
      ),
  ]);

  const knownSince = new Map(known.map((row) => [row.id, row.createdAt]));
  const claimedElsewhere = new Set(
    claimed.filter((row) => row.resourceId !== null).map((row) => row.resourceId!),
  );
  // A claim by *this* instance is the member being recovered, not somebody
  // else's hold on the resource.
  const ownClaims = await db
    .select({ resourceId: environmentInstanceMembers.resourceId })
    .from(environmentInstanceMembers)
    .where(eq(environmentInstanceMembers.instanceId, instanceId));
  for (const row of ownClaims) {
    if (row.resourceId) claimedElsewhere.delete(row.resourceId);
  }

  return matches.map((match) => ({
    externalId: match.externalId ?? null,
    createdAt: match.createdAt,
    knownSince: knownSince.get(match.id)?.toISOString() ?? null,
    claimedByAnotherMember: claimedElsewhere.has(match.id),
  }));
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
  await repairMissingMemberLeases(organizationId);

  const rows = await db
    .select({ id: environmentInstances.id })
    .from(environmentInstances)
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        inArray(environmentInstances.status, ["active", "partial"]),
        lte(environmentInstances.expiresAt, new Date()),
      ),
    )
    .limit(50);

  for (const row of rows) {
    const members = await getInstanceMemberRows(row.id);
    const liveIds = members
      .filter((m) => m.status === "created" && m.resourceId)
      .map((m) => m.resourceId!);
    if (liveIds.length === 0) {
      if (members.every((m) => m.status !== "created")) {
        await setInstanceStatus(row.id, "deleted", { completedAt: new Date() });
      }
      continue;
    }
    const alive = await db
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(resources.id, liveIds),
          isNull(resources.deletedAt),
        ),
      );
    const aliveIds = new Set(alive.map((r) => r.id));
    for (const member of members) {
      if (member.status !== "created" || !member.resourceId) continue;
      if (!aliveIds.has(member.resourceId)) {
        await markMemberStatus(row.id, member.memberKey, "deleted", null);
      }
    }
    if (aliveIds.size === 0) {
      await setInstanceStatus(row.id, "deleted", { completedAt: new Date() });
    }
  }
}

/**
 * Give a live member back its TTL if it somehow lost one.
 *
 * The third layer under "no member runs without an expiry": instantiation
 * retries the attachment and rolls the resource back if it cannot manage it,
 * and this catches whatever still slips through — most realistically a lease
 * that was created while the write recording its id failed, which leaves the
 * TTL working but the row claiming otherwise. Adopting the existing lease is
 * why this looks it up before creating one.
 */
async function repairMissingMemberLeases(organizationId: string): Promise<void> {
  const orphans = await db
    .select({
      instanceId: environmentInstanceMembers.instanceId,
      memberKey: environmentInstanceMembers.memberKey,
      resourceId: environmentInstanceMembers.resourceId,
      accountId: environmentInstanceMembers.accountId,
      pluginId: environmentInstanceMembers.pluginId,
      resourceTypeId: environmentInstanceMembers.resourceTypeId,
      status: environmentInstanceMembers.status,
      leaseId: environmentInstanceMembers.leaseId,
      expiresAt: environmentInstances.expiresAt,
      name: environmentInstances.name,
    })
    .from(environmentInstanceMembers)
    .innerJoin(
      environmentInstances,
      eq(environmentInstanceMembers.instanceId, environmentInstances.id),
    )
    .where(
      and(
        eq(environmentInstanceMembers.organizationId, organizationId),
        // Deliberately **not** `status = "created"`. A member whose rollback
        // failed is `failed` while its resource is very much alive, and
        // filtering on `created` is what let that state run past its TTL with
        // nothing watching it. The question this pass asks is "does a resource
        // exist with no clock on it", and `resource_id` is what answers it.
        inArray(environmentInstanceMembers.status, ["created", "failed"]),
        isNotNull(environmentInstanceMembers.resourceId),
        isNull(environmentInstanceMembers.leaseId),
        inArray(environmentInstances.status, ["creating", "active", "partial"]),
      ),
    )
    .limit(50);

  for (const orphan of orphans) {
    // The SQL above is a cheap pre-filter; `memberNeedsLeaseRepair` is the
    // authority, so the rule lives in one tested place rather than being
    // restated in a WHERE clause that can drift away from it.
    if (!memberNeedsLeaseRepair(orphan) || !orphan.resourceId) continue;
    try {
      await attachMemberLease({
        organizationId,
        instanceId: orphan.instanceId,
        memberKey: orphan.memberKey,
        resourceId: orphan.resourceId,
        accountId: orphan.accountId,
        // A member discovered after its instance already expired cannot be
        // given a deadline in the past — `validateLeaseInput` rejects it — so
        // it gets a short one instead. The lease pass still announces before
        // it deletes; it just does so on a compressed schedule.
        expiresAt: leaseDeadlineFor(orphan.expiresAt),
        environmentName: orphan.name,
      });
    } catch (error) {
      // The lease needs a `resources` row to point at, and the member whose
      // bookkeeping failed before the upsert has none. There is no way to give
      // that resource a TTL, so honour the rule the other way: it was already
      // marked for rollback, so retry the rollback. Identity is certain — this
      // id came back from the provider during the run.
      console.error("[environments] could not attach a repair lease:", error);
      const rolledBack = await rollbackCreatedMember(organizationId, {
        accountId: orphan.accountId,
        pluginId: orphan.pluginId,
        resourceTypeId: orphan.resourceTypeId,
        resourceId: orphan.resourceId,
      });
      if (rolledBack) {
        await markMemberStatus(orphan.instanceId, orphan.memberKey, "deleted", null).catch(
          () => undefined,
        );
      }
    }
  }
}

/**
 * Surface an instantiation that stopped without finishing.
 *
 * A process that dies mid-run leaves the instance at `creating` and its
 * in-flight member at `pending` with no id — the one state no lease can cover,
 * because there is nothing recorded to attach a lease to. It is instead made
 * *visible*: the instance becomes `partial`, which is a state the page shows
 * and teardown acts on (that member is within the attempted ceiling, so
 * teardown checks it against the provider).
 */
async function failStalledInstantiations(organizationId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60_000);
  await db
    .update(environmentInstances)
    .set({
      status: "partial",
      error:
        "This instantiation stopped before it finished. Tear the environment down — any " +
        "resources it created will be checked against the provider.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        eq(environmentInstances.status, "creating"),
        lte(environmentInstances.updatedAt, cutoff),
      ),
    )
    .catch((error: unknown) => {
      console.error("[environments] failed to fail a stalled instantiation:", error);
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
