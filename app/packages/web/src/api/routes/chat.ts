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
import { chatConversations, chatMessages, chatPendingActions } from "../../db/schema";
import { authenticateChat } from "../../chat/auth";
import {
  runAgentTurn,
  executePendingAction,
  rejectPendingAction,
  type AgentEvent,
} from "../../chat/agent";
import { getMonthlySpend } from "../../chat/billing";
import type { ToolAuthContext } from "../../tools/types";

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
  const id = uuidv4();
  await db.insert(chatConversations).values({
    id,
    organizationId: auth.organizationId,
    userId: auth.userId,
    title: body.title?.slice(0, 200) ?? "New chat",
    ...(body.model ? { model: body.model } : {}),
    ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
  });
  return c.json({ id });
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
  };

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
  };

  if (body.action === "reject") {
    const { allResolved } = await rejectPendingAction(pendingId, body.reason);
    return c.json({ ok: true, allResolved });
  }

  // Approve: mark approved, then execute synchronously. If execution succeeds
  // and all sibling pending actions are now resolved, the caller can hit
  // POST /messages { resume: true } to continue the model loop.
  await db
    .update(chatPendingActions)
    .set({ status: "approved" })
    .where(eq(chatPendingActions.id, pendingId));

  try {
    const { allResolved } = await executePendingAction(pendingId, toolAuth);
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
    return c.json({ error: e instanceof Error ? e.message : "Execution failed" }, 500);
  }
});

export { app as chatRoutes };
