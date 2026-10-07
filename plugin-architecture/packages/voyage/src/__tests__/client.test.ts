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
    const items = await new VoyageClient({ apiKey: "k" }, { http }).listResources(
      "voyage-batch",
      ACCOUNT,
    );
    expect(items.map((i) => i.externalId)).toEqual(["batch-1", "batch-2"]);
    expect(calls[1]?.url).toBe("https://api.voyageai.com/v1/batches?limit=100&after=batch-1");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer k");
  });

  it("creates a batch with the model picked for its endpoint", async () => {
    const { http, calls } = host(() => ({
      body: { id: "batch-9", status: "validating", model: "rerank-3" },
    }));
    await new VoyageClient({ apiKey: "k" }, { http }).createResource("voyage-batch", ACCOUNT, {
      inputFileId: "file-1",
      endpoint: "/v1/rerank",
      "model:rerank": "rerank-3",
      "model:embedding": "voyage-4",
      metadata: "corpus=docs\nbad line",
    });
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
      new VoyageClient({ apiKey: "k" }, { http }).streamChatMessage(
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
      new VoyageClient({ apiKey: "k" }, { http }).streamChatMessage(
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
    const res = await new VoyageClient({ apiKey: "bad" }, { http }).verifyCredentials();
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
