import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroqClient } from "../client.js";

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

describe("Groq through the host's HTTP service", () => {
  it("sends speech through the host and hands back its bytes", async () => {
    const request = hostHttp(AUDIO);
    const hosted = hostClient(new GroqClient({ apiKey: "k" }, { http: { request } }));

    const result = await hosted.synthesizeSpeech!("groq-model", "id", "acct", { text: "Hello" });

    expect(fetchStub).not.toHaveBeenCalled();
    const req = request.mock.calls.at(-1)![0];
    expect(new URL(req.url).hostname).toBe("api.groq.com");
    expect(new URL(req.url).pathname).toContain("/audio/speech");
    expect(req.responseEncoding).toBe("binary");
    expect(req).not.toHaveProperty("caCert");
    expect(atob(result.audioBase64).length).toBe(AUDIO.length);
  });

  it("sends a transcription through the host as a multipart body", async () => {
    const request = hostHttp({ text: "hi" });
    const hosted = hostClient(new GroqClient({ apiKey: "k" }, { http: { request } }));

    await hosted.transcribeAudio!("groq-model", "id", "acct", CLIP);

    expect(fetchStub).not.toHaveBeenCalled();
    const req = request.mock.calls.at(-1)![0];
    expect(new URL(req.url).pathname).toContain("/audio/transcriptions");
    expect(req.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(new TextDecoder().decode(req.body as Uint8Array)).toContain("clip");
  });

  it("passes a custom CA to the host", async () => {
    const request = hostHttp({ text: "hi" });
    const hosted = hostClient(
      new GroqClient({ ...{ apiKey: "k" }, caCert: "PEM" }, { http: { request } }),
    );

    await hosted.transcribeAudio!("groq-model", "id", "acct", CLIP);

    expect(request.mock.calls.at(-1)![0].caCert).toBe("PEM");
  });
});
