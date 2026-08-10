/**
 * HTTP API for workflow approval requests (org-scoped, mounted at
 * /api/org/:orgId/workflow-approvals).
 *
 * A run suspended on `infra.waitForApproval(...)` writes a pending
 * `workflow_approvals` row and polls it; these routes are how a human lands
 * the decision. Listing takes `workflows:read` — the same permission that opens
 * the Workflows tab — while approving or denying takes `workflows:approve`,
 * deliberately NOT `workflows:write`: the point of an approval step is that a
 * second person signs off, so a role can grant authorship without sign-off (or
 * sign-off without authorship).
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";

import { db } from "@infrawrench/server-core/db/client";
import { users } from "@infrawrench/server-core/db/schema";
import {
  decideWorkflowApproval,
  listWorkflowApprovals,
  type WorkflowApprovalStatus,
} from "@infrawrench/server-core/workflows/approvals";

import { requirePermission } from "../../auth/permissions";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

const STATUSES: WorkflowApprovalStatus[] = ["pending", "approved", "denied", "expired"];

app.get("/", async (c) => {
  requirePermission(c, "workflows:read");
  const rawStatus = c.req.query("status");
  if (rawStatus !== undefined && !STATUSES.includes(rawStatus as WorkflowApprovalStatus)) {
    return c.json({ error: `status must be one of: ${STATUSES.join(", ")}` }, 400);
  }
  const approvals = await listWorkflowApprovals(orgId(c), {
    ...(rawStatus ? { status: rawStatus as WorkflowApprovalStatus } : {}),
    ...(c.req.query("workflowId") ? { workflowId: c.req.query("workflowId")! } : {}),
    ...(c.req.query("runId") ? { runId: c.req.query("runId")! } : {}),
  });
  return c.json(approvals);
});

async function decide(c: Context, decision: "approved" | "denied") {
  requirePermission(c, "workflows:approve");
  const approvalId = c.req.param("id");
  if (!approvalId) return c.json({ error: "Not found" }, 404);
  const session = c.get("session") as { userId?: string } | undefined;
  const userId = session?.userId;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const [user] = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const result = await decideWorkflowApproval(orgId(c), approvalId, decision, {
    userId,
    name: user?.displayName ?? user?.email ?? null,
  });
  if (result.outcome === "not_found") return c.json({ error: "Not found" }, 404);
  if (result.outcome === "conflict") {
    return c.json({ error: "This request has already been decided or has expired." }, 409);
  }
  return c.json(result.approval);
}

app.post("/:id/approve", (c) => decide(c, "approved"));
app.post("/:id/deny", (c) => decide(c, "denied"));

export default app;
