import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinodeApi } from "../api.js";
import { deleteObject, makeFolder, uploadObject } from "../object-storage.js";
import type { HttpHostServices } from "@infrawrench/plugin-base";

const BASE = "https://linode.test";
const SIGNED = "https://us-east-1.linodeobjects.com/b/k?X-Amz-Signature=abc";

type HostRequest = Parameters<HttpHostServices["request"]>[0];

function hostApi(storageStatus = 200, caCert?: string) {
  const requests: HostRequest[] = [];
  const request = vi.fn(async (req: HostRequest) => {
    if (req.url.startsWith(`${BASE}/object-storage/buckets/us-east/b/object-url`)) {
      return { status: 200, headers: {}, body: JSON.stringify({ url: SIGNED }) };
    }
    if (req.url === SIGNED) {
      requests.push(req);
      return { status: storageStatus, headers: {}, body: "" };
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });
  const api = createLinodeApi({
    token: "t",
    baseUrl: BASE,
    services: { http: { request } },
    ...(caCert ? { caCert } : {}),
  });
  return { api, requests };
}

describe("the bucket browser's signed URLs", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("the global fetch must not be reached");
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uploads through the host, with the signed Content-Type and the file's bytes", async () => {
    const { api, requests } = hostApi();
    const progress: number[] = [];
    const file = new File(["hello"], "k", { type: "text/plain" });
    await uploadObject(api, "us-east/b", "k", file, (pct) => progress.push(pct));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "PUT", headers: { "content-type": "text/plain" } });
    expect(requests[0]).not.toHaveProperty("caCert");
    expect(new TextDecoder().decode(requests[0]!.body as Uint8Array)).toBe("hello");
    expect(progress).toEqual([100]);
  });

  it("creates a folder through the host", async () => {
    const { api, requests } = hostApi();
    await makeFolder(api, "us-east/b", "k");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      headers: { "content-type": "application/x-directory" },
    });
    expect(requests[0]).not.toHaveProperty("caCert");
  });

  it("deletes through the host", async () => {
    const { api, requests } = hostApi();
    await deleteObject(api, "us-east/b", "k");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "DELETE" });
    expect(requests[0]).not.toHaveProperty("caCert");
  });

  it("sends the account's custom CA along when there is one", async () => {
    const { api, requests } = hostApi(200, "PEM");
    await deleteObject(api, "us-east/b", "k");
    expect(requests[0]).toMatchObject({ caCert: "PEM" });
  });

  it("still reports a failed upload", async () => {
    const { api } = hostApi(403);
    await expect(
      uploadObject(api, "us-east/b", "k", new File(["x"], "k", { type: "text/plain" })),
    ).rejects.toThrow("Upload failed: 403");
  });

  it("still treats an object already gone as deleted", async () => {
    const { api } = hostApi(404);
    await expect(deleteObject(api, "us-east/b", "k")).resolves.toBeUndefined();
  });

  it("falls back to fetch where there is no host", async () => {
    const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.linode.com")) {
        return new Response(JSON.stringify({ url: SIGNED }), { status: 200 });
      }
      expect(url).toBe(SIGNED);
      expect(init.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchStub);
    await deleteObject(createLinodeApi({ token: "t" }), "us-east/b", "k");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
