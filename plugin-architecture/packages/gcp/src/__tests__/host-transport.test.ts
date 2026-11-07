import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GcpClient } from "../client.js";
import { manifest, plugin } from "../plugin.js";

type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  responseEncoding?: "utf8" | "binary";
};

function answer(status: number, value: unknown) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: "",
    rawBody: new TextEncoder().encode(JSON.stringify(value)),
  };
}

const TOKEN_HOST = "oauth2.googleapis.com";

function hostHttp(route?: (req: HostRequest, url: URL) => ReturnType<typeof answer> | null) {
  return vi.fn(async (req: HostRequest) => {
    const url = new URL(req.url);
    if (url.hostname === TOKEN_HOST) {
      return answer(200, { access_token: "tok", expires_in: 3600 });
    }
    return route?.(req, url) ?? answer(200, {});
  });
}

let privateKeyPem: string;
let keySerial = 0;

beforeAll(async () => {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
});

function credentials(extra: Record<string, string> = {}) {
  // A new key id per client, since access tokens are cached by key.
  keySerial += 1;
  return {
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: "proj",
      private_key_id: `key-${keySerial}`,
      private_key: privateKeyPem,
      client_email: "sa@proj.iam.gserviceaccount.com",
      client_id: "1",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    ...extra,
  };
}

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  fetchStub = vi.fn(async () => {
    throw new Error("global fetch must not be used");
  });
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("a socket must not be opened");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hosts = (request: ReturnType<typeof hostHttp>) =>
  request.mock.calls.map(([req]) => new URL(req.url).hostname);

describe("Google Cloud calls through the host's HTTP service", () => {
  it("gets its access token and reads a list through the host", async () => {
    const request = hostHttp((_req, url) =>
      url.hostname === "pubsub.googleapis.com" ? answer(200, { topics: [] }) : null,
    );
    const client = hostClient(
      new GcpClient(credentials(), plugin.resourceTypes, { http: { request } }),
    );

    await client.listResources("pubsub-topic", "acct");

    expect(hosts(request)).toEqual([TOKEN_HOST, "pubsub.googleapis.com"]);
    const read = request.mock.calls[1]![0];
    expect(read.headers["authorization"]).toBe("Bearer tok");
    expect(read).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("deletes through the host", async () => {
    const request = hostHttp((req, url) =>
      req.method === "GET" && url.hostname === "pubsub.googleapis.com"
        ? answer(200, { topics: [{ name: "projects/proj/topics/t" }] })
        : null,
    );
    const client = hostClient(
      new GcpClient(credentials(), plugin.resourceTypes, { http: { request } }),
    );

    await client.deleteResource("pubsub-topic", "acct:pubsub-topic:projects/proj/topics/t", "acct");

    expect(request.mock.calls.map(([req]) => req.method)).toContain("DELETE");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("publishes through the host", async () => {
    const request = hostHttp((_req, url) =>
      url.pathname.endsWith(":publish") ? answer(200, { messageIds: ["m1"] }) : null,
    );
    const client = hostClient(
      new GcpClient(credentials(), plugin.resourceTypes, { http: { request } }),
    );

    await client.publishMessage!("pubsub-topic", "acct:pubsub-topic:t", "acct", {
      body: "hi",
      extras: {},
    });

    expect(hosts(request)).toContain("pubsub.googleapis.com");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reads the billing export through the host", async () => {
    const request = hostHttp((_req, url) =>
      url.hostname === "bigquery.googleapis.com"
        ? answer(200, { jobComplete: true, schema: { fields: [] }, rows: [] })
        : null,
    );
    const client = hostClient(
      new GcpClient(
        credentials({ billingExportTable: "proj.billing.export" }),
        plugin.resourceTypes,
        {
          http: { request },
        },
      ),
    );

    await client.fetchCostData!("acct", { fromDate: "2026-10-01", toDate: "2026-10-31" });

    expect(hosts(request)).toContain("bigquery.googleapis.com");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("estimates a query's cost through the host", async () => {
    const request = hostHttp((_req, url) =>
      url.hostname === "bigquery.googleapis.com"
        ? answer(200, { statistics: { query: { totalBytesProcessed: "1024" } } })
        : null,
    );
    const client = hostClient(
      new GcpClient(credentials(), plugin.resourceTypes, { http: { request } }),
    );

    await client.estimateQueryCost!("acct:bigquery-dataset:proj:ds", "acct", "SELECT 1");

    expect(hosts(request)).toContain("bigquery.googleapis.com");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("runs the preflight through the host", async () => {
    const request = hostHttp((_req, url) =>
      url.hostname === "cloudresourcemanager.googleapis.com"
        ? answer(200, { permissions: [] })
        : null,
    );
    const client = hostClient(
      new GcpClient(credentials(), plugin.resourceTypes, { http: { request } }),
    );

    await client.verifyCredentials!();

    expect(hosts(request)).toEqual(
      expect.arrayContaining([TOKEN_HOST, "cloudresourcemanager.googleapis.com"]),
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("streams Vertex AI chat through the host", async () => {
    const encoder = new TextEncoder();
    const request = hostHttp();
    const requestStream = vi.fn(async (_req: HostRequest) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
          );
          c.close();
        },
      }),
    }));
    const client = hostClient(
      new GcpClient(credentials(), plugin.resourceTypes, { http: { request, requestStream } }),
    );

    const chunks: unknown[] = [];
    for await (const chunk of client.streamChatMessage!(
      "vertex-gemini-model",
      "acct:vertex-gemini-model:gemini-x",
      "acct",
      [{ role: "user", content: "hello" }],
    )) {
      chunks.push(chunk);
    }

    expect(requestStream).toHaveBeenCalledOnce();
    expect(new URL(requestStream.mock.calls[0]![0].url).hostname).toMatch(/\.googleapis\.com$/);
    expect(chunks.length).toBeGreaterThan(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    "sharedCtx",
    "firestoreCtx",
    "cloudRunCtx",
    "cloudArmorCtx",
    "bqSpannerCtx",
    "createCtx",
    "businessMetricCtx",
  ])("hands the host's services to %s", (getter) => {
    const http = { request: hostHttp() };
    const client = new GcpClient(credentials(), plugin.resourceTypes, { http });
    const contexts = client as unknown as Record<string, { hostServices?: { http?: unknown } }>;
    expect(contexts[getter]!.hostServices?.http).toBe(http);
  });

  it("names no direct fetch outside the one call that is not to Google", async () => {
    const { readdirSync, readFileSync } = await vi.importActual<{
      readdirSync: (dir: URL) => string[];
      readFileSync: (file: URL, encoding: "utf8") => string;
    }>("node:fs");
    const src = new URL("../", import.meta.url);
    const direct: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts") || name.endsWith(".gen.ts")) continue;
      readFileSync(new URL(name, src), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.replace(/^\s*(\/\/|\*).*/, "");
          if (/(^|[^.\w])fetch\(/.test(code) && !code.includes("api.ipify.org")) {
            direct.push(`${name}:${i + 1}`);
          }
        });
    }
    expect(direct).toEqual([]);
  });

  it("declares the hosts it calls", () => {
    expect(manifest.egressHosts).toContain("*.googleapis.com");
  });
});
