import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechmaticsClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function response(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => text,
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
}

function client(overrides: Record<string, string> = {}) {
  return new SpeechmaticsClient({ apiKey: "sm-key", region: "eu1", ...overrides });
}

function authHeader(init?: RequestInit): string {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
}

function bodyBytes(init?: RequestInit): Uint8Array {
  return init?.body as unknown as Uint8Array;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("construction", () => {
  it("rejects an unknown region rather than building a bad host", () => {
    expect(() => new SpeechmaticsClient({ apiKey: "k", region: "uk1" })).toThrow(/unknown region/);
  });

  it("defaults to eu1 and builds the regional base URL", async () => {
    installFetch(() => response({ jobs: [] }));
    await client({ region: "au1" }).listResources("job", ACCOUNT);
    expect(calls[0]?.url).toContain("https://au1.asr.api.speechmatics.com/v2/jobs");
  });
});

describe("listResources — job", () => {
  it("pages with limit and the created_before cursor and sends a bearer token", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `job-${i}`,
      status: "done",
      created_at: `2026-07-${String(28 - Math.floor(i / 50)).padStart(2, "0")}T10:00:00.000Z`,
      data_name: `clip-${i}.wav`,
    }));
    installFetch((url) => {
      if (url.includes("created_before=")) return response({ jobs: [] });
      return response({ jobs: page1 });
    });

    const resources = await client().listResources("job", ACCOUNT);

    expect(resources).toHaveLength(100);
    expect(calls[0]?.url).toContain("limit=100");
    expect(authHeader(calls[0]?.init)).toBe("Bearer sm-key");
    expect(calls[1]?.url).toContain("created_before=2026-07-27T10%3A00%3A00.000Z");
    expect(resources[0]?.id).toBe(`${ACCOUNT}:job:job-0`);
    expect(resources[0]?.resolvedOutputs["transcriptUrl"]).toBe(
      "https://eu1.asr.api.speechmatics.com/v2/jobs/job-0/transcript?format=txt",
    );
  });

  it("reads the deprecated operating_point when a job has no model", async () => {
    installFetch(() =>
      response({
        jobs: [
          {
            id: "old-job",
            status: "done",
            created_at: "2026-01-01T00:00:00Z",
            data_name: "old.wav",
            config: {
              type: "transcription",
              transcription_config: { operating_point: "standard" },
            },
          },
        ],
      }),
    );
    const [resource] = await client().listResources("job", ACCOUNT);
    expect(resource?.fields["model"]).toBe("standard");
  });
});

