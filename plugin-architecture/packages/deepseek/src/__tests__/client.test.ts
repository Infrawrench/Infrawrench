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
    // Concurrency caps are documented, not returned — filled in from the docs.
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

describe("read-only surface", () => {
  it("implements no create, update, or delete", () => {
    const c = client() as unknown as Record<string, unknown>;
    expect(c["createResource"]).toBeUndefined();
    expect(c["updateResource"]).toBeUndefined();
    expect(c["deleteResource"]).toBeUndefined();
    expect(c["getCreateConfig"]).toBeUndefined();
    expect(c["fetchCostData"]).toBeUndefined();
    expect(c["fetchMetricSeries"]).toBeUndefined();
    // No speech API exists at DeepSeek, so no speech methods either.
    expect(c["synthesizeSpeech"]).toBeUndefined();
    expect(c["transcribeAudio"]).toBeUndefined();
  });
});
