import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { PerplexityClient, agentOutputText } from "../client.js";
import { RESOURCE_TYPES } from "../plugin.js";
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

  it("has no async request type: Perplexity retired it, and its replacement has no list", async () => {
    expect(RESOURCE_TYPES.map((t) => t.id)).not.toContain("perplexity-async-request");
    const { http, calls } = host(() => ({ body: { requests: [] } }));
    await expect(
      hostClient(new PerplexityClient({ apiKey: "k" }, { http })).listResources(
        "perplexity-async-request",
        ACCOUNT,
      ),
    ).rejects.toThrow("unknown resource type");
    expect(calls).toHaveLength(0);
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

  describe("streaming chat", () => {
    const SSE =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\n';
    const noFetch = vi.fn(async () => {
      throw new Error("global fetch must not be called");
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      noFetch.mockClear();
    });

    async function collect(client: PerplexityClient, typeId: string, model: string) {
      const events = [];
      const stream = hostClient(client).streamChatMessage?.(
        typeId,
        `${ACCOUNT}:${typeId}:${model}`,
        ACCOUNT,
        [{ role: "user", content: "Hi" }],
      );
      for await (const event of stream ?? []) events.push(event);
      return events;
    }

    const streamed = (status = 200, text = SSE) => ({
      status,
      headers: {},
      body: new Response(text).body,
    });

    it.each([
      ["perplexity-sonar-model", "sonar", "https://api.perplexity.ai/v1/sonar"],
      [
        "perplexity-router-model",
        "perplexity/kimi-k3",
        "https://api.perplexity.ai/router/v1/chat/completions",
      ],
    ])("streams %s through the host, not global fetch", async (typeId, model, url) => {
      vi.stubGlobal("fetch", noFetch);
      const request = vi.fn();
      const requestStream = vi.fn<NonNullable<HttpHostServices["requestStream"]>>(async () =>
        streamed(),
      );
      const client = new PerplexityClient({ apiKey: "k" }, { http: { request, requestStream } });
      const events = await collect(client, typeId, model);
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        message: { content: "Hi there" },
      });
      expect(noFetch).not.toHaveBeenCalled();
      expect(requestStream).toHaveBeenCalledTimes(1);
      expect(requestStream.mock.lastCall).toMatchObject([
        {
          url,
          method: "POST",
          headers: { authorization: "Bearer k" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Hi" }],
            stream: true,
          }),
        },
      ]);
      expect(requestStream.mock.lastCall?.[0]).not.toHaveProperty("caCert");
    });

    it("takes a custom CA to the host even when it cannot stream", async () => {
      vi.stubGlobal("fetch", noFetch);
      const request = vi.fn(async () => ({ status: 200, headers: {}, body: SSE }));
      const client = new PerplexityClient({ apiKey: "k", caCert: "PEM" }, { http: { request } });
      const events = await collect(client, "perplexity-sonar-model", "sonar");
      expect(events.at(-1)).toMatchObject({ kind: "done", message: { content: "Hi there" } });
      expect(noFetch).not.toHaveBeenCalled();
      expect(request.mock.lastCall).toMatchObject([{ caCert: "PEM" }]);
    });

    it("reports a failed stream with its status", async () => {
      vi.stubGlobal("fetch", noFetch);
      const client = new PerplexityClient(
        { apiKey: "k" },
        { http: { request: vi.fn(), requestStream: vi.fn(async () => streamed(402, "")) } },
      );
      const events = await collect(client, "perplexity-sonar-model", "sonar");
      expect(events).toEqual([
        { kind: "error", message: expect.stringContaining("out of credits") },
      ]);
    });
  });

  it("deletes a skill by its latest revision, which the active one may not be", async () => {
    const { http, calls } = host((_url, method) =>
      method === "GET"
        ? { body: { skill_id: "sk1", revision: "active", latest_revision: "latest" } }
        : { status: 204 },
    );
    await hostClient(new PerplexityClient({ apiKey: "k" }, { http })).deleteResource(
      "perplexity-skill",
      `${ACCOUNT}:perplexity-skill:sk1`,
      ACCOUNT,
    );
    expect(calls[1]?.url).toBe("https://api.perplexity.ai/v1/skills/sk1?expected_revision=latest");
  });

  it.each([
    ["a blank id", `${ACCOUNT}:perplexity-skill:`, { skill_id: "sk1", revision: "rev" }],
    ["no revision to guard with", `${ACCOUNT}:perplexity-skill:sk1`, { skill_id: "sk1" }],
  ])("refuses to delete a skill with %s", async (_name, id, skill) => {
    const { http, calls } = host(() => ({ body: skill }));
    await expect(
      hostClient(new PerplexityClient({ apiKey: "k" }, { http })).deleteResource(
        "perplexity-skill",
        id,
        ACCOUNT,
      ),
    ).rejects.toThrow("Refusing to delete");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  describe("list reads a sync prunes by", () => {
    const list = (http: HttpHostServices, typeId: string) =>
      hostClient(new PerplexityClient({ apiKey: "k" }, { http })).listResources(typeId, ACCOUNT);

    it("walks every page of skills at the largest page size", async () => {
      const { http, calls } = host((url) =>
        url.includes("page_token=t2")
          ? { body: { skills: [{ skill_id: "b" }] } }
          : { body: { skills: [{ skill_id: "a" }], next_page_token: "t2" } },
      );
      const rows = await list(http, "perplexity-skill");
      expect(rows.map((r) => r.externalId)).toEqual(["a", "b"]);
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.perplexity.ai/v1/skills?limit=200",
        "https://api.perplexity.ai/v1/skills?limit=200&page_token=t2",
      ]);
    });

    it("throws on a skill list that outruns 10,000 rows, after exactly 50 requests", async () => {
      let n = 0;
      const { http, calls } = host(() => ({
        body: { skills: [{ skill_id: `s${n++}` }], next_page_token: `t${n}` },
      }));
      await expect(list(http, "perplexity-skill")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(50);
    });

    it.each([
      ["first", 0],
      ["later", 1],
    ])("throws when the %s skill page is not a list", async (_name, bad) => {
      let page = 0;
      const { http } = host(() =>
        page++ === bad
          ? { body: { items: [{ skill_id: "x" }] } }
          : { body: { skills: [{ skill_id: "a" }], next_page_token: "t2" } },
      );
      await expect(list(http, "perplexity-skill")).rejects.toThrow("is not a list");
    });

    it.each([["perplexity-agent-model"], ["perplexity-router-model"]])(
      "throws when %s answers with something that is not a list",
      async (typeId) => {
        const { http } = host(() => ({ body: { error: "try later" } }));
        await expect(list(http, typeId)).rejects.toThrow("is not a list");
      },
    );
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
