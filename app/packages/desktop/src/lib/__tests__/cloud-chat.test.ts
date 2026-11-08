/**
 * The desktop ChatClient: the conversation calls over the cloud transport
 * (`CloudHttp`), and the turn over the `CloudChatTurn` stream, adapted into
 * the AsyncIterable the chat UI reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";
import type { ChatTurnEvent } from "@infrawrench/ui";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const { answerCloudHttp, fakeRpc, resetFakeRpc } = await import("./fake-rpc");
const { CloudRequestError } = await import("../../../shared/rpc/errors");
const { createDesktopChatClient } = await import("../cloud-chat");

const CHAT = "/api/org/org1/chat";

beforeEach(() => {
  resetFakeRpc();
});

function requests(http: ReturnType<typeof answerCloudHttp>) {
  return http.mock.calls.map(([request]) => ({
    method: request.method,
    url: request.url,
    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
  }));
}

async function collect(events: AsyncIterable<ChatTurnEvent>) {
  const out: ChatTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("createDesktopChatClient", () => {
  it("sends the conversation calls over the transport", async () => {
    const summary = { id: "c1", title: "New chat", model: "m", createdAt: "t", updatedAt: "t" };
    const spend = {
      monthToDateMicros: 1,
      monthlyCapMicros: null,
      exceeded: false,
      freeTier: true,
      complimentary: false,
    };
    const http = answerCloudHttp((request) => {
      if (request.url.endsWith("/spend")) return { status: 200, json: spend };
      if (request.url.endsWith("/conversations") && request.method === "GET") {
        return { status: 200, json: { conversations: [summary] } };
      }
      if (request.url.endsWith("/conversations")) return { status: 200, json: { id: "c2" } };
      if (request.url.includes("/pending/")) {
        return { status: 200, json: { ok: true, allResolved: true } };
      }
      if (request.method === "GET") {
        return {
          status: 200,
          json: {
            conversation: summary,
            messages: [],
            pendingActions: [],
            pendingSecretRequests: [],
          },
        };
      }
      return { status: 200, json: { ok: true } };
    });
    const client = createDesktopChatClient("org1");

    await expect(client.listConversations()).resolves.toEqual([summary]);
    await expect(client.createConversation()).resolves.toEqual({ id: "c2" });
    await client.createConversation("claude-opus-5");
    await client.setConversationModel("c1", "claude-sonnet-5");
    await expect(client.getConversation("c1")).resolves.toMatchObject({ conversation: summary });
    await expect(client.getSpend()).resolves.toEqual(spend);
    await client.resolvePendingAction("c1", "p1", "approve");
    await client.resolvePendingAction("c1", "p2", "reject", "Not now");

    expect(requests(http)).toEqual([
      { method: "GET", url: `${CHAT}/conversations` },
      { method: "POST", url: `${CHAT}/conversations`, body: {} },
      { method: "POST", url: `${CHAT}/conversations`, body: { model: "claude-opus-5" } },
      { method: "PATCH", url: `${CHAT}/conversations/c1`, body: { model: "claude-sonnet-5" } },
      { method: "GET", url: `${CHAT}/conversations/c1` },
      { method: "GET", url: `${CHAT}/spend` },
      { method: "POST", url: `${CHAT}/conversations/c1/pending/p1`, body: { action: "approve" } },
      {
        method: "POST",
        url: `${CHAT}/conversations/c1/pending/p2`,
        body: { action: "reject", reason: "Not now" },
      },
    ]);
  });

  it("yields the turn's events until the stream ends", async () => {
    const turn = vi.fn(() =>
      Stream.make(
        { type: "text_delta" as const, text: "Hi" },
        { type: "turn_end" as const, hasPending: false },
      ),
    );
    fakeRpc["CloudChatTurn"] = turn;
    const client = createDesktopChatClient("org1");

    await expect(collect(client.streamTurn("c1", { text: "Hello" }))).resolves.toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "turn_end", hasPending: false },
    ]);
    expect(turn).toHaveBeenCalledWith({
      orgId: "org1",
      conversationId: "c1",
      body: { text: "Hello" },
    });
  });

  it("ends a turn that never started with its error", async () => {
    fakeRpc["CloudChatTurn"] = () =>
      Stream.fail(new CloudRequestError({ message: "Not authenticated to Infrawrench Cloud" }));
    const client = createDesktopChatClient("org1");

    await expect(collect(client.streamTurn("c1", { resume: true }))).resolves.toEqual([
      { type: "error", message: "Not authenticated to Infrawrench Cloud" },
    ]);
  });

  it("stops the stream when the reader leaves early", async () => {
    let released = false;
    fakeRpc["CloudChatTurn"] = () =>
      Stream.concat(Stream.make({ type: "text_delta" as const, text: "Hi" }), Stream.never).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            released = true;
          }),
        ),
      );
    const client = createDesktopChatClient("org1");

    for await (const event of client.streamTurn("c1", { text: "Hello" })) {
      expect(event).toEqual({ type: "text_delta", text: "Hi" });
      break;
    }
    await vi.waitFor(() => expect(released).toBe(true));
  });
});
