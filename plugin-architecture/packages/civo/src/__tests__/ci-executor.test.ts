import { describe, expect, it } from "vitest";

import { ciTagStrings } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createCivoApi } from "../api.js";
import {
  civoCiListTagged,
  civoCiPreflight,
  civoCiStart,
  civoCiStatus,
  civoCiTeardown,
  instanceBody,
} from "../ci-executor.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "vm" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 3600,
};
const HOST = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function civo(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createCivoApi({ apiKey: "secret-key", services: { http } }), sent };
}

describe("Civo CI executor", () => {
  it("writes an instance with the bootstrap as its script and space-separated tags", () => {
    const body = instanceBody(spec, "net-1", "img-1");
    expect(body).toMatchObject({
      hostname: HOST,
      size: "g4s.medium",
      template_id: "img-1",
      network_id: "net-1",
      public_ip: "create",
    });
    expect(body.script).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    expect(body.tags.split(" ")).toEqual(ciTagStrings(tags));
  });

  it("finds the region's network and Ubuntu image, then starts once", async () => {
    const { api, sent } = civo([
      ["GET /v2/instances", () => ({ page: 1, pages: 1, items: [] })],
      ["GET /v2/networks", () => [{ id: "net-x" }, { id: "net-1", default: true }]],
      [
        "GET /v2/disk_images",
        () => [
          { id: "img-0", name: "debian-12" },
          { id: "img-1", name: "ubuntu-noble" },
        ],
      ],
      ["POST /v2/instances", () => ({ id: "i-1", status: "BUILDING" })],
    ]);
    expect(await civoCiStart(api, { ...spec, region: "fra1" })).toEqual({
      id: "i-1",
      region: "FRA1",
      label: "civo instance i-1 (FRA1)",
    });
    const create = sent.find((c) => c.method === "POST");
    expect(create?.url.searchParams.get("region")).toBe("FRA1");
    expect(create?.body).toMatchObject({
      network_id: "net-1",
      template_id: "img-1",
      region: "FRA1",
    });
    expect(JSON.stringify(create?.body)).not.toContain("secret-key");

    const again = civo([
      ["GET /v2/instances", () => ({ page: 1, pages: 1, items: [{ id: "i-1", hostname: HOST }] })],
    ]);
    expect((await civoCiStart(again.api, spec)).id).toBe("i-1");
    expect(again.sent).toHaveLength(1);
  });

  it("maps states, and tears down even what is already gone", async () => {
    for (const [status, state] of [
      ["BUILDING", "starting"],
      ["ACTIVE", "running"],
      ["SHUTOFF", "stopped"],
    ] as const) {
      const { api } = civo([["GET /v2/instances/i-1", () => ({ id: "i-1", status })]]);
      expect((await civoCiStatus(api, { id: "i-1", region: "LON1", label: "x" })).state).toBe(
        state,
      );
    }
    const { api, sent } = civo([
      ["GET /v2/instances/i-1", () => new FakeHttpReply(404, "404 Not Found")],
      ["DELETE /v2/instances/i-1", () => new FakeHttpReply(404, "404 Not Found")],
    ]);
    expect(await civoCiStatus(api, { id: "i-1", region: "LON1", label: "x" })).toEqual({
      state: "gone",
    });
    await expect(
      civoCiTeardown(api, { id: "i-1", region: "LON1", label: "x" }),
    ).resolves.toBeUndefined();
    expect(sent.at(-1)?.url.searchParams.get("region")).toBe("LON1");
  });

  it("lists tagged instances in each region asked for", async () => {
    const { api, sent } = civo([
      [
        "GET /v2/instances",
        (call) => ({
          page: 1,
          pages: 1,
          items:
            call.url.searchParams.get("region") === "LON1"
              ? [
                  {
                    id: "a",
                    status: "ACTIVE",
                    created_at: "2026-11-13T10:00:00Z",
                    tags: ciTagStrings(tags),
                  },
                  { id: "b", status: "ACTIVE", tags: ["web"] },
                ]
              : [{ id: "c", status: "SHUTOFF", tags: ciTagStrings(tags) }],
        }),
      ],
    ]);
    const found = await civoCiListTagged(api, "infrawrench-ci", ["LON1", "nyc1"]);
    expect(sent.map((c) => c.url.searchParams.get("region"))).toEqual(["LON1", "NYC1"]);
    expect(sent[0]!.url.searchParams.get("tags")).toBe("iwci");
    expect(found.map((f) => [f.handle.id, f.handle.region, f.live])).toEqual([
      ["a", "LON1", true],
      ["c", "NYC1", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
  });

  it("checks with harmless reads and says what stops it", async () => {
    const { api } = civo([
      ["GET /v2/instances", () => ({ page: 1, pages: 1, items: [] })],
      ["GET /v2/networks", () => []],
      ["GET /v2/disk_images", () => [{ id: "img-1", name: "ubuntu-noble" }]],
      ["GET /v2/quota", () => ({ instance_count_usage: 16, instance_count_limit: 16 })],
    ]);
    const result = await civoCiPreflight(api, "vm");
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.problems).toHaveLength(2);
    expect(result.region).toBe("LON1");
  });
});
