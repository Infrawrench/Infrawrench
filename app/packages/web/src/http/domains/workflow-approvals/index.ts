/**
 * Workflow approval requests: `/api/org/:orgId/workflow-approvals`, the
 * handlers. A run suspended on `infra.waitForApproval(...)` polls its row;
 * these land the human decision on it.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { users } from "@infrawrench/server-core/db/schema";
import {
  decideWorkflowApproval,
  listWorkflowApprovals,
} from "@infrawrench/server-core/workflows/approvals";
import { makeDomain } from "../../domain";
import { badRequest, conflict, HttpFailure, notFound } from "../../errors";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { WorkflowApproval, WorkflowApprovalsApi, WorkflowApprovalStatus } from "./api";

const STATUSES = WorkflowApprovalStatus.literals;
const isStatus = Schema.is(WorkflowApprovalStatus);

const decide = Effect.fnUntraced(function* (approvalId: string, decision: "approved" | "denied") {
  const { organizationId, session } = yield* OrgPrincipal;
  if (!approvalId) return yield* notFound();
  const userId = session.userId;
  if (!userId) return yield* Effect.die(new HttpFailure(401, { error: "Unauthorized" }));
  const result = yield* legacy(async () => {
    const [user] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return decideWorkflowApproval(organizationId, approvalId, decision, {
      userId,
      name: user?.displayName ?? user?.email ?? null,
    });
  });
  if (result.outcome === "not_found") return yield* notFound();
  if (result.outcome === "conflict") {
    return yield* conflict("This request has already been decided or has expired.");
  }
  return yield* respond(WorkflowApproval)(result.approval);
});

const WorkflowApprovalsHandlers = HttpApiBuilder.group(
  WorkflowApprovalsApi,
  "workflowApprovals",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const { status, workflowId, runId } = query;
          if (status !== undefined && !isStatus(status)) {
            return yield* badRequest(`status must be one of: ${STATUSES.join(", ")}`);
          }
          const approvals = yield* legacy(() =>
            listWorkflowApprovals(organizationId, {
              ...(status ? { status } : {}),
              ...(workflowId ? { workflowId } : {}),
              ...(runId ? { runId } : {}),
            }),
          );
          return yield* respond(Schema.Array(WorkflowApproval))(approvals);
        }),
      )
      .handle("approve", ({ params }) => decide(params.id, "approved"))
      .handle("deny", ({ params }) => decide(params.id, "denied")),
);

export const workflowApprovalsDomain = makeDomain(
  "workflow-approvals",
  WorkflowApprovalsApi,
  WorkflowApprovalsHandlers,
);
