import { describe, expect, it } from "vitest";

import {
  instanceBody,
  instanceName,
  ovhCiListTagged,
  ovhCiPreflight,
  ovhCiStart,
  ovhCiStatus,
  ovhCiTeardown,
  ruleCovers,
} from "../ci-executor.js";
import type { OvhApi } from "../extras.js";
import { OvhApiError } from "../lists.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX4Q8W2M3N5P6R7S8T9V0WX",
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
const PREFIX = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

type Route = (path: string, init?: RequestInit) => unknown;

/** A fake signed OVH API: `METHOD path` prefixes to answers. No network. */
function fakeOvh(routes: Array<[string, Route]>, regions = ["GRA11", "SBG5"]) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: OvhApi = {
    cloudPath: (suffix) => `/cloud/project/p1${suffix}`,
    listUpRegions: async () => regions,
    fetch: async <T>(path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      sent.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const match = routes.find(([pattern]) => {
        const [m, p] = pattern.split(" ");
        return m === method && path.startsWith(p ?? "");
      });
      if (!match) throw new Error(`unexpected ${method} ${path}`);
      return (await match[1](path, init)) as T;
    },
  };
  return { api, sent };
}

const notFound = () => {
  throw new OvhApiError("/x", 404, '{"class":"Client::NotFound","message":"x"}');
};

describe("OVHcloud CI executor", () => {
  it("names the instance after the job and carries its tags there", () => {
    const name = instanceName(spec);
    expect(name.startsWith(`${PREFIX} `)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(255);
    const body = instanceBody(spec, "flv", "img");
    expect(body).toMatchObject({
      flavorId: "flv",
      imageId: "img",
      region: "GRA11",
      monthlyBilling: false,
    });
    expect(body.userData).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
  });

  it("resolves the flavor and image in the region and creates once", async () => {
    const { api, sent } = fakeOvh([
      ["GET /cloud/project/p1/instance?region=SBG5", () => []],
      [
        "GET /cloud/project/p1/flavor",
        () => [
          { id: "win", name: "b3-8", osType: "windows" },
          { id: "flv", name: "b3-8", osType: "linux" },
        ],
      ],
      ["GET /cloud/project/p1/image", () => [{ id: "img", name: "Ubuntu 24.04" }]],
      ["POST /cloud/project/p1/instance", () => ({ id: "i-1", status: "BUILD", region: "SBG5" })],
    ]);
    expect(await ovhCiStart(api, { ...spec, region: "SBG5" })).toEqual({
      id: "i-1",
      region: "SBG5",
      label: "ovh instance i-1 (SBG5)",
    });
    const create = sent.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({ flavorId: "flv", imageId: "img", region: "SBG5" });

    const again = fakeOvh([
      [
        "GET /cloud/project/p1/instance?region=GRA11",
        () => [{ id: "i-1", name: instanceName(spec), status: "ACTIVE" }],
      ],
    ]);
    expect((await ovhCiStart(again.api, spec)).id).toBe("i-1");
    expect(again.sent).toHaveLength(1);
  });

  it("maps states, and tears down even what is already gone", async () => {
    for (const [status, state] of [
      ["BUILD", "starting"],
      ["ACTIVE", "running"],
      ["SHUTOFF", "stopped"],
      ["DELETED", "gone"],
    ] as const) {
      const { api } = fakeOvh([
        ["GET /cloud/project/p1/instance/i-1", () => ({ id: "i-1", status })],
      ]);
      expect((await ovhCiStatus(api, { id: "i-1", label: "x" })).state).toBe(state);
    }
    const { api } = fakeOvh([
      ["GET /cloud/project/p1/instance/i-1", notFound],
      ["DELETE /cloud/project/p1/instance/i-1", notFound],
    ]);
    expect(await ovhCiStatus(api, { id: "i-1", label: "x" })).toEqual({ state: "gone" });
    await expect(ovhCiTeardown(api, { id: "i-1", label: "x" })).resolves.toBeUndefined();
  });

  it("finds CI instances by name and reads their tags back", async () => {
    const { api } = fakeOvh([
      [
        "GET /cloud/project/p1/instance?region=GRA11",
        () => [
          { id: "a", name: instanceName(spec), status: "ACTIVE", created: "2026-11-13T10:00:00Z" },
          { id: "b", name: "web-1", status: "ACTIVE" },
          { id: "c", name: instanceName(spec), status: "SHUTOFF", region: "GRA11" },
        ],
      ],
    ]);
    const found = await ovhCiListTagged(api, "infrawrench-ci", []);
    expect(found.map((f) => [f.handle.id, f.live])).toEqual([
      ["a", true],
      ["c", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
    expect(found[0]?.createdAt).toBe("2026-11-13T10:00:00Z");
  });

  it("checks the consumer key's rules", async () => {
    expect(ruleCovers("/*", "/cloud/project/p1/instance")).toBe(true);
    expect(ruleCovers("/cloud/project/p1/*", "/cloud/project/p1/instance/{instanceId}")).toBe(true);
    expect(
      ruleCovers("/cloud/project/p1/instance", "/cloud/project/p1/instance/{instanceId}"),
    ).toBe(false);
    const readOnly = fakeOvh([
      [
        "GET /auth/currentCredential",
        () => ({ status: "validated", rules: [{ method: "GET", path: "/*" }] }),
      ],
    ]);
    const result = await ovhCiPreflight(readOnly.api, "vm");
    expect(result.missing.map((m) => m.permission)).toEqual([
      "POST /cloud/project/p1/instance",
      "DELETE /cloud/project/p1/instance/{instanceId}",
    ]);
    const full = fakeOvh([
      [
        "GET /auth/currentCredential",
        () => ({
          status: "validated",
          rules: ["GET", "POST", "PUT", "DELETE"].map((method) => ({
            method,
            path: "/cloud/project/p1/*",
          })),
        }),
      ],
    ]);
    expect(await ovhCiPreflight(full.api, "vm", "SBG5")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "SBG5",
    });
    expect((await ovhCiPreflight(full.api, "vm", "BHS5")).problems[0]).toContain("BHS5");
  });
});
