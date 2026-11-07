import { hostClient } from "@infrawrench/plugin-base/effect";
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
    const [m] = await hostClient(
      new PerplexityClient({ apiKey: "pplx-x" }, { http }),
    ).listResources("perplexity-router-model", ACCOUNT);
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
    const r = await hostClient(new PerplexityClient({ apiKey: "k" }, { http })).createResource(
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
    const r = await hostClient(new PerplexityClient({ apiKey: "k" }, { http })).getResource(
      "perplexity-async-request",
      `${ACCOUNT}:perplexity-async-request:req-1`,
      ACCOUNT,
    );
    expect(r.fields["answer"]).toBe("Answer");
    expect(r.fields["citations"]).toBe("https://a");
    expect(r.fields["cost"]).toBe(0.0123);
  });

  it("reads a structured async answer's text chunks, not [object Object]", async () => {
    const { http } = host(() => ({
      body: {
        id: "req-1",
        model: "sonar-pro",
        status: "COMPLETED",
        created_at: 1760000000,
        response: {
          choices: [
            {
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "First " },
                  { type: "image_url", image_url: { url: "https://a/i.png" } },
                  { type: "text", text: "second" },
                ],
              },
            },
          ],
        },
      },
    }));
    const r = await hostClient(new PerplexityClient({ apiKey: "k" }, { http })).getResource(
      "perplexity-async-request",
      `${ACCOUNT}:perplexity-async-request:req-1`,
      ACCOUNT,
    );
    expect(r.fields["answer"]).toBe("First second");
  });

  it("shows no answer for null content", async () => {
    const { http } = host(() => ({
      body: {
        id: "req-1",
        status: "COMPLETED",
        response: { choices: [{ message: { role: "assistant", content: null } }] },
      },
    }));
    const r = await hostClient(new PerplexityClient({ apiKey: "k" }, { http })).getResource(
      "perplexity-async-request",
      `${ACCOUNT}:perplexity-async-request:req-1`,
      ACCOUNT,
    );
    expect(r.fields["answer"]).toBeUndefined();
  });

  it("deletes a skill guarded by its current revision", async () => {
    const { http, calls } = host((url, method) =>
      method === "GET" ? { body: { skill_id: "sk1", revision: "rev-9" } } : { body: {} },
    );
    await hostClient(new PerplexityClient({ apiKey: "k" }, { http })).deleteResource(
      "perplexity-skill",
      `${ACCOUNT}:perplexity-skill:sk1`,
      ACCOUNT,
    );
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe("https://api.perplexity.ai/v1/skills/sk1?expected_revision=rev-9");
  });

  async function chat(model: string, reply: object) {
    const { http, calls } = host(() => ({ body: reply }));
    const stream = hostClient(new PerplexityClient({ apiKey: "k" }, { http })).streamChatMessage?.(
      "perplexity-agent-model",
      `${ACCOUNT}:perplexity-agent-model:${model}`,
      ACCOUNT,
      [{ role: "user", content: "Hi" }],
    );
    const events = [];
    for await (const event of stream ?? []) events.push(event);
    return { events, sent: JSON.parse(calls[0]?.body ?? "{}") };
  }

  const AGENT_REPLY = {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
  };

  it("caps an anthropic Agent API reply, which the API requires", async () => {
    const { sent } = await chat("anthropic/claude-sonnet-5-5", AGENT_REPLY);
    expect(sent.model).toBe("anthropic/claude-sonnet-5-5");
    expect(sent.max_output_tokens).toBe(8192);
  });

  it("leaves other Agent API models on their own limit", async () => {
    const { sent } = await chat("openai/gpt-5.6-terra", AGENT_REPLY);
    expect(sent).not.toHaveProperty("max_output_tokens");
  });

  it("says so when an Agent API reply was cut short", async () => {
    const { events } = await chat("anthropic/claude-sonnet-5-5", {
      ...AGENT_REPLY,
      status: "incomplete",
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      message: { content: expect.stringMatching(/^Hello\n\n.*incomplete/) },
    });
  });

  const SKILL = {
    id: `${ACCOUNT}:perplexity-skill:sk1`,
    pluginId: "perplexity",
    resourceTypeId: "perplexity-skill",
    accountId: ACCOUNT,
    displayName: "Skill",
    externalId: "sk1",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };

  it("reads every page of a skill's revisions", async () => {
    const { http, calls } = host((url) =>
      url.includes("page_token=t2")
        ? { body: { revisions: [{ revision: "r2" }] } }
        : { body: { revisions: [{ revision: "r1" }], next_page_token: "t2" } },
    );
    const client = new PerplexityClient({ apiKey: "k" }, { http });
    const enriched = await hostClient(client).enrichDetail?.(SKILL);
    expect(JSON.parse(enriched?.resolvedOutputs["__revisions__"] ?? "[]")).toEqual([
      { revision: "r1" },
      { revision: "r2" },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.perplexity.ai/v1/skills/sk1/revisions?limit=200",
      "https://api.perplexity.ai/v1/skills/sk1/revisions?limit=200&page_token=t2",
    ]);
  });

  it("stops at the newest revisions and says that is what it shows", async () => {
    const { http, calls } = host(() => ({
      body: {
        revisions: Array.from({ length: 200 }, (_, i) => ({ revision: `r${i}` })),
        next_page_token: "more",
      },
    }));
    const client = new PerplexityClient({ apiKey: "k" }, { http });
    const enriched = await hostClient(client).enrichDetail?.(SKILL);
    expect(calls).toHaveLength(50);
    const detail = client.renderDetail(enriched ?? SKILL);
    expect(JSON.stringify(detail.sections)).toContain("Showing the newest 10000 revisions");
  });

  it("says the revision history could not be read, rather than that there is none", async () => {
    const { http } = host(() => ({ status: 500, body: { error: "boom" } }));
    const client = new PerplexityClient({ apiKey: "k" }, { http });
    const enriched = await hostClient(client).enrichDetail?.(SKILL);
    const shown = JSON.stringify(client.renderDetail(enriched ?? SKILL).sections);
    expect(shown).toContain("Could not read the revision history");
    expect(shown).not.toContain("No revision history");
  });

  it("attaches the HTTP status to errors", async () => {
    const { http } = host(() => ({ status: 401, body: { error: "bad key" } }));
    await expect(
      hostClient(new PerplexityClient({ apiKey: "k" }, { http })).listResources(
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
