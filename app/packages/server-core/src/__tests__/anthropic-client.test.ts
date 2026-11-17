import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { anthropicClient, isAnthropicConfigured } from "../anthropic-client";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "AI_GATEWAY_ID",
  "AI_GATEWAY_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
let requests: Array<{ url: string; headers: Headers }>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  requests = [];
  // The SDK picks up the global fetch when the client is built, so this has
  // to be in place before anthropicClient() runs.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function send(): Promise<{ url: string; headers: Headers }> {
  await anthropicClient({ maxRetries: 0 }).messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
  const [request] = requests;
  if (!request) throw new Error("no request was sent");
  return request;
}

describe("anthropicClient", () => {
  it("is unconfigured with nothing set", () => {
    expect(isAnthropicConfigured()).toBe(false);
    expect(() => anthropicClient()).toThrow(/not configured/);
  });

  it("needs all three gateway variables", () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acct";
    process.env["AI_GATEWAY_ID"] = "app";
    expect(isAnthropicConfigured()).toBe(false);
  });

  it("calls the gateway's Anthropic endpoint with the gateway token and no provider key", async () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acct";
    process.env["AI_GATEWAY_ID"] = "app";
    process.env["AI_GATEWAY_TOKEN"] = "gw-token";
    // Present, and still never sent: a key on the request would bypass
    // Unified Billing.
    process.env["ANTHROPIC_API_KEY"] = "sk-should-not-be-sent";

    const { url, headers } = await send();
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/acct/app/anthropic/v1/messages");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer gw-token");
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
  });

  it("falls back to Anthropic directly with a key", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-direct";

    const { url, headers } = await send();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("sk-direct");
    expect(headers.has("cf-aig-authorization")).toBe(false);
  });
});
