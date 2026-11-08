import net from "node:net";
import { hostClient } from "@infrawrench/plugin-base/effect";
import type { HostedMethods } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GladiaClient } from "../client.js";
import {
  GLADIA_LANGUAGE_OPTIONS,
  GLADIA_MODEL_OPTIONS,
  SOLARIA_3_LANGUAGE_IDS,
  undocumentedLanguageNote,
} from "../languages.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
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

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as typeof fetch);
}

function client(): HostedMethods<GladiaClient> {
  return hostClient(new GladiaClient({ apiKey: "test-gladia-key" }));
}

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? "";
}

function doneJob(id: string) {
  return {
    id,
    request_id: "req-1",
    status: "done",
    created_at: "2026-07-01T00:00:00Z",
    completed_at: "2026-07-01T00:00:20Z",
    kind: "pre-recorded",
    file: { filename: "clip.webm", audio_duration: 4.2, number_of_channels: 1 },
    request_params: { model: "solaria-1" },
    result: {
      metadata: {
        audio_duration: 4.2,
        number_of_distinct_channels: 1,
        billing_time: 4.2,
        transcription_time: 1.1,
      },
      transcription: {
        full_transcript: "Hello world.",
        languages: ["en"],
        utterances: [
          {
            start: 0,
            end: 1.5,
            text: "Hello world.",
            speaker: 0,
            confidence: 0.94,
            language: "en",
            words: [
              { word: "Hello", start: 0, end: 0.6, confidence: 0.99 },
              { word: "world.", start: 0.7, end: 1.5, confidence: 0.9 },
            ],
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  calls = [];
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("sends x-gladia-key rather than a Bearer token", async () => {
    installFetch(() => jsonResponse({ items: [], next: null }));
    await client().listResources("transcription", ACCOUNT);
    expect(headerOf(calls[0]!.init, "x-gladia-key")).toBe("test-gladia-key");
    expect(headerOf(calls[0]!.init, "Authorization")).toBe("");
  });
});

describe("listResources", () => {
  it("follows the {first,current,next,items} envelope with offset/limit", async () => {
    installFetch((url) => {
      if (url.endsWith("/v2/pre-recorded?offset=0&limit=50")) {
        return jsonResponse({
          first: "…",
          current: "…",
          next: "https://api.gladia.io/v2/pre-recorded?offset=1",
          items: [doneJob("job-1")],
        });
      }
      if (url.endsWith("/v2/pre-recorded?offset=1&limit=50")) {
        return jsonResponse({ next: null, items: [doneJob("job-2")] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const resources = await client().listResources("transcription", ACCOUNT);

    expect(resources.map((r) => r.externalId)).toEqual(["job-1", "job-2"]);
    expect(resources[0]!.fields["billingTime"]).toBe(4.2);
    expect(resources[0]!.resolvedOutputs["__transcript__"]).toBe("Hello world.");
  });

  it("sums billing_time over history for the workspace and never invents a quota", async () => {
    installFetch((url) => {
      if (url.includes("/v2/pre-recorded?offset=0")) {
        return jsonResponse({
          next: null,
          items: [doneJob("job-1"), { ...doneJob("job-2"), status: "error", error_code: 500 }],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const [workspace] = await client().listResources("workspace", ACCOUNT);

    expect(workspace!.fields["recentJobs"]).toBe(2);
    expect(workspace!.fields["doneJobs"]).toBe(1);
    expect(workspace!.fields["erroredJobs"]).toBe(1);
    expect(workspace!.fields["sampledBillingTime"]).toBe(8.4);
  });
});

describe("resolveOutput", () => {
  it("optional-chains result when the job is not done", async () => {
    installFetch(() => jsonResponse({ id: "job-1", status: "processing", result: null }));
    const text = await client().resolveOutput(
      "transcription",
      `${ACCOUNT}:transcription:job-1`,
      "fullTranscript",
      ACCOUNT,
    );
    expect(text).toBe("");
  });
});

describe("deleteResource", () => {
  it("DELETEs /v2/pre-recorded/{id} and tolerates the empty 202 body", async () => {
    installFetch(() => jsonResponse("", 202));
    await client().deleteResource("transcription", `${ACCOUNT}:transcription:job-1`, ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.gladia.io/v2/pre-recorded/job-1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});

describe("transcribeAudio", () => {
  it("uploads multipart, submits, polls, and returns words with speaker labels", async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    let polls = 0;

    installFetch((url, init) => {
      if (url.endsWith("/v2/upload")) {
        return jsonResponse({ audio_url: "https://api.gladia.io/file/abc" });
      }
      if (url.endsWith("/v2/pre-recorded") && init?.method === "POST") {
        return jsonResponse(
          { id: "job-9", result_url: "https://api.gladia.io/v2/transcription/job-9" },
          201,
        );
      }
      if (url.endsWith("/v2/pre-recorded/job-9")) {
        polls++;
        return jsonResponse(doneJob("job-9"));
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await client().transcribeAudio(
      "workspace",
      `${ACCOUNT}:workspace:default`,
      ACCOUNT,
      {
        audioBase64: Buffer.from(audio).toString("base64"),
        mimeType: "audio/webm;codecs=opus",
        fileName: "clip.webm",
        language: "en",
        modelId: "solaria-3",
      },
    );

    expect(polls).toBe(1);
    expect(result.text).toBe("Hello world.");
    expect(result.language).toBe("en");
    expect(result.durationSeconds).toBe(4.2);
    expect(result.requestId).toBe("job-9");
    expect(result.words).toEqual([
      { text: "Hello", start: 0, end: 0.6, speaker: "Speaker 0" },
      { text: "world.", start: 0.7, end: 1.5, speaker: "Speaker 0" },
    ]);

    const upload = calls.find((c) => c.url.endsWith("/v2/upload"))!;
    const contentType = headerOf(upload.init, "Content-Type");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    // The body must be real multipart bytes, not a stringified FormData, and
    // must forward the browser's own MIME type untouched.
    const body = upload.init!.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder("latin1").decode(body);
    expect(decoded).toContain('name="audio"; filename="clip.webm"');
    expect(decoded).toContain("Content-Type: audio/webm;codecs=opus");
    expect(decoded).not.toContain("[object FormData]");
    // base64 round-trips to the exact bytes the browser sent.
    expect(decoded).toContain(String.fromCharCode(1, 2, 3, 4, 5));

    const submit = calls.find(
      (c) => c.url.endsWith("/v2/pre-recorded") && c.init?.method === "POST",
    )!;
    expect(JSON.parse(submit.init!.body as string)).toEqual({
      audio_url: "https://api.gladia.io/file/abc",
      diarization: true,
      model: "solaria-3",
      language_config: { languages: ["en"], code_switching: false },
    });
  });

  it("omits language_config entirely for auto-detect, never an empty code_switching", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/v2/upload")) return jsonResponse({ audio_url: "u" });
      if (url.endsWith("/v2/pre-recorded") && init?.method === "POST") {
        return jsonResponse({ id: "job-9" }, 201);
      }
      if (url.endsWith("/v2/pre-recorded/job-9")) return jsonResponse(doneJob("job-9"));
      throw new Error(`unrouted: ${url}`);
    });

    await client().transcribeAudio("workspace", `${ACCOUNT}:workspace:default`, ACCOUNT, {
      audioBase64: Buffer.from([9]).toString("base64"),
      mimeType: "audio/mp4",
      language: "auto",
    });

    const submit = calls.find(
      (c) => c.url.endsWith("/v2/pre-recorded") && c.init?.method === "POST",
    )!;
    const body = JSON.parse(submit.init!.body as string);
    expect(body).not.toHaveProperty("language_config");
    expect(body.model).toBe("solaria-1");
  });

  it("treats an HTTP 200 with status:error as a failure", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/v2/upload")) return jsonResponse({ audio_url: "u" });
      if (url.endsWith("/v2/pre-recorded") && init?.method === "POST") {
        return jsonResponse({ id: "job-bad" }, 201);
      }
      if (url.endsWith("/v2/pre-recorded/job-bad")) {
        // Note the 200: Gladia does not use a non-2xx code for a failed job.
        return jsonResponse({ id: "job-bad", status: "error", error_code: 503, result: null }, 200);
      }
      throw new Error(`unrouted: ${url}`);
    });

    await expect(
      client().transcribeAudio("workspace", `${ACCOUNT}:workspace:default`, ACCOUNT, {
        audioBase64: Buffer.from([1]).toString("base64"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/failed \(error_code 503\)/);
  });

  it("rejects a non-workspace resource type", async () => {
    await expect(
      client().transcribeAudio("transcription", `${ACCOUNT}:transcription:x`, ACCOUNT, {
        audioBase64: "AA==",
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/cannot transcribe audio for type "transcription"/);
  });
});

describe("live sessions", () => {
  function liveSession(id: string) {
    return {
      ...doneJob(id),
      kind: "live",
      file: undefined,
      request_params: {
        model: "solaria-1",
        encoding: "wav/pcm",
        sample_rate: 16000,
        bit_depth: 16,
        channels: 1,
      },
    };
  }

  it("lists /v2/live and maps the stream format", async () => {
    installFetch(() => jsonResponse({ next: null, items: [liveSession("live-1")] }));
    const [session] = await client().listResources("live-session", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.gladia.io/v2/live?offset=0&limit=50");
    expect(session?.id).toBe(`${ACCOUNT}:live-session:live-1`);
    expect(session?.resourceTypeId).toBe("live-session");
    expect(session?.fields["streamFormat"]).toBe("wav/pcm · 16000 Hz · 16-bit · 1 ch");
    expect(session?.fields["billingTime"]).toBe(4.2);
  });

  it("reads and deletes a session on the live path", async () => {
    installFetch((url, init) =>
      init?.method === "DELETE" ? jsonResponse("", 202) : jsonResponse(liveSession("live-2")),
    );
    const resourceId = `${ACCOUNT}:live-session:live-2`;
    const session = await client().getResource("live-session", resourceId, ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.gladia.io/v2/live/live-2");
    expect(client().renderDetail(session).subtitle).toBe("Gladia live session · done");
    expect(await client().resolveOutput("live-session", resourceId, "resultUrl", ACCOUNT)).toBe(
      "https://api.gladia.io/v2/live/live-2",
    );
    await client().deleteResource("live-session", resourceId, ACCOUNT);
    expect(calls.at(-1)?.url).toBe("https://api.gladia.io/v2/live/live-2");
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
  });

  it("counts live sessions in the workspace activity", async () => {
    installFetch((url) =>
      url.includes("/v2/live")
        ? jsonResponse({ next: null, items: [liveSession("l1"), liveSession("l2")] })
        : jsonResponse({ next: null, items: [] }),
    );
    const [workspace] = await client().listResources("workspace", ACCOUNT);
    expect(workspace?.fields["liveSessions"]).toBe(2);
    expect(workspace?.fields["sampledLiveBillingTime"]).toBe(8.4);
  });
});

describe("workspace metrics", () => {
  const day = Date.UTC(2026, 8, 1);
  const range = { startMs: day, endMs: day + 2 * 86_400_000 - 1 };
  const job = (id: string, created: string, model: string, billed: number, status = "done") => ({
    id,
    status,
    created_at: created,
    request_params: { model },
    result:
      status === "done"
        ? { metadata: { audio_duration: billed, billing_time: billed, transcription_time: 6 } }
        : null,
  });

  it("buckets pre-recorded and live history by day inside the window", async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      if (url.includes("/v2/live")) {
        return jsonResponse({
          next: null,
          items: [
            {
              id: "l1",
              status: "done",
              created_at: "2026-09-02T08:00:00.000Z",
              result: { metadata: { billing_time: 600 } },
            },
          ],
        });
      }
      return jsonResponse({
        next: null,
        items: [
          job("a", "2026-09-01T10:00:00.000Z", "solaria-1", 120),
          job("b", "2026-09-01T11:00:00.000Z", "solaria-3", 60),
          job("c", "2026-09-02T10:00:00.000Z", "solaria-1", 0, "error"),
        ],
      });
    });
    const series = await client().fetchMetricSeries(
      "workspace",
      `${ACCOUNT}:workspace:default`,
      ACCOUNT,
      range,
    );
    const prerecorded = new URL(urls.find((u) => u.includes("/v2/pre-recorded"))!);
    expect(prerecorded.searchParams.get("after_date")).toBe(new Date(range.startMs).toISOString());
    expect(prerecorded.searchParams.get("before_date")).toBe(new Date(range.endMs).toISOString());
    expect(series.map((s) => s.label)).toEqual([
      "Transcriptions",
      "Failed transcriptions",
      "Billed minutes",
      "Billed minutes: solaria-1",
      "Billed minutes: solaria-3",
      "Avg processing time",
      "Live sessions",
      "Live billed minutes",
    ]);
    expect(series[0]!.points.map((p) => p.value)).toEqual([2, 1]);
    expect(series[1]!.points.map((p) => p.value)).toEqual([0, 1]);
    expect(series[2]!.points.map((p) => p.value)).toEqual([3, 0]);
    expect(series[5]!.points).toEqual([{ timestamp: day, value: 6 }]);
    expect(series[7]!.points.map((p) => p.value)).toEqual([0, 10]);
  });

  it("keeps the batch charts when the live list fails", async () => {
    installFetch((url) =>
      url.includes("/v2/live")
        ? jsonResponse({ message: "boom" }, 500)
        : jsonResponse({ next: null, items: [job("a", "2026-09-01T10:00:00Z", "solaria-1", 60)] }),
    );
    const series = await client().fetchMetricSeries(
      "workspace",
      `${ACCOUNT}:workspace:default`,
      ACCOUNT,
      range,
    );
    expect(series.map((s) => s.label)).toEqual([
      "Transcriptions",
      "Failed transcriptions",
      "Billed minutes",
      "Avg processing time",
    ]);
  });
});

describe("job lists", () => {
  /** A list that always has more: one job a page, and a next link on every one. */
  function endlessList(url: string): Response {
    const offset = new URL(url).searchParams.get("offset");
    return jsonResponse({ next: "https://api.gladia.io/more", items: [doneJob(`job-${offset}`)] });
  }

  it("reads a transcription history past the old 200-job cap", async () => {
    const total = 260;
    installFetch((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const items = Array.from({ length: Math.min(50, total - offset) }, (_, i) =>
        doneJob(`job-${offset + i}`),
      );
      const more = offset + items.length < total;
      return jsonResponse({ next: more ? "https://api.gladia.io/more" : null, items });
    });

    const resources = await client().listResources("transcription", ACCOUNT);

    expect(resources).toHaveLength(total);
    expect(calls).toHaveLength(6);
  });

  it.each(["transcription", "live-session"])(
    "rejects a %s list that never ends, after exactly 1,000 requests",
    async (typeId) => {
      installFetch(endlessList);
      await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(1000);
    },
  );

  it.each(["transcription", "live-session"])(
    "rejects a %s page with its key renamed, on the first page",
    async (typeId) => {
      installFetch(() => jsonResponse({ next: null, jobs: [doneJob("job-1")] }));
      await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
    },
  );

  it("rejects a page with its key renamed on a later page", async () => {
    installFetch((url) =>
      url.includes("offset=0")
        ? jsonResponse({ next: "https://api.gladia.io/more", items: [doneJob("job-1")] })
        : jsonResponse({ next: null, jobs: [doneJob("job-2")] }),
    );
    await expect(client().listResources("transcription", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads items set to null as an empty list", async () => {
    installFetch(() => jsonResponse({ next: null, items: null }));
    expect(await client().listResources("transcription", ACCOUNT)).toEqual([]);
  });

  it("stays on the host's HTTP service, and sends no CA it was not given", async () => {
    const stub = installFetch(() => {
      throw new Error("the plugin's own fetch must not run");
    });
    const request = vi.fn(async (_req: { caCert?: string }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ next: null, items: [doneJob("job-1")] }),
    }));
    const hosted = hostClient(
      new GladiaClient({ apiKey: "test-gladia-key" }, { http: { request } }),
    );

    await hosted.listResources("transcription", ACCOUNT);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("workspace sample", () => {
  it("sums a sample of 200 jobs a list and does not fail a longer history", async () => {
    installFetch((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const items = Array.from({ length: 50 }, (_, i) => doneJob(`job-${offset + i}`));
      return jsonResponse({ next: "https://api.gladia.io/more", items });
    });

    const [workspace] = await client().listResources("workspace", ACCOUNT);

    expect(workspace!.fields["recentJobs"]).toBe(200);
    expect(workspace!.fields["liveSessions"]).toBe(200);
    expect(calls).toHaveLength(8);
  });

  it.each(["/v2/pre-recorded", "/v2/live"])(
    "does not read a renamed key on %s as no jobs",
    async (path) => {
      installFetch((url) =>
        url.includes(path)
          ? jsonResponse({ next: null, jobs: [doneJob("job-1")] })
          : jsonResponse({ next: null, items: [] }),
      );
      await expect(client().listResources("workspace", ACCOUNT)).rejects.toThrow("is not a list");
    },
  );

  it("stays navigable when a list fails outright", async () => {
    installFetch(() => jsonResponse({ message: "boom" }, 500));
    const [workspace] = await client().listResources("workspace", ACCOUNT);
    expect(workspace!.fields["recentJobs"]).toBe(0);
    expect(workspace!.fields["liveSessions"]).toBe(0);
  });
});

describe("workspace metrics window", () => {
  const range = { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 2) };
  const metrics = () =>
    client().fetchMetricSeries("workspace", `${ACCOUNT}:workspace:default`, ACCOUNT, range);

  it("charts what 20 pages hold rather than failing a busy window", async () => {
    installFetch((url) =>
      jsonResponse({
        next: "https://api.gladia.io/more",
        items: url.includes("/v2/live") ? [] : [doneJob("job-1")],
      }),
    );
    const series = await metrics();
    expect(series.map((s) => s.label)).toContain("Transcriptions");
    expect(calls.filter((c) => c.url.includes("/v2/pre-recorded"))).toHaveLength(20);
  });

  it.each(["/v2/pre-recorded", "/v2/live"])(
    "does not read a renamed key on %s as no jobs",
    async (path) => {
      installFetch((url) =>
        url.includes(path)
          ? jsonResponse({ next: null, jobs: [doneJob("job-1")] })
          : jsonResponse({ next: null, items: [] }),
      );
      await expect(metrics()).rejects.toThrow("is not a list");
    },
  );
});

describe("deleteResource with no id", () => {
  it.each(["transcription", "live-session"])("refuses a blank %s id", async (typeId) => {
    installFetch(() => {
      throw new Error("no request should be sent");
    });
    await expect(client().deleteResource(typeId, `${ACCOUNT}:${typeId}:`, ACCOUNT)).rejects.toThrow(
      "no job id",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("Speech panel options", () => {
  it("says which languages Solaria-3 is documented to take", () => {
    const solaria3 = GLADIA_MODEL_OPTIONS.find((model) => model.id === "solaria-3");
    for (const language of ["English", "French", "German", "Spanish", "Italian"]) {
      expect(solaria3?.description).toContain(language);
    }
    expect(solaria3?.description).toMatch(/one language/i);
  });

  it("narrows the picker to the five Solaria-3 languages, auto-detect excluded", () => {
    const solaria3 = GLADIA_MODEL_OPTIONS.find((model) => model.id === "solaria-3");
    expect(solaria3?.languageIds).toEqual(["en", "fr", "de", "it", "es"]);
    expect(solaria3?.languageIds).toBe(SOLARIA_3_LANGUAGE_IDS);
    const offered = new Set(GLADIA_LANGUAGE_OPTIONS.map((option) => option.id));
    for (const id of SOLARIA_3_LANGUAGE_IDS) expect(offered.has(id)).toBe(true);
    expect(solaria3?.languageIds).not.toContain("auto");
    for (const id of ["solaria-1", "solaria-fusion"]) {
      expect(GLADIA_MODEL_OPTIONS.find((model) => model.id === id)?.languageIds).toBeUndefined();
    }
  });

  it("says auto-detect is not documented for Solaria-3", () => {
    const auto = GLADIA_LANGUAGE_OPTIONS.find((option) => option.id === "auto");
    expect(auto?.description).toContain("Solaria-3");
  });
});

describe("Solaria-3 outside its documented languages", () => {
  const REFUSAL =
    /Solaria-3 transcribes one named language, English \(en\), French \(fr\), German \(de\), Italian \(it\) or Spanish \(es\).*Solaria-1/;

  // Nothing here may reach a network: fetch throws on anything not routed,
  // and a raw socket connect throws outright.
  beforeEach(() => {
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("tests must not open sockets");
    });
  });

  function transcribe(modelId: string, language: string | undefined) {
    return client().transcribeAudio("workspace", `${ACCOUNT}:workspace:default`, ACCOUNT, {
      audioBase64: Buffer.from([1]).toString("base64"),
      mimeType: "audio/wav",
      modelId,
      ...(language !== undefined ? { language } : {}),
    });
  }

  /** Answers the submit with `submit`, and any job read with `job`. */
  function installGladia(submit: Response, job: unknown = doneJob("job-1")) {
    installFetch((url, init) => {
      if (url.endsWith("/v2/upload")) return jsonResponse({ audio_url: "u" });
      if (url.endsWith("/v2/pre-recorded") && init?.method === "POST") return submit;
      if (url.endsWith("/v2/pre-recorded/job-1")) return jsonResponse(job);
      throw new Error(`unrouted: ${url}`);
    });
  }

  it.each([
    ["ja", /does not support language "ja"/],
    ["auto", /does not support auto-detect/],
    ["", /does not support auto-detect/],
    [undefined, /does not support auto-detect/],
  ])("refuses %j before uploading anything", async (language, asked) => {
    installFetch((url) => {
      throw new Error(`no request should be sent: ${url}`);
    });
    const failure = transcribe("solaria-3", language);
    await expect(failure).rejects.toThrow(REFUSAL);
    await expect(failure).rejects.toThrow(asked);
    expect(calls).toHaveLength(0);
  });

  it("refuses before decoding the clip, so even an empty payload gets the language message", async () => {
    installFetch((url) => {
      throw new Error(`no request should be sent: ${url}`);
    });
    await expect(
      client().transcribeAudio("workspace", `${ACCOUNT}:workspace:default`, ACCOUNT, {
        audioBase64: "",
        mimeType: "audio/wav",
        modelId: "solaria-3",
        language: "ja",
      }),
    ).rejects.toThrow(REFUSAL);
    expect(calls).toHaveLength(0);
  });

  it.each(["en", "fr", "de", "it", "es"])("sends Solaria-3 with %s", async (language) => {
    installGladia(jsonResponse({ id: "job-1" }, 201));
    const result = await transcribe("solaria-3", language);
    const submit = calls.find(
      (c) => c.url.endsWith("/v2/pre-recorded") && c.init?.method === "POST",
    )!;
    expect(JSON.parse(submit.init!.body as string).language_config).toEqual({
      languages: [language],
      code_switching: false,
    });
    expect(result.summary).not.toMatch(/documents Solaria-3/);
  });

  it("leaves other models alone, auto-detect and any language included", async () => {
    installGladia(jsonResponse({ id: "job-1" }, 201));
    await expect(transcribe("solaria-1", "ja")).resolves.toBeDefined();
    await expect(transcribe("solaria-1", "auto")).resolves.toBeDefined();
    await expect(transcribe("solaria-fusion", "ja")).resolves.toBeDefined();
    // No model means Gladia's default, Solaria-1.
    await expect(transcribe("", "auto")).resolves.toBeDefined();
  });

  it("does not blame the language when a documented pair fails", async () => {
    installGladia(jsonResponse({ message: "bad" }, 422));
    await expect(transcribe("solaria-3", "fr")).rejects.not.toThrow(REFUSAL);
    await expect(transcribe("solaria-3", "fr")).rejects.not.toThrow(/documents Solaria-3/);
  });
});

describe("Solaria-3 post-submit note", () => {
  // Unreachable through transcribeAudio while the refusal above stands; kept
  // for the case #679 describes, where a live call shows Gladia accepts a pair.
  const NOTE = /documents Solaria-3 for one named language.*Solaria-1/;

  it("explains an undocumented pair", () => {
    expect(undocumentedLanguageNote("solaria-3", "ja")).toMatch(NOTE);
    expect(undocumentedLanguageNote("solaria-3", "auto")).toMatch(NOTE);
    expect(undocumentedLanguageNote("solaria-3", undefined)).toMatch(NOTE);
  });

  it("stays quiet for a documented language or another model", () => {
    expect(undocumentedLanguageNote("solaria-3", "fr")).toBeUndefined();
    expect(undocumentedLanguageNote("solaria-1", "ja")).toBeUndefined();
  });
});
