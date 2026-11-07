import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CerebrasClient } from "../client.js";

type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
  responseEncoding?: "utf8" | "binary";
};

const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xfe]);

function hostHttp(json: unknown) {
  return vi.fn(async (req: HostRequest) => ({
    status: 200,
    headers: {},
    body: "",
    rawBody:
      req.responseEncoding === "binary" && json === AUDIO
        ? AUDIO
        : new TextEncoder().encode(JSON.stringify(json)),
  }));
}

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  fetchStub = vi.fn(async () => {
    throw new Error("global fetch must not be used");
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("a socket must not be opened");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CLIP = { audioBase64: btoa("clip"), mimeType: "audio/webm" };

describe("Cerebras through the host's HTTP service", () => {
  it("streams chat through the host", async () => {
    const encoder = new TextEncoder();
    const requestStream = vi.fn(async (_req: HostRequest) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
          );
          c.close();
        },
      }),
    }));
    const request = hostHttp({});
    const hosted = hostClient(
      new CerebrasClient({ apiKey: "k" }, { http: { request, requestStream } }),
    );

    const chunks: unknown[] = [];
    for await (const chunk of hosted.streamChatMessage!(
      "cerebras-model",
      "acct:cerebras-model:m1",
      "acct",
      [{ role: "user", content: "hello" }],
    )) {
      chunks.push(chunk);
    }

    expect(fetchStub).not.toHaveBeenCalled();
    expect(requestStream).toHaveBeenCalledOnce();
    expect(new URL(requestStream.mock.calls[0]![0].url).pathname).toContain("/chat/completions");
    expect(chunks.length).toBeGreaterThan(0);
  });
});
