import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GladiaClient } from "../client.js";

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

function client(): GladiaClient {
  return new GladiaClient({ apiKey: "test-gladia-key" });
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
        // Note the 200 — Gladia does not use a non-2xx code for a failed job.
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
