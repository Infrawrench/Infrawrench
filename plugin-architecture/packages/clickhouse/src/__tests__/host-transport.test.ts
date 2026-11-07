import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClickHouseClient } from "../client.js";
import { manifest } from "../plugin.js";

// The real ClickHouse client: what is under test is how its requests leave.
type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
};

const SQL_HOST = "abc123.us-east-1.aws.clickhouse.cloud";

function hostHttp(body: string) {
  return vi.fn(async (_req: HostRequest) => ({
    status: 200,
    headers: {},
    body: "",
    rawBody: new TextEncoder().encode(body),
  }));
}

function makeClient(request: ReturnType<typeof hostHttp>) {
  return new ClickHouseClient(
    {
      apiKeyId: "id",
      apiKeySecret: "secret",
      organizationId: "org",
      chHost: SQL_HOST,
      chUser: "default",
      chPassword: "pw",
      caCert: "PEM",
    },
    { http: { request } },
  ) as unknown as {
    chQueryAt(host: string, sql: string): Promise<Record<string, unknown>[]>;
    chCommandAt(host: string, sql: string): Promise<void>;
    businessMetricCtx: {
      makeClient(opts: { requestTimeoutMs: number }): {
        query(params: { query: string; format: "JSONEachRow" }): Promise<{
          json<T>(): Promise<T[]>;
        }>;
      } | null;
    };
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

describe("ClickHouse SQL through the host's HTTP service", () => {
  it("sends a query through the host with the custom CA and reads its rows", async () => {
    const request = hostHttp('{"n":1}\n{"n":2}\n');

    const rows = await makeClient(request).chQueryAt(SQL_HOST, "SELECT n");

    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(fetchStub).not.toHaveBeenCalled();
    const req = request.mock.calls[0]![0];
    expect(new URL(req.url).hostname).toBe(SQL_HOST);
    expect(req.method).toBe("POST");
    expect(req.caCert).toBe("PEM");
    expect(req.body).toContain("SELECT n");
  });

  it("sends a command through the host", async () => {
    const request = hostHttp("");

    await makeClient(request).chCommandAt(SQL_HOST, "KILL QUERY WHERE 1");

    expect(request).toHaveBeenCalledOnce();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("sends a business metric import through the host", async () => {
    const request = hostHttp('{"n":1}\n');
    const sdk = makeClient(request).businessMetricCtx.makeClient({ requestTimeoutMs: 1000 })!;

    const result = await sdk.query({ query: "SELECT n", format: "JSONEachRow" });

    expect(await result.json()).toEqual([{ n: 1 }]);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("egress hosts", () => {
  const matches = (host: string) =>
    manifest.egressHosts.some((pattern) =>
      pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
    );

  it("names the Cloud API and ClickHouse Cloud's SQL services", () => {
    expect(matches("api.clickhouse.cloud")).toBe(true);
    expect(matches(SQL_HOST)).toBe(true);
  });
});
