import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, requestId = "req_123"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === "x-request-id" ? requestId : null) },
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    text: async () => "",
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
}

function client(credentials?: Record<string, string>): OpenAIClient {
  return new OpenAIClient(credentials ?? { apiKey: "sk-proj-test", adminApiKey: "sk-admin-test" });
}

function authOf(init: RequestInit | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers["Authorization"] ?? "";
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credential routing", () => {
  it("sends the project key on the data plane", async () => {
    installFetch(() => jsonResponse({ data: [{ id: "gpt-5", owned_by: "openai", created: 1 }] }));

    const resources = await client().listResources("model", ACCOUNT);

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(authOf(calls[0]!.init)).toBe("Bearer sk-proj-test");
    expect(resources[0]!.id).toBe(`${ACCOUNT}:model:gpt-5`);
    expect(resources[0]!.fields["ownedBy"]).toBe("openai");
  });

  it("sends the admin key on /v1/organization/*", async () => {
    installFetch(() => jsonResponse({ data: [{ id: "proj_1", name: "prod", created_at: 1 }] }));

    await client().listResources("project", ACCOUNT);

    expect(calls[0]!.url).toContain("/v1/organization/projects?");
    expect(authOf(calls[0]!.init)).toBe("Bearer sk-admin-test");
  });

  it("names the missing admin key instead of surfacing a raw 403", async () => {
    installFetch(() => jsonResponse({ error: "forbidden" }, 403));

    await expect(
      client({ apiKey: "sk-proj-test" }).listResources("organization-user", ACCOUNT),
    ).rejects.toThrow(/Admin API key/);
    // The request is never sent: the guard fires first.
    expect(calls).toHaveLength(0);
  });
});

describe("pagination", () => {
  it("uses last_id when the response supplies one", async () => {
    installFetch((url) => {
      if (url.includes("after=")) {
        return jsonResponse({ data: [{ id: "vs_3" }], has_more: false, last_id: "vs_3" });
      }
      return jsonResponse({
        data: [{ id: "vs_1" }, { id: "vs_2" }],
        has_more: true,
        // Deliberately different from data[-1].id so the assertion proves which
        // cursor was used.
        last_id: "vs_cursor",
      });
    });

    const resources = await client().listResources("vector-store", ACCOUNT);

    expect(calls[1]!.url).toContain("after=vs_cursor");
    expect(resources.map((r) => r.externalId)).toEqual(["vs_1", "vs_2", "vs_3"]);
  });

  it("derives the cursor from the last element when there is no last_id", async () => {
    installFetch((url) => {
      if (url.includes("after="))
        return jsonResponse({ data: [{ id: "ftjob-3" }], has_more: false });
      return jsonResponse({ data: [{ id: "ftjob-1" }, { id: "ftjob-2" }], has_more: true });
    });

    const resources = await client().listResources("fine-tuning-job", ACCOUNT);

    expect(calls[1]!.url).toContain("after=ftjob-2");
    expect(resources).toHaveLength(3);
  });
});

