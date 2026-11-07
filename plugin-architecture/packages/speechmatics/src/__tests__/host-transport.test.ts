import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpeechmaticsClient } from "../client.js";
import { manifest } from "../plugin.js";

type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
  responseEncoding?: "utf8" | "binary";
};

const WAV = new Uint8Array(46);

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

const matches = (host: string) =>
  manifest.egressHosts.some((pattern) =>
    pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
  );

describe("Speechmatics through the host's HTTP service", () => {
  it("sends text to speech through the host with the custom CA, and reads its bytes", async () => {
    const request = vi.fn(async (_req: HostRequest) => ({
      status: 200,
      headers: {},
      body: "",
      rawBody: WAV,
    }));
    const hosted = hostClient(
      new SpeechmaticsClient({ apiKey: "k", region: "eu1", caCert: "PEM" }, { http: { request } }),
    );

    const result = await hosted.synthesizeSpeech!("job", "res", "acct", { text: "Hello" });

    expect(fetchStub).not.toHaveBeenCalled();
    const req = request.mock.calls[0]![0];
    expect(new URL(req.url).hostname).toBe("preview.tts.speechmatics.com");
    expect(req.caCert).toBe("PEM");
    expect(req.responseEncoding).toBe("binary");
    expect(atob(result.audioBase64).length).toBe(WAV.length);
  });

  it("declares the management API and text to speech hosts it calls", () => {
    expect(matches("mp.speechmatics.com")).toBe(true);
    expect(matches("preview.tts.speechmatics.com")).toBe(true);
    expect(matches("eu1.asr.api.speechmatics.com")).toBe(true);
  });
});
