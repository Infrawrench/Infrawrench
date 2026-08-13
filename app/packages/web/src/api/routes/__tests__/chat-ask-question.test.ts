import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "./test-utils";

const updates: Record<string, unknown>[] = [];
let pendingStatus = "pending";
let pendingToolName = "ask_question";

let selectCall = 0;
vi.mock("@/db/client", () => ({
  db: {
    select: () => {
      selectCall += 1;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => (selectCall === 1 ? chain : Promise.resolve([])),
        limit: async () => [
          {
            pending: {
              id: "pending-1",
              conversationId: "conversation-1",
              messageId: "message-1",
              toolUseId: "tool-1",
              toolName: pendingToolName,
              toolInput: {
                questions: [
                  {
                    id: "region",
                    prompt: "Which region?",
                    type: "selection",
                    options: [
                      { id: "eu", label: "EU" },
                      { id: "us", label: "US" },
                    ],
                  },
                ],
              },
              status: pendingStatus,
            },
            orgId: "org-1",
            userId: "user-1",
          },
        ],
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
        };
        return result;
      },
    }),
  },
}));

vi.mock("@/chat/auth", () => ({
  authenticateChat: async () => ({
    organizationId: "org-1",
    userId: "user-1",
    via: "session",
  }),
}));
vi.mock("@/chat/agent", () => ({
  runAgentTurn: vi.fn(),
  executePendingAction: vi.fn(),
  rejectPendingAction: vi.fn(),
}));
vi.mock("@/chat/billing", () => ({ getMonthlySpend: vi.fn() }));
vi.mock("@/chat/slack-approvals", () => ({ noteChatToolApprovalDecided: vi.fn() }));
vi.mock("@/auth/effective-permissions", () => ({
  effectivePermissions: async () => new Set(["chat:write"]),
}));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: () => true,
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { chatRoutes } = await import("@/api/routes/chat");

describe("POST /conversations/:id/pending/:pendingId/answer", () => {
  beforeEach(() => {
    selectCall = 0;
    updates.length = 0;
    pendingStatus = "pending";
    pendingToolName = "ask_question";
  });

  it("records a selection answer as the tool result", async () => {
    const response = await buildTestApp(chatRoutes).request(
      "/conversations/conversation-1/pending/pending-1/answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [{ questionId: "region", optionId: "eu" }] }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, allResolved: true });
    expect(updates[0]).toMatchObject({
      status: "executed",
      isError: false,
      result: "Which region?\nEU",
    });
  });

  it("rejects approve/reject-style answers that are not for ask_question", async () => {
    pendingToolName = "delete_resource";
    const response = await buildTestApp(chatRoutes).request(
      "/conversations/conversation-1/pending/pending-1/answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [{ questionId: "region", optionId: "eu" }] }),
      },
    );
    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});
