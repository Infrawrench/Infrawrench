import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeGraphClient } from "../graph-client.js";
import { manifest } from "../plugin.js";

// The real Graph SDK: what is under test is how its requests leave.
type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};

function answer(status: number, value: unknown) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: "",
    rawBody: new TextEncoder().encode(JSON.stringify(value)),
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

describe("Microsoft Graph through the host's HTTP service", () => {
  const token = { graphToken: async () => "graph-tok" };

  it("sends a read through the host with its token and reads the answer", async () => {
    const request = vi.fn(async (_req: HostRequest) => answer(200, { value: [{ id: "a1" }] }));

    const res = await makeGraphClient(token, { request }).api("/applications").get();

    expect(res).toEqual({ value: [{ id: "a1" }] });
    expect(fetchStub).not.toHaveBeenCalled();
    const req = request.mock.calls[0]![0];
    expect(req.url).toBe("https://graph.microsoft.com/v1.0/applications");
    expect(req.method).toBe("GET");
    expect(req.headers["authorization"]).toBe("Bearer graph-tok");
  });

  it("sends a write's JSON body through the host", async () => {
    const request = vi.fn(async (_req: HostRequest) => answer(201, { id: "a1" }));

    await makeGraphClient(token, { request }).api("/applications").post({ displayName: "x" });

    const req = request.mock.calls[0]![0];
    expect(req.method).toBe("POST");
    expect(req.body).toBe(JSON.stringify({ displayName: "x" }));
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("surfaces a failed status as the SDK's error", async () => {
    const request = vi.fn(async (_req: HostRequest) =>
      answer(403, { error: { code: "Forbidden", message: "nope" } }),
    );

    await expect(makeGraphClient(token, { request }).api("/me").get()).rejects.toMatchObject({
      statusCode: 403,
      code: "Forbidden",
    });
  });

  it("names Graph's host in the egress list", () => {
    expect(manifest.egressHosts).toContain("graph.microsoft.com");
  });
});
