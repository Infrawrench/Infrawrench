import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAccessToken,
  fetchStorageAccessToken,
  fetchGraphAccessToken,
  fetchAcrAccessToken,
  fetchServiceBusAccessToken,
  type AzureCredentials,
} from "../auth.js";

const creds: AzureCredentials = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "secret-1",
  subscriptionId: "sub-1",
};

function okToken(token = "tok-123") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: 3600, token_type: "Bearer" }),
    text: async () => "",
  } as unknown as Response;
}

describe("auth token exchange", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchAccessToken posts client_credentials to the tenant token endpoint with the ARM scope", async () => {
    fetchSpy.mockResolvedValue(okToken("arm-token"));
    const token = await fetchAccessToken(creds);
    expect(token).toBe("arm-token");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = String(init!.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=client-1");
    expect(body).toContain("client_secret=secret-1");
    expect(body).toContain(encodeURIComponent("https://management.azure.com/.default"));
  });

  it("each scoped helper requests its own audience", async () => {
    const cases: Array<[(c: AzureCredentials) => Promise<string>, string]> = [
      [fetchStorageAccessToken, "https://storage.azure.com/.default"],
      [fetchGraphAccessToken, "https://graph.microsoft.com/.default"],
      [fetchAcrAccessToken, "https://containerregistry.azure.net/.default"],
      [fetchServiceBusAccessToken, "https://servicebus.azure.net/.default"],
    ];
    for (const [fn, scope] of cases) {
      fetchSpy.mockResolvedValueOnce(okToken());
      await fn(creds);
      const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]!;
      expect(String(lastCall[1]!.body)).toContain(encodeURIComponent(scope));
    }
  });

  it("throws a labeled error on a non-ok response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "bad creds",
      json: async () => ({}),
    } as unknown as Response);
    await expect(fetchAccessToken(creds)).rejects.toThrow(/Azure auth failed: 401 bad creds/);
  });

  it("throws when the token response shape is invalid (zod parse failure)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 123 }),
      text: async () => "",
    } as unknown as Response);
    await expect(fetchStorageAccessToken(creds)).rejects.toBeInstanceOf(Error);
  });
});
