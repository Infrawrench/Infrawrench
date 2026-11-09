/**
 * A CI run's live log end to end: the renderer's `CloudCiRunLogs` call
 * through the real RPC server to the main process's real handler
 * (`electron/cloud-ci.ts`), with `fetch` and the token store as the only
 * fakes, as `cloud-chat-rpc.test.ts` does for the chat turn.
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

const logs = (take?: number) =>
  Effect.gen(function* () {
    const rpc = yield* DesktopRpcClient;
    const frames = rpc.CloudCiRunLogs({ orgId: "org 1", runId: "run-1" });
    return yield* Stream.runCollect(take === undefined ? frames : Stream.take(frames, take));
  });

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  h.getAccessToken.mockReset();
  h.getAccessToken.mockResolvedValue("access-1");
  h.forceRefreshAccessToken.mockReset();
  h.forceRefreshAccessToken.mockResolvedValue("access-2");
});

describe("CloudCiRunLogs", () => {
  it("reads the log and hands on each event with its name, skipping keep-alives", async () => {
    h.fetch.mockResolvedValue(
      sse([
        'event: job-started\ndata: {"event":"job-started","job":"a","name":"A"}\n\n',
        ": keep-alive\n\n",
        // Split across reads, as a network delivers it.
        'event: truncated\ndata: {"after_',
        'bytes":8388608}\n\n',
        "data: not json\n\n",
      ]),
    );
    const frames = await callDesktopRpc(logs());
    expect(frames).toEqual([
      { event: "job-started", data: { event: "job-started", job: "a", name: "A" } },
      { event: "truncated", data: { after_bytes: 8388608 } },
    ]);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe(`${CLOUD_URL}/api/org/org%201/ci/runs/run-1/logs`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-1");
  });

  it("fails with the server's sentence when the log cannot be followed", async () => {
    h.fetch.mockResolvedValue(
      new Response('{"error":"The run is not running; its jobs\' output is in the run."}', {
        status: 409,
      }),
    );
    await expect(failureOf(logs())).resolves.toMatchObject({
      _tag: "CloudRequestError",
      message: "The run is not running; its jobs' output is in the run.",
    });
  });

  it("cancels the body when the renderer stops reading", async () => {
    const cancelled = vi.fn();
    h.fetch.mockResolvedValue(
      sse(['event: job-started\ndata: {"event":"job-started","job":"a","name":"A"}\n\n'], {
        open: true,
        onCancel: cancelled,
      }),
    );
    await expect(callDesktopRpc(logs(1))).resolves.toHaveLength(1);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  });
});
