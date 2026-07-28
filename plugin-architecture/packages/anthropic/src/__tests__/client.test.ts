import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { AnthropicClient } from "../client.js";

const ACCOUNT = "acct-1";

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

function headerOf(init: RequestInit | undefined, key: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[key];
}

function client(withAdmin = true) {
  return new AnthropicClient({
    apiKey: "sk-ant-api03-test",
    ...(withAdmin ? { adminApiKey: "sk-ant-admin01-test" } : {}),
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("headers", () => {
  it("sends x-api-key plus the mandatory anthropic-version on every call", async () => {
    installFetch(() => jsonResponse({ data: [], has_more: false }));
    await client().listResources("model", ACCOUNT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(headerOf(calls[0]!.init, "x-api-key")).toBe("sk-ant-api03-test");
    expect(headerOf(calls[0]!.init, "anthropic-version")).toBe("2023-06-01");
    expect(headerOf(calls[0]!.init, "anthropic-beta")).toBeUndefined();
  });

  it("swaps in the admin key for /v1/organizations/* and keeps it off data-plane calls", async () => {
    installFetch(() => jsonResponse({ data: [], has_more: false }));
    await client().listResources("workspace", ACCOUNT);

    expect(calls[0]!.url).toBe(
      "https://api.anthropic.com/v1/organizations/workspaces?include_archived=true&limit=100",
    );
    expect(headerOf(calls[0]!.init, "x-api-key")).toBe("sk-ant-admin01-test");
  });

  it("sends the files beta header only on the Files API", async () => {
    installFetch(() => jsonResponse({ data: [], has_more: false }));
    await client().listResources("file", ACCOUNT);

    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/files?limit=100");
    expect(headerOf(calls[0]!.init, "anthropic-beta")).toBe("files-api-2025-04-14");
  });
});

describe("pagination", () => {
  it("walks after_id / has_more / last_id until the cursor runs out", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/models?limit=100")) {
        return jsonResponse({
          data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }],
          has_more: true,
          last_id: "claude-opus-4-6",
        });
      }
      if (url.endsWith("/v1/models?limit=100&after_id=claude-opus-4-6")) {
        return jsonResponse({
          data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
          has_more: false,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const models = await client().listResources("model", ACCOUNT);
    expect(models.map((m) => m.displayName)).toEqual(["Claude Opus 4.6", "Claude Haiku 4.5"]);
    expect(calls).toHaveLength(2);
  });
});

describe("model mapping", () => {
  it("flattens the capabilities object into fields", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "claude-opus-4-6",
            display_name: "Claude Opus 4.6",
            created_at: "2026-02-04T00:00:00Z",
            max_input_tokens: 200000,
            max_tokens: 64000,
            capabilities: {
              batch: { supported: true },
              citations: { supported: false },
              code_execution: { supported: true },
              context_management: { supported: true },
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                max: { supported: false },
                xhigh: { supported: false },
              },
              image_input: { supported: true },
              pdf_input: { supported: true },
              structured_outputs: { supported: true },
              thinking: {
                supported: true,
                types: { adaptive: { supported: true }, enabled: { supported: false } },
              },
            },
          },
        ],
        has_more: false,
      }),
    );

    const [model] = await client().listResources("model", ACCOUNT);
    expect(model!.fields["maxInputTokens"]).toBe(200000);
    expect(model!.fields["vision"]).toBe(true);
    expect(model!.fields["citations"]).toBe(false);
    expect(model!.fields["effortLevels"]).toBe("low, medium, high");
    expect(model!.fields["thinkingTypes"]).toBe("adaptive");
    expect(model!.resolvedOutputs["modelId"]).toBe("claude-opus-4-6");
  });
});