describe("project API keys", () => {
  it("fans out over non-archived projects and skips the archived ones", async () => {
    installFetch((url) => {
      if (url.includes("/organization/projects?")) {
        return jsonResponse({
          data: [
            { id: "proj_live", name: "prod", status: "active", created_at: 1 },
            { id: "proj_old", name: "legacy", status: "archived", created_at: 1 },
          ],
          has_more: false,
        });
      }
      if (url.includes("/projects/proj_live/api_keys")) {
        return jsonResponse({
          data: [
            {
              id: "key_1",
              name: "server",
              redacted_value: "sk-proj-***abc",
              created_at: 1,
              owner: { type: "service_account", service_account: { name: "ci" } },
            },
          ],
          has_more: false,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const keys = await client().listResources("project-api-key", ACCOUNT);

    expect(calls.some((c) => c.url.includes("proj_old/api_keys"))).toBe(false);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.externalId).toBe("proj_live:key_1");
    expect(keys[0]!.fields["ownerName"]).toBe("ci");
    expect(keys[0]!.parentResourceId).toBe(`${ACCOUNT}:project:proj_live`);
  });

  it("revokes a key at the project-scoped path", async () => {
    installFetch(() => jsonResponse({ deleted: true }));

    await client().deleteResource(
      "project-api-key",
      `${ACCOUNT}:project-api-key:proj_live:key_1`,
      ACCOUNT,
    );

    expect(calls[0]!.url).toBe(
      "https://api.openai.com/v1/organization/projects/proj_live/api_keys/key_1",
    );
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});

describe("actions", () => {
  it("maps the fine-tuning verbs onto their POST paths", async () => {
    installFetch(() => jsonResponse({ id: "ftjob-1" }));
    const c = client();

    for (const [actionId, verb] of [
      ["cancel-fine-tuning-job", "cancel"],
      ["pause-fine-tuning-job", "pause"],
      ["resume-fine-tuning-job", "resume"],
    ] as const) {
      await c.invokeAction(
        "fine-tuning-job",
        `${ACCOUNT}:fine-tuning-job:ftjob-1`,
        actionId,
        ACCOUNT,
      );
      const call = calls[calls.length - 1]!;
      expect(call.url).toBe(`https://api.openai.com/v1/fine_tuning/jobs/ftjob-1/${verb}`);
      expect(call.init?.method).toBe("POST");
    }
  });

  it("cancels a batch", async () => {
    installFetch(() => jsonResponse({ id: "batch_1" }));

    await client().invokeAction("batch", `${ACCOUNT}:batch:batch_1`, "cancel-batch", ACCOUNT);

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/batches/batch_1/cancel");
  });

  it("refuses to delete a base model", async () => {
    installFetch(() => jsonResponse({}));

    await expect(
      client().invokeAction("model", `${ACCOUNT}:model:gpt-5`, "delete-fine-tuned-model", ACCOUNT),
    ).rejects.toThrow(/base model/);
    expect(calls).toHaveLength(0);
  });

  it("deletes a fine-tuned model", async () => {
    installFetch(() => jsonResponse({ deleted: true }));

    await client().invokeAction(
      "model",
      `${ACCOUNT}:model:ft:gpt-4o-mini:acme::abc`,
      "delete-fine-tuned-model",
      ACCOUNT,
    );

    expect(calls[0]!.url).toBe(
      `https://api.openai.com/v1/models/${encodeURIComponent("ft:gpt-4o-mini:acme::abc")}`,
    );
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});

describe("createResource", () => {
  it("posts an invite with project membership", async () => {
    installFetch(() =>
      jsonResponse({ id: "invite_1", email: "a@b.com", role: "reader", status: "pending" }),
    );

    const created = await client().createResource("invite", ACCOUNT, {
      email: "a@b.com",
      role: "reader",
      project_id: "proj_1",
      project_role: "member",
    });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/organization/invites");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      email: "a@b.com",
      role: "reader",
      projects: [{ id: "proj_1", role: "member" }],
    });
    expect(created.externalId).toBe("invite_1");
  });

  it("omits the projects array when no project was picked", async () => {
    installFetch(() => jsonResponse({ id: "invite_2", email: "c@d.com", role: "owner" }));

    await client().createResource("invite", ACCOUNT, {
      email: "c@d.com",
      role: "owner",
      project_id: "",
    });

    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      email: "c@d.com",
      role: "owner",
    });
  });
});

describe("exportCredential", () => {
  it("mints a service-account key and flags it as shown-once", async () => {
    installFetch(() =>
      jsonResponse({
        id: "svc_acct_1",
        name: "infrawrench-20260729T000000",
        role: "member",
        created_at: 1,
        api_key: { id: "key_9", value: "sk-svcacct-secret", name: "default" },
      }),
    );

    const result = await client().exportCredential(
      "project",
      `${ACCOUNT}:project:proj_1`,
      ACCOUNT,
      "service-account-key",
    );

    expect(calls[0]!.url).toBe(
      "https://api.openai.com/v1/organization/projects/proj_1/service_accounts",
    );
    expect(authOf(calls[0]!.init)).toBe("Bearer sk-admin-test");
    expect(result.content).toBe("sk-svcacct-secret");
    expect(result.fields?.some((f) => f.sensitive && f.value === "sk-svcacct-secret")).toBe(true);
    expect(result.warning).toMatch(/never returns it again/i);
  });
});

describe("costs", () => {
  it("asks for daily buckets over the requested window and normalises the rows", async () => {
    installFetch(() =>
      jsonResponse({
        object: "page",
        data: [
          {
            object: "bucket",
            start_time: Math.floor(Date.parse("2026-03-01T00:00:00Z") / 1000),
            end_time: Math.floor(Date.parse("2026-03-02T00:00:00Z") / 1000),
            results: [
              {
                object: "organization.costs.result",
                amount: { value: 1.25, currency: "usd" },
                line_item: "gpt-5, input",
                project_id: "proj_1",
              },
              { object: "organization.costs.result", amount: { value: 0, currency: "usd" } },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-03-01",
      toDate: "2026-03-03",
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/organization/costs");
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(url.searchParams.get("start_time")).toBe(
      String(Math.floor(Date.parse("2026-03-01T00:00:00Z") / 1000)),
    );
    // end_time is exclusive, so the last requested day still lands inside it.
    expect(url.searchParams.get("end_time")).toBe(
      String(Math.floor(Date.parse("2026-03-04T00:00:00Z") / 1000)),
    );
    // Arrays go out as repeated params, matching the official SDKs.
    expect(url.searchParams.getAll("group_by")).toEqual(["line_item", "project_id"]);

    expect(rows).toEqual([
      {
        date: "2026-03-01",
        currency: "USD",
        amount: 1.25,
        service: "gpt-5, input",
        tags: { project_id: "proj_1" },
      },
    ]);
  });

  it("raises a setup error rather than a 403 when there is no admin key", async () => {
    installFetch(() => jsonResponse({}, 403));

    await expect(
      client({ apiKey: "sk-proj-test" }).fetchCostData(ACCOUNT, {
        fromDate: "2026-03-01",
        toDate: "2026-03-02",
      }),
    ).rejects.toThrow(/Admin API key/);
  });
});

describe("synthesizeSpeech", () => {
  it("requests mp3 and round-trips the audio as base64", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]);
    installFetch(() => binaryResponse(audio));

    const result = await client().synthesizeSpeech(
      "model",
      `${ACCOUNT}:model:gpt-4o-mini-tts-2025-12-15`,
      ACCOUNT,
      { text: "Hello there", voiceId: "coral", modelId: "gpt-4o-mini-tts-2025-12-15" },
    );

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.model).toBe("gpt-4o-mini-tts-2025-12-15");
    expect(body.voice).toBe("coral");
    expect(body.input).toBe("Hello there");
    expect(body.response_format).toBe("mp3");
    expect(body.instructions).toBeTypeOf("string");

    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.characters).toBe("Hello there".length);
    expect(result.requestId).toBe("req_123");
    expect(new Uint8Array(Buffer.from(result.audioBase64, "base64"))).toEqual(audio);
  });

  it("drops instructions on tts-1, which does not accept them", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1, 2, 3])));

    await client().synthesizeSpeech("model", `${ACCOUNT}:model:tts-1`, ACCOUNT, {
      text: "Hi",
      modelId: "tts-1",
    });

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.model).toBe("tts-1");
    expect(body.instructions).toBeUndefined();
    expect(body.stream_format).toBeUndefined();
  });

  it("falls back to a TTS model when the shared picker holds an STT model", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1])));

    const result = await client().synthesizeSpeech("model", `${ACCOUNT}:model:whisper-1`, ACCOUNT, {
      text: "Hi",
      modelId: "whisper-1",
    });

    expect(JSON.parse(calls[0]!.init!.body as string).model).toBe("gpt-4o-mini-tts-2025-12-15");
    expect(result.summary).toContain("can't synthesize");
  });

  it("surfaces the API's JSON error body when audio was expected", async () => {
    installFetch(() => jsonResponse({ error: { message: "bad voice" } }, 400));

    await expect(
      client().synthesizeSpeech("model", `${ACCOUNT}:model:tts-1`, ACCOUNT, { text: "Hi" }),
    ).rejects.toThrow(/OpenAI API error 400 for \/audio\/speech/);
  });
});

