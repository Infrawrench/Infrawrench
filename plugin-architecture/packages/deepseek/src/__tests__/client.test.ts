import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../client.js";

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

function client() {
  return new DeepSeekClient({ apiKey: "sk-test" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listResources", () => {
  it("calls the canonical /models path — no /v1 segment — with a bearer token", async () => {
    installFetch(() =>
      jsonResponse({
        object: "list",
        data: [
          { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
          { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
        ],
      }),
    );

    const models = await client().listResources("model", ACCOUNT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");

    expect(models.map((m) => m.displayName)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    // Concurrency caps are documented, not returned: filled in from the docs.
    expect(models[0]!.fields["concurrencyLimit"]).toBe(2500);
    expect(models[1]!.fields["concurrencyLimit"]).toBe(500);
  });

  it("parses the string-encoded balance amounts into numbers", async () => {
    installFetch(() =>
      jsonResponse({
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "110.00",
            granted_balance: "10.00",
            topped_up_balance: "100.00",
          },
          {
            currency: "USD",
            total_balance: "15.50",
            granted_balance: "0.00",
            topped_up_balance: "15.50",
          },
        ],
      }),
    );

    const balances = await client().listResources("balance", ACCOUNT);

    expect(calls[0]!.url).toBe("https://api.deepseek.com/user/balance");
    expect(balances).toHaveLength(2);
    expect(balances[0]!.id).toBe(`${ACCOUNT}:balance:CNY`);
    // Numbers, not the raw "110.00" strings the API sends.
    expect(balances[0]!.fields["totalBalance"]).toBe(110);
    expect(balances[0]!.fields["grantedBalance"]).toBe(10);
    expect(balances[0]!.fields["toppedUpBalance"]).toBe(100);
    expect(balances[0]!.fields["isAvailable"]).toBe(true);
    expect(balances[1]!.fields["totalBalance"]).toBe(15.5);
  });

  it("propagates is_available: false onto every currency row", async () => {
    installFetch(() =>
      jsonResponse({
        is_available: false,
        balance_infos: [{ currency: "USD", total_balance: "0.00" }],
      }),
    );

    const [balance] = await client().listResources("balance", ACCOUNT);
    expect(balance!.fields["isAvailable"]).toBe(false);
    expect(balance!.resolvedOutputs["isAvailable"]).toBe("false");
  });

  it("rejects unknown resource types", async () => {
    await expect(client().listResources("workspace", ACCOUNT)).rejects.toThrow(
      /unknown resource type/,
    );
  });
});

describe("fetchDashboardStats", () => {
  it("surfaces the balance as the account's headline stat", async () => {
    installFetch(() =>
      jsonResponse({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "42.75",
            granted_balance: "5.00",
            topped_up_balance: "37.75",
          },
        ],
      }),
    );

    const stats = await client().fetchDashboardStats("balance", `${ACCOUNT}:balance:USD`, ACCOUNT);

    expect(stats).toEqual([
      { label: "Balance", value: "42.75 USD", variant: "status-healthy" },
      { label: "Granted", value: "5.00 USD" },
      { label: "Topped up", value: "37.75 USD" },
    ]);
  });

  it("marks an unavailable balance as an error", async () => {
    installFetch(() =>
      jsonResponse({
        is_available: false,
        balance_infos: [{ currency: "USD", total_balance: "0.00" }],
      }),
    );

    const stats = await client().fetchDashboardStats("balance", `${ACCOUNT}:balance:USD`, ACCOUNT);
    expect(stats[0]!.variant).toBe("status-error");
  });
});

describe("resolveOutput", () => {
  it("resolves a model id without a round-trip", async () => {
    const spy = installFetch(() => jsonResponse({ object: "list", data: [] }));
    const modelId = await client().resolveOutput(
      "model",
      `${ACCOUNT}:model:deepseek-v4-pro`,
      "modelId",
      ACCOUNT,
    );
    expect(modelId).toBe("deepseek-v4-pro");
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves the balance total from the live endpoint", async () => {
    installFetch(() =>
      jsonResponse({
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "7.25" }],
      }),
    );
    const total = await client().resolveOutput(
      "balance",
      `${ACCOUNT}:balance:USD`,
      "totalBalance",
      ACCOUNT,
    );
    expect(total).toBe("7.25");
  });
});

