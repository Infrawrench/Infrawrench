/**
 * The chat turn stream end to end: the renderer's `CloudChatTurn` call
 * through the real RPC server to the main process's real handler
 * (`electron/cloud-chat.ts`), with `fetch` and the token store as the only
 * fakes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";

const h = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  forceRefreshAccessToken: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: new EventEmitter(),
    app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "" },
  };
});
vi.mock("../cloud-tokens", () => ({
  getAccessToken: h.getAccessToken,
  forceRefreshAccessToken: h.forceRefreshAccessToken,
}));

const { callDesktopRpc, failureOf } = await import("./rpc-harness");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");
const { CLOUD_URL } = await import("../../env");

const encoder = new TextEncoder();

/** An SSE answer whose body is `chunks`, in order; `open` keeps it from ending. */
function sse(chunks: string[], options: { open?: boolean; onCancel?: () => void } = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.open) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const frame = (event: { type: string } & Record<string, unknown>) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** Run one turn and collect its events, the first `take` of them when given. */
const turn = (body: { text?: string; resume?: boolean } = { text: "Hello" }, take?: number) =>
  Effect.gen(function* () {
    const rpc = yield* DesktopRpcClient;
    const events = rpc.CloudChatTurn({ orgId: "org 1", conversationId: "c1", body });
    return yield* Stream.runCollect(take === undefined ? events : Stream.take(events, take));
  });

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  h.getAccessToken.mockReset();
  h.getAccessToken.mockResolvedValue("access-1");
  h.forceRefreshAccessToken.mockReset();
  h.forceRefreshAccessToken.mockResolvedValue("access-2");
});

describe("CloudChatTurn", () => {
  it("posts the turn and yields each event, skipping what is not one", async () => {
    h.fetch.mockResolvedValue(
      sse([
        frame({ type: "text_delta", text: "Hi" }),
        // Split across reads, as a network delivers it.
        'event: tool_use_start\ndata: {"type":"tool_use_',
        'start","id":"t1","name":"list_accounts"}\n\n',
        "data: not json\n\n",
        frame({ type: "a_type_this_build_does_not_know" }),
        frame({ type: "turn_end", hasPending: false }),
      ]),
    );

    const events = await callDesktopRpc(turn());
    expect(events).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "tool_use_start", id: "t1", name: "list_accounts" },
      { type: "turn_end", hasPending: false },
    ]);

    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe(`${CLOUD_URL}/api/org/org%201/chat/conversations/c1/messages`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-1");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ text: "Hello" }));
  });

  it("refreshes the token once on a 401", async () => {
    h.fetch
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(sse([frame({ type: "turn_end" })]));

    await expect(callDesktopRpc(turn({ resume: true }))).resolves.toEqual([{ type: "turn_end" }]);
    expect(
      h.fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("Authorization")),
    ).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("fails with the server's answer when the turn does not start", async () => {
    h.fetch.mockResolvedValue(new Response('{"error":"Not found"}', { status: 404 }));
    const error = await failureOf(turn());
    expect(error).toMatchObject({ _tag: "CloudRequestError", message: '{"error":"Not found"}' });

    h.fetch.mockResolvedValue(new Response("", { status: 502 }));
    await expect(failureOf(turn())).resolves.toMatchObject({
      message: "Cloud request failed: 502",
    });
  });

  it("fails signed out without sending anything", async () => {
    h.getAccessToken.mockResolvedValue(null);
    await expect(failureOf(turn())).resolves.toMatchObject({
      message: "Not authenticated to Infrawrench Cloud",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("cancels the body when the renderer stops reading", async () => {
    const cancelled = vi.fn();
    h.fetch.mockResolvedValue(
      sse([frame({ type: "text_delta", text: "Hi" })], { open: true, onCancel: cancelled }),
    );

    await expect(callDesktopRpc(turn(undefined, 1))).resolves.toEqual([
      { type: "text_delta", text: "Hi" },
    ]);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });
});
