import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepgramClient } from "../client.js";

const ACCOUNT = "acct-1";
const PROJECT = "11111111-2222-3333-4444-555555555555";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  } as unknown as Response;
}

function binaryResponse(
  bytes: Uint8Array,
  headers: Record<string, string>,
  status = 200,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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

function client() {
  return new DeepgramClient({ apiKey: "dg-test-key" });
}

// GET /v1/projects returns only project_id + name — there is no `company`.
const PROJECT_LIST = {
  projects: [{ project_id: PROJECT, name: "Prod" }],
};

const MODEL_LIST = {
  stt: [
    {
      name: "Nova 3",
      canonical_name: "nova-3",
      architecture: "nova-3",
      languages: ["en", "es"],
      version: "2026-01-01",
      uuid: "stt-uuid-1",
    },
    { name: "Nova 2", canonical_name: "nova-2", languages: ["en"], uuid: "stt-uuid-2" },
  ],
  tts: [
    {
      name: "Thalia",
      canonical_name: "aura-2-thalia-en",
      architecture: "aura-2",
      languages: ["en"],
      uuid: "tts-uuid-1",
      metadata: {
        accent: "American",
        age: "Adult",
        color: "#C58DFF",
        image: "https://static.deepgram.com/thalia.jpg",
        sample: "https://static.deepgram.com/thalia.wav",
        tags: ["clear", "confident", "energetic"],
        use_cases: ["IVR"],
      },
    },
    {
      name: "Asteria",
      canonical_name: "aura-asteria-en",
      uuid: "tts-uuid-2",
      metadata: { accent: "American", sample: "https://static.deepgram.com/asteria.wav" },
    },
  ],
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("sends Authorization: Token, never Bearer", async () => {
    installFetch(() => jsonResponse(PROJECT_LIST));
    await client().listResources("project", ACCOUNT);
    const header = (calls[0]!.init!.headers as Record<string, string>)["Authorization"];
    expect(header).toBe("Token dg-test-key");
    expect(header).not.toMatch(/Bearer/);
  });
});

describe("listResources", () => {
  it("lists projects", async () => {
    installFetch(() => jsonResponse(PROJECT_LIST));
    const projects = await client().listResources("project", ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.deepgram.com/v1/projects");
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(`${ACCOUNT}:project:${PROJECT}`);
    expect(projects[0]!.displayName).toBe("Prod");
    expect(projects[0]!.resolvedOutputs["projectId"]).toBe(PROJECT);
  });

  it("fans keys out across every visible project and parents them", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/projects")) return jsonResponse(PROJECT_LIST);
      if (url.endsWith(`/v1/projects/${PROJECT}/keys`)) {
        return jsonResponse({
          api_keys: [
            {
              member: { member_id: "m-1", email: "dev@acme.co" },
              api_key: {
                api_key_id: "key-1",
                comment: "CI",
                scopes: ["member"],
                tags: ["ci"],
                created: "2026-01-05T10:00:00.000Z",
              },
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const keys = await client().listResources("api-key", ACCOUNT);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(`${ACCOUNT}:api-key:${PROJECT}/key-1`);
    expect(keys[0]!.parentResourceId).toBe(`${ACCOUNT}:project:${PROJECT}`);
    expect(keys[0]!.fields["scopes"]).toBe("member");
    expect(keys[0]!.fields["memberEmail"]).toBe("dev@acme.co");
    // The list endpoint never returns the secret.
    expect(keys[0]!.resolvedOutputs["apiKey"]).toBeUndefined();
  });

  it("maps members, invites and balances", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/projects")) return jsonResponse(PROJECT_LIST);
      if (url.endsWith("/members")) {
        return jsonResponse({
          members: [
            {
              member_id: "m-1",
              email: "ada@acme.co",
              first_name: "Ada",
              last_name: "Lovelace",
              scopes: ["owner"],
            },
          ],
        });
      }
      if (url.endsWith("/invites")) {
        return jsonResponse({ invites: [{ email: "new@acme.co", scope: "member" }] });
      }
      if (url.endsWith("/balances")) {
        return jsonResponse({
          balances: [{ balance_id: "bal-1", amount: 42.5, units: "usd" }],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const c = client();
    const [members, invites, balances] = await Promise.all([
      c.listResources("member", ACCOUNT),
      c.listResources("invite", ACCOUNT),
      c.listResources("balance", ACCOUNT),
    ]);

    expect(members[0]!.displayName).toBe("Ada Lovelace");
    expect(members[0]!.id).toBe(`${ACCOUNT}:member:${PROJECT}/m-1`);
    // Invites are addressed by email — Deepgram has no invite id.
    expect(invites[0]!.id).toBe(`${ACCOUNT}:invite:${PROJECT}/new@acme.co`);
    expect(balances[0]!.fields["amount"]).toBe(42.5);
    expect(balances[0]!.displayName).toBe("42.50 usd");
  });

  it("splits /v1/models into stt and tts entries", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/projects")) return jsonResponse(PROJECT_LIST);
      if (url.endsWith("/models")) return jsonResponse(MODEL_LIST);
      throw new Error(`unrouted: ${url}`);
    });

    const models = await client().listResources("model", ACCOUNT);
    expect(models.map((m) => m.fields["canonicalName"])).toEqual([
      "nova-3",
      "nova-2",
      "aura-2-thalia-en",
      "aura-asteria-en",
    ]);
    const thalia = models.find((m) => m.fields["canonicalName"] === "aura-2-thalia-en")!;
    expect(thalia.fields["family"]).toBe("tts");
    expect(thalia.fields["tags"]).toBe("clear, confident, energetic");
    expect(thalia.fields["age"]).toBe("Adult");
    expect(thalia.fields["useCases"]).toBe("IVR");
    expect(thalia.fields["color"]).toBe("#C58DFF");
    expect(thalia.resolvedOutputs["sampleUrl"]).toBe("https://static.deepgram.com/thalia.wav");
  });

  it("keeps going when one project's child listing is forbidden", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/projects")) {
        return jsonResponse({
          projects: [
            { project_id: "p-open", name: "Open" },
            { project_id: "p-closed", name: "Closed" },
          ],
        });
      }
      if (url.includes("p-closed")) return jsonResponse({ err_msg: "forbidden" }, 403);
      return jsonResponse({ members: [{ member_id: "m-1", email: "a@b.co" }] });
    });

    const members = await client().listResources("member", ACCOUNT);
    expect(members).toHaveLength(1);
  });
});

