import { Hono } from "hono";
import { tagPolicySchema } from "@infrawrench/ui/cost/config";
import { getOrgTagPolicy, setOrgTagPolicy } from "@infrawrench/server-core/cost/tag-policy";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { getAccountTagCompliance } from "../../services/tag-policy";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/tag-policy — the org's required-tag policy. Readable by
 * anyone who can see resources: the create form needs it to pre-fill required
 * tags, and the compliance report is meaningless without it.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getOrgTagPolicy(c.get("organizationId")));
});

/** PUT /api/org/:orgId/tag-policy — replace the policy. Org-settings gated. */
app.put("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = tagPolicySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid tag policy", issues: parsed.error.issues }, 400);
  }

  const policy = await setOrgTagPolicy(organizationId, parsed.data);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "tag_policy.update",
    entityType: "tag_policy",
    entityId: organizationId,
    metadata: {
      requiredKeys: policy.requiredTags.map((t) => t.key),
      enforceOnCreate: policy.enforceOnCreate,
    },
  });
  return c.json(policy);
});

/**
 * GET /api/org/:orgId/tag-policy/compliance — per-account compliance scores:
 * the share of each account's tag-capable resources carrying every required
 * tag (with an allowed value where the policy restricts one).
 */
app.get("/compliance", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const [policy, accounts] = await Promise.all([
    getOrgTagPolicy(organizationId),
    getAccountTagCompliance(organizationId),
  ]);
  return c.json({ policy, accounts });
});

export { app as tagPolicyRoutes };
