/**
 * Every Azure request must prefer the host's HTTP service when the host
 * supplies one, and must behave exactly as it did before when it does not.
 * The first half is what makes bastion routing and custom CA trust reach
 * Azure at all; the second is what keeps the renderer and the tests working.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { HttpHostServices } from "@infrawrench/plugin-base";

import { AzureClient } from "../client.js";
import { azureRequest } from "../http.js";
import { fetchAzurePricingRates } from "../pricing.js";
import { fetchAccessToken } from "../auth.js";

const creds = {
  tenantId: "t1",
  clientId: "c1",
  clientSecret: "s1",
  subscriptionId: "sub1",
};

const TOKEN_BODY = JSON.stringify({
  access_token: "arm-tok",
  expires_in: 3600,
  token_type: "Bearer",
});

/**
 * A host HTTP service that answers from a URL→response table. Anything not in
 * the table is a 200 with an empty JSON object, so a test only has to describe
 * the calls it cares about.
 */
function hostService(
  responses: Array<[RegExp, { status?: number; body?: string; headers?: Record<string, string> }]>,
) {
  const calls: Array<Parameters<HttpHostServices["request"]>[0]> = [];
  const request = vi.fn(async (req: Parameters<HttpHostServices["request"]>[0]) => {
    calls.push(req);
    for (const [pattern, res] of responses) {
      if (pattern.test(req.url)) {
        return { status: res.status ?? 200, headers: res.headers ?? {}, body: res.body ?? "{}" };
      }
    }
    return { status: 200, headers: {}, body: "{}" };
  });
  return { http: { request } as HttpHostServices, calls, request };
}

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
  } as unknown as Response;
}

describe("azureRequest", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  it("falls through to global fetch when no host service is supplied", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const res = await azureRequest(undefined, "https://example.test/x", {
      method: "POST",
      headers: { A: "b" },
      body: "payload",
    });
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith("https://example.test/x", {
      method: "POST",
      headers: { A: "b" },
      body: "payload",
    });
  });

  it("goes through the host service and never touches fetch when one is supplied", async () => {
    const { http, calls } = hostService([[/example\.test/, { body: '{"ok":true}' }]]);
    const res = await azureRequest(http, "https://example.test/x", {
      method: "POST",
      headers: { A: "b" },
      body: "payload",
    });
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls[0]).toEqual({
      url: "https://example.test/x",
      method: "POST",
      headers: { A: "b" },
      body: "payload",
    });
  });

  it("reports non-2xx as not-ok rather than throwing, and exposes the body", async () => {
    // Several call sites treat particular non-2xx statuses as success (blob
    // delete on 404, ARM DELETE on 202), so the helper must not throw.
    const { http } = hostService([[/./, { status: 404, body: "BlobNotFound" }]]);
    const res = await azureRequest(http, "https://example.test/x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("BlobNotFound");
  });

  it("reads response headers case-insensitively", async () => {
    // The host flattens Node's already-lower-cased header names; call sites
    // ask for "content-length" with whatever casing they were written in.
    const { http } = hostService([[/./, { headers: { "content-length": "0" }, body: "" }]]);
    const res = await azureRequest(http, "https://example.test/x");
    expect(res.headers.get("Content-Length")).toBe("0");
    expect(res.headers.get("x-missing")).toBeNull();
  });

  it("treats an empty host body as an empty object rather than a JSON crash", async () => {
    const { http } = hostService([[/./, { status: 204, body: "" }]]);
    const res = await azureRequest(http, "https://example.test/x");
    expect(await res.json()).toEqual({});
  });
});

