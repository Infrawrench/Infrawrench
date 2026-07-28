import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevAiClient } from "../client.js";

const ACCOUNT = "acct-1";
const US = "https://api.rev.ai/speechtotext/v1";
const EU = "https://ec1.api.rev.ai/speechtotext/v1";

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

function client(region = "us"): RevAiClient {
  return new RevAiClient({ accessToken: "test-revai-access-token", region });
}

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? "";
}

const TRANSCRIPT = {
  monologues: [
    {
      speaker: 1,
      elements: [
        { type: "text", value: "Hello", ts: 0.5, end_ts: 1.5, confidence: 1 },
        { type: "punct", value: " " },
        { type: "text", value: "World", ts: 1.75, end_ts: 2.85, confidence: 0.8 },
        { type: "punct", value: "." },
      ],
    },
  ],
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth and region", () => {
  it("sends a Bearer token against the US host by default", async () => {
    installFetch(() => jsonResponse([]));
    await client().listResources("job", ACCOUNT);
    expect(calls[0]!.url.startsWith(US)).toBe(true);
    expect(headerOf(calls[0]!.init, "Authorization")).toBe("Bearer test-revai-access-token");
  });

  it("uses the EU host when the account picked that deployment", async () => {
    installFetch(() => jsonResponse([]));
    await client("eu").listResources("job", ACCOUNT);
    expect(calls[0]!.url.startsWith(EU)).toBe(true);
  });

  it("reports no vocabularies on the EU deployment rather than calling a missing route", async () => {
    installFetch(() => {
      throw new Error("should not be called");
    });
    expect(await client("eu").listResources("vocabulary", ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("listResources", () => {
  it("reads the bare JSON array /jobs returns and tolerates omitted null fields", async () => {
    installFetch((url) => {
      if (url === `${US}/jobs?limit=100`) {
        // Rev AI omits null properties entirely — `name`, `duration_seconds`
        // and `completed_on` are simply absent on an in-progress job.
        return jsonResponse([
          { id: "job-1", status: "in_progress", type: "async", created_on: "2026-07-01T00:00:00Z" },
        ]);
      }
      throw new Error(`unrouted: ${url}`);
    });

    const jobs = await client().listResources("job", ACCOUNT);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.externalId).toBe("job-1");
    expect(jobs[0]!.displayName).toBe("job-1");
    expect(jobs[0]!.fields["durationSeconds"]).toBe(0);
    expect(jobs[0]!.fields["completedOn"]).toBe("");
  });

  it("wires the USD balances into the account resource", async () => {
    installFetch((url) => {
      if (url === `${US}/account`) {
        return jsonResponse({
          email: "dev@example.com",
          free_balance: 5.5,
          purchased_balance: 20,
          total_balance: 25.5,
          invoiced_balance: 0,
          balance_seconds: 0,
          hipaa_enabled: false,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const [account] = await client().listResources("account", ACCOUNT);

    expect(account!.fields["totalBalance"]).toBe(25.5);
    expect(account!.fields["freeBalance"]).toBe(5.5);
    expect(account!.fields).not.toHaveProperty("balanceSeconds");
  });
});

describe("fetchDashboardStats", () => {
  it("reports the USD balances for the account", async () => {
    installFetch(() =>
      jsonResponse({ free_balance: 0, purchased_balance: 12.25, total_balance: 12.25 }),
    );
    const stats = await client().fetchDashboardStats("account", `${ACCOUNT}:account:self`, ACCOUNT);
    expect(stats).toEqual([
      { label: "Total balance", value: "$12.25", variant: "status-healthy" },
      { label: "Free", value: "$0.00" },
      { label: "Purchased", value: "$12.25" },
    ]);
  });
});

describe("getResource", () => {
  it("fetches the transcript with an explicit Accept and stashes it for renderDetail", async () => {
    installFetch((url) => {
      if (url === `${US}/jobs/job-1`) {
        return jsonResponse({ id: "job-1", status: "transcribed", duration_seconds: 3 });
      }
      if (url === `${US}/jobs/job-1/transcript`) return jsonResponse(TRANSCRIPT);
      throw new Error(`unrouted: ${url}`);
    });

    const resource = await client().getResource("job", `${ACCOUNT}:job:job-1`, ACCOUNT);

    expect(resource.resolvedOutputs["__transcript__"]).toBe("Hello World.");
    const transcriptCall = calls.find((call) => call.url.endsWith("/transcript"))!;
    expect(headerOf(transcriptCall.init, "Accept")).toBe(
      "application/vnd.rev.transcript.v1.0+json",
    );
  });
});

describe("createResource", () => {
  it("posts phrases under custom_vocabularies", async () => {
    installFetch((url, init) => {
      if (url === `${US}/vocabularies` && init?.method === "POST") {
        return jsonResponse({ id: "cv-1", status: "in_progress", metadata: "names" });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const created = await client().createResource("vocabulary", ACCOUNT, {
      phrases: "Amelia Earhart, Paul McCartney",
      metadata: "names",
    });

    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      custom_vocabularies: [{ phrases: ["Amelia Earhart", "Paul McCartney"] }],
      metadata: "names",
    });
    expect(created.externalId).toBe("cv-1");
  });
});

describe("deleteResource", () => {
  it("deletes jobs and vocabularies and tolerates the empty 204 body", async () => {
    installFetch(() => jsonResponse("", 204));
    const c = client();
    await c.deleteResource("job", `${ACCOUNT}:job:job-1`, ACCOUNT);
    await c.deleteResource("vocabulary", `${ACCOUNT}:vocabulary:cv-1`, ACCOUNT);
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      `DELETE ${US}/jobs/job-1`,
      `DELETE ${US}/vocabularies/cv-1`,
    ]);
  });

  it("explains a 409 as an invalid job state", async () => {
    installFetch(() => jsonResponse({ title: "Job is in invalid state" }, 409));
    await expect(client().deleteResource("job", `${ACCOUNT}:job:job-1`, ACCOUNT)).rejects.toThrow(
      /only be fetched or deleted once it is "transcribed" or "failed"/,
    );
  });
});

describe("transcribeAudio", () => {
  it("submits multipart media+options, polls, and concatenates the transcript", async () => {
    const audio = new Uint8Array([7, 8, 9]);
    let polls = 0;

    installFetch((url, init) => {
      if (url === `${US}/jobs` && init?.method === "POST") {
        // 200, not 201 — and nulls are omitted from the response.
        return jsonResponse({ id: "job-9", status: "in_progress", type: "async" }, 200);
      }
      if (url === `${US}/jobs/job-9`) {
        polls++;
        return jsonResponse({
          id: "job-9",
          status: "transcribed",
          duration_seconds: 3.1,
          language: "en",
          transcriber: "fusion",
        });
      }
      if (url === `${US}/jobs/job-9/transcript`) return jsonResponse(TRANSCRIPT);
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await client().transcribeAudio("account", `${ACCOUNT}:account:self`, ACCOUNT, {
      audioBase64: Buffer.from(audio).toString("base64"),
      mimeType: "audio/mp4",
      fileName: "clip.m4a",
      modelId: "fusion",
      language: "en",
    });

    expect(polls).toBe(1);
    // No space inserted between "World" and "." — punct carries the spacing.
    expect(result.text).toBe("Hello World.");
    expect(result.durationSeconds).toBe(3.1);
    expect(result.language).toBe("en");
    expect(result.requestId).toBe("job-9");
    expect(result.summary).toContain("transcriber fusion");
    // Only `text` elements make it into the word table.
    expect(result.words).toEqual([
      { text: "Hello", start: 0.5, end: 1.5, speaker: "Speaker 1" },
      { text: "World", start: 1.75, end: 2.85, speaker: "Speaker 1" },
    ]);

    const submit = calls.find((call) => call.url === `${US}/jobs` && call.init?.method === "POST")!;
    expect(headerOf(submit.init, "Content-Type")).toMatch(/^multipart\/form-data; boundary=/);

    const body = submit.init!.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder("latin1").decode(body);
    expect(decoded).toContain('name="media"; filename="clip.m4a"');
    expect(decoded).toContain("Content-Type: audio/mp4");
    expect(decoded).toContain('name="options"');
    expect(decoded).not.toContain("[object FormData]");
    // base64 round-trips to the exact bytes the browser sent.
    expect(decoded).toContain(String.fromCharCode(7, 8, 9));

    const options = JSON.parse(
      /name="options"\r\n\r\n(\{.*?\})\r\n/.exec(decoded)![1] as string,
    ) as Record<string, unknown>;
    expect(options["transcriber"]).toBe("fusion");
    expect(options["language"]).toBe("en");
  });

  it("maps HTTP 405 to Rev AI's 'Invalid Job Properties' meaning", async () => {
    installFetch(() => jsonResponse({ title: "Job contains unsupported properties" }, 405));
    await expect(
      client().transcribeAudio("account", `${ACCOUNT}:account:self`, ACCOUNT, {
        audioBase64: Buffer.from([1]).toString("base64"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/Invalid Job Properties.*not "method not allowed"/s);
  });

  it("explains a 406 on the transcript as the wildcard-Accept rejection", async () => {
    installFetch((url, init) => {
      if (url === `${US}/jobs` && init?.method === "POST") return jsonResponse({ id: "job-9" });
      if (url === `${US}/jobs/job-9`) return jsonResponse({ id: "job-9", status: "transcribed" });
      if (url === `${US}/jobs/job-9/transcript`) {
        return jsonResponse({ current_value: "*/*" }, 406);
      }
      throw new Error(`unrouted: ${url}`);
    });

    await expect(
      client().transcribeAudio("account", `${ACCOUNT}:account:self`, ACCOUNT, {
        audioBase64: Buffer.from([1]).toString("base64"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/only accepts "application\/vnd\.rev\.transcript\.v1\.0\+json"/);
  });

  it("reports a failed job with Rev AI's own failure detail", async () => {
    installFetch((url, init) => {
      if (url === `${US}/jobs` && init?.method === "POST") return jsonResponse({ id: "job-bad" });
      if (url === `${US}/jobs/job-bad`) {
        return jsonResponse({
          id: "job-bad",
          status: "failed",
          failure: "invalid_media",
          failure_detail: "The media file could not be decoded",
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    await expect(
      client().transcribeAudio("account", `${ACCOUNT}:account:self`, ACCOUNT, {
        audioBase64: Buffer.from([1]).toString("base64"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/failed: The media file could not be decoded/);
  });

  it("rejects a non-account resource type", async () => {
    await expect(
      client().transcribeAudio("job", `${ACCOUNT}:job:x`, ACCOUNT, {
        audioBase64: "AA==",
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/cannot transcribe audio for type "job"/);
  });
});
