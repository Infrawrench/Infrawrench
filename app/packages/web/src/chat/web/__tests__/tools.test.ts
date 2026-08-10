import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// tools.ts reaches billing, which reaches the db client at import time. None of
// these cases dispatch a tool, so a stub keeps the suite from needing a DATABASE_URL.
// Billing also reaches server-core's shared AI spend helper, which imports
// server-core's own db client — a separate module from the web alias above, so
// both need their own stubs or the suite fails at import.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/billing/ai-usage", () => ({
  getAiSpendStatus: () =>
    Promise.resolve({
      monthToDateMicros: 0,
      monthlyCapMicros: null,
      exceeded: false,
      freeTier: false,
      complimentary: false,
    }),
  reserveAiSpend: () => Promise.resolve("res-test"),
  releaseAiSpendReservation: () => Promise.resolve(),
  AiSpendCapExceededError: class AiSpendCapExceededError extends Error {},
  estimateTokensFromChars: (n: number) => Math.max(1, Math.ceil(n / 4)),
}));

import { searchBackend, isWebSearchConfigured } from "../backend";
import { webChatToolSpecs } from "../tools";
import { validateFetchUrl } from "../fetch";
import { computeSearchCostMicros } from "../../pricing";

const ENV_KEYS = [
  "GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_API_KEY",
  "INFRAWRENCH_CHAT_SEARCH_BACKEND",
  "WORKFLOW_FETCH_PROXY_URL",
  "WORKFLOW_FETCH_PROXY_TOKEN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("searchBackend", () => {
  it("is null when nothing is configured", () => {
    expect(searchBackend()).toBeNull();
    expect(isWebSearchConfigured()).toBe(false);
  });

  it("prefers Vertex, the credential the default deployment already has", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "proj";
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    expect(searchBackend()?.id).toBe("vertex");
  });

  it("uses Anthropic when that is the only key present", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    expect(searchBackend()?.id).toBe("anthropic");
  });

  it("honours the operator override", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "proj";
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["INFRAWRENCH_CHAT_SEARCH_BACKEND"] = "anthropic";
    expect(searchBackend()?.id).toBe("anthropic");
  });

  it("falls back to auto-selection when the override names an unconfigured backend", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "proj";
    process.env["INFRAWRENCH_CHAT_SEARCH_BACKEND"] = "anthropic";
    expect(searchBackend()?.id).toBe("vertex");
  });

  it("falls back to auto-selection when the override is a typo", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["INFRAWRENCH_CHAT_SEARCH_BACKEND"] = "antropic";
    expect(searchBackend()?.id).toBe("anthropic");
  });
});

describe("webChatToolSpecs", () => {
  it("offers nothing when the deployment can run neither tool", () => {
    expect(webChatToolSpecs()).toEqual([]);
  });

  it("offers only web_search without an egress proxy", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "proj";
    expect(webChatToolSpecs().map((t) => t.name)).toEqual(["web_search"]);
  });

  it("offers only web_fetch without a search backend", () => {
    process.env["WORKFLOW_FETCH_PROXY_URL"] = "https://egress.example.com";
    process.env["WORKFLOW_FETCH_PROXY_TOKEN"] = "tok";
    expect(webChatToolSpecs().map((t) => t.name)).toEqual(["web_fetch"]);
  });

  it("needs both proxy vars before offering web_fetch", () => {
    process.env["WORKFLOW_FETCH_PROXY_URL"] = "https://egress.example.com";
    expect(webChatToolSpecs()).toEqual([]);
  });

  it("keeps both tools read-tier and ungated, so neither prompts for approval", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "proj";
    process.env["WORKFLOW_FETCH_PROXY_URL"] = "https://egress.example.com";
    process.env["WORKFLOW_FETCH_PROXY_TOKEN"] = "tok";
    const specs = webChatToolSpecs();
    expect(specs.map((t) => t.name).sort()).toEqual(["web_fetch", "web_search"]);
    for (const spec of specs) {
      expect(spec.risk).toBe("read");
      expect(spec.permission).toBeNull();
    }
  });
});

describe("validateFetchUrl", () => {
  it("accepts http and https", () => {
    expect(validateFetchUrl("https://example.com/a").host).toBe("example.com");
    expect(validateFetchUrl("http://example.com").protocol).toBe("http:");
  });

  it("rejects other schemes before they reach the proxy", () => {
    expect(() => validateFetchUrl("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => validateFetchUrl("gopher://example.com")).toThrow(/Only http and https/);
  });

  it("rejects a relative URL", () => {
    expect(() => validateFetchUrl("/etc/passwd")).toThrow(/valid absolute URL/);
  });
});

describe("computeSearchCostMicros", () => {
  it("is zero when no query ran", () => {
    expect(computeSearchCostMicros("vertex", 0)).toBe(0);
    expect(computeSearchCostMicros("anthropic", -1)).toBe(0);
  });

  it("bills per query at list x1.5", () => {
    // $0.014 x 1.5 = $0.021
    expect(computeSearchCostMicros("vertex", 1)).toBe(21_000);
    expect(computeSearchCostMicros("vertex", 3)).toBe(63_000);
    // $0.010 x 1.5 = $0.015
    expect(computeSearchCostMicros("anthropic", 2)).toBe(30_000);
  });

  it("charges an unknown backend at the most expensive rate", () => {
    expect(computeSearchCostMicros("mystery", 1)).toBe(21_000);
  });
});
