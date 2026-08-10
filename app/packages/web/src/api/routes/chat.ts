/**
 * Chat API — conversation CRUD plus a streaming SSE endpoint that runs the
 * agent loop and a pending-action approval endpoint that gates destructive
 * tool calls. Authenticates via session cookie, WorkOS Bearer, or API key
 * with the `chat:write` scope — see ../../chat/auth.ts.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, isNull, desc, asc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { chatConversations, chatMessages, chatPendingActions, users } from "../../db/schema";
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
import type { ToolAuthContext } from "../../tools/types";
import { enterAuditPrincipal } from "../../services/audit-context";

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

  const [conv] = await db
    .select()
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

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.createdAt));

  const pending = await db
    .select()
    .from(chatPendingActions)
    .where(eq(chatPendingActions.conversationId, conversationId))
    .orderBy(asc(chatPendingActions.createdAt));

  return c.json({ conversation: conv, messages, pendingActions: pending });
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

export { app as chatRoutes };
