import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * The chat turn stream and the self-authentication every chat endpoint does.
 *
 * The SSE framing is the chat contract the web, desktop and mobile clients
 * parse, so it is pinned byte for byte. The turn runs after the handler has
 * returned, so it is also where a lost request scope would show: an `iwk_`
 * caller's key must still be the audit principal at every step of the turn,
 * under concurrent requests, and a client going away must not cut the turn
 * off half-persisted.
 */

const mockAuthenticate = vi.fn();
vi.mock("@/auth/org-request-auth", () => ({
  authenticateOrgRawRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

let conversationRows: unknown[] = [{ id: "conversation-1" }];
const updates: Record<string, unknown>[] = [];
vi.mock("@/db/client", () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => conversationRows,
      };
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        const result = {
          where: () => result,
          returning: async () => [{ id: "pending-1" }],
          then: (resolve: (value: unknown[]) => void) => resolve([]),
          catch: () => result,
        };
        return result;
      },
    }),
  },
}));

const mockRunAgentTurn = vi.fn();
const mockExecute = vi.fn();
vi.mock("@/chat/agent", () => ({
  runAgentTurn: (...args: unknown[]) => mockRunAgentTurn(...args),
  executePendingAction: (...args: unknown[]) => mockExecute(...args),
  rejectPendingAction: vi.fn(),
}));
vi.mock("@/chat/billing", () => ({ getMonthlySpend: vi.fn() }));
vi.mock("@/chat/slack-approvals", () => ({ noteChatToolApprovalDecided: vi.fn(async () => {}) }));
vi.mock("@/auth/effective-permissions", () => ({ effectivePermissions: async () => new Set() }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { chatDomain } = await import("@/http/domains/chat/index");
const { currentAuditPrincipal } = await import("@/services/audit-context");

const app = () => buildTestApi(chatDomain, { basePath: "/api/org/org-1/chat" });

const send = (body: unknown, init: RequestInit = {}) =>
  app().request("/conversations/conversation-1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    ...init,
  });

const keyCaller = (apiKeyId: string) => ({
  ok: true,
  caller: { userId: "user-1", organizationId: "org-1", apiKeyId, scopes: [], via: "api-key" },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

beforeEach(() => {
  vi.clearAllMocks();
  conversationRows = [{ id: "conversation-1" }];
  updates.length = 0;
  mockAuthenticate.mockResolvedValue({
    ok: true,
    caller: { userId: "user-1", organizationId: "org-1", email: "a@b.com", via: "session" },
  });
});

describe("POST /conversations/:id/messages", () => {
  it("streams each agent event as one SSE frame, with streamSSE's headers", async () => {
    mockRunAgentTurn.mockImplementation(async function* () {
      yield { type: "message_start", messageId: "m1", role: "assistant" };
      yield { type: "text_delta", delta: "line one\nline two" };
      yield {
        type: "turn_end",
        messageId: "m1",
        stopReason: "end_turn",
        costMicros: 3,
        hasPending: false,
      };
    });

    const res = await send({ text: "hello" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toBe(
      'event: message_start\ndata: {"type":"message_start","messageId":"m1","role":"assistant"}\n\n' +
        'event: text_delta\ndata: {"type":"text_delta","delta":"line one\\nline two"}\n\n' +
        'event: turn_end\ndata: {"type":"turn_end","messageId":"m1","stopReason":"end_turn","costMicros":3,"hasPending":false}\n\n',
    );
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.anything(), "org-1", "chat:write");
    expect(mockRunAgentTurn).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      auth: { userId: "user-1", organizationId: "org-1", source: "chat", email: "a@b.com" },
      userText: "hello",
    });
    // The default title is renamed after the text just sent.
    expect(updates).toContainEqual({ title: "hello" });
  });

  it("resumes without a user message", async () => {
    mockRunAgentTurn.mockImplementation(async function* () {});
    const res = await send({ resume: true });
    expect(res.status).toBe(200);
    await res.text();
    expect(mockRunAgentTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ userText: expect.anything() }),
    );
    expect(updates).toHaveLength(0);
  });

  it("ends a turn that throws with an error frame", async () => {
    mockRunAgentTurn.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "partial" };
      throw new Error("model unavailable");
    });

    const res = await send({ text: "hello" });
    expect(await res.text()).toBe(
      'event: text_delta\ndata: {"type":"text_delta","delta":"partial"}\n\n' +
        'event: error\ndata: {"type":"error","message":"model unavailable"}\n\n',
    );
  });

  it("answers 400 with neither text nor resume, and 404 for someone else's conversation", async () => {
    const empty = await send({});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Either `text` or `resume: true` is required" });

    conversationRows = [];
    const missing = await send({ text: "hello" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
    expect(mockRunAgentTurn).not.toHaveBeenCalled();
  });

  it("returns the auth refusal verbatim, before reading anything", async () => {
    mockAuthenticate.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Missing required scope: chat:write",
    });
    const res = await send({ text: "hello" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing required scope: chat:write" });
    expect(mockRunAgentTurn).not.toHaveBeenCalled();
  });

  it("runs every step of the turn as the caller's key, under concurrent requests", async () => {
    mockRunAgentTurn.mockImplementation(async function* () {
      for (let step = 0; step < 3; step++) {
        await tick();
        yield { type: "text_delta", delta: currentAuditPrincipal()?.apiKeyId ?? "none" };
      }
    });
    mockAuthenticate.mockImplementation(async (request: Request) => {
      const { text } = await request.clone().json();
      return keyCaller(`key-${text}`);
    });

    // One after the other, so both turns are streaming at once. (Two requests
    // started together race vitest's mock of the authenticator's dynamic import.)
    const a = await send({ text: "a" });
    const b = await send({ text: "b" });
    const [textA, textB] = await Promise.all([a.text(), b.text()]);

    const deltas = (text: string) =>
      [...text.matchAll(/"delta":"([^"]+)"/g)].map((match) => match[1]);
    expect(deltas(textA)).toEqual(["key-a", "key-a", "key-a"]);
    expect(deltas(textB)).toEqual(["key-b", "key-b", "key-b"]);
    expect(mockRunAgentTurn.mock.calls[0]?.[0]).toMatchObject({
      auth: { source: "api", apiKeyId: "key-a", scopes: [] },
    });
  });

  it("finishes the turn server-side when the client goes away", async () => {
    let finished = false;
    mockRunAgentTurn.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "first" };
      for (let step = 0; step < 5; step++) {
        await tick();
        yield { type: "text_delta", delta: `more ${step}` };
      }
      finished = true;
    });

    const res = await send({ text: "hello" });
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"delta":"first"');
    await reader?.cancel();

    await vi.waitFor(() => expect(finished).toBe(true));
  });
});

