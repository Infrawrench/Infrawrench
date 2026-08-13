/**
 * Re-export: the implementation moved to server-core so the deployment runner —
 * shared with `github-watcher`, which cannot import web — can reach it.
 */
export {
  planAccess,
  requirePaidPlan,
  FREE_PLAN_LIMITS,
  PlanRequiredError,
} from "@infrawrench/server-core/entitlements";
