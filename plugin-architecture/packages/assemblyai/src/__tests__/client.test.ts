import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyAIClient } from "../client.js";

const ACCOUNT = "acct-1";
const JOB_ID = "1f9c0a5e-0000-4000-8000-000000000001";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init: RequestInit = {},
  ) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
}

function client(credentials: Record<string, string> = {}): AssemblyAIClient {
  return new AssemblyAIClient({ apiKey: "test-key", ...credentials });
}

function completedTranscript(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: "completed",
    text: "Hello there.",
    confidence: 0.94,
    audio_duration: 12.5,
    language_code: "en_us",
    speaker_labels: true,
    speech_models: ["universal-3-5-pro"],
    audio_url: "https://cdn.assemblyai.com/upload/abc",
    resource_url: `https://api.assemblyai.com/v2/transcript/${JOB_ID}`,
    created: "2026-07-20T10:00:00.000Z",
    completed: "2026-07-20T10:01:00.000Z",
    words: [
      { text: "Hello", start: 400, end: 900, confidence: 0.99, speaker: "A" },
      { text: "there.", start: 950, end: 1500, confidence: 0.9, speaker: "B" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("auth and host selection", () => {
  it("sends the bare API key with no Bearer prefix", async () => {
    installFetch(() => jsonResponse({ transcripts: [] }));
    await client().listResources("transcript", ACCOUNT);
    const auth = calls[0]!.headers["authorization"];
    expect(auth).toBe("test-key");
    expect(auth).not.toMatch(/Bearer/i);
  });

  it("defaults to the North America host", async () => {
    installFetch(() => jsonResponse({ transcripts: [] }));
    await client().listResources("transcript", ACCOUNT);
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.assemblyai\.com\/v2\/transcript/);
  });

  it("routes every call to the EU host when the region is eu", async () => {
    installFetch(() => jsonResponse({ transcripts: [] }));
    await client({ region: "eu" }).listResources("transcript", ACCOUNT);
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.eu\.assemblyai\.com\/v2\/transcript/);
  });

  it("falls back to the default host for an unrecognised region", async () => {
    installFetch(() => jsonResponse({ transcripts: [] }));
    await client({ region: "moon" }).listResources("transcript", ACCOUNT);
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.assemblyai\.com\//);
  });

  it("throws without an API key", () => {
    expect(() => new AssemblyAIClient({})).toThrow(/missing apiKey/);
  });
});

describe("listResources", () => {
  it("lists then hydrates each transcript, since the list endpoint omits model/duration", async () => {
    installFetch((url) => {
      if (url.includes("/v2/transcript?")) {
        return jsonResponse({
          page_details: { limit: 100, result_count: 1 },
          transcripts: [{ id: JOB_ID, status: "completed", created: "2026-07-20T10:00:00.000Z" }],
        });
      }
      return jsonResponse(completedTranscript());
    });

    const resources = await client().listResources("transcript", ACCOUNT);

    expect(calls[0]!.url).toContain("/v2/transcript?limit=100");
    expect(calls[1]!.url).toBe(`https://api.assemblyai.com/v2/transcript/${JOB_ID}`);
    expect(resources).toHaveLength(1);
    const resource = resources[0]!;
    expect(resource.id).toBe(`${ACCOUNT}:transcript:${JOB_ID}`);
    expect(resource.fields["speechModel"]).toBe("universal-3-5-pro");
    expect(resource.fields["audioDuration"]).toBe(12.5);
    expect(resource.fields["languageCode"]).toBe("en_us");
    expect(resource.fields["wordCount"]).toBe(2);
    expect(resource.resolvedOutputs["text"]).toBe("Hello there.");
  });

  it("keeps the list-level record when hydration fails", async () => {
    installFetch((url) => {
      if (url.includes("/v2/transcript?")) {
        return jsonResponse({
          transcripts: [{ id: JOB_ID, status: "error", error: "gone", created: "2026-07-20" }],
        });
      }
      return jsonResponse("nope", 404);
    });

    const resources = await client().listResources("transcript", ACCOUNT);
    expect(resources).toHaveLength(1);
    expect(resources[0]!.fields["status"]).toBe("error");
    expect(resources[0]!.fields["errorMessage"]).toBe("gone");
  });

  it("rejects an unknown resource type", async () => {
    await expect(client().listResources("voice", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("account (the singleton that hosts the Speech tab)", () => {
  it("marks the account unreachable when the listing fails, rather than healthy", async () => {
    // A revoked key lands here. The listing failure is swallowed so the Speech
    // tab survives, but the status must not read the same as a valid key that
    // has simply never transcribed anything.
    installFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const c = client();
    const [account] = await c.listResources("account", ACCOUNT);

    expect(account!.fields["reachable"]).toBe("no");
    expect(c.renderDetail(account!).status?.status).toBe("error");
    // Still navigable, so the user can see the account at all.
    expect(c.renderDetail(account!).speechPanel).toBeDefined();
  });

  it("returns exactly one account, with a Speech tab, on a key with zero transcripts", async () => {
    // The regression: a freshly added account has nothing to open, so the
    // Speech tab has to hang off something that exists regardless.
    installFetch(() => jsonResponse({ transcripts: [] }));
    const resources = await client().listResources("account", ACCOUNT);

    expect(resources).toHaveLength(1);
    const account = resources[0]!;
    expect(account.id).toBe(`${ACCOUNT}:account:default`);
    expect(account.fields["sampledTranscripts"]).toBe(0);
    expect(client().renderDetail(account).speechPanel?.modes).toEqual(["stt"]);
  });

  it("still returns the account when the transcript listing fails outright", async () => {
    installFetch(() => jsonResponse("Server error", 500));
    const resources = await client().listResources("account", ACCOUNT);
    expect(resources).toHaveLength(1);
    expect(client().renderDetail(resources[0]!).speechPanel).toBeDefined();
  });

  it("counts the retention window and the oldest transcript sampled", async () => {
    installFetch(() =>
      jsonResponse({
        transcripts: [
          { id: "a", status: "completed", created: "2026-07-20T10:00:00.000Z" },
          { id: "b", status: "error", created: "2026-07-01T10:00:00.000Z" },
          { id: "c", status: "processing", created: "2026-07-25T10:00:00.000Z" },
        ],
      }),
    );
    const account = await client().getResource("account", `${ACCOUNT}:account:default`, ACCOUNT);
    expect(calls[0]!.url).toContain("/v2/transcript?limit=100");
    // The account view is a count, so it never hydrates each record.
    expect(calls).toHaveLength(1);
    expect(account.fields).toMatchObject({
      sampledTranscripts: 3,
      completedTranscripts: 1,
      erroredTranscripts: 1,
      pendingTranscripts: 1,
      oldestSampledAt: "2026-07-01T10:00:00.000Z",
    });
  });

  it("resolves the endpoint output against the account's region", async () => {
    installFetch(() => jsonResponse({ transcripts: [] }));
    await expect(
      client({ region: "eu" }).resolveOutput(
        "account",
        `${ACCOUNT}:account:default`,
        "endpoint",
        ACCOUNT,
      ),
    ).resolves.toBe("https://api.eu.assemblyai.com");
  });
});

describe("getResource / resolveOutput / deleteResource", () => {
  it("fetches a single transcript by its trailing UUID", async () => {
    installFetch(() => jsonResponse(completedTranscript()));
    const resource = await client().getResource(
      "transcript",
      `${ACCOUNT}:transcript:${JOB_ID}`,
      ACCOUNT,
    );
    expect(calls[0]!.url).toBe(`https://api.assemblyai.com/v2/transcript/${JOB_ID}`);
    expect(resource.externalId).toBe(JOB_ID);
  });

  it("resolves declared outputs and rejects unknown ones", async () => {
    installFetch(() => jsonResponse(completedTranscript()));
    const c = client();
    await expect(
      c.resolveOutput("transcript", `${ACCOUNT}:transcript:${JOB_ID}`, "transcriptId", ACCOUNT),
    ).resolves.toBe(JOB_ID);
    await expect(
      c.resolveOutput("transcript", `${ACCOUNT}:transcript:${JOB_ID}`, "nope", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });

  it("DELETEs the transcript", async () => {
    installFetch(() => jsonResponse(completedTranscript({ status: "completed", text: null })));
    await client().deleteResource("transcript", `${ACCOUNT}:transcript:${JOB_ID}`, ACCOUNT);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`https://api.assemblyai.com/v2/transcript/${JOB_ID}`);
  });
});

describe("enrichDetail", () => {
  it("stashes a retention-window job count for the synchronous renderer", async () => {
    installFetch(() =>
      jsonResponse({
        transcripts: [
          { id: "a", status: "completed" },
          { id: "b", status: "error" },
          { id: "c", status: "processing" },
        ],
      }),
    );
    const enriched = await client().enrichDetail({
      id: `${ACCOUNT}:transcript:${JOB_ID}`,
      pluginId: "assemblyai",
      resourceTypeId: "transcript",
      accountId: ACCOUNT,
      displayName: "t",
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(JSON.parse(enriched.resolvedOutputs["__recentActivity__"]!)).toEqual({
      sampled: 3,
      completed: 1,
      error: 1,
      pending: 1,
    });
  });
});

describe("transcribeAudio", () => {
  const audioBase64 = Buffer.from("fake-audio-bytes").toString("base64");

  function installTranscribeFetch(pollStatuses: string[] = ["completed"]) {
    let poll = 0;
    return installFetch((url, init) => {
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ upload_url: "https://cdn.assemblyai.com/upload/abc" });
      }
      if (url.endsWith("/v2/transcript") && init.method === "POST") {
        return jsonResponse({ id: JOB_ID, status: "queued" });
      }
      if (url.endsWith(`/v2/transcript/${JOB_ID}`)) {
        const status = pollStatuses[Math.min(poll++, pollStatuses.length - 1)]!;
        if (status === "completed") return jsonResponse(completedTranscript());
        if (status === "error") {
          return jsonResponse({ id: JOB_ID, status: "error", error: "Audio file is corrupt" });
        }
        return jsonResponse({ id: JOB_ID, status });
      }
      throw new Error(`unrouted: ${init.method ?? "GET"} ${url}`);
    });
  }

  it("uploads raw bytes as application/octet-stream, not multipart", async () => {
    installTranscribeFetch();
    await client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm;codecs=opus",
    });

    const upload = calls[0]!;
    expect(upload.url).toBe("https://api.assemblyai.com/v2/upload");
    expect(upload.method).toBe("POST");
    expect(upload.headers["Content-Type"]).toBe("application/octet-stream");
    expect(upload.headers["authorization"]).toBe("test-key");
    expect(upload.body).toBeInstanceOf(Uint8Array);
    // Base64 round-trips to the exact original bytes.
    expect(Buffer.from(upload.body as Uint8Array).toString()).toBe("fake-audio-bytes");
    expect(String(upload.body)).not.toContain("Content-Disposition");
  });

  it("submits speech_models as a priority-ordered array with the documented fallback", async () => {
    installTranscribeFetch();
    await client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
      modelId: "universal-3-5-pro",
    });

    const submit = calls[1]!;
    expect(submit.url).toBe("https://api.assemblyai.com/v2/transcript");
    const body = JSON.parse(String(submit.body)) as Record<string, unknown>;
    expect(body["speech_models"]).toEqual(["universal-3-5-pro", "universal-2"]);
    expect(body).not.toHaveProperty("speech_model");
    expect(body["audio_url"]).toBe("https://cdn.assemblyai.com/upload/abc");
    expect(body["punctuate"]).toBe(true);
    expect(body["format_text"]).toBe(true);
    expect(body["speaker_labels"]).toBe(true);
  });

  it("sends universal-2 on its own when it is the explicit choice", async () => {
    installTranscribeFetch();
    await client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
      modelId: "universal-2",
    });
    const body = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(body["speech_models"]).toEqual(["universal-2"]);
  });

  it("pins language_code with an underscored region, and never both code and detection", async () => {
    installTranscribeFetch();
    await client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
      language: "en_us",
    });
    const body = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(body["language_code"]).toBe("en_us");
    expect(body).not.toHaveProperty("language_detection");
  });

  it("asks for language_detection instead of a code when the language is auto", async () => {
    installTranscribeFetch();
    await client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
      language: "auto",
    });
    const body = JSON.parse(String(calls[1]!.body)) as Record<string, unknown>;
    expect(body["language_detection"]).toBe(true);
    expect(body).not.toHaveProperty("language_code");
  });

  it("returns the transcript with word timings converted from ms to seconds", async () => {
    installTranscribeFetch();
    const result = await client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
    });

    expect(result.text).toBe("Hello there.");
    expect(result.language).toBe("en_us");
    expect(result.durationSeconds).toBe(12.5);
    expect(result.confidence).toBe(0.94);
    expect(result.requestId).toBe(JOB_ID);
    expect(result.words).toEqual([
      { text: "Hello", start: 0.4, end: 0.9, speaker: "A" },
      { text: "there.", start: 0.95, end: 1.5, speaker: "B" },
    ]);
    expect(result.summary).toContain("universal-3-5-pro");
    expect(result.summary).toContain("2 words");
  });

  it("polls until the job leaves queued/processing", async () => {
    vi.useFakeTimers();
    installTranscribeFetch(["queued", "processing", "completed"]);
    const promise = client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toMatchObject({ text: "Hello there." });
    const polls = calls.filter((c) => c.url.endsWith(`/v2/transcript/${JOB_ID}`));
    expect(polls).toHaveLength(3);
  });

  it("surfaces a failed job — which arrives as HTTP 200 with status error", async () => {
    installTranscribeFetch(["error"]);
    await expect(
      client().transcribeAudio("transcript", "r", ACCOUNT, {
        audioBase64,
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/Audio file is corrupt/);
  });

  it("gives up with a clear message after the 120s poll budget", async () => {
    vi.useFakeTimers();
    installTranscribeFetch(["processing"]);
    const promise = client().transcribeAudio("transcript", "r", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm",
    });
    const assertion = expect(promise).rejects.toThrow(/did not finish within 120s/);
    await vi.advanceTimersByTimeAsync(200_000);
    await assertion;
  });

  it("rejects an empty clip before touching the network", async () => {
    installTranscribeFetch();
    await expect(
      client().transcribeAudio("transcript", "r", ACCOUNT, {
        audioBase64: "",
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/empty audio payload/);
    expect(calls).toHaveLength(0);
  });

  it("accepts the account singleton, which is where the tab lives on a fresh key", async () => {
    installTranscribeFetch();
    await expect(
      client().transcribeAudio("account", `${ACCOUNT}:account:default`, ACCOUNT, {
        audioBase64,
        mimeType: "audio/webm",
      }),
    ).resolves.toMatchObject({ text: "Hello there." });
  });

  it("rejects an unknown resource type", async () => {
    await expect(
      client().transcribeAudio("voice", "r", ACCOUNT, { audioBase64, mimeType: "audio/webm" }),
    ).rejects.toThrow(/not supported for type/);
  });
});

describe("error handling", () => {
  it("explains that a 403 may be a rate limit rather than a bad key", async () => {
    installFetch(() => jsonResponse("Forbidden", 403));
    await expect(client().listResources("transcript", ACCOUNT)).rejects.toThrow(
      /403 for rate-limit violations \(not 429\)/,
    );
  });

  it("leaves other statuses alone", async () => {
    installFetch(() => jsonResponse("Server error", 500));
    await expect(client().listResources("transcript", ACCOUNT)).rejects.toThrow(
      /AssemblyAI API error 500/,
    );
    await expect(client().listResources("transcript", ACCOUNT)).rejects.toThrow(/^(?!.*not 429)/s);
  });
});

describe("voice agents", () => {
  const AGENT = {
    id: "agent-1",
    name: "Support",
    system_prompt: "Be brief.",
    greeting: "Hi!",
    voice: { voice_id: "anna" },
    tools: [{ name: "get_weather" }],
    llm: [{ base_url: "https://llm.example.com", model: "my-model" }],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  };

  it("lists live agents on the agents host with the bare key, skipping deleted ones", async () => {
    installFetch(() =>
      jsonResponse([
        { id: "agent-1", name: "Support" },
        { id: "agent-0", name: "Old", deleted_at: "2026-08-01T00:00:00Z" },
      ]),
    );
    const agents = await client().listResources("voice-agent", ACCOUNT);
    expect(calls[0]?.url).toBe("https://agents.assemblyai.com/v1/agents");
    expect(calls[0]?.headers["authorization"]).toBe("test-key");
    expect(agents.map((a) => a.id)).toEqual([`${ACCOUNT}:voice-agent:agent-1`]);
  });

  it("reads one agent with its voice, tools and LLM", async () => {
    installFetch(() => jsonResponse(AGENT));
    const agent = await client().getResource(
      "voice-agent",
      `${ACCOUNT}:voice-agent:agent-1`,
      ACCOUNT,
    );
    expect(agent.fields["voiceId"]).toBe("anna");
    expect(agent.fields["tools"]).toBe("get_weather");
    expect(agent.fields["llmModel"]).toBe("my-model");
    const detail = client().renderDetail(agent);
    expect(detail.metricsCapability).toBeDefined();
    expect(JSON.stringify(detail.sections)).toContain("Anna (English (British))");
  });

  it("creates an agent with a voice, greeting and key terms", async () => {
    installFetch(() => jsonResponse(AGENT, 201));
    await client().createResource("voice-agent", ACCOUNT, {
      name: "Support",
      systemPrompt: "Be brief.",
      voiceId: "anna",
      greeting: "Hi!",
      keyterms: "Infrawrench, AssemblyAI",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      name: "Support",
      system_prompt: "Be brief.",
      voice: { voice_id: "anna" },
      greeting: "Hi!",
      input: { keyterms: ["Infrawrench", "AssemblyAI"] },
    });
  });

  it("updates only what changed with PUT", async () => {
    installFetch(() => jsonResponse({ ...AGENT, voice: { voice_id: "paul" } }));
    const updated = await client().updateResource(
      "voice-agent",
      `${ACCOUNT}:voice-agent:agent-1`,
      ACCOUNT,
      { voiceId: "paul" },
    );
    expect(calls[0]?.url).toBe("https://agents.assemblyai.com/v1/agents/agent-1");
    expect(calls[0]?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ voice: { voice_id: "paul" } });
    expect(updated.fields["voiceId"]).toBe("paul");
  });

  it("buckets an agent's sessions into daily metrics", async () => {
    const day = Date.UTC(2026, 8, 10);
    installFetch(() =>
      jsonResponse({
        sessions: [
          {
            id: "s1",
            agent_id: "agent-1",
            created_at: new Date(day + 1000).toISOString(),
            duration_seconds: 60,
          },
          {
            id: "s2",
            agent_id: "agent-1",
            created_at: new Date(day + 2000).toISOString(),
            duration_seconds: 30,
          },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      }),
    );
    const series = await client().fetchMetricSeries(
      "voice-agent",
      `${ACCOUNT}:voice-agent:agent-1`,
      ACCOUNT,
      { startMs: day, endMs: day + 86_400_000 - 1 },
    );
    expect(calls[0]?.url).toBe(
      "https://agents.assemblyai.com/v1/sessions?limit=200&agent_id=agent-1",
    );
    expect(series[0]?.points[0]).toEqual({ timestamp: day, value: 2 });
    expect(series[1]?.points[0]).toEqual({ timestamp: day, value: 1.5 });
  });

  it("names sessions after their agent and deletes them", async () => {
    installFetch((url, init) => {
      if (init.method === "DELETE") return jsonResponse("", 204);
      if (url.includes("/sessions")) {
        return jsonResponse({
          sessions: [
            {
              id: "sess_1",
              agent_id: "agent-1",
              status: "completed",
              created_at: "2026-09-01T10:00:00Z",
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse([{ id: "agent-1", name: "Support" }]);
    });
    const [session] = await client().listResources("agent-session", ACCOUNT);
    expect(session?.displayName).toBe("Support · 2026-09-01 10:00:00");
    await client().deleteResource("agent-session", session!.id, ACCOUNT);
    expect(calls.at(-1)?.url).toBe("https://agents.assemblyai.com/v1/sessions/sess_1");
    expect(calls.at(-1)?.method).toBe("DELETE");
  });
});

describe("voice agent webhooks", () => {
  it("creates a subscription with picked events and a generated secret shown once", async () => {
    installFetch(() =>
      jsonResponse(
        {
          id: "wh_1",
          url: "https://example.com/hook",
          events: ["session.completed"],
          enabled: true,
          secret_version: 1,
        },
        201,
      ),
    );
    const sub = await client().createResource("webhook-subscription", ACCOUNT, {
      url: "https://example.com/hook",
      events: JSON.stringify(["session.completed", "bogus"]),
      agentId: "",
      secret: "",
    });
    const body = JSON.parse(String(calls[0]?.body));
    expect(calls[0]?.url).toBe("https://agents.assemblyai.com/v1/webhook-subscriptions");
    expect(body.events).toEqual(["session.completed"]);
    expect(body.secret).toHaveLength(48);
    expect(body.agent_id).toBeUndefined();
    expect(sub.resolvedOutputs["signingSecret"]).toBe(body.secret);
    expect(sub.fields["eventSessionCompleted"]).toBe(true);
    expect(sub.fields["eventCallFailed"]).toBe(false);
  });

  it("rejects a non-HTTPS delivery URL before calling the API", async () => {
    const spy = installFetch(() => jsonResponse({}));
    await expect(
      client().createResource("webhook-subscription", ACCOUNT, {
        url: "http://example.com",
        events: '["call.ended"]',
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("patches toggled events merged with the current set", async () => {
    installFetch((url, init) => {
      if (init.method === "PATCH") {
        return jsonResponse({
          id: "wh_1",
          url: "https://e.com",
          events: ["session.started", "call.ended"],
        });
      }
      if (url.includes("/webhook-subscriptions")) {
        return jsonResponse({
          subscriptions: [
            { id: "wh_1", url: "https://e.com", events: ["session.started"], enabled: true },
          ],
          has_more: false,
        });
      }
      return jsonResponse([]);
    });
    await client().updateResource(
      "webhook-subscription",
      `${ACCOUNT}:webhook-subscription:wh_1`,
      ACCOUNT,
      {
        eventCallEnded: "true",
      },
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://agents.assemblyai.com/v1/webhook-subscriptions/wh_1");
    expect(JSON.parse(String(patch?.body))).toEqual({ events: ["session.started", "call.ended"] });
  });
});

describe("LLM Gateway catalogue", () => {
  it("lists models from the regional gateway with global prices", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "claude-sonnet-4-6",
            name: "Sonnet 4.6",
            creator: "Claude",
            context_length: 200000,
            top_provider: { max_completion_tokens: 128000 },
            pricing: {
              global: { prompt: 3, completions: 15, input_cache_read: 0.3 },
              regional_increase_percent: 0.1,
            },
            retirement_date: 0,
            available_regions: ["us", "eu", "global"],
          },
        ],
      }),
    );
    const [model] = await client({ region: "eu" }).listResources("llm-model", ACCOUNT);
    expect(calls[0]?.url).toBe("https://llm-gateway.eu.assemblyai.com/v1/models");
    expect(model?.fields["promptPrice"]).toBe(3);
    expect(model?.fields["completionPrice"]).toBe(15);
    expect(model?.fields["retirementDate"]).toBe("");
    expect(model?.fields["regions"]).toBe("us, eu, global");
  });
});
