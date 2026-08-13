/**
 * Chat API — conversation CRUD plus a streaming SSE endpoint that runs the
 * agent loop, a pending-action approval endpoint that gates destructive tool
 * calls, a structured-answer endpoint for `ask_question`, and a human-only
 * secret-request handoff. Authenticates via session cookie, WorkOS Bearer, or
 * API key with the `chat:write` scope — see ../../chat/auth.ts.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, isNull, desc, asc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import {
  chatConversations,
  chatMessages,
  chatPendingActions,
  chatPendingSecretRequests,
  users,
} from "../../db/schema";
import { authenticateChat } from "../../chat/auth";
import {
  runAgentTurn,
  executePendingAction,
  rejectPendingAction,
  type AgentEvent,
} from "../../chat/agent";
import { noteChatToolApprovalDecided } from "../../chat/slack-approvals";
import { getMonthlySpend } from "../../chat/billing";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "@infrawrench/ui";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import type { ToolAuthContext } from "../../tools/types";
import { enterAuditPrincipal } from "../../services/audit-context";
import { logAudit } from "../../services/audit";
import { storeWorkflowSecretFromChat } from "../../chat/workflow-secret-store";
import { effectivePermissions } from "../../auth/effective-permissions";
import {
  ASK_QUESTION_TOOL_NAME,
  formatAskQuestionResult,
  parseAskQuestionInput,
  validateAskQuestionAnswers,
} from "@infrawrench/client-core";

const app = new Hono();

/* -------------------------------------------------------------------------- */
/* GET /  — list conversations for the caller (most recent first)             */
/* -------------------------------------------------------------------------- */
app.get("/conversations", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:read");
  if (auth instanceof Response) return auth;

  const rows = await db
    .select({
      id: chatConversations.id,
      title: chatConversations.title,
      model: chatConversations.model,
      createdAt: chatConversations.createdAt,
      updatedAt: chatConversations.updatedAt,
    })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.organizationId, auth.organizationId),
        eq(chatConversations.userId, auth.userId),
        isNull(chatConversations.archivedAt),
      ),
    )
    .orderBy(desc(chatConversations.updatedAt))
    .limit(200);

  return c.json({ conversations: rows });
});

/* POST / — create */
app.post("/conversations", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;

  const body = await c.req.json<{ title?: string; model?: string; systemPrompt?: string }>();
  if (body.model && !CHAT_MODELS.some((m) => m.id === body.model)) {
    return c.json(
      { error: `Unknown model. Supported: ${CHAT_MODELS.map((m) => m.id).join(", ")}` },
      400,
    );
  }
  const id = uuidv4();
  await db.insert(chatConversations).values({
    id,
    organizationId: auth.organizationId,
    userId: auth.userId,
    title: body.title?.slice(0, 200) ?? "New chat",
    // Always write a model rather than letting the column default decide. A
    // caller that omits one (the desktop sidebar's New chat did) would
    // otherwise get whatever the schema happens to say, which is how new chats
    // silently opened on the most expensive model instead of the cheapest.
    model: body.model ?? DEFAULT_CHAT_MODEL,
    ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
  });
  return c.json({ id });
});

