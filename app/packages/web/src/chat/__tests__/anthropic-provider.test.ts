import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderEvent, ProviderTool } from "../providers/types";

// The provider's only outside dependency is the client: a fake stream lets the
// tests check what goes on the wire and what comes back as stored blocks.
let streamEvents: unknown[] = [];
const streamCalls: Array<Record<string, unknown>> = [];
vi.mock("@infrawrench/server-core/anthropic-client", () => ({
  ANTHROPIC_NOT_CONFIGURED: "not configured",
  isAnthropicConfigured: () => true,
  anthropicClient: () => ({
    messages: {
      stream: (params: Record<string, unknown>) => {
        streamCalls.push(params);
        return (async function* () {
          for (const ev of streamEvents) yield ev;
        })();
      },
    },
  }),
}));

const { anthropicProvider, anthropicTools, sanitizeForAnthropic, TOOL_SEARCH_TOOL } =
  await import("../providers/anthropic");

function tool(name: string, deferLoading?: boolean): ProviderTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    ...(deferLoading ? { deferLoading } : {}),
  };
}

type ToolWithFlags = Anthropic.Tool & { defer_loading?: boolean };

describe("anthropicTools", () => {
  it("puts the search tool first and defers what is marked deferred", () => {
    const out = anthropicTools([tool("a"), tool("big_create", true), tool("b")]);
    expect(out[0]).toEqual(TOOL_SEARCH_TOOL);
    expect(out.map((t) => t.name)).toEqual(["tool_search_tool_bm25", "a", "b", "big_create"]);
    expect((out[3] as ToolWithFlags).defer_loading).toBe(true);
    expect((out[1] as ToolWithFlags).defer_loading).toBeUndefined();
  });

  it("marks only the last up-front tool for caching, never a deferred one", () => {
    const out = anthropicTools([tool("a"), tool("x", true), tool("b"), tool("y", true)]);
    const marked = out.filter((t) => "cache_control" in t && t.cache_control);
    expect(marked.map((t) => t.name)).toEqual(["b"]);
  });

  it("leaves the search tool out when nothing is deferred", () => {
    const out = anthropicTools([tool("a"), tool("b")]);
    expect(out.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("keeps a non-deferred tool in the request when every registry tool is deferred", () => {
    const out = anthropicTools([tool("x", true)]);
    expect(out.map((t) => t.name)).toEqual(["tool_search_tool_bm25", "x"]);
    expect((out[0] as ToolWithFlags).defer_loading).toBeUndefined();
  });
});

describe("sanitizeForAnthropic", () => {
  it("replays tool search blocks unchanged", () => {
    const blocks = [
      {
        type: "server_tool_use" as const,
        id: "srvtoolu_1",
        name: "tool_search_tool_bm25",
        input: { query: "droplet" },
      },
      {
        type: "tool_search_tool_result" as const,
        tool_use_id: "srvtoolu_1",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "digitalocean_create_droplet" }],
        },
      },
    ];
    expect(sanitizeForAnthropic(blocks)).toEqual(blocks);
  });
});

describe("anthropicProvider.streamTurn", () => {
  beforeEach(() => {
    streamCalls.length = 0;
  });

  it("stores the search pair in order and caches the conversation tail", async () => {
    const result = {
      type: "tool_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "digitalocean_create_droplet" }],
      },
    };
    streamEvents = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 7,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "tool_search_tool_bm25",
          input: {},
          caller: { type: "direct" },
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"droplet"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: result },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "digitalocean_create_droplet",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: '{"name":"web"}' },
      },
      { type: "content_block_stop", index: 3 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    ];

    const events: ProviderEvent[] = [];
    for await (const ev of anthropicProvider.streamTurn({
      model: "claude-sonnet-5-5",
      system: "sys",
      tools: [tool("list_resources"), tool("digitalocean_create_droplet", true)],
      messages: [{ role: "user", content: [{ type: "text", text: "make a droplet" }] }],
      maxTokens: 1000,
    })) {
      events.push(ev);
    }

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("no done event");
    expect(done.blocks).toEqual([
      { type: "text", text: "Looking." },
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "tool_search_tool_bm25",
        input: { query: "droplet" },
        caller: { type: "direct" },
      },
      result,
      {
        type: "tool_use",
        id: "toolu_1",
        name: "digitalocean_create_droplet",
        input: { name: "web" },
      },
    ]);
    expect(done.usage).toEqual({
      inputTokens: 10,
      outputTokens: 42,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
    });
    // Only the client tool's input streams to the UI; the search is not a tool card.
    expect(
      events
        .filter((e) => e.type === "tool_use_start")
        .map((e) => e.type === "tool_use_start" && e.name),
    ).toEqual(["digitalocean_create_droplet"]);

    const params = streamCalls[0]!;
    expect(params["cache_control"]).toEqual({ type: "ephemeral" });
    const tools = params["tools"] as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual([
      "tool_search_tool_bm25",
      "list_resources",
      "digitalocean_create_droplet",
    ]);
  });
});