describe("admin degradation", () => {
  it("lists admin-only types as empty rather than throwing when no admin key is set", async () => {
    const spy = installFetch(() => jsonResponse({ data: [], has_more: false }));
    const noAdmin = client(false);

    expect(await noAdmin.listResources("workspace", ACCOUNT)).toEqual([]);
    expect(await noAdmin.listResources("organization-user", ACCOUNT)).toEqual([]);
    expect(await noAdmin.listResources("invite", ACCOUNT)).toEqual([]);
    expect(await noAdmin.listResources("api-key", ACCOUNT)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns an empty metric series without an admin key", async () => {
    const spy = installFetch(() => jsonResponse({ data: [] }));
    const series = await client(false).fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:claude-opus-4-6`,
      ACCOUNT,
    );
    expect(series).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("raises a CostSetupError with a help link when cost collection has no admin key", async () => {
    await expect(
      client(false).fetchCostData(ACCOUNT, { fromDate: "2026-07-01", toDate: "2026-07-07" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchCostData", () => {
  it("requests daily buckets and converts the cents-denominated amount string to dollars", async () => {
    installFetch((url) => {
      if (url.includes("/v1/organizations/cost_report")) {
        return jsonResponse({
          data: [
            {
              starting_at: "2026-07-01T00:00:00Z",
              ending_at: "2026-07-02T00:00:00Z",
              results: [
                {
                  amount: "123.78912",
                  currency: "USD",
                  cost_type: "tokens",
                  description: "Claude Opus 4.6 Usage - Input Tokens",
                  workspace_id: "wrkspc_1",
                },
                {
                  amount: "50",
                  currency: "USD",
                  cost_type: "web_search",
                  description: null,
                  workspace_id: null,
                },
              ],
            },
          ],
          has_more: false,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-07",
    });

    const url = calls[0]!.url;
    expect(url).toContain("bucket_width=1d");
    expect(url).toContain("starting_at=2026-07-01T00%3A00%3A00Z");
    // ending_at is exclusive, so it must be midnight *after* the last day.
    expect(url).toContain("ending_at=2026-07-08T00%3A00%3A00Z");
    expect(url).toContain("group_by%5B%5D=description");
    expect(url).toContain("group_by%5B%5D=workspace_id");

    expect(rows).toHaveLength(2);
    // "123.78912" cents === $1.2378912, NOT $123.79.
    expect(rows[0]).toEqual({
      date: "2026-07-01",
      service: "Claude Opus 4.6 Usage - Input Tokens",
      resourceId: "wrkspc_1",
      currency: "USD",
      amount: 1.2378912,
    });
    expect(rows[1]!.amount).toBe(0.5);
    expect(rows[1]!.service).toBe("web_search");
    expect(rows[1]!.resourceId).toBe("default-workspace");
  });
});

describe("fetchMetricSeries", () => {
  it("filters the usage report by model and sums each token family per bucket", async () => {
    installFetch((url) => {
      if (url.includes("/v1/organizations/usage_report/messages")) {
        return jsonResponse({
          data: [
            {
              starting_at: "2026-07-01T00:00:00Z",
              ending_at: "2026-07-02T00:00:00Z",
              results: [
                {
                  uncached_input_tokens: 1500,
                  output_tokens: 500,
                  cache_read_input_tokens: 200,
                  cache_creation: {
                    ephemeral_1h_input_tokens: 1000,
                    ephemeral_5m_input_tokens: 500,
                  },
                  server_tool_use: { web_search_requests: 10 },
                },
                { uncached_input_tokens: 500, output_tokens: 100 },
              ],
            },
          ],
          has_more: false,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const series = await client().fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:claude-opus-4-6`,
      ACCOUNT,
      { startMs: Date.parse("2026-07-01T00:00:00Z"), endMs: Date.parse("2026-07-08T00:00:00Z") },
    );

    expect(calls[0]!.url).toContain("models%5B%5D=claude-opus-4-6");
    expect(series.map((s) => s.label)).toEqual([
      "Input tokens (uncached)",
      "Output tokens",
      "Cache read tokens",
      "Cache write tokens",
      "Web search requests",
    ]);
    expect(series[0]!.points[0]!.value).toBe(2000);
    expect(series[1]!.points[0]!.value).toBe(600);
    expect(series[3]!.points[0]!.value).toBe(1500);
  });

  it("filters by workspace id for workspace resources", async () => {
    installFetch(() => jsonResponse({ data: [], has_more: false }));
    await client().fetchMetricSeries("workspace", `${ACCOUNT}:workspace:wrkspc_1`, ACCOUNT);
    expect(calls[0]!.url).toContain("workspace_ids%5B%5D=wrkspc_1");
  });
});