/* PATCH /:id — update settings (currently just the model) */
app.patch("/conversations/:id", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;
  const conversationId = c.req.param("id");

  const body = await c.req.json<{ model?: string }>().catch(() => ({}) as { model?: string });
  if (!body.model) return c.json({ error: "`model` is required" }, 400);
  if (!CHAT_MODELS.some((m) => m.id === body.model)) {
    return c.json(
      { error: `Unknown model. Supported: ${CHAT_MODELS.map((m) => m.id).join(", ")}` },
      400,
    );
  }

  const updated = await db
    .update(chatConversations)
    .set({ model: body.model, updatedAt: new Date() })
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.organizationId, auth.organizationId),
        eq(chatConversations.userId, auth.userId),
      ),
    )
    .returning({ id: chatConversations.id });
  if (updated.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/* GET /:id — fetch with messages */
app.get("/conversations/:id", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:read");
  if (auth instanceof Response) return auth;
  const conversationId = c.req.param("id");

  const [conversationRows, messages, pending, pendingSecretRequests] = await Promise.all([
    db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.id, conversationId),
          eq(chatConversations.organizationId, auth.organizationId),
          eq(chatConversations.userId, auth.userId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt)),
    db
      .select()
      .from(chatPendingActions)
      .where(eq(chatPendingActions.conversationId, conversationId))
      .orderBy(asc(chatPendingActions.createdAt)),
    db
      .select()
      .from(chatPendingSecretRequests)
      .where(eq(chatPendingSecretRequests.conversationId, conversationId))
      .orderBy(asc(chatPendingSecretRequests.createdAt)),
  ]);
  const [conv] = conversationRows;
  if (!conv) return c.json({ error: "Not found" }, 404);

  return c.json({ conversation: conv, messages, pendingActions: pending, pendingSecretRequests });
});

/* DELETE /:id — archive */
app.delete("/conversations/:id", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;
  const conversationId = c.req.param("id");

  await db
    .update(chatConversations)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.organizationId, auth.organizationId),
        eq(chatConversations.userId, auth.userId),
      ),
    );
  return c.json({ ok: true });
});

/* GET /spend — current month-to-date spend + cap */
app.get("/spend", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:read");
  if (auth instanceof Response) return auth;
  const status = await getMonthlySpend(auth.organizationId);
  return c.json(status);
});

