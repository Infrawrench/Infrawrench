import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * Conversation creation, specifically which model a new chat opens on.
 *
 * The interesting case is the caller that sends no model. That used to fall
 * through to the `chat_conversations.model` column default — which was
 * `claude-opus-5`, the most expensive of the four — so the desktop sidebar's
 * New chat button silently opened billed Opus conversations while every picker
 * in the product said the default was Gemini Flash. The route now always
 * writes a model, and this pins that.
 */

process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

const inserted: Record<string, unknown>[] = [];
vi.mock("@/db/client", () => ({
  db: {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v);
      },
    }),
  },
}));

// The route authenticates through chat/auth, not the shared middleware.
vi.mock("@/chat/auth", () => ({
  authenticateChat: async () => ({ organizationId: "org-1", userId: "user-1" }),
}));

// Not exercised here, and importing the real modules drags in the provider SDKs.
vi.mock("@/chat/agent", () => ({
  runAgentTurn: vi.fn(),
  executePendingAction: vi.fn(),
  rejectPendingAction: vi.fn(),
}));
vi.mock("@/chat/billing", () => ({ getMonthlySpend: vi.fn() }));
vi.mock("uuid", () => ({ v4: () => "conv-1" }));

const { chatRoutes } = await import("@/api/routes/chat");
const { DEFAULT_CHAT_MODEL } = await import("@infrawrench/ui");

const post = (body: unknown) =>
  buildTestApp(chatRoutes).request("/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /conversations", () => {
  beforeEach(() => {
    inserted.length = 0;
  });

  it("writes the default model when the caller sends none", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    // Explicitly written, not left for the column default to decide.
    expect(inserted[0]).toMatchObject({ model: DEFAULT_CHAT_MODEL });
    expect(inserted[0]?.["model"]).toBe("gemini-3.6-flash");
  });

  it("honours an explicit model", async () => {
    await post({ model: "claude-opus-5" });
    expect(inserted[0]).toMatchObject({ model: "claude-opus-5" });
  });

  it("rejects a model that isn't in the catalogue", async () => {
    const res = await post({ model: "gpt-9" });
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });
});