describe("API key lifecycle", () => {
  it('revokes a key by POSTing status "inactive" — there is no DELETE', async () => {
    installFetch((url, init) => {
      if (url.endsWith("/v1/organizations/api_keys/apikey_1") && init?.method === "POST") {
        return jsonResponse({ id: "apikey_1", name: "Developer Key", status: "inactive" });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    await client().invokeAction(
      "api-key",
      `${ACCOUNT}:api-key:apikey_1`,
      "deactivate-key",
      ACCOUNT,
    );

    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ status: "inactive" });
  });

  it("refuses deleteResource for API keys and points at deactivation", async () => {
    await expect(
      client().deleteResource("api-key", `${ACCOUNT}:api-key:apikey_1`, ACCOUNT),
    ).rejects.toThrow(/cannot be deleted through the API/);
  });

  it("refuses getCreateConfig for API keys", async () => {
    await expect(client().getCreateConfig("api-key")).rejects.toThrow(
      /cannot be created through the API/,
    );
  });

  it('rejects "expired" as a settable status', async () => {
    await expect(
      client().updateResource("api-key", `${ACCOUNT}:api-key:apikey_1`, ACCOUNT, {
        status: "expired",
      }),
    ).rejects.toThrow(/state the API reports/);
  });
});

describe("workspace lifecycle", () => {
  it("archives through the dedicated endpoint and never a DELETE", async () => {
    installFetch((url, init) => {
      if (
        url.endsWith("/v1/organizations/workspaces/wrkspc_1/archive") &&
        init?.method === "POST"
      ) {
        return jsonResponse({ id: "wrkspc_1", name: "Old", archived_at: "2026-07-01T00:00:00Z" });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    await client().invokeAction(
      "workspace",
      `${ACCOUNT}:workspace:wrkspc_1`,
      "archive-workspace",
      ACCOUNT,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("refuses deleteResource for workspaces and points at archiving", async () => {
    await expect(
      client().deleteResource("workspace", `${ACCOUNT}:workspace:wrkspc_1`, ACCOUNT),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("creates a workspace by name", async () => {
    installFetch(() => jsonResponse({ id: "wrkspc_new", name: "Production" }));
    const created = await client().createResource("workspace", ACCOUNT, { name: "Production" });

    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/organizations/workspaces");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ name: "Production" });
    expect(created.id).toBe(`${ACCOUNT}:workspace:wrkspc_new`);
  });
});

describe("batch lifecycle", () => {
  it("cancels via POST /cancel and deletes via DELETE", async () => {
    installFetch(() => jsonResponse({ id: "msgbatch_1", type: "message_batch_deleted" }));

    await client().invokeAction(
      "message-batch",
      `${ACCOUNT}:message-batch:msgbatch_1`,
      "cancel-batch",
      ACCOUNT,
    );
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages/batches/msgbatch_1/cancel");
    expect(calls[0]!.init?.method).toBe("POST");

    await client().deleteResource("message-batch", `${ACCOUNT}:message-batch:msgbatch_1`, ACCOUNT);
    expect(calls[1]!.url).toBe("https://api.anthropic.com/v1/messages/batches/msgbatch_1");
    expect(calls[1]!.init?.method).toBe("DELETE");
  });

  it("maps request_counts into a total", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "msgbatch_1",
            processing_status: "ended",
            request_counts: {
              processing: 0,
              succeeded: 50,
              errored: 30,
              canceled: 10,
              expired: 10,
            },
            created_at: "2026-07-01T00:00:00Z",
            results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
          },
        ],
        has_more: false,
      }),
    );

    const [batch] = await client().listResources("message-batch", ACCOUNT);
    expect(batch!.fields["totalRequests"]).toBe(100);
    expect(batch!.resolvedOutputs["resultsUrl"]).toContain("/results");
  });
});

describe("invites", () => {
  it("creates an invite with email and role", async () => {
    installFetch(() =>
      jsonResponse({ id: "invite_1", email: "a@b.com", role: "developer", status: "pending" }),
    );
    const created = await client().createResource("invite", ACCOUNT, {
      email: "a@b.com",
      role: "developer",
    });

    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      email: "a@b.com",
      role: "developer",
    });
    expect(created.fields["status"]).toBe("pending");
  });

  it("deletes an invite", async () => {
    installFetch(() => jsonResponse({}, 204));
    await client().deleteResource("invite", `${ACCOUNT}:invite:invite_1`, ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/organizations/invites/invite_1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});