/* -------------------------------------------------------------------------- */
/* POST /:id/messages — SSE: start a turn (either with a new user message or  */
/* by resuming from approved pending actions)                                  */
/* -------------------------------------------------------------------------- */
app.post("/conversations/:id/messages", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;
  const conversationId = c.req.param("id");

  const [conv] = await db
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.organizationId, auth.organizationId),
        eq(chatConversations.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!conv) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ text?: string; resume?: boolean }>()
    .catch(() => ({}) as { text?: string; resume?: boolean });

  if (!body.text && !body.resume) {
    return c.json({ error: "Either `text` or `resume: true` is required" }, 400);
  }

  const toolAuth: ToolAuthContext = {
    userId: auth.userId,
    organizationId: auth.organizationId,
    source: auth.via === "api-key" ? "api" : "chat",
    ...(auth.email !== undefined ? { email: auth.email } : {}),
    ...(auth.apiKeyId !== undefined ? { apiKeyId: auth.apiKeyId } : {}),
    ...(auth.scopes !== undefined ? { scopes: auth.scopes } : {}),
  };
  // Most of the tool layer passes `source` to `logAudit` and drops
  // `apiKeyId`, so a key-driven `resource.delete` would otherwise read as if
  // the owner did it by hand. Entered here rather than inside
  // `authenticateChat`: `enterWith` reaches this execution's descendants —
  // which is the tool loop — but not the caller of an awaited function.
  if (auth.apiKeyId) enterAuditPrincipal({ apiKeyId: auth.apiKeyId, userId: auth.userId });

  // Title auto-rename: if conversation still has the default title and the
  // user just sent a new text turn, set the title to the first 60 chars.
  if (body.text) {
    void db
      .update(chatConversations)
      .set({ title: body.text.slice(0, 60) })
      .where(and(eq(chatConversations.id, conversationId), eq(chatConversations.title, "New chat")))
      .catch((err: unknown) => {
        console.error(`[chat] auto-rename failed for ${conversationId}:`, err);
      });
  }

  return streamSSE(c, async (stream) => {
    const send = async (ev: AgentEvent): Promise<void> => {
      await stream.writeSSE({
        event: ev.type,
        data: JSON.stringify(ev),
      });
    };

    try {
      const runInput: { conversationId: string; auth: ToolAuthContext; userText?: string } = {
        conversationId,
        auth: toolAuth,
      };
      if (body.text) runInput.userText = body.text;
      for await (const ev of runAgentTurn(runInput)) {
        await send(ev);
      }
    } catch (e) {
      await send({ type: "error", message: e instanceof Error ? e.message : "Agent failed" });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* POST /pending/:pendingId — approve or reject a destructive tool call       */
/* -------------------------------------------------------------------------- */
app.post("/conversations/:id/pending/:pendingId", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;
  const conversationId = c.req.param("id");
  const pendingId = c.req.param("pendingId");

  // Verify the pending action belongs to a conversation owned by the caller.
  const [row] = await db
    .select({
      pending: chatPendingActions,
      orgId: chatConversations.organizationId,
      userId: chatConversations.userId,
    })
    .from(chatPendingActions)
    .innerJoin(chatConversations, eq(chatConversations.id, chatPendingActions.conversationId))
    .where(
      and(
        eq(chatPendingActions.id, pendingId),
        eq(chatPendingActions.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "Pending action not found" }, 404);
  if (row.orgId !== auth.organizationId || row.userId !== auth.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ action: "approve" | "reject"; reason?: string }>();
  if (body.action !== "approve" && body.action !== "reject") {
    return c.json({ error: "action must be 'approve' or 'reject'" }, 400);
  }

  if (row.pending.status !== "pending") {
    return c.json({ error: `Action already resolved (status=${row.pending.status})` }, 409);
  }
  if (row.pending.toolName === ASK_QUESTION_TOOL_NAME) {
    return c.json(
      { error: "This pending action is a question; submit answers instead of approve/reject." },
      400,
    );
  }

  const toolAuth: ToolAuthContext = {
    userId: auth.userId,
    organizationId: auth.organizationId,
    source: auth.via === "api-key" ? "api" : "chat",
    ...(auth.email !== undefined ? { email: auth.email } : {}),
    ...(auth.apiKeyId !== undefined ? { apiKeyId: auth.apiKeyId } : {}),
    ...(auth.scopes !== undefined ? { scopes: auth.scopes } : {}),
  };
  // Most of the tool layer passes `source` to `logAudit` and drops
  // `apiKeyId`, so a key-driven `resource.delete` would otherwise read as if
  // the owner did it by hand. Entered here rather than inside
  // `authenticateChat`: `enterWith` reaches this execution's descendants —
  // which is the tool loop — but not the caller of an awaited function.
  if (auth.apiKeyId) enterAuditPrincipal({ apiKeyId: auth.apiKeyId, userId: auth.userId });

  // Name the decider the way every other approval surface does: display name
  // first, email as the fallback.
  const [decider] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  const decidedByName = decider?.displayName ?? auth.email ?? null;

  // Retire the interactive Slack copies of this request, whatever the
  // decision. Fire-and-forget (the helper never throws) — the decision below
  // is the record; Slack is presentation.
  const noteDecided = (decision: "approved" | "denied") =>
    void noteChatToolApprovalDecided({
      organizationId: auth.organizationId,
      pendingActionId: pendingId,
      toolName: row.pending.toolName,
      toolInput: row.pending.toolInput,
      decision,
      decidedByName,
      via: "the web app",
    });

  // Claim the row conditioned on it still being `pending`: the returned row
  // count makes two racing deciders — this route, a Slack button, or both —
  // produce exactly one decision. The loser gets the same 409 as the
  // status pre-check above.
  const claimed = await db
    .update(chatPendingActions)
    .set({ status: body.action === "reject" ? "rejected" : "approved" })
    .where(and(eq(chatPendingActions.id, pendingId), eq(chatPendingActions.status, "pending")))
    .returning({ id: chatPendingActions.id });
  if (claimed.length === 0) {
    return c.json({ error: "Action already resolved" }, 409);
  }

  if (body.action === "reject") {
    // finally: the claim above already decided the row, so the Slack copies
    // must retire even when recording the rejection details throws.
    try {
      const { allResolved } = await rejectPendingAction(pendingId, body.reason);
      return c.json({ ok: true, allResolved });
    } finally {
      noteDecided("denied");
    }
  }

  // Approved and claimed: execute synchronously. If execution succeeds and all
  // sibling pending actions are now resolved, the caller can hit
  // POST /messages { resume: true } to continue the model loop.
  try {
    const { allResolved } = await executePendingAction(pendingId, toolAuth);
    noteDecided("approved");
    return c.json({ ok: true, allResolved });
  } catch (e) {
    await db
      .update(chatPendingActions)
      .set({
        status: "errored",
        result: e instanceof Error ? e.message : "Execution failed",
        isError: true,
        resolvedAt: new Date(),
      })
      .where(eq(chatPendingActions.id, pendingId));
    // The approval itself landed — only the execution failed — so the Slack
    // copies' decision controls still retire.
    noteDecided("approved");
    return c.json({ error: e instanceof Error ? e.message : "Execution failed" }, 500);
  }
});

/* -------------------------------------------------------------------------- */
/* POST /pending/:pendingId/answer — structured reply to ask_question         */
/* -------------------------------------------------------------------------- */
app.post("/conversations/:id/pending/:pendingId/answer", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;
  const conversationId = c.req.param("id");
  const pendingId = c.req.param("pendingId");

  const [row] = await db
    .select({
      pending: chatPendingActions,
      orgId: chatConversations.organizationId,
      userId: chatConversations.userId,
    })
    .from(chatPendingActions)
    .innerJoin(chatConversations, eq(chatConversations.id, chatPendingActions.conversationId))
    .where(
      and(
        eq(chatPendingActions.id, pendingId),
        eq(chatPendingActions.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "Pending action not found" }, 404);
  if (row.orgId !== auth.organizationId || row.userId !== auth.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (row.pending.toolName !== ASK_QUESTION_TOOL_NAME) {
    return c.json({ error: "This pending action is not a question." }, 400);
  }
  if (row.pending.status !== "pending") {
    return c.json({ error: `Question already answered (status=${row.pending.status})` }, 409);
  }

  const parsedQuestions = parseAskQuestionInput(row.pending.toolInput);
  if (!parsedQuestions.ok) {
    return c.json({ error: parsedQuestions.error }, 400);
  }

  const body = await c.req.json<{ answers?: unknown }>().catch(() => ({ answers: undefined }));
  const parsedAnswers = validateAskQuestionAnswers(parsedQuestions.questions, body.answers);
  if (!parsedAnswers.ok) return c.json({ error: parsedAnswers.error }, 400);

  const result = formatAskQuestionResult(parsedQuestions.questions, parsedAnswers.answers);
  const claimed = await db
    .update(chatPendingActions)
    .set({
      status: "executed",
      result,
      isError: false,
      resolvedAt: new Date(),
    })
    .where(and(eq(chatPendingActions.id, pendingId), eq(chatPendingActions.status, "pending")))
    .returning({ id: chatPendingActions.id });
  if (claimed.length === 0) {
    return c.json({ error: "Question already answered" }, 409);
  }

  const [actions, requests] = await Promise.all([
    db
      .select({ status: chatPendingActions.status })
      .from(chatPendingActions)
      .where(eq(chatPendingActions.messageId, row.pending.messageId)),
    db
      .select({ status: chatPendingSecretRequests.status })
      .from(chatPendingSecretRequests)
      .where(eq(chatPendingSecretRequests.messageId, row.pending.messageId)),
  ]);
  const allResolved =
    actions.every((item) => ["executed", "errored", "rejected"].includes(item.status)) &&
    requests.every((item) => item.status === "stored");
  return c.json({ ok: true, allResolved });
});

/* -------------------------------------------------------------------------- */
/* POST /secret-requests/:requestId — human-only, write-only secret handoff   */
/* -------------------------------------------------------------------------- */
app.post("/conversations/:id/secret-requests/:requestId", async (c) => {
  const orgId = c.req.param("orgId") ?? "";
  const auth = await authenticateChat(c, orgId, "chat:write");
  if (auth instanceof Response) return auth;
  // API keys are machine principals. This endpoint is deliberately restricted
  // to an authenticated human session or WorkOS Bearer token.
  if (auth.via === "api-key") return c.json({ error: "Human authentication required" }, 403);
  const permissions = await effectivePermissions({
    userId: auth.userId,
    organizationId: auth.organizationId,
    ...(auth.scopes ? { scopes: auth.scopes } : {}),
  });
  if (!hasPermission(permissions, "secrets:write")) {
    return c.json({ error: "Missing required permission: secrets:write" }, 403);
  }

  const conversationId = c.req.param("id");
  const requestId = c.req.param("requestId");
  const body = await c.req.json<{ value?: unknown }>().catch(() => ({ value: undefined }));
  if (typeof body.value !== "string") return c.json({ error: "`value` must be a string" }, 400);

  const [row] = await db
    .select({
      request: chatPendingSecretRequests,
      orgId: chatConversations.organizationId,
      userId: chatConversations.userId,
    })
    .from(chatPendingSecretRequests)
    .innerJoin(
      chatConversations,
      eq(chatConversations.id, chatPendingSecretRequests.conversationId),
    )
    .where(
      and(
        eq(chatPendingSecretRequests.id, requestId),
        eq(chatPendingSecretRequests.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "Secret request not found" }, 404);
  if (row.orgId !== auth.organizationId || row.userId !== auth.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (row.request.status !== "pending") {
    return c.json({ error: "Secret request already submitted" }, 409);
  }

  const claimed = await db
    .update(chatPendingSecretRequests)
    .set({ status: "submitting", updatedAt: new Date() })
    .where(
      and(
        eq(chatPendingSecretRequests.id, requestId),
        eq(chatPendingSecretRequests.status, "pending"),
      ),
    )
    .returning({ id: chatPendingSecretRequests.id });
  if (claimed.length === 0) return c.json({ error: "Secret request already submitted" }, 409);

  try {
    const stored = await storeWorkflowSecretFromChat({
      organizationId: auth.organizationId,
      secretId: row.request.secretId,
      name: row.request.name,
      description: row.request.description,
      value: body.value,
      onResolvedId: async (secretId) => {
        // Persist only the resulting id before the value write. If encryption
        // or storage fails, a retry updates the same secret instead of creating
        // a duplicate.
        await db
          .update(chatPendingSecretRequests)
          .set({ secretId, updatedAt: new Date() })
          .where(eq(chatPendingSecretRequests.id, requestId));
      },
    });
    void logAudit({
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: "workflow_secret.value_write",
      entityType: "workflow_secret",
      entityId: stored.id,
      metadata: { name: stored.name, source: "chat" },
    });
    await db
      .update(chatPendingSecretRequests)
      .set({ status: "stored", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(chatPendingSecretRequests.id, requestId));

    const [actions, requests] = await Promise.all([
      db
        .select({ status: chatPendingActions.status })
        .from(chatPendingActions)
        .where(eq(chatPendingActions.messageId, row.request.messageId)),
      db
        .select({ status: chatPendingSecretRequests.status })
        .from(chatPendingSecretRequests)
        .where(eq(chatPendingSecretRequests.messageId, row.request.messageId)),
    ]);
    const allResolved =
      actions.every((item) => ["executed", "errored", "rejected"].includes(item.status)) &&
      requests.every((item) => item.status === "stored");
    return c.json({ ok: true, allResolved });
  } catch {
    // Do not serialize or log the exception: third-party/database errors can
    // contain bound values. Reset the metadata-only claim so the human can
    // safely retry.
    await db
      .update(chatPendingSecretRequests)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(chatPendingSecretRequests.id, requestId));
    return c.json({ error: "Secret could not be stored" }, 500);
  }
});

export { app as chatRoutes };