describe("transcribeAudio", () => {
  const clip = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64");

  async function formEntries(init: RequestInit | undefined): Promise<Record<string, string[]>> {
    const form = init?.body as FormData;
    const out: Record<string, string[]> = {};
    for (const [key, value] of form.entries()) {
      const bucket = out[key] ?? [];
      bucket.push(value instanceof Blob ? `blob:${value.type}` : String(value));
      out[key] = bucket;
    }
    return out;
  }

  it("asks whisper-1 for verbose_json and returns the word timings", async () => {
    installFetch(() =>
      jsonResponse({
        text: "hello world",
        language: "english",
        duration: 1.5,
        words: [
          { word: "hello", start: 0, end: 0.4 },
          { word: "world", start: 0.4, end: 0.9 },
        ],
      }),
    );

    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:whisper-1`, ACCOUNT, {
      audioBase64: clip,
      mimeType: "audio/webm;codecs=opus",
      modelId: "whisper-1",
      language: "en",
    });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const entries = await formEntries(calls[0]!.init);
    expect(entries["model"]).toEqual(["whisper-1"]);
    expect(entries["response_format"]).toEqual(["verbose_json"]);
    expect(entries["language"]).toEqual(["en"]);
    expect(entries["timestamp_granularities[]"]).toEqual(["segment", "word"]);
    // The recorder's MIME type is forwarded verbatim, never transcoded.
    expect(entries["file"]).toEqual(["blob:audio/webm;codecs=opus"]);

    expect(result.text).toBe("hello world");
    expect(result.durationSeconds).toBe(1.5);
    expect(result.words).toEqual([
      { text: "hello", start: 0, end: 0.4 },
      { text: "world", start: 0.4, end: 0.9 },
    ]);
  });

  it("never asks a gpt-4o transcribe model for verbose_json", async () => {
    installFetch(() => jsonResponse({ text: "hi", usage: { type: "duration", seconds: 2 } }));

    const result = await client().transcribeAudio(
      "model",
      `${ACCOUNT}:model:gpt-4o-transcribe`,
      ACCOUNT,
      { audioBase64: clip, mimeType: "audio/mp4", modelId: "gpt-4o-transcribe" },
    );

    const entries = await formEntries(calls[0]!.init);
    expect(entries["response_format"]).toEqual(["json"]);
    expect(entries["timestamp_granularities[]"]).toBeUndefined();
    expect(result.words).toBeUndefined();
    expect(result.summary).toContain("whisper-1 is the only model");
    expect(result.durationSeconds).toBe(2);
  });

  it("uses diarized_json for the diarize model and maps segments to speakers", async () => {
    installFetch(() =>
      jsonResponse({
        task: "transcribe",
        duration: 4,
        text: "Agent: hi\nCustomer: hello",
        segments: [
          { type: "transcript.text.segment", id: "s1", start: 0, end: 2, text: "hi", speaker: "A" },
          {
            type: "transcript.text.segment",
            id: "s2",
            start: 2,
            end: 4,
            text: "hello",
            speaker: "B",
          },
        ],
      }),
    );

    const result = await client().transcribeAudio(
      "model",
      `${ACCOUNT}:model:gpt-4o-transcribe-diarize`,
      ACCOUNT,
      { audioBase64: clip, mimeType: "audio/wav", modelId: "gpt-4o-transcribe-diarize" },
    );

    const entries = await formEntries(calls[0]!.init);
    expect(entries["response_format"]).toEqual(["diarized_json"]);
    expect(result.words).toEqual([
      { text: "hi", start: 0, end: 2, speaker: "A" },
      { text: "hello", start: 2, end: 4, speaker: "B" },
    ]);
  });

  it("omits the language field when the picker is on auto-detect", async () => {
    installFetch(() => jsonResponse({ text: "hi" }));

    await client().transcribeAudio("model", `${ACCOUNT}:model:gpt-4o-transcribe`, ACCOUNT, {
      audioBase64: clip,
      mimeType: "audio/webm",
      language: "auto",
    });

    const entries = await formEntries(calls[0]!.init);
    expect(entries["language"]).toBeUndefined();
  });
});

describe("project members, service accounts and rate limits", () => {
  const projects = {
    data: [
      { id: "proj_1", name: "prod", status: "active" },
      { id: "proj_old", name: "old", status: "archived" },
    ],
    has_more: false,
  };

  it("fans project members out over live projects with project-scoped ids", async () => {
    installFetch((url) => {
      if (url.includes("/organization/projects?")) return jsonResponse(projects);
      if (url.includes("/organization/projects/proj_1/users?")) {
        return jsonResponse({
          data: [{ id: "user_1", name: "Ada", email: "ada@x.com", role: "owner", added_at: 1 }],
          has_more: false,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const [member, ...rest] = await client().listResources("project-user", ACCOUNT);
    expect(rest).toHaveLength(0);
    expect(member!.id).toBe(`${ACCOUNT}:project-user:proj_1:user_1`);
    expect(member!.parentResourceId).toBe(`${ACCOUNT}:project:proj_1`);
    expect(member!.fields["role"]).toBe("owner");
    expect(calls.some((c) => c.url.includes("proj_old/users"))).toBe(false);
  });

  it("adds a member from the picker and changes their role", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/organization/projects/proj_1"))
        return jsonResponse({ id: "proj_1", name: "prod" });
      if (init?.method === "POST") {
        return jsonResponse({ id: "user_1", email: "ada@x.com", role: "member", added_at: 1 });
      }
      return jsonResponse({ id: "user_1", email: "ada@x.com", role: "owner", added_at: 1 });
    });

    const created = await client().createResource("project-user", ACCOUNT, {
      project_id: "proj_1",
      user_id: "user_1",
      role: "member",
    });
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("https://api.openai.com/v1/organization/projects/proj_1/users");
    expect(JSON.parse(post.init?.body as string)).toEqual({ user_id: "user_1", role: "member" });
    expect(created.externalId).toBe("proj_1:user_1");

    calls = [];
    await client().updateResource("project-user", created.id, ACCOUNT, { role: "owner" });
    const update = calls.find((c) => c.init?.method === "POST")!;
    expect(update.url).toBe("https://api.openai.com/v1/organization/projects/proj_1/users/user_1");
    expect(JSON.parse(update.init?.body as string)).toEqual({ role: "owner" });
  });

  it("hides the project picker when adding from a project page", async () => {
    installFetch((url) =>
      url.includes("/organization/projects?")
        ? jsonResponse(projects)
        : jsonResponse({ data: [{ id: "user_1", email: "a@x.com" }], has_more: false }),
    );
    const config = await client().getCreateConfig("project-user", `${ACCOUNT}:project:proj_1`);
    const project = config.fields.find((f) => f.key === "project_id")!;
    expect(project.hidden).toBe(true);
    expect(project.defaultValue).toBe("proj_1");
    expect(config.fields.find((f) => f.key === "user_id")!.options).toEqual([
      { id: "user_1", label: "a@x.com", description: "a@x.com" },
    ]);
  });

  it("writes only the rate-limit fields that were filled in", async () => {
    installFetch((url) =>
      url.includes("/rate_limits/")
        ? jsonResponse({
            id: "rl_1",
            model: "gpt-5",
            max_requests_per_1_minute: 100,
            max_tokens_per_1_minute: 20000,
          })
        : jsonResponse({ id: "proj_1", name: "prod" }),
    );

    const updated = await client().updateResource(
      "project-rate-limit",
      `${ACCOUNT}:project-rate-limit:proj_1:rl_1`,
      ACCOUNT,
      {
        maxRequestsPerMinute: "100",
        maxTokensPerMinute: "20000",
        maxImagesPerMinute: "",
      },
    );
    expect(calls[0]!.url).toBe(
      "https://api.openai.com/v1/organization/projects/proj_1/rate_limits/rl_1",
    );
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      max_requests_per_1_minute: 100,
      max_tokens_per_1_minute: 20000,
    });
    expect(updated.fields["maxImagesPerMinute"]).toBe("");
  });

  it("mints another key for a service account through credential export", async () => {
    installFetch(() =>
      jsonResponse({
        id: "key_9",
        name: "infrawrench-x",
        value: "sk-svcacct-secret",
        expires_at: null,
      }),
    );
    const exported = await client().exportCredential!(
      "project-service-account",
      `${ACCOUNT}:project-service-account:proj_1:svc_1`,
      ACCOUNT,
      "service-account-api-key",
    );
    expect(calls[0]!.url).toBe(
      "https://api.openai.com/v1/organization/projects/proj_1/service_accounts/svc_1/api_keys",
    );
    expect(exported.content).toBe("sk-svcacct-secret");
  });
});

describe("spend limits and alerts", () => {
  it("lists the org limit and skips projects that answer 404", async () => {
    installFetch((url) => {
      if (url.includes("/organization/projects?")) {
        return jsonResponse({ data: [{ id: "proj_1", name: "prod", status: "active" }] });
      }
      if (url.endsWith("/organization/spend_limit")) {
        return jsonResponse({
          threshold_amount: 50000,
          currency: "USD",
          interval: "month",
          enforcement: { status: "inactive" },
        });
      }
      if (url.endsWith("/organization/projects/proj_1/spend_limit")) {
        return jsonResponse({ error: { message: "not found" } }, 404);
      }
      throw new Error(`unrouted: ${url}`);
    });

    const limits = await client().listResources("spend-limit", ACCOUNT);
    expect(limits).toHaveLength(1);
    expect(limits[0]!.id).toBe(`${ACCOUNT}:spend-limit:organization`);
    expect(limits[0]!.fields["amountUsd"]).toBe(500);
  });

  it("creates a project spend limit in cents", async () => {
    installFetch((url) =>
      url.endsWith("/spend_limit")
        ? jsonResponse({
            threshold_amount: 12345,
            interval: "month",
            enforcement: { status: "inactive" },
          })
        : jsonResponse({ id: "proj_1", name: "prod" }),
    );
    const created = await client().createResource("spend-limit", ACCOUNT, {
      scope: "proj_1",
      amount_usd: "123.45",
    });
    expect(calls[0]!.url).toBe(
      "https://api.openai.com/v1/organization/projects/proj_1/spend_limit",
    );
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      threshold_amount: 12345,
      currency: "USD",
      interval: "month",
    });
    expect(created.parentResourceId).toBe(`${ACCOUNT}:project:proj_1`);
  });

  it("creates and edits an organization spend alert with email recipients", async () => {
    installFetch(() =>
      jsonResponse({
        id: "alert_1",
        threshold_amount: 25000,
        currency: "USD",
        interval: "month",
        notification_channel: { type: "email", recipients: ["a@x.com", "b@x.com"] },
      }),
    );
    const created = await client().createResource("spend-alert", ACCOUNT, {
      scope: "organization",
      threshold_usd: "250",
      recipients: "a@x.com, b@x.com",
    });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/organization/spend_alerts");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      threshold_amount: 25000,
      currency: "USD",
      interval: "month",
      notification_channel: { type: "email", recipients: ["a@x.com", "b@x.com"] },
    });
    expect(created.externalId).toBe("organization:alert_1");

    await client().updateResource("spend-alert", created.id, ACCOUNT, {
      thresholdUsd: "300",
      recipients: "a@x.com",
      subjectPrefix: "[AI]",
    });
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/organization/spend_alerts/alert_1");
    expect(JSON.parse(calls[1]!.init?.body as string).notification_channel).toEqual({
      type: "email",
      recipients: ["a@x.com"],
      subject_prefix: "[AI]",
    });
  });

  it("refuses an alert with no recipients", async () => {
    await expect(
      client().createResource("spend-alert", ACCOUNT, {
        scope: "organization",
        threshold_usd: "1",
      }),
    ).rejects.toThrow(/at least one recipient/);
  });
});

describe("admin API keys", () => {
  it("lists and revokes admin keys", async () => {
    installFetch((_url, init) =>
      init?.method === "DELETE"
        ? jsonResponse({ id: "key_1", deleted: true })
        : jsonResponse({
            data: [
              {
                id: "key_1",
                name: "ops",
                redacted_value: "sk-admin...abcd",
                created_at: 1,
                expires_at: 1900000000,
                last_used_at: null,
                owner: { id: "user_1", name: "Ada" },
              },
            ],
            has_more: false,
          }),
    );
    const [key] = await client().listResources("admin-api-key", ACCOUNT);
    expect(key!.fields["ownerName"]).toBe("Ada");
    expect(key!.fields["expiresAt"]).toBe(new Date(1900000000 * 1000).toISOString());

    await client().deleteResource("admin-api-key", key!.id, ACCOUNT);
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/organization/admin_api_keys/key_1");
    expect(calls[1]!.init?.method).toBe("DELETE");
  });
});

describe("usage metrics", () => {
  it("filters completions usage by the bare key id for a project API key", async () => {
    installFetch(() => jsonResponse({ data: [], has_more: false }));
    await client().fetchMetricSeries(
      "project-api-key",
      `${ACCOUNT}:project-api-key:proj_1:key_1`,
      ACCOUNT,
    );
    expect(calls[0]!.url).toContain("/organization/usage/completions?");
    expect(calls[0]!.url).toContain("api_key_ids=key_1");
  });

  it("charts a project's cost alongside its token usage", async () => {
    installFetch((url) =>
      url.includes("/organization/costs")
        ? jsonResponse({
            data: [{ start_time: 1, results: [{ amount: { value: 2.5, currency: "usd" } }] }],
          })
        : jsonResponse({
            data: [
              {
                start_time: 1,
                results: [
                  {
                    input_tokens: 10,
                    input_cached_tokens: 4,
                    output_tokens: 5,
                    num_model_requests: 2,
                  },
                ],
              },
            ],
          }),
    );
    const series = await client().fetchMetricSeries(
      "project",
      `${ACCOUNT}:project:proj_1`,
      ACCOUNT,
    );
    expect(series.map((s) => s.label)).toEqual([
      "Cost",
      "Input tokens",
      "Cached input tokens",
      "Output tokens",
      "Requests",
    ]);
    expect(series[2]!.points[0]!.value).toBe(4);
  });
});