describe("AzureClient routing", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes both the AAD token exchange and the ARM call through the host", async () => {
    const { http, calls } = hostService([
      [/login\.microsoftonline\.com/, { body: TOKEN_BODY }],
      [/resourcegroups/, { body: '{"value":[]}' }],
    ]);
    const client = new AzureClient(creds, [], { http });
    await client.listResources("azure-resource-group", "acct");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual([
      "https://login.microsoftonline.com/t1/oauth2/v2.0/token",
      "https://management.azure.com/subscriptions/sub1/resourcegroups?api-version=2022-09-01",
    ]);
    // The secret leaves through the host too — an account bound to a bastion
    // expects all of its egress to leave from its own network.
    expect(String(calls[0]!.body)).toContain("client_secret=s1");
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer arm-tok");
  });

  it("uses direct fetch when the host supplies no services at all", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "arm-tok", expires_in: 3600, token_type: "Bearer" }),
      )
      .mockResolvedValue(jsonResponse({ value: [] }));
    const client = new AzureClient(creds);
    await client.listResources("azure-resource-group", "acct");

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      "https://login.microsoftonline.com/t1/oauth2/v2.0/token",
      "https://management.azure.com/subscriptions/sub1/resourcegroups?api-version=2022-09-01",
    ]);
  });

  it("keeps the ARM error strings identical on the host path", async () => {
    const { http } = hostService([
      [/login\.microsoftonline\.com/, { body: TOKEN_BODY }],
      [/resourcegroups/, { status: 403, body: "AuthorizationFailed" }],
    ]);
    const client = new AzureClient(creds, [], { http });
    await expect(client.listResources("azure-resource-group", "acct")).rejects.toThrow(
      "Azure API 403: AuthorizationFailed",
    );
  });

  it("keeps the verb in write error strings", async () => {
    const { http } = hostService([
      [/login\.microsoftonline\.com/, { body: TOKEN_BODY }],
      // The action itself fails; the listing that resolves the VM succeeds.
      [/\/start\?/, { status: 409, body: "Conflict" }],
      [
        /virtualMachines/,
        {
          body: JSON.stringify({
            value: [
              {
                id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1",
                name: "vm1",
                location: "eastus",
                properties: {},
              },
            ],
          }),
        },
      ],
    ]);
    const client = new AzureClient(creds, [], { http });
    await expect(
      client.invokeAction("azure-vm", "acct:azure-vm:rg1/vm1", "start", "acct"),
    ).rejects.toThrow("Azure API POST 409: Conflict");
  });

  it("routes blob storage through the host", async () => {
    const { http, calls } = hostService([
      [/login\.microsoftonline\.com/, { body: TOKEN_BODY }],
      [
        /blob\.core\.windows\.net/,
        { body: '<?xml version="1.0"?><EnumerationResults><Blobs/></EnumerationResults>' },
      ],
    ]);
    const client = new AzureClient(creds, [], { http });
    await client.deleteStorageObject("acct1", "container/blob.txt");

    expect(fetchSpy).not.toHaveBeenCalled();
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe("https://acct1.blob.core.windows.net/container/blob.txt");
    expect(del.headers["x-ms-version"]).toBe("2023-11-03");
  });

  it("routes the whole ACR token dance and registry API through the host", async () => {
    const { http, calls } = hostService([
      [/login\.microsoftonline\.com/, { body: TOKEN_BODY }],
      [
        /Microsoft\.ContainerRegistry/,
        { body: JSON.stringify({ properties: { loginServer: "reg1.azurecr.io" } }) },
      ],
      [/oauth2\/exchange/, { body: '{"refresh_token":"rt"}' }],
      [/oauth2\/token/, { body: '{"access_token":"acr-tok"}' }],
      [/_catalog/, { body: '{"repositories":["app"]}' }],
      [/_tags/, { body: '{"tags":[{"name":"v1","digest":"sha256:abc"}]}' }],
    ]);
    const client = new AzureClient(creds, [], { http });
    const result = await client.listArtifacts(
      "azure-container-registry",
      "acct:azure-container-registry:rg1/reg1",
      "acct",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      { name: "app", tags: ["v1"], digest: "sha256:abc", version: "v1" },
    ]);
    // Both legs of the exchange and both registry reads went through the host.
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("https://reg1.azurecr.io/oauth2/exchange");
    expect(urls).toContain("https://reg1.azurecr.io/oauth2/token");
    expect(urls.some((u) => u.includes("/v2/_catalog"))).toBe(true);
    expect(urls.some((u) => u.includes("/_tags"))).toBe(true);
  });

  it("routes the Service Bus data plane through the host", async () => {
    const { http, calls } = hostService([
      [/login\.microsoftonline\.com/, { body: TOKEN_BODY }],
      [
        /namespaces/,
        {
          body: JSON.stringify({
            value: [
              {
                id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.ServiceBus/namespaces/ns1",
                name: "ns1",
                location: "eastus",
                properties: { serviceBusEndpoint: "https://ns1.servicebus.windows.net:443/" },
              },
            ],
          }),
        },
      ],
      [/servicebus\.windows\.net/, { status: 201, body: "" }],
    ]);
    const client = new AzureClient(creds, [], { http });
    await client.publishMessage("azure-service-bus", "acct:azure-service-bus:rg1/ns1", "acct", {
      body: "hello",
      extras: { entity: "q1" },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    const send = calls.find((c) => c.url.includes("servicebus.windows.net"))!;
    expect(send.url).toBe("https://ns1.servicebus.windows.net/q1/messages");
    expect(send.body).toBe("hello");
  });
});

describe("unauthenticated endpoints", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes the public Retail Prices API through the host when one exists", async () => {
    const { http, calls } = hostService([[/prices\.azure\.com/, { body: '{"Items":[]}' }]]);
    await fetchAzurePricingRates("eastus", http);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.url).toContain("prices.azure.com");
  });

  it("still reaches the Retail Prices API directly with no host", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ Items: [] }));
    await fetchAzurePricingRates("eastus");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("exchanges the AAD token directly when no host service is passed", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }),
    );
    await expect(fetchAccessToken(creds)).resolves.toBe("tok");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
