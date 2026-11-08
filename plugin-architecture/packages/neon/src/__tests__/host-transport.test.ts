import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NeonClient } from "../client.js";
import { manifest } from "../plugin.js";

// The real SDK, unlike the other suites: what is under test is how its requests leave.
type HostRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
  responseEncoding?: "utf8" | "binary";
};

const json = (status: number, value: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: "",
  rawBody: new TextEncoder().encode(JSON.stringify(value)),
});

/** A host answering `answer`, where the key belongs to no organization unless it says so. */
function hostHttp(answer: (req: HostRequest) => ReturnType<typeof json>) {
  return vi.fn(async (req: HostRequest) =>
    new URL(req.url).pathname.endsWith("/users/me/organizations")
      ? json(200, { organizations: [] })
      : answer(req),
  );
}

function makeClient(request: ReturnType<typeof hostHttp>) {
  return hostClient(new NeonClient({ apiKey: "neon_test" }, { http: { request } }));
}

const PRESIGNED =
  "https://br-a1.storage.c-1.us-east-2.aws.neon.tech/assets/photo.png?X-Amz-Signature=s";

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

describe("Neon API calls through the host's HTTP service", () => {
  it("sends an SDK read through the host, with its query and key", async () => {
    const request = hostHttp((req) =>
      new URL(req.url).searchParams.get("cursor")
        ? json(200, { projects: [], pagination: {} })
        : json(200, { projects: [{ id: "p1", name: "one" }], pagination: { cursor: "c1" } }),
    );

    await makeClient(request).listResources("neon-project", "acct");

    expect(request).toHaveBeenCalledTimes(3);
    expect(new URL(request.mock.calls[2]![0].url).pathname).toBe("/api/v2/users/me/organizations");
    const req = request.mock.calls[1]![0];
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://console.neon.tech/api/v2/projects");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(req.method).toBe("GET");
    expect(req.headers["authorization"] ?? req.headers["Authorization"]).toBe("Bearer neon_test");
    expect(req).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reads each organization's projects with its org_id, keeping one row per project", async () => {
    const request = vi.fn(async (req: HostRequest) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/users/me/organizations")) {
        return json(200, { organizations: [{ id: "org-a" }, { id: "org-b" }] });
      }
      const ids = {
        "": ["p1"],
        "org-a": ["p1", "p2"],
        "org-b": ["p3"],
      }[url.searchParams.get("org_id") ?? ""];
      return json(200, {
        projects: (ids ?? []).map((id) => ({ id, name: id })),
        pagination: {},
      });
    });

    const rows = await makeClient(request).listResources("neon-project", "acct");

    expect(rows.map((r) => r.externalId)).toEqual(["p1", "p2", "p3"]);
    const orgIds = request.mock.calls.map(([r]) => new URL(r.url).searchParams.get("org_id"));
    expect(orgIds).toEqual([null, null, "org-a", "org-b"]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("parses the host's answer into the rows the plugin reads", async () => {
    const request = hostHttp(() =>
      json(200, {
        projects: [{ id: "p1", name: "one", region_id: "aws-us-east-2", created_at: "x" }],
        pagination: {},
      }),
    );

    const rows = await makeClient(request).listResources("neon-project", "acct");

    expect(rows.map((r) => r.externalId)).toEqual(["p1"]);
  });

  it("sends a JSON write's body through the host", async () => {
    const request = hostHttp((req) =>
      req.method === "DELETE"
        ? json(200, { project: { id: "p1" } })
        : json(200, { projects: [{ id: "p1", name: "one" }], pagination: {} }),
    );

    await makeClient(request).deleteResource("neon-project", "acct:neon-project:p1", "acct");

    const del = request.mock.calls.find(([req]) => req.method === "DELETE")![0];
    expect(new URL(del.url).pathname).toBe("/api/v2/projects/p1");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("gives a failed status the shape the plugin reads a refusal from", async () => {
    const request = hostHttp(() => json(500, { message: "boom" }));

    const failure = await makeClient(request)
      .listResources("neon-project", "acct")
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({
      message: "Request failed with status code 500",
      status: 500,
      response: { status: 500, data: { message: "boom" } },
    });
  });

  it("keeps a refused branch service reading as not available", async () => {
    const request = hostHttp((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/projects")) {
        return json(200, { projects: [{ id: "p1", name: "one" }], pagination: {} });
      }
      if (path.endsWith("/branches")) {
        return json(200, { branches: [{ id: "b1", name: "main" }], pagination: {} });
      }
      return json(404, { message: "not entitled" });
    });

    await expect(makeClient(request).listResources("neon-bucket", "acct")).resolves.toEqual([]);
  });

  it("lets a host's own failure through unchanged, so the host can still recognise it", async () => {
    class BastionDown extends Error {}
    const down = new BastionDown("bastion is not connected");
    const request = vi.fn(async (_req: HostRequest): Promise<ReturnType<typeof json>> => {
      throw down;
    });

    await expect(makeClient(request).listResources("neon-project", "acct")).rejects.toBe(down);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("Neon uploads through the host's HTTP service", () => {
  function storageHost(onPut: (req: HostRequest) => ReturnType<typeof json>) {
    return hostHttp((req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "PUT") return onPut(req);
      if (path.endsWith("/presign")) {
        return json(200, {
          url: PRESIGNED,
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          expires_at: "2026-11-07T00:00:00Z",
        });
      }
      if (path.endsWith("/projects")) {
        return json(200, { projects: [{ id: "p1", name: "one" }], pagination: {} });
      }
      if (path.endsWith("/branches")) {
        return json(200, { branches: [{ id: "b1", name: "main" }], pagination: {} });
      }
      if (path.endsWith("/storage")) {
        return json(200, { enabled: true, s3_endpoint: "https://x", region: "r" });
      }
      if (path.endsWith("/buckets")) {
        return json(200, { buckets: [{ name: "assets", access_level: "private" }] });
      }
      throw new Error(`unexpected ${req.method} ${path}`);
    });
  }

  it("uploads to the presigned URL through the host, with its bytes and signed headers", async () => {
    const request = storageHost(() => json(200, {}));
    const file = new File([new Uint8Array([1, 2, 250])], "photo.png", { type: "image/png" });

    await makeClient(request).uploadStorageObject!("assets", "photo.png", file);

    const put = request.mock.calls.find(([req]) => req.method === "PUT")![0];
    expect(put.url).toBe(PRESIGNED);
    expect(put.headers["content-type"]).toBe("image/png");
    expect(put.body).toEqual(new Uint8Array([1, 2, 250]));
    expect(put).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("fails when the host's upload answers with an error", async () => {
    const request = storageHost(() => json(403, {}));
    const file = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });

    await expect(
      makeClient(request).uploadStorageObject!("assets", "photo.png", file),
    ).rejects.toThrow(/upload of "photo.png" failed \(403\)/);
  });
});

describe("egress hosts", () => {
  const matches = (host: string) =>
    manifest.egressHosts.some((pattern) =>
      pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
    );

  it("names the API and the host a presigned upload goes to", () => {
    expect(matches("console.neon.tech")).toBe(true);
    expect(matches(new URL(PRESIGNED).hostname)).toBe(true);
  });
});