describe("getResource", () => {
  it("stashes the model catalogue on the project for the synchronous renderer", async () => {
    installFetch((url) => {
      if (url.endsWith(`/v1/projects/${PROJECT}`)) {
        return jsonResponse({ project_id: PROJECT, name: "Prod" });
      }
      if (url.endsWith("/models")) return jsonResponse(MODEL_LIST);
      throw new Error(`unrouted: ${url}`);
    });

    const project = await client().getResource("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT);
    const stashed = JSON.parse(project.resolvedOutputs["__models__"]!) as {
      stt: { id: string }[];
      tts: { id: string; description?: string }[];
    };
    expect(stashed.stt.map((m) => m.id)).toEqual(["nova-3", "nova-2"]);
    expect(stashed.tts.map((v) => v.id)).toEqual(["aura-2-thalia-en", "aura-asteria-en"]);
    expect(stashed.tts[0]!.description).toBe("American · Adult · clear, confident, energetic");
  });

  it("unwraps the item/member/api_key nesting of the single-key GET", async () => {
    installFetch(() =>
      jsonResponse({
        item: {
          member: {
            member_id: "m-1",
            email: "john@test.com",
            first_name: "John",
            last_name: "Doe",
            api_key: {
              api_key_id: "key-1",
              comment: "A comment",
              scopes: ["admin"],
              tags: ["prod", "west-region"],
              expiration_date: "2027-01-01T00:00:00Z",
              created: "2026-01-01T00:00:00Z",
            },
          },
        },
      }),
    );

    const key = await client().getResource(
      "api-key",
      `${ACCOUNT}:api-key:${PROJECT}/key-1`,
      ACCOUNT,
    );
    expect(calls[0]!.url).toBe(`https://api.deepgram.com/v1/projects/${PROJECT}/keys/key-1`);
    // tags and expiration_date only exist on this read, not on the list.
    expect(key.fields["tags"]).toBe("prod, west-region");
    expect(key.fields["expirationDate"]).toBe("2027-01-01T00:00:00Z");
    expect(key.fields["memberEmail"]).toBe("john@test.com");
  });

  it("reads a single balance from the bare (unwrapped) object", async () => {
    installFetch(() =>
      jsonResponse({
        balance_id: "bal-1",
        amount: 1250.75,
        units: "USD",
        purchase_order_id: "PO-1",
      }),
    );
    const balance = await client().getResource(
      "balance",
      `${ACCOUNT}:balance:${PROJECT}/bal-1`,
      ACCOUNT,
    );
    expect(calls[0]!.url).toBe(`https://api.deepgram.com/v1/projects/${PROJECT}/balances/bal-1`);
    expect(balance.fields["amount"]).toBe(1250.75);
    expect(balance.fields["purchaseOrderId"]).toBe("PO-1");
  });

  it("stashes an empty catalogue rather than failing when models are unreadable", async () => {
    installFetch((url) => {
      if (url.endsWith(`/v1/projects/${PROJECT}`)) {
        return jsonResponse({ project_id: PROJECT, name: "Prod" });
      }
      return jsonResponse({ err_msg: "insufficient scope" }, 403);
    });

    const project = await client().getResource("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT);
    expect(project.resolvedOutputs["__models__"]).toBe('{"stt":[],"tts":[]}');
  });
});

describe("createResource", () => {
  it("creates an API key and surfaces the one-shot secret", async () => {
    installFetch((url, init) => {
      if (url.endsWith(`/v1/projects/${PROJECT}/keys`) && init?.method === "POST") {
        return jsonResponse({
          api_key_id: "key-9",
          key: "the-only-copy",
          comment: "CI",
          scopes: ["member"],
          tags: ["ci"],
          created: "2026-07-01T00:00:00.000Z",
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    const created = await client().createResource(
      "api-key",
      ACCOUNT,
      {
        comment: "CI",
        scopes: "member",
        tags: "ci, build",
        expirationDate: "2027-01-01T00:00:00Z",
      },
      `${ACCOUNT}:project:${PROJECT}`,
    );

    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      comment: "CI",
      scopes: ["member"],
      tags: ["ci", "build"],
      expiration_date: "2027-01-01T00:00:00Z",
    });
    expect(created.id).toBe(`${ACCOUNT}:api-key:${PROJECT}/key-9`);
    expect(created.resolvedOutputs["apiKey"]).toBe("the-only-copy");
  });

  it("omits the expiry and tags when the user left them blank", async () => {
    installFetch(() => jsonResponse({ api_key_id: "key-10", key: "s", comment: "x" }));
    await client().createResource(
      "api-key",
      ACCOUNT,
      { comment: "x", scopes: "admin", projectId: PROJECT },
      undefined,
    );
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body["expiration_date"]).toBeUndefined();
    expect(body["tags"]).toBeUndefined();
  });

  it("sends an invite", async () => {
    installFetch(() => jsonResponse({ message: "sent" }));
    const invite = await client().createResource(
      "invite",
      ACCOUNT,
      { email: "new@acme.co", scope: "admin" },
      `${ACCOUNT}:project:${PROJECT}`,
    );
    expect(calls[0]!.url).toBe(`https://api.deepgram.com/v1/projects/${PROJECT}/invites`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      email: "new@acme.co",
      scope: "admin",
    });
    expect(invite.id).toBe(`${ACCOUNT}:invite:${PROJECT}/new@acme.co`);
  });
});

describe("deleteResource", () => {
  it("deletes keys, invites (by email) and members", async () => {
    installFetch(() => jsonResponse({}, 204));
    const c = client();
    await c.deleteResource("api-key", `${ACCOUNT}:api-key:${PROJECT}/key-1`, ACCOUNT);
    await c.deleteResource("invite", `${ACCOUNT}:invite:${PROJECT}/new@acme.co`, ACCOUNT);
    await c.deleteResource("member", `${ACCOUNT}:member:${PROJECT}/m-1`, ACCOUNT);

    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      `DELETE https://api.deepgram.com/v1/projects/${PROJECT}/keys/key-1`,
      `DELETE https://api.deepgram.com/v1/projects/${PROJECT}/invites/new%40acme.co`,
      `DELETE https://api.deepgram.com/v1/projects/${PROJECT}/members/m-1`,
    ]);
  });

  it("refuses to delete a balance or a model", async () => {
    await expect(
      client().deleteResource("balance", `${ACCOUNT}:balance:${PROJECT}/bal-1`, ACCOUNT),
    ).rejects.toThrow(/cannot delete/);
  });
});

describe("updateResource", () => {
  it("PATCHes the project name — the only documented mutable attribute", async () => {
    installFetch((url, init) => {
      if (init?.method === "PATCH") return jsonResponse({ message: "ok" });
      if (url.endsWith(`/v1/projects/${PROJECT}`)) {
        return jsonResponse({ project_id: PROJECT, name: "Renamed", mip_opt_out: false });
      }
      return jsonResponse(MODEL_LIST);
    });

    const updated = await client().updateResource(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
      { name: "Renamed" },
    );
    expect(calls[0]!.init!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ name: "Renamed" });
    expect(updated.displayName).toBe("Renamed");
  });

  it("changes a member's role through the scopes sub-resource", async () => {
    installFetch((url, init) => {
      if (init?.method === "PUT") return jsonResponse({ message: "Scopes updated successfully." });
      return jsonResponse({
        members: [{ member_id: "m-1", email: "ada@acme.co", scopes: ["admin"] }],
      });
    });

    const updated = await client().updateResource(
      "member",
      `${ACCOUNT}:member:${PROJECT}/m-1`,
      ACCOUNT,
      { scopes: "admin" },
    );
    expect(calls[0]!.url).toBe(
      `https://api.deepgram.com/v1/projects/${PROJECT}/members/m-1/scopes`,
    );
    expect(calls[0]!.init!.method).toBe("PUT");
    // Singular `scope`, unlike the plural `scopes` array a member reads back.
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ scope: "admin" });
    expect(updated.fields["scopes"]).toBe("admin");
  });
});

