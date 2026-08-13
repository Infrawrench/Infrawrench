import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "./test-utils";

const SENTINEL = "chat-secret-sentinel-plaintext";
const updates: Record<string, unknown>[] = [];
const writeWorkflowSecretValue = vi.fn();

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
            request: {
              id: "request-1",
              conversationId: "conversation-1",
              messageId: "message-1",
              toolUseId: "tool-1",
              secretId: "secret-1",
              name: "DEPLOY_TOKEN",
              title: "Deployment token",
              description: "Used by deploys",
              status: "pending",
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
          returning: async () => [{ id: "request-1" }],
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
  effectivePermissions: async () => new Set(["secrets:write"]),
}));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: () => true,
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/services/workflow-secrets", () => ({
  createWorkflowSecret: vi.fn(),
  listWorkflowSecrets: vi.fn(),
  updateWorkflowSecretMetadata: vi.fn().mockResolvedValue({
    id: "secret-1",
    name: "DEPLOY_TOKEN",
    hasValue: true,
  }),
  writeWorkflowSecretValue,
}));

const { chatRoutes } = await import("@/api/routes/chat");

describe("POST /conversations/:id/secret-requests/:requestId", () => {
  beforeEach(() => {
    selectCall = 0;
    updates.length = 0;
    writeWorkflowSecretValue.mockReset();
    writeWorkflowSecretValue.mockResolvedValue({
      id: "secret-1",
      name: "DEPLOY_TOKEN",
      hasValue: true,
    });
  });

  it("hands plaintext only to encrypted storage and never returns or persists it in chat", async () => {
    const response = await buildTestApp(chatRoutes).request(
      "/conversations/conversation-1/secret-requests/request-1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: SENTINEL }),
      },
    );
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(writeWorkflowSecretValue).toHaveBeenCalledWith("org-1", "secret-1", SENTINEL);
    expect(JSON.stringify(updates)).not.toContain(SENTINEL);
    expect(responseText).not.toContain(SENTINEL);
    expect(JSON.parse(responseText)).toEqual({ ok: true, allResolved: true });
  });
});
