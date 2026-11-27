/**
 * The plan gate of Infrawrench CI: it is part of the paid plan, and an
 * organization on the free plan neither starts it nor sets it up.
 *
 * Two lines hold it. Everything a person does to start CI or set it up asks
 * here first and is refused with a sentence that says why (402 on the API):
 * turning an account on, a run started by hand, a retry, an approval, a
 * secret or a variable. And whatever queues a run another way (a webhook, a
 * schedule, a forge push, a check re-requested on GitHub) meets `planAccess`
 * again before anything reaches a runner: `dispatchRun` ends the run unsent,
 * and the forge's events and the schedules never record one.
 *
 * Stopping and removing never ask (turning an account off, cancelling,
 * rejecting, deleting a value): an organization whose plan ended can still
 * put things away.
 */
import { PlanRequiredError, planAccess } from "../entitlements.js";

/** Refuses with `PlanRequiredError` unless the organization's plan includes CI. */
export async function requireCiPlan(organizationId: string): Promise<void> {
  const access = await planAccess(organizationId);
  if (access.paid) return;
  throw new PlanRequiredError(
    access.reason === "inactive"
      ? `Infrawrench CI needs an active plan. This organization's subscription is ${access.status}. ` +
          `Reactivate it under Settings → Billing.`
      : "Infrawrench CI is part of Pro. Upgrade under Settings → Billing.",
  );
}