describe("models metadata", () => {
  it("maps the context window, modalities, effort levels and legacy aliases", async () => {
    installFetch(() =>
      jsonResponse({
        object: "list",
        data: [
          {
            id: "deepseek-flash",
            object: "model",
            owned_by: "deepseek",
            name: "DeepSeek-V4.1-Flash",
            context_window: 1048576,
            max_output_tokens: 393216,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
            api_capabilities: { anthropic_messages: { system_prompt_update: "in-history" } },
          },
        ],
      }),
    );

    const [model] = await client().listResources("model", ACCOUNT);
    expect(model!.fields).toMatchObject({
      modelId: "deepseek-flash",
      name: "DeepSeek-V4.1-Flash",
      contextWindow: 1048576,
      maxOutputTokens: 393216,
      inputModalities: "text, image",
      outputModalities: "text",
      effortLevels: "low, high, max",
      defaultEffort: "high",
      anthropicSystemPromptUpdate: "in-history",
      concurrencyLimit: 2500,
      legacyAliases: "deepseek-v4-flash, deepseek-v4-flash-vision-exp",
    });
    expect(model!.resolvedOutputs["contextWindow"]).toBe("1048576");

    const stats = await client().fetchDashboardStats("model", model!.id, ACCOUNT);
    expect(stats).toContainEqual({ label: "Context", value: "1M" });
    expect(stats).toContainEqual({ label: "Max output", value: "384K" });
  });
});

describe("files", () => {
  it("pages through GET /files with the after cursor", async () => {
    installFetch((url) => {
      if (url.includes("after=file-api-b")) {
        return jsonResponse({
          object: "list",
          data: [
            {
              id: "file-api-c",
              object: "file",
              bytes: 2048,
              created_at: 1_700_000_200,
              filename: "c.png",
              purpose: "user_data",
            },
          ],
          first_id: "file-api-c",
          last_id: "file-api-c",
          has_more: false,
        });
      }
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "file-api-a",
            object: "file",
            bytes: 102400,
            created_at: 1_700_000_000,
            filename: "a.jpg",
            purpose: "user_data",
            expires_at: 1_700_003_600,
          },
          {
            id: "file-api-b",
            object: "file",
            bytes: 10,
            created_at: 1_700_000_100,
            filename: "b.webp",
            purpose: "user_data",
          },
        ],
        first_id: "file-api-a",
        last_id: "file-api-b",
        has_more: true,
      });
    });

    const files = await client().listResources("file", ACCOUNT);

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.deepseek.com/files?limit=1000&order=desc",
      "https://api.deepseek.com/files?limit=1000&order=desc&after=file-api-b",
    ]);
    expect(files.map((f) => f.id)).toEqual([
      `${ACCOUNT}:file:file-api-a`,
      `${ACCOUNT}:file:file-api-b`,
      `${ACCOUNT}:file:file-api-c`,
    ]);
    expect(files[0]!.fields).toMatchObject({
      fileId: "file-api-a",
      filename: "a.jpg",
      bytes: 102400,
      purpose: "user_data",
      createdAt: "2023-11-14T22:13:20.000Z",
      expiresAt: "2023-11-14T23:13:20.000Z",
    });
    // No expiry at upload means the file is kept forever.
    expect(files[1]!.fields["expiresAt"]).toBe("");
  });

  it("deletes a file with DELETE /files/{id}", async () => {
    installFetch(() => jsonResponse({ id: "file-api-a", object: "file", deleted: true }));

    await client().deleteResource("file", `${ACCOUNT}:file:file-api-a`, ACCOUNT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/files/file-api-a");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("surfaces deleted: false as an error", async () => {
    installFetch(() => jsonResponse({ id: "file-api-a", object: "file", deleted: false }));
    await expect(
      client().deleteResource("file", `${ACCOUNT}:file:file-api-a`, ACCOUNT),
    ).rejects.toThrow(/not deleted/);
  });

  it("refuses to delete anything but a file", async () => {
    await expect(
      client().deleteResource("balance", `${ACCOUNT}:balance:USD`, ACCOUNT),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("resolves a file id without a round-trip", async () => {
    const spy = installFetch(() => jsonResponse({}));
    const fileId = await client().resolveOutput(
      "file",
      `${ACCOUNT}:file:file-api-a`,
      "fileId",
      ACCOUNT,
    );
    expect(fileId).toBe("file-api-a");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("limited surface", () => {
  it("implements no create or update, and no cost or speech hooks", () => {
    const c = client() as unknown as Record<string, unknown>;
    expect(c["createResource"]).toBeUndefined();
    expect(c["updateResource"]).toBeUndefined();
    expect(c["getCreateConfig"]).toBeUndefined();
    expect(c["fetchCostData"]).toBeUndefined();
    expect(c["fetchMetricSeries"]).toBeUndefined();
    // No speech API exists at DeepSeek, so no speech methods either.
    expect(c["synthesizeSpeech"]).toBeUndefined();
    expect(c["transcribeAudio"]).toBeUndefined();
  });
});