describe("fetchMetricSeries", () => {
  it("charts requests, hours and tts_characters from the usage breakdown", async () => {
    installFetch((url) => {
      expect(url).toContain("/usage/breakdown?");
      expect(url).toContain("start=");
      expect(url).toContain("end=");
      // Per-bucket timestamps live on `grouping`, NOT at the top of the result.
      return jsonResponse({
        start: "2026-07-01",
        end: "2026-07-03",
        resolution: { units: "day", amount: 1 },
        results: [
          {
            hours: 1.5,
            total_hours: 1.5,
            agent_hours: 0,
            tokens_in: 0,
            tokens_out: 0,
            tts_characters: 2400,
            requests: 10,
            grouping: { start: "2026-07-01", end: "2026-07-01", endpoint: "listen" },
          },
          {
            hours: 2.5,
            total_hours: 2.5,
            agent_hours: 0,
            tokens_in: 0,
            tokens_out: 0,
            tts_characters: 800,
            requests: 20,
            grouping: { start: "2026-07-02", end: "2026-07-02", endpoint: "speak" },
          },
        ],
      });
    });

    const series = await client().fetchMetricSeries(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
    );
    expect(series.map((s) => s.label)).toEqual(["Requests", "Audio Hours", "TTS Characters"]);
    expect(series[0]!.points).toHaveLength(2);
    expect(series[2]!.points[0]!.value).toBe(2400);
    expect(series[0]!.points[0]!.timestamp).toBe(Date.parse("2026-07-01"));
  });

  it("sums several grouped rows that share one interval", async () => {
    installFetch(() =>
      jsonResponse({
        results: [
          {
            requests: 5,
            hours: 1,
            tts_characters: 100,
            grouping: { start: "2026-07-01", endpoint: "listen" },
          },
          {
            requests: 7,
            hours: 0,
            tts_characters: 900,
            grouping: { start: "2026-07-01", endpoint: "speak" },
          },
        ],
      }),
    );
    const series = await client().fetchMetricSeries(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
    );
    expect(series[0]!.points).toEqual([{ timestamp: Date.parse("2026-07-01"), value: 12 }]);
    expect(series[2]!.points[0]!.value).toBe(1000);
  });

  it("drops series that are entirely zero", async () => {
    installFetch(() =>
      jsonResponse({
        results: [
          { requests: 5, hours: 0.25, tts_characters: 0, grouping: { start: "2026-07-01" } },
        ],
      }),
    );
    const series = await client().fetchMetricSeries(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
    );
    expect(series.map((s) => s.label)).toEqual(["Requests", "Audio Hours"]);
  });

  it("returns nothing for non-project types", async () => {
    installFetch(() => jsonResponse({}));
    const series = await client().fetchMetricSeries("api-key", `${ACCOUNT}:api-key:x/y`, ACCOUNT);
    expect(series).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("synthesizeSpeech", () => {
  it("puts model and encoding in the query and only text in the body", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]);
    installFetch(() =>
      binaryResponse(audio, {
        "dg-request-id": "req-abc",
        "dg-model-name": "aura-2-thalia-en",
        "dg-char-count": "42",
      }),
    );

    const result = await client().synthesizeSpeech(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
      { text: "Hello there", voiceId: "aura-2-thalia-en", modelId: "nova-3" },
    );

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/speak");
    expect(url.searchParams.get("model")).toBe("aura-2-thalia-en");
    expect(url.searchParams.get("encoding")).toBe("mp3");
    // The STT model picker must not leak into the TTS query.
    expect(url.searchParams.get("language")).toBeNull();
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ text: "Hello there" });
    expect((calls[0]!.init!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    expect(result.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(Buffer.from(audio));
    expect(result.requestId).toBe("req-abc");
    expect(result.characters).toBe(42);
    expect(result.fileName).toMatch(/^aura-2-thalia-en-\d+\.mp3$/);
    expect(result.summary).toContain("aura-2-thalia-en");
  });

  it("refuses more than 2,000 characters without spending a request", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().synthesizeSpeech("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT, {
        text: "x".repeat(2001),
      }),
    ).rejects.toThrow(/2000 characters/);
    expect(calls).toHaveLength(0);
  });

  it("turns Deepgram's 413 into a clear over-limit message", async () => {
    installFetch(() =>
      binaryResponse(new TextEncoder().encode('{"err_msg":"payload too large"}'), {}, 413),
    );
    await expect(
      client().synthesizeSpeech("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT, {
        text: "hello",
      }),
    ).rejects.toThrow(/413/);
  });

  it("falls back to Deepgram's default voice when the picker is empty", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1, 2, 3]), {}));
    await client().synthesizeSpeech("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT, {
      text: "hi",
    });
    expect(new URL(calls[0]!.url).searchParams.get("model")).toBe("aura-2-thalia-en");
  });
});

