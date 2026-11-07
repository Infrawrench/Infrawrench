import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { VoyageClient, parseRerankInput } from "../client.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

function host(
  handler: (url: string, method: string, body?: string) => { status?: number; body?: unknown },
) {
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
      const res = handler(req.url, req.method, body);
      return { status: res.status ?? 200, headers: {}, body: JSON.stringify(res.body ?? {}) };
    }),
  };
  return { http, calls };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("Voyage", () => {
  it("pages batches with after=last_id", async () => {
    const { http, calls } = host((url) =>
      url.includes("after=")
        ? { body: { data: [{ id: "batch-2", status: "completed" }], has_more: false } }
        : {
            body: {
              data: [{ id: "batch-1", status: "in_progress" }],
              has_more: true,
              last_id: "batch-1",
            },
          },
    );
    const items = await hostClient(new VoyageClient({ apiKey: "k" }, { http })).listResources(
      "voyage-batch",
      ACCOUNT,
    );
    expect(items.map((i) => i.externalId)).toEqual(["batch-1", "batch-2"]);
    expect(calls[1]?.url).toBe("https://api.voyageai.com/v1/batches?limit=100&after=batch-1");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer k");
  });

  describe("lists that cannot say they have every row", () => {
    const client = (http: HttpHostServices) =>
      hostClient(new VoyageClient({ apiKey: "k" }, { http }));
    const endless = (url: string) => {
      const at = Number(/after=row-(\d+)/.exec(url)?.[1] ?? 0) + 1;
      return { body: { data: [{ id: `row-${at}` }], has_more: true, last_id: `row-${at}` } };
    };

    it("reads batches past the old 50 page stop", async () => {
      const { http, calls } = host((url) => {
        const page = endless(url);
        return calls.length === 51 ? { body: { ...page.body, has_more: false } } : page;
      });
      const items = await client(http).listResources("voyage-batch", ACCOUNT);
      expect(items).toHaveLength(51);
      expect(calls).toHaveLength(51);
    });

    it("fails batches that outrun 50,000 rows instead of returning part of them", async () => {
      const { http, calls } = host(endless);
      await expect(client(http).listResources("voyage-batch", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(500);
      expect(calls[0]?.url).toBe("https://api.voyageai.com/v1/batches?limit=100");
    });

    it("reads files at the documented 10,000 a page and fails past 50,000 rows", async () => {
      const { http, calls } = host(endless);
      await expect(client(http).listResources("voyage-file", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(5);
      expect(calls[0]?.url).toBe("https://api.voyageai.com/v1/files?limit=10000");
    });

    it.each(["voyage-batch", "voyage-file"])(
      "fails %s when the first page has no list",
      async (typeId) => {
        const { http } = host(() => ({ body: { items: [{ id: "a" }], has_more: false } }));
        await expect(client(http).listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
      },
    );

    it("fails when a later page has no list", async () => {
      const { http, calls } = host((url) =>
        url.includes("after=")
          ? { body: { detail: "busy" } }
          : { body: { data: [{ id: "a" }], has_more: true, last_id: "a" } },
      );
      await expect(client(http).listResources("voyage-batch", ACCOUNT)).rejects.toThrow(
        "is not a list",
      );
      expect(calls).toHaveLength(2);
    });

    it("fails when has_more leaves no cursor to continue from", async () => {
      const { http, calls } = host(() => ({ body: { data: [], has_more: true } }));
      await expect(client(http).listResources("voyage-file", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(1);
    });

    it("takes the cursor from the last row when last_id is missing", async () => {
      const { http, calls } = host((url) =>
        url.includes("after=")
          ? { body: { data: [{ id: "b" }], has_more: false } }
          : { body: { data: [{ id: "a" }], has_more: true } },
      );
      const items = await client(http).listResources("voyage-batch", ACCOUNT);
      expect(items.map((i) => i.externalId)).toEqual(["a", "b"]);
      expect(calls[1]?.url).toContain("after=a");
    });

    it("reads an empty account as empty", async () => {
      const { http, calls } = host(() => ({
        body: { object: "list", data: [], first_id: null, last_id: null, has_more: false },
      }));
      await expect(client(http).listResources("voyage-file", ACCOUNT)).resolves.toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it("offers the newest page of files in the create form, however many there are", async () => {
      const { http, calls } = host(() => ({
        body: {
          data: [
            { id: "file-2", filename: "new.jsonl", purpose: "batch" },
            { id: "file-1", filename: "out.jsonl", purpose: "batch-output" },
          ],
          has_more: true,
          last_id: "file-1",
        },
      }));
      const config = await client(http).getCreateConfig("voyage-batch");
      const input = config.fields.find((f) => f.key === "inputFileId");
      expect(input?.options?.map((o) => o.id)).toEqual(["file-2"]);
      expect(calls.map((c) => c.url)).toEqual(["https://api.voyageai.com/v1/files?limit=10000"]);
    });
  });

  it("creates a batch with the model picked for its endpoint", async () => {
    const { http, calls } = host(() => ({
      body: { id: "batch-9", status: "validating", model: "rerank-3" },
    }));
    await hostClient(new VoyageClient({ apiKey: "k" }, { http })).createResource(
      "voyage-batch",
      ACCOUNT,
      {
        inputFileId: "file-1",
        endpoint: "/v1/rerank",
        "model:rerank": "rerank-3",
        "model:embedding": "voyage-4",
        metadata: "corpus=docs\nbad line",
      },
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      input_file_id: "file-1",
      endpoint: "/v1/rerank",
      completion_window: "12h",
      request_params: { model: "rerank-3" },
      metadata: { corpus: "docs" },
    });
  });

  it("reranks in the test bench", async () => {
    const { http, calls } = host(() => ({
      body: {
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
        usage: { total_tokens: 12 },
      },
    }));
    const events = await collect(
      hostClient(new VoyageClient({ apiKey: "k" }, { http })).streamChatMessage(
        "voyage-model",
        `${ACCOUNT}:voyage-model:rerank-3`,
        ACCOUNT,
        [{ role: "user", content: "best fruit?\nkale\nmango" }],
      ),
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      query: "best fruit?",
      documents: ["kale", "mango"],
      model: "rerank-3",
    });
    const done = events.find((e) => e.kind === "done");
    expect(done && done.kind === "done" ? done.message.content : "").toContain("1. (0.9000) mango");
  });

  it("embeds in the test bench and reports the dimension", async () => {
    const { http } = host(() => ({
      body: { data: [{ embedding: [0.6, 0.8, 0, 0] }], usage: { total_tokens: 3 } },
    }));
    const events = await collect(
      hostClient(new VoyageClient({ apiKey: "k" }, { http })).streamChatMessage(
        "voyage-model",
        `${ACCOUNT}:voyage-model:voyage-4`,
        ACCOUNT,
        [{ role: "user", content: "hello" }],
      ),
    );
    const delta = events.find((e) => e.kind === "delta");
    expect(delta && delta.kind === "delta" ? delta.text : "").toContain(
      "4-dimension vector, norm 1.0000",
    );
  });

  it("verifies the key with a file listing", async () => {
    const { http } = host(() => ({
      status: 401,
      body: { detail: "Provided API key is invalid." },
    }));
    const res = await hostClient(new VoyageClient({ apiKey: "bad" }, { http })).verifyCredentials();
    expect(res.checks[0]?.status).toBe("missing");
  });

  it("splits rerank input", () => {
    expect(parseRerankInput("q\n\n a \nb")).toEqual({ query: "q", documents: ["a", "b"] });
  });

  it("escalates API incidents and ignores the dashboard", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "1",
          name: "Errors",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "API" }],
          incident_updates: [],
        },
        {
          id: "2",
          name: "UI",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "User Dashboard" }],
          incident_updates: [],
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents.map((i) => i.externalId)).toEqual(["1"]);
    expect(incidents[0]?.providerWide).toBe(true);
  });
});