describe("POST /conversations/:id/pending/:pendingId", () => {
  const pendingRow = {
    pending: { id: "pending-1", status: "pending", toolName: "delete_resource", toolInput: {} },
    orgId: "org-1",
    userId: "user-1",
  };

  const decide = (body: unknown) =>
    app().request("/conversations/conversation-1/pending/pending-1", {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("runs the approved tool as the caller's key", async () => {
    conversationRows = [pendingRow];
    mockAuthenticate.mockResolvedValue(keyCaller("key-a"));
    let principal: unknown;
    mockExecute.mockImplementation(async () => {
      await tick();
      principal = currentAuditPrincipal();
      return { allResolved: true };
    });

    const res = await decide({ action: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, allResolved: true });
    expect(principal).toEqual({ apiKeyId: "key-a", userId: "user-1" });
    expect(updates[0]).toEqual({ status: "approved" });
  });

  it("records a failed execution and answers 500 with its message", async () => {
    conversationRows = [pendingRow];
    mockExecute.mockRejectedValue(new Error("provider said no"));

    const res = await decide({ action: "approve" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "provider said no" });
    expect(updates[1]).toMatchObject({
      status: "errored",
      result: "provider said no",
      isError: true,
    });
  });

  it("refuses an unknown action, and a question", async () => {
    conversationRows = [pendingRow];
    const bad = await decide({ action: "maybe" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "action must be 'approve' or 'reject'" });

    conversationRows = [
      { ...pendingRow, pending: { ...pendingRow.pending, toolName: "ask_question" } },
    ];
    const question = await decide({ action: "approve" });
    expect(question.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("answers 403 for a pending action in someone else's conversation", async () => {
    conversationRows = [{ ...pendingRow, userId: "user-2" }];
    const res = await decide({ action: "approve" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

describe("conversation reads", () => {
  it("lists with chat:read", async () => {
    conversationRows = [{ id: "conversation-1", title: "Hi" }];
    const res = await app().request("/conversations");
    expect(mockAuthenticate).toHaveBeenCalledWith(expect.anything(), "org-1", "chat:read");
    expect(res.status).toBe(200);
  });

  it("refuses a model outside the catalogue on PATCH", async () => {
    const res = await app().request("/conversations/conversation-1", {
      method: "PATCH",
      body: JSON.stringify({ model: "gpt-9" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Unknown model\. Supported: /);

    const missing = await app().request("/conversations/conversation-1", {
      method: "PATCH",
      body: "{}",
    });
    expect(await missing.json()).toEqual({ error: "`model` is required" });
  });
});