describe("account (the singleton that hosts the Speech tab)", () => {
  const discovery = {
    metadata: { language_pack_info: { en: { language_description: "English" } } },
    batch: { transcription: [{ version: "latest", languages: ["en"] }] },
  };

  it("returns exactly one account, with a Speech tab, when the account has zero jobs", async () => {
    // The regression: Speechmatics purges jobs after 7 days, so a week-idle
    // account has nothing to open and the Speech tab has to live elsewhere.
    installFetch((url) => {
      if (url.includes("/v1/discovery/features")) return response(discovery);
      if (url.includes("/v2/usage")) return response({ summary: [], details: [] });
      return response({ jobs: [] });
    });
    const c = client();

    expect(await c.listResources("job", ACCOUNT)).toEqual([]);
    const resources = await c.listResources("account", ACCOUNT);

    expect(resources).toHaveLength(1);
    const account = resources[0]!;
    expect(account.id).toBe(`${ACCOUNT}:account:default`);
    expect(c.renderDetail(account).speechPanel?.modes).toEqual(["stt"]);
    expect(c.renderDetail(account).speechPanel?.languages?.map((l) => l.id)).toEqual([
      "en",
      "multi",
    ]);
  });

  it("still renders — Speech tab included — when discovery and usage both fail", async () => {
    installFetch(() => response("nope", 503));
    const c = client();
    const [account] = await c.listResources("account", ACCOUNT);
    const detail = c.renderDetail(account!);

    expect(detail.speechPanel).toBeDefined();
    // Falls back to the built-in language list rather than an empty picker.
    expect(detail.speechPanel?.languages?.some((l) => l.id === "en")).toBe(true);
    expect(account!.fields["usageHours"]).toBe(0);
    // …but it must not claim to be healthy. A revoked key reaches exactly this
    // path, and a green dot over zeroed usage is indistinguishable from a valid
    // key that has simply never transcribed anything.
    expect(detail.status?.status).toBe("error");
  });

  it("reports a healthy account when the authenticated usage call succeeds", async () => {
    installFetch((url) =>
      url.includes("/usage") ? response({ summary: [] }) : response({ language_packs: [] }),
    );
    const c = client();
    const [account] = await c.listResources("account", ACCOUNT);
    expect(c.renderDetail(account!).status?.status).toBe("healthy");
  });

  it("summarises GET /v2/usage over a 30-day window and stashes the breakdown", async () => {
    installFetch((url) => {
      if (url.includes("/v1/discovery/features")) return response(discovery);
      return response({
        since: "2026-06-29",
        until: "2026-07-28",
        summary: [
          { mode: "batch", type: "transcription", model: "enhanced", count: 3, duration_hrs: 1.25 },
          {
            mode: "batch",
            type: "transcription",
            operating_point: "standard",
            count: 1,
            duration_hrs: 0.5,
          },
        ],
      });
    });

    const [account] = await client().listResources("account", ACCOUNT);
    const usageCall = calls.find((c) => c.url.includes("/v2/usage"))!;
    expect(usageCall.url).toMatch(/\/v2\/usage\?since=\d{4}-\d{2}-\d{2}&until=\d{4}-\d{2}-\d{2}$/);

    expect(account!.fields["usageHours"]).toBe(1.75);
    expect(account!.fields["usageJobs"]).toBe(4);

    const flat = JSON.stringify(client().renderDetail(account!).sections);
    expect(flat).toContain("2026-06-29 → 2026-07-28");
    // Both spellings of the breakdown key make it into a row label.
    expect(flat).toContain("batch · transcription · enhanced");
    expect(flat).toContain("batch · transcription · standard");
  });

  it("says whether the management token is configured", async () => {
    installFetch(() => response({}));
    const [without] = await client().listResources("account", ACCOUNT);
    const [with_] = await client({ managementToken: "mgmt" }).listResources("account", ACCOUNT);

    expect(JSON.stringify(client().renderDetail(without!).sections)).toContain("Not configured");
    expect(JSON.stringify(client().renderDetail(with_!).sections)).toContain("Configured");
  });

  it("derives account outputs without a round trip", async () => {
    const spy = installFetch(() => response({}));
    const c = client({ region: "us1" });
    expect(await c.resolveOutput("account", `${ACCOUNT}:account:default`, "region", ACCOUNT)).toBe(
      "us1",
    );
    expect(
      await c.resolveOutput("account", `${ACCOUNT}:account:default`, "endpoint", ACCOUNT),
    ).toBe("https://us1.asr.api.speechmatics.com/v2");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("management API", () => {
  it("stays empty rather than erroring when no management token is configured", async () => {
    const spy = installFetch(() => response([]));
    expect(await client().listResources("project", ACCOUNT)).toEqual([]);
    expect(await client().listResources("api-key", ACCOUNT)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("hits mp.api.speechmatics.com with the management token", async () => {
    installFetch((url) => {
      if (url.endsWith("/projects")) {
        return response([{ project_id: 42, name: "Prod", is_default: true, is_active: true }]);
      }
      return response([{ apikey_id: "ak_1", name: "ci", created_at: "2026-05-01T00:00:00Z" }]);
    });
    const c = client({ managementToken: "mgmt-token" });

    const [project] = await c.listResources("project", ACCOUNT);
    const [key] = await c.listResources("api-key", ACCOUNT);

    expect(calls[0]?.url).toBe("https://mp.api.speechmatics.com/v1/projects");
    expect(authHeader(calls[0]?.init)).toBe("Bearer mgmt-token");
    expect(calls[1]?.url).toBe("https://mp.api.speechmatics.com/v1/api-keys");
    expect(project?.fields["projectId"]).toBe("42");
    expect(key?.fields["apiKeyId"]).toBe("ak_1");
  });
});

describe("deleteResource", () => {
  it("force-deletes a job so a running one is not left locked", async () => {
    installFetch(() => response({}, 200));
    await client().deleteResource("job", `${ACCOUNT}:job:a1b2c3`, ACCOUNT);
    expect(calls[0]?.url).toBe("https://eu1.asr.api.speechmatics.com/v2/jobs/a1b2c3?force=true");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("deletes an API key through the management host", async () => {
    installFetch(() => response({}, 200));
    await client({ managementToken: "mgmt-token" }).deleteResource(
      "api-key",
      `${ACCOUNT}:api-key:ak_1`,
      ACCOUNT,
    );
    expect(calls[0]?.url).toBe("https://mp.api.speechmatics.com/v1/api-keys/ak_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("transcribeAudio", () => {
  const audio = "hello-speechmatics-audio";
  const audioBase64 = Buffer.from(audio).toString("base64");

  function multipartText(init?: RequestInit): string {
    return new TextDecoder().decode(bodyBytes(init));
  }

  it("submits multipart config + data_file and reads the embedded txt transcript", async () => {
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) {
        return response({ id: "job-1", status: "done", txt: "Hello world.\n" });
      }
      if (url.includes("format=json-v2")) {
        return response({
          job: { id: "job-1", duration: 12 },
          metadata: { transcription_config: { language: "en", model: "enhanced" } },
          results: [
            {
              type: "word",
              start_time: 0.55,
              end_time: 1.2,
              alternatives: [{ content: "Hello", confidence: 0.9, speaker: "S1" }],
            },
            {
              type: "punctuation",
              start_time: 1.2,
              end_time: 1.2,
              alternatives: [{ content: ".", confidence: 1 }],
            },
            {
              type: "word",
              start_time: 1.45,
              end_time: 1.8,
              alternatives: [{ content: "world", confidence: 0.8, speaker: "S1" }],
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm;codecs=opus",
      fileName: "clip.webm",
      language: "en",
      modelId: "enhanced",
    });

    // One-call sync path: wait + format are query params.
    expect(calls[0]?.url).toBe("https://eu1.asr.api.speechmatics.com/v2/jobs?wait=60&format=txt");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=----infrawrench/);
    expect(headers["Authorization"]).toBe("Bearer sm-key");

    const body = multipartText(calls[0]?.init);
    expect(body).toContain('name="config"');
    expect(body).toContain(
      '{"type":"transcription","transcription_config":{"language":"en","model":"enhanced"}}',
    );
    expect(body).toContain('name="data_file"; filename="clip.webm"');
    // The recorder's MIME type is forwarded verbatim rather than assumed.
    expect(body).toContain("Content-Type: audio/webm;codecs=opus");
    // base64 round-trips to the original bytes.
    expect(body).toContain(audio);

    expect(result.text).toBe("Hello world.");
    expect(result.requestId).toBe("job-1");
    expect(result.durationSeconds).toBe(12);
    expect(result.words).toEqual([
      { text: "Hello", start: 0.55, end: 1.2, speaker: "S1" },
      { text: "world", start: 1.45, end: 1.8, speaker: "S1" },
    ]);
    expect(result.confidence).toBeCloseTo(0.85, 4);
    expect(result.summary).toContain("job job-1");
    expect(result.summary).toContain("eu1 region");
  });

  it("forces language=multi when melia-1 is selected", async () => {
    installFetch(() => response({ id: "job-2", status: "done", txt: "bonjour" }));
    await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      language: "fr",
      modelId: "melia-1",
    });
    expect(multipartText(calls[0]?.init)).toContain(
      '{"type":"transcription","transcription_config":{"language":"multi","model":"melia-1"}}',
    );
  });

  it("never surfaces the echoed request as the detected language", async () => {
    // `metadata.transcription_config.language` is the value the job was
    // *submitted* with. For melia-1 that is always the literal "multi", which
    // is an instruction to the recogniser and not a language anyone speaks.
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) {
        return response({ id: "job-m", status: "done", txt: "bonjour hello" });
      }
      return response({
        job: { id: "job-m", duration: 3 },
        metadata: { transcription_config: { language: "multi", model: "melia-1" } },
        results: [
          { type: "word", start_time: 0, end_time: 0.4, alternatives: [{ content: "bonjour" }] },
        ],
      });
    });

    const result = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      language: "fr",
      modelId: "melia-1",
    });

    expect(result.language).toBeUndefined();
    expect("language" in result).toBe(false);
    expect(result.summary).toContain("language not identified");
    expect(result.summary).not.toContain("multi");
  });

  it("reads the real language-identification block when the job ran language-ID", async () => {
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) {
        return response({ id: "job-lid", status: "done", txt: "hola" });
      }
      return response({
        job: { id: "job-lid", duration: 6 },
        metadata: {
          transcription_config: { language: "auto", model: "enhanced" },
          language_identification: {
            results: [
              {
                start_time: 0,
                end_time: 3,
                alternatives: [
                  { language: "es", confidence: 0.91 },
                  { language: "pt", confidence: 0.09 },
                ],
              },
              {
                start_time: 3,
                end_time: 6,
                alternatives: [{ language: "es", confidence: 0.88 }],
              },
            ],
          },
        },
        results: [],
      });
    });

    const result = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      language: "auto",
    });

    expect(result.language).toBe("es");
    expect(result.summary).toContain("language es");
  });

  it("ignores a failed language-identification and reports nothing detected", async () => {
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) return response({ id: "job-lidx", status: "done", txt: "" });
      return response({
        job: { id: "job-lidx" },
        metadata: {
          transcription_config: { language: "auto" },
          language_identification: { error: "LOW_CONFIDENCE", message: "not confident enough" },
        },
        results: [],
      });
    });

    const result = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      language: "auto",
    });

    expect(result.language).toBeUndefined();
    expect(result.summary).not.toContain("language auto");
  });

  it("falls back to the per-word language, but only when every word agrees", async () => {
    function withWordLanguages(languages: string[]) {
      return (url: string) => {
        if (url.includes("/jobs?wait=")) {
          return response({ id: "job-w", status: "done", txt: "words" });
        }
        return response({
          job: { id: "job-w" },
          metadata: { transcription_config: { language: "multi", model: "melia-1" } },
          results: languages.map((language, i) => ({
            type: "word",
            start_time: i,
            end_time: i + 0.5,
            alternatives: [{ content: `w${i}`, confidence: 0.9, language }],
          })),
        });
      };
    }

    installFetch(withWordLanguages(["de", "de", "de"]));
    const unanimous = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      modelId: "melia-1",
    });
    expect(unanimous.language).toBe("de");

    // A genuinely code-switched clip has no single language; blank beats
    // picking whichever one happened to have more words.
    calls = [];
    installFetch(withWordLanguages(["de", "en", "de"]));
    const mixed = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      modelId: "melia-1",
    });
    expect(mixed.language).toBeUndefined();
  });

  it("falls back to polling and ?format=txt when the transcript is not embedded", async () => {
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) return response({ id: "job-3", status: "created" });
      if (url.endsWith("/jobs/job-3")) return response({ job: { id: "job-3", status: "done" } });
      if (url.includes("format=txt")) return response("Polled transcript.");
      if (url.includes("format=json-v2")) return response({}, 500);
      throw new Error(`unexpected url ${url}`);
    });

    const result = await client().transcribeAudio("job", "res", ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
    });

    expect(calls.map((c) => c.url)).toEqual([
      "https://eu1.asr.api.speechmatics.com/v2/jobs?wait=60&format=txt",
      "https://eu1.asr.api.speechmatics.com/v2/jobs/job-3",
      "https://eu1.asr.api.speechmatics.com/v2/jobs/job-3/transcript?format=txt",
      "https://eu1.asr.api.speechmatics.com/v2/jobs/job-3/transcript?format=json-v2",
    ]);
    expect(result.text).toBe("Polled transcript.");
    expect(result.words).toBeUndefined();
  });

  it("surfaces a rejected job instead of returning an empty transcript", async () => {
    installFetch(() => response({ id: "job-4", status: "rejected" }));
    await expect(
      client().transcribeAudio("job", "res", ACCOUNT, { audioBase64, mimeType: "audio/wav" }),
    ).rejects.toThrow(/rejected/);
  });

  it("accepts the account singleton, which is where the tab lives once jobs expire", async () => {
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) return response({ id: "job-6", status: "done", txt: "hi" });
      return response({}, 500);
    });
    const result = await client().transcribeAudio(
      "account",
      `${ACCOUNT}:account:default`,
      ACCOUNT,
      { audioBase64, mimeType: "audio/wav" },
    );
    expect(result.text).toBe("hi");
  });

  it("rejects a type that does not carry the panel", async () => {
    await expect(
      client().transcribeAudio("project", "res", ACCOUNT, { audioBase64, mimeType: "audio/wav" }),
    ).rejects.toThrow(/not supported for type/);
  });

  it("surfaces an expired job from the async status enum", async () => {
    installFetch((url) => {
      if (url.includes("/jobs?wait=")) return response({ id: "job-5" });
      return response({ job: { id: "job-5", status: "expired" } });
    });
    await expect(
      client().transcribeAudio("job", "res", ACCOUNT, { audioBase64, mimeType: "audio/wav" }),
    ).rejects.toThrow(/no longer available/);
  });
});