describe("transcribeAudio", () => {
  const LISTEN_RESPONSE = {
    metadata: {
      request_id: "req-xyz",
      duration: 4.25,
      channels: 1,
      model_info: { "abc-uuid": { name: "nova-3", version: "2026-01-01", arch: "nova-3" } },
    },
    results: {
      channels: [
        {
          detected_language: "en",
          alternatives: [
            {
              transcript: "hello world",
              confidence: 0.987,
              words: [{ word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.4 }],
            },
          ],
        },
      ],
      utterances: [
        {
          start: 0.1,
          end: 1.2,
          transcript: "Hello world.",
          speaker: 0,
          words: [
            { word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.4, speaker: 0 },
            { word: "world", punctuated_word: "world.", start: 0.5, end: 0.9 },
          ],
        },
        {
          start: 1.5,
          end: 2.4,
          transcript: "Good morning.",
          speaker: 1,
          words: [{ word: "good", punctuated_word: "Good", start: 1.5, end: 1.8, speaker: 1 }],
        },
      ],
    },
  };

  function listenFetch() {
    return installFetch(() =>
      binaryResponse(new TextEncoder().encode(JSON.stringify(LISTEN_RESPONSE)), {
        "dg-request-id": "header-req",
      }),
    );
  }

  it("posts raw bytes with the browser's own MIME type and the right flags", async () => {
    listenFetch();
    const clip = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x99]);

    await client().transcribeAudio("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT, {
      audioBase64: clip.toString("base64"),
      mimeType: "audio/webm;codecs=opus",
      modelId: "nova-3",
      language: "multi",
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("language")).toBe("multi");
    expect(url.searchParams.get("punctuate")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(url.searchParams.get("utterances")).toBe("true");

    const headers = calls[0]!.init!.headers as Record<string, string>;
    // MediaRecorder's own type is forwarded untouched — no multipart, no transcode.
    expect(headers["Content-Type"]).toBe("audio/webm;codecs=opus");
    expect(headers["Authorization"]).toBe("Token dg-test-key");
    expect(Buffer.from(calls[0]!.init!.body as Uint8Array)).toEqual(clip);
  });

  it("builds a diarised word table from the utterances", async () => {
    listenFetch();
    const result = await client().transcribeAudio(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
      { audioBase64: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "audio/mp4" },
    );

    expect(result.text).toBe("Hello world.\nGood morning.");
    expect(result.language).toBe("en");
    expect(result.durationSeconds).toBe(4.25);
    expect(result.confidence).toBeCloseTo(0.987);
    expect(result.requestId).toBe("req-xyz");
    expect(result.words).toEqual([
      { text: "Hello", start: 0.1, end: 0.4, speaker: "Speaker 0" },
      { text: "world.", start: 0.5, end: 0.9, speaker: "Speaker 0" },
      { text: "Good", start: 1.5, end: 1.8, speaker: "Speaker 1" },
    ]);
    expect(result.summary).toContain("2 speakers");
    expect(result.summary).toContain("nova-3");
  });

  it("falls back to the flat alternative when there are no utterances", async () => {
    installFetch(() =>
      binaryResponse(
        new TextEncoder().encode(
          JSON.stringify({
            metadata: { request_id: "r" },
            results: {
              channels: [
                {
                  alternatives: [
                    {
                      transcript: "just this",
                      confidence: 0.5,
                      words: [{ word: "just", start: 0, end: 0.2 }],
                    },
                  ],
                },
              ],
            },
          }),
        ),
        {},
      ),
    );

    const result = await client().transcribeAudio(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
      { audioBase64: Buffer.from([9]).toString("base64"), mimeType: "audio/wav" },
    );
    expect(result.text).toBe("just this");
    expect(result.words).toEqual([{ text: "just", start: 0, end: 0.2 }]);
  });

  it("reads the language from alternatives[].languages under language=multi", async () => {
    // Code-switching returns no channel-level detected_language.
    installFetch(() =>
      binaryResponse(
        new TextEncoder().encode(
          JSON.stringify({
            metadata: { request_id: "r" },
            results: {
              channels: [
                {
                  alternatives: [
                    { transcript: "No recuerdo mi bank password.", languages: ["en", "es"] },
                  ],
                },
              ],
            },
          }),
        ),
        {},
      ),
    );

    const result = await client().transcribeAudio(
      "project",
      `${ACCOUNT}:project:${PROJECT}`,
      ACCOUNT,
      {
        audioBase64: Buffer.from([1]).toString("base64"),
        mimeType: "audio/webm",
        language: "multi",
      },
    );
    expect(result.language).toBe("en, es");
  });

  it("rejects an empty clip", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().transcribeAudio("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT, {
        audioBase64: "",
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/empty/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a JSON error body returned in place of a transcript", async () => {
    installFetch(() =>
      binaryResponse(
        new TextEncoder().encode('{"err_code":"INVALID_AUTH","err_msg":"bad key"}'),
        {},
        401,
      ),
    );
    await expect(
      client().transcribeAudio("project", `${ACCOUNT}:project:${PROJECT}`, ACCOUNT, {
        audioBase64: Buffer.from([1]).toString("base64"),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/401.*bad key/);
  });

  it("is only offered on projects", async () => {
    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:x/nova-3`, ACCOUNT, {
        audioBase64: "AA==",
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow(/not available/);
  });
});

describe("getCreateConfig", () => {
  it("offers a project picker from the base, and none under a project", async () => {
    installFetch(() => jsonResponse(PROJECT_LIST));
    const c = client();

    const fromBase = await c.getCreateConfig("api-key");
    expect(fromBase.fields[0]!.key).toBe("projectId");
    expect(fromBase.fields[0]!.options?.[0]).toEqual({ id: PROJECT, label: "Prod" });

    const underProject = await c.getCreateConfig("api-key", `${ACCOUNT}:project:${PROJECT}`);
    expect(underProject.fields.map((f) => f.key)).toEqual([
      "comment",
      "scopes",
      "tags",
      "expirationDate",
    ]);
  });

  it("has no create config for read-only types", async () => {
    await expect(
      client().getCreateConfig("balance", `${ACCOUNT}:project:${PROJECT}`),
    ).rejects.toThrow(/no create config/);
  });
});
