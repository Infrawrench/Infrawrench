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
 * **Everything goes through the ordinary paths.** Creates run through the same
 * `createResource` + `upsertCreatedResource` + secret-state persistence the
 * create form uses; deletes run through the same `deleteResource`; the TTL is
 * an ordinary `resource_leases` row with `autoDelete`, so expiry is executed by
 * the existing lease pass — two announcements, freeze-deferring, retries,
 * audit, all of it — rather than by a second teardown scheduler that would
 * have to relearn the same lessons.
 */
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import {
  buildInstantiationPlan,
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
} from "@infrawrench/client-core";
import { normalizeResourceCreateResult, parseOutputRef } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { environmentInstances, resourceLeases, resources } from "../db/schema";
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
  markMemberLease,
  markMemberStatus,
  setInstanceStatus,
  type InstanceMemberRow,
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
      displayName: step.member.sourceName,
    })),
  });

  const created: Record<string, CreatedMemberState> = {};
  let failure: string | null = null;

  for (const step of plan.steps) {
    const member = step.member;
    const accountId = accountFor(member);
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
      // resource can always be found and torn down.
      await markMemberCreated(instance.id, member.key, {
        resourceId: resource.id,
        externalId: resource.externalId ?? null,
        displayName: resource.displayName,
      });

      await upsertCreatedResource({
        organizationId,
        pluginId: member.pluginId,
        resourceTypeId: member.resourceTypeId,
        accountId,
        resource,
      }).catch((error: unknown) => {
        console.error("[environments] failed to persist created resource:", error);
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

      // The TTL: an ordinary auto-delete lease, so the existing lease pass owns
      // expiry. A lease that fails to attach is loud but not fatal — the
      // environment can still be torn down by hand, and refusing to record a
      // resource we already created would be strictly worse.
      try {
        const lease = await createLeaseRecord(
          organizationId,
          {
            resourceId: resource.id,
            accountId,
            expiresAt: expiresAt.toISOString(),
            autoDelete: true,
            note: `Ephemeral environment "${name}"`,
          },
          ctx.userId,
        );
        await markMemberLease(instance.id, member.key, lease.id);
      } catch (error) {
        console.error("[environments] failed to attach lease:", error);
      }
    } catch (error) {
      failure = `${member.sourceName}: ${errorMessage(error)}`;
      await markMemberStatus(instance.id, member.key, "failed", errorMessage(error));
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
 * Idempotent by construction: a member with no resource id, a member already
 * marked deleted, a resource row that is already soft-deleted and a provider
 * that answers "not found" all take the same quiet success path, so re-running
 * a teardown — or running one after the lease pass already got there — is a
 * no-op rather than an error.
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

  const failures: string[] = [];
  for (const member of members) {
    if (member.status === "deleted" || member.status === "pending" || !member.resourceId) {
      if (member.status !== "deleted") {
        await markMemberStatus(instanceId, member.memberKey, "deleted", null);
      }
      continue;
    }
    try {
      await deleteMemberResource(organizationId, member);
      await markMemberStatus(instanceId, member.memberKey, "deleted", null);
    } catch (error) {
      failures.push(`${member.displayName}: ${errorMessage(error)}`);
      await markMemberStatus(instanceId, member.memberKey, "failed", errorMessage(error));
    }
    await cancelMemberLease(organizationId, member);
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
): Promise<void> {
  const resourceId = member.resourceId!;
  const [stored] = await db
    .select({ id: resources.id, deletedAt: resources.deletedAt })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, resourceId)))
    .limit(1);
  // Already reaped — by the lease pass, by a hand delete, by a previous
  // teardown. Nothing to do, and nothing to complain about.
  if (stored && stored.deletedAt !== null) return;

  const ctxClient = await getOrgAccountClient(member.accountId, organizationId).catch(() => null);
  if (!ctxClient) throw new Error("That account is no longer connected");
  if (!ctxClient.client.deleteResource) {
    throw new Error(`The ${member.pluginId} plugin cannot delete ${member.resourceTypeId}`);
  }

  try {
    await ctxClient.client.deleteResource(member.resourceTypeId, resourceId, member.accountId);
  } catch (error) {
    if (!looksAlreadyGone(error)) throw error;
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