describe("getResource — job", () => {
  it("stashes condensed discovery data for the synchronous renderer", async () => {
    installFetch((url) => {
      if (url.includes("/v1/discovery/features")) {
        return response({
          metadata: {
            language_pack_info: {
              en: { language_description: "English" },
              cy: { language_description: "Welsh" },
            },
          },
          batch: { transcription: [{ version: "latest", languages: ["en", "cy"] }] },
        });
      }
      return response({
        job: {
          id: "job-9",
          status: "done",
          created_at: "2026-07-01T00:00:00Z",
          data_name: "a.wav",
          duration: 30,
        },
      });
    });

    const resource = await client().getResource("job", `${ACCOUNT}:job:job-9`, ACCOUNT);
    const stash = JSON.parse(resource.resolvedOutputs["__discovery__"] ?? "{}") as {
      languages: Array<{ id: string }>;
    };

    expect(
      calls.some((c) => c.url === "https://eu1.asr.api.speechmatics.com/v1/discovery/features"),
    ).toBe(true);
    expect(stash.languages.map((l) => l.id)).toEqual(["en", "cy", "multi"]);

    const panel = client().renderDetail(resource).speechPanel;
    expect(panel?.languages?.map((l) => l.id)).toEqual(["en", "cy", "multi"]);
  });

  it("still renders when discovery is unreachable", async () => {
    installFetch((url) => {
      if (url.includes("/v1/discovery/features")) return response("nope", 503);
      return response({ job: { id: "job-9", status: "done", created_at: "2026-07-01T00:00:00Z" } });
    });
    const resource = await client().getResource("job", `${ACCOUNT}:job:job-9`, ACCOUNT);
    const panel = client().renderDetail(resource).speechPanel;
    expect(panel?.languages?.some((l) => l.id === "en")).toBe(true);
  });
});

