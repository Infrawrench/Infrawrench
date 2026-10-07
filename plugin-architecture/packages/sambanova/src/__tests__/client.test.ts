import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { SambaNovaClient, modelKind } from "../client.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

function host(handler: (url: string, body?: string) => { status?: number; body?: unknown }) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const http: HttpHostServices = {
    request: vi.fn(async (req) => {
      const body = typeof req.body === "string" ? req.body : undefined;
      calls.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(body ? { body } : {}),
      });
      const res = handler(req.url, body);
      return { status: res.status ?? 200, headers: {}, body: JSON.stringify(res.body ?? {}) };
    }),
  };
  return { http, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("SambaNova", () => {
  it("lists models with string prices converted per million tokens", async () => {
    const { http, calls } = host(() => ({
      body: {
        data: [
          {
            id: "DeepSeek-V3.1",
            context_length: 131072,
            pricing: { prompt: "0.00000300", completion: "0.00000450" },
          },
          { id: "Whisper-Large-v3", pricing: { duration_per_hour: 0.5 } },
        ],
      },
    }));
    const items = await new SambaNovaClient({ apiKey: "k" }, { http }).listResources(
      "sambanova-model",
      ACCOUNT,
    );
    expect(items[0]?.fields["inputPricePerMillion"]).toBe(3);
    expect(items[0]?.fields["outputPricePerMillion"]).toBe(4.5);
    expect(items[1]?.fields["kind"]).toBe("transcription");
    expect(items[1]?.fields["pricePerAudioHour"]).toBe(0.5);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer k");
  });

  it("offers chat for chat models and speech for Whisper", () => {
    const client = new SambaNovaClient({ apiKey: "k" });
    const base = {
      pluginId: "sambanova",
      resourceTypeId: "sambanova-model",
      accountId: ACCOUNT,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const chat = client.renderDetail({
      ...base,
      id: "a:sambanova-model:gpt-oss-120b",
      displayName: "gpt-oss-120b",
      externalId: "gpt-oss-120b",
      fields: { modelId: "gpt-oss-120b" },
    });
    expect(chat.chatPanel).toBeDefined();
    expect(chat.speechPanel).toBeUndefined();
    const stt = client.renderDetail({
      ...base,
      id: "a:sambanova-model:Whisper-Large-v3",
      displayName: "w",
      externalId: "Whisper-Large-v3",
      fields: { modelId: "Whisper-Large-v3" },
    });
    expect(stt.speechPanel?.modes).toEqual(["stt"]);
    expect(stt.chatPanel).toBeUndefined();
  });

  it("verifies the key with a free token count and reports a 401 as missing", async () => {
    const { http, calls } = host(() => ({
      status: 401,
      body: { error: { message: "Incorrect API key" } },
    }));
    const result = await new SambaNovaClient({ apiKey: "bad" }, { http }).verifyCredentials();
    expect(result.checks[0]?.status).toBe("missing");
    expect(calls[0]?.url).toBe("https://api.sambanova.ai/v1/messages/count_tokens");
  });

  it("attaches the HTTP status to thrown errors", async () => {
    const { http } = host(() => ({ status: 503, body: { error: "down" } }));
    await expect(
      new SambaNovaClient({ apiKey: "k" }, { http }).listResources("sambanova-model", ACCOUNT),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("classifies model ids", () => {
    expect(modelKind("E5-Mistral-7B-Instruct-embed")).toBe("embedding");
    expect(modelKind("gpt-oss-120b")).toBe("chat");
  });

  it("escalates gateway incidents and ignores the playground", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "1",
          name: "Gateway",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "SambaCloud API Gateway" }],
          incident_updates: [],
        },
        {
          id: "2",
          name: "UI",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "SambaCloud Playground" }],
          incident_updates: [],
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents.map((i) => i.externalId)).toEqual(["1"]);
    expect(incidents[0]?.providerWide).toBe(true);
  });
});
