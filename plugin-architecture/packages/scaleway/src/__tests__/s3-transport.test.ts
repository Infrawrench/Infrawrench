import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScalewayClient } from "../client.js";

function answer({ url, method }: { url: string; method: string }) {
  const bucketList = new URL(url).pathname === "/";
  return {
    status: 200,
    headers: {},
    body:
      method === "HEAD"
        ? ""
        : bucketList
          ? "<ListAllMyBucketsResult></ListAllMyBucketsResult>"
          : "<ListBucketResult></ListBucketResult>",
  };
}

const request = vi.fn(async (call: { url: string; method: string }) => answer(call));

function client() {
  return hostClient(
    new ScalewayClient({ secretKey: "sk", accessKey: "ak" }, [], { http: { request } }),
  );
}

describe("Object Storage (#370)", () => {
  beforeEach(() => {
    request.mockClear();
    vi.stubGlobal("fetch", () => {
      throw new Error("reached the global fetch");
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the region probe and every storage browser call through the host", async () => {
    const c = client();
    await c.listStorageObjects("b", "");
    await c.uploadStorageObject("b", "k", new File(["x"], "x"));
    await c.makeStorageFolder("b", "f/");
    await c.deleteStorageObject("b", "k");
    expect(request.mock.calls.map(([call]) => call.method)).toEqual([
      "HEAD",
      "GET",
      "PUT",
      "PUT",
      "DELETE",
    ]);
    for (const [call] of request.mock.calls) expect(call.url).toContain(".scw.cloud");
  });

  it("sends the bucket listing through the host", async () => {
    await client().listResources("object-storage-bucket", "acc");
    expect(request).toHaveBeenCalled();
    for (const [call] of request.mock.calls) expect(call.url).toContain(".scw.cloud");
  });

  it("keeps a transport failure rather than reading it as no such bucket", async () => {
    const refused = new Error("Routing through a bastion agent is only possible on the gateway");
    request.mockRejectedValue(refused);
    await expect(client().listStorageObjects("b", "")).rejects.toThrow(refused.message);
    request.mockReset();
    request.mockImplementation(async (call: { url: string; method: string }) => answer(call));
  });
});