describe("fetchMetricSeries", () => {
  it("buckets GET /v2/usage across the range and reads both model spellings", async () => {
    installFetch((url) => {
      expect(url).toContain("/v2/usage?since=");
      return response({
        summary: [{ mode: "batch", type: "transcription", count: 2, duration_hrs: 0.5 }],
        details: [
          { mode: "batch", type: "transcription", language: "en", model: "enhanced", count: 1 },
          {
            mode: "batch",
            type: "transcription",
            language: "de",
            operating_point: "standard",
            count: 1,
          },
        ],
      });
    });

    const endMs = Date.parse("2026-07-28T00:00:00Z");
    const series = await client().fetchMetricSeries("job", "res", ACCOUNT, {
      startMs: endMs - 5 * 86_400_000,
      endMs,
    });

    expect(calls).toHaveLength(5);
    expect(calls[0]?.url).toContain("since=2026-07-23&until=2026-07-23");
    expect(series.map((s) => s.label)).toEqual(["Transcription hours", "Billable jobs"]);
    expect(series[0]?.points).toHaveLength(5);
    expect(series[0]?.points[0]?.value).toBe(0.5);
    expect(series[1]?.points[0]?.value).toBe(2);
  });

  it("returns nothing for types that have no usage dimension", async () => {
    const spy = installFetch(() => response({}));
    expect(await client().fetchMetricSeries("project", "res", ACCOUNT)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("resolveOutput", () => {
  it("derives job outputs without a round trip", async () => {
    const spy = installFetch(() => response({}));
    const c = client({ region: "us1" });
    expect(await c.resolveOutput("job", `${ACCOUNT}:job:xyz`, "jobId", ACCOUNT)).toBe("xyz");
    expect(await c.resolveOutput("job", `${ACCOUNT}:job:xyz`, "region", ACCOUNT)).toBe("us1");
    expect(await c.resolveOutput("job", `${ACCOUNT}:job:xyz`, "transcriptUrl", ACCOUNT)).toBe(
      "https://us1.asr.api.speechmatics.com/v2/jobs/xyz/transcript?format=txt",
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
