import { describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { PerplexityClient, agentOutputText } from "../client.js";
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

describe("Perplexity", () => {
  it("lists router models with prices and keeps slashes in ids", async () => {
    const { http, calls } = host(() => ({
      body: {
        data: [
          {
            id: "perplexity/kimi-k3",
            owned_by: "moonshot",
            pricing: { input: 0.6, output: 2.5, unit: "per_1m_tokens" },
          },
        ],
      },
    }));
    const [m] = await new PerplexityClient({ apiKey: "pplx-x" }, { http }).listResources(
      "perplexity-router-model",
      ACCOUNT,
    );
    expect(m?.externalId).toBe("perplexity/kimi-k3");
    expect(m?.fields["inputPrice"]).toBe(0.6);
    expect(calls[0]?.url).toBe("https://api.perplexity.ai/router/v1/models");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer pplx-x");
  });

  it("creates an async deep-research request wrapped in `request`", async () => {
    const { http, calls } = host(() => ({
      body: {
        id: "req-1",
        model: "sonar-deep-research",
        status: "CREATED",
        created_at: 1760000000,
      },
    }));
    const r = await new PerplexityClient({ apiKey: "k" }, { http }).createResource(
      "perplexity-async-request",
      ACCOUNT,
      {
        model: "sonar-deep-research",
        prompt: "Why?",
        searchRecency: "week",
      },
    );
    expect(r.fields["status"]).toBe("CREATED");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      request: {
        model: "sonar-deep-research",
        messages: [{ role: "user", content: "Why?" }],
        search_recency_filter: "week",
      },
    });
  });

  it("maps a completed async request's answer, citations and cost", async () => {
    const { http } = host(() => ({
      body: {
        id: "req-1",
        model: "sonar-pro",
        status: "COMPLETED",
        created_at: 1760000000,
        response: {
          choices: [{ message: { content: "Answer" } }],
          citations: ["https://a"],
          usage: { cost: { total_cost: 0.0123 } },
        },
      },
    }));
    const r = await new PerplexityClient({ apiKey: "k" }, { http }).getResource(
      "perplexity-async-request",
      `${ACCOUNT}:perplexity-async-request:req-1`,
      ACCOUNT,
    );
    expect(r.fields["answer"]).toBe("Answer");
    expect(r.fields["citations"]).toBe("https://a");
    expect(r.fields["cost"]).toBe(0.0123);
  });

  it("deletes a skill guarded by its current revision", async () => {
    const { http, calls } = host((url, method) =>
      method === "GET" ? { body: { skill_id: "sk1", revision: "rev-9" } } : { body: {} },
    );
    await new PerplexityClient({ apiKey: "k" }, { http }).deleteResource(
      "perplexity-skill",
      `${ACCOUNT}:perplexity-skill:sk1`,
      ACCOUNT,
    );
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe("https://api.perplexity.ai/v1/skills/sk1?expected_revision=rev-9");
  });

  it("attaches the HTTP status to errors", async () => {
    const { http } = host(() => ({ status: 401, body: { error: "bad key" } }));
    await expect(
      new PerplexityClient({ apiKey: "k" }, { http }).listResources(
        "perplexity-agent-model",
        ACCOUNT,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("extracts Agent API output text", () => {
    expect(
      agentOutputText([
        { type: "search_results" },
        {
          type: "message",
          content: [
            { type: "output_text", text: "Hello " },
            { type: "output_text", text: "world" },
          ],
        },
      ]),
    ).toBe("Hello world");
  });

  it("keeps only unresolved API incidents", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "1",
          name: "API errors",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "API" }],
          incident_updates: [],
        },
        {
          id: "2",
          name: "App slow",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "App" }],
          incident_updates: [],
        },
        {
          id: "3",
          name: "Old",
          status: "resolved",
          impact: "minor",
          created_at: "2026-09-01T00:00:00Z",
          resolved_at: "2026-09-02T00:00:00Z",
          components: [{ name: "API" }],
          incident_updates: [],
        },
      ],
    });
    expect(parseStatusFeed(body).map((i) => i.externalId)).toEqual(["1"]);
  });
});
