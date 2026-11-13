import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createFlyApi } from "../api.js";
import {
  flyCiListTagged,
  flyCiPreflight,
  flyCiStart,
  flyCiStatus,
  flyCiTeardown,
  guestOf,
  machineConfig,
} from "../ci-executor.js";

const tags = {
  "infrawrench-ci": "org-org_01HZX",
  "infrawrench-ci-run": "4c1f6a2e-9b7d-4e3a-8f21-0d5c6b7a8e9f",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const spec = {
  kind: "container" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 3600,
};
const APP = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TOKEN = "fly-secret-token";

function fly(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createFlyApi({ token: TOKEN, http }), sent };
}

function machine(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    name: APP,
    region: "iad",
    state: "started",
    created_at: "2026-11-13T10:00:00Z",
    config: { metadata: { ...tags, "infrawrench-ci-tags": JSON.stringify(tags) } },
    ...over,
  };
}

describe("Fly CI executor", () => {
  it("reads sizes as guests within Fly's memory rules", () => {
    expect(guestOf("performance-2x")).toEqual({
      cpu_kind: "performance",
      cpus: 2,
      memory_mb: 4096,
    });
    expect(guestOf("shared-cpu-4x")).toEqual({ cpu_kind: "shared", cpus: 4, memory_mb: 4096 });
    expect(guestOf("performance-4x-16gb").memory_mb).toBe(16384);
    expect(() => guestOf("performance-3x")).toThrow("performance-4x-16gb");
    expect(() => guestOf("performance-1x-1gb")).toThrow("2 to 8 GB");
    expect(() => guestOf("2vcpu-4gb")).toThrow("shared-cpu-4x");
  });

  it("runs the bootstrap under the watchdog, destroys itself and never restarts", () => {
    const config = machineConfig(spec);
    expect(config).toMatchObject({
      image: "docker.io/library/buildpack-deps:noble-curl",
      auto_destroy: true,
      restart: { policy: "no" },
      guest: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 },
      metadata: tags,
    });
    expect(config.init?.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(config.init?.cmd?.[2]).toContain("echo hi");
    expect(config.init?.cmd?.[0]).toContain("sleep 3600");
    expect(config.env).toBeUndefined();
  });

  it("makes the job's app on its own network, then its Machine", async () => {
    const { api, sent } = fly([
      [`GET /v1/apps/${APP}/machines`, () => []],
      [`GET /v1/apps/${APP}`, () => new FakeHttpReply(404, { error: "not found" })],
      ["POST /v1/apps/", () => machine({ state: "created" })],
      ["POST /v1/apps", () => new FakeHttpReply(201, { id: "app1" })],
    ]);
    const handle = await flyCiStart(api, "acme", spec);
    expect(handle).toEqual({
      id: "m1",
      region: "iad",
      label: `fly machine m1 (${APP}, iad)`,
      data: { app: APP },
    });
    const app = sent.find((c) => c.method === "POST" && c.url.pathname === "/v1/apps");
    expect(app?.body).toEqual({ app_name: APP, org_slug: "acme", network: APP });
    const create = sent.find((c) => c.url.pathname === `/v1/apps/${APP}/machines`);
    expect(create?.method).toBe("GET");
    const post = sent.filter((c) => c.method === "POST").at(-1);
    expect(post?.body).toMatchObject({ name: APP, region: "iad" });
    for (const call of sent) expect(JSON.stringify(call.body ?? "")).not.toContain(TOKEN);
    expect(sent.every((c) => c.headers["Authorization"] === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("finds the Machine a first start made", async () => {
    const { api, sent } = fly([
      [
        `GET /v1/apps/${APP}/machines`,
        () => [machine({ id: "m0", state: "destroyed" }), machine()],
      ],
      [`GET /v1/apps/${APP}`, () => ({ name: APP, organization: { slug: "acme" } })],
    ]);
    expect(await flyCiStart(api, "acme", spec)).toMatchObject({ id: "m1" });
    expect(sent.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses an app of the same name in another organization", async () => {
    const { api } = fly([
      [`GET /v1/apps/${APP}`, () => ({ name: APP, organization: { slug: "someone-else" } })],
    ]);
    await expect(flyCiStart(api, "acme", spec)).rejects.toThrow("not this CI job's");
  });

  it("gives the empty app back when the Machine cannot start", async () => {
    const { api, sent } = fly([
      [`GET /v1/apps/${APP}/machines`, () => []],
      [`GET /v1/apps/${APP}`, () => ({ name: APP, organization: { slug: "acme" } })],
      [`POST /v1/apps/${APP}/machines`, () => new FakeHttpReply(422, { error: "no capacity" })],
      [`DELETE /v1/apps/${APP}`, () => new FakeHttpReply(202, {})],
    ]);
    await expect(flyCiStart(api, "acme", spec)).rejects.toThrow("422");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("refuses GPUs, which Fly no longer offers", async () => {
    const { api } = fly([]);
    await expect(flyCiStart(api, "acme", { ...spec, gpu: "a100-40gb" })).rejects.toThrow(
      "no longer offers GPU",
    );
  });

  it("maps Machine states", async () => {
    const answer = (state: string) => fly([["GET /v1/apps/", () => machine({ state })]]).api;
    const handle = { id: "m1", label: "x", data: { app: APP } };
    expect((await flyCiStatus(answer("created"), handle)).state).toBe("starting");
    expect((await flyCiStatus(answer("started"), handle)).state).toBe("running");
    expect((await flyCiStatus(answer("stopped"), handle)).state).toBe("stopped");
    expect((await flyCiStatus(answer("destroyed"), handle)).state).toBe("gone");
    const gone = fly([["GET /v1/apps/", () => new FakeHttpReply(404, { error: "x" })]]).api;
    expect(await flyCiStatus(gone, handle)).toEqual({ state: "gone" });
  });

  it("tears down the Machine and its app, and succeeds when both are gone", async () => {
    const { api, sent } = fly([
      [`DELETE /v1/apps/${APP}/machines/m1`, () => ({ ok: true })],
      [`DELETE /v1/apps/${APP}`, () => new FakeHttpReply(202, {})],
    ]);
    await flyCiTeardown(api, { id: "m1", label: "x", data: { app: APP } });
    expect(sent.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      `DELETE /v1/apps/${APP}/machines/m1?force=true`,
      `DELETE /v1/apps/${APP}`,
    ]);
    const gone = fly([["DELETE /v1/apps/", () => new FakeHttpReply(404, { error: "x" })]]).api;
    await expect(
      flyCiTeardown(gone, { id: "m1", label: "x", data: { app: APP } }),
    ).resolves.toBeUndefined();
  });

  it("lists CI apps by their Machine's tags, destroyed ones too", async () => {
    const { api } = fly([
      [
        "GET /v1/apps?org_slug=acme&cursor=2",
        () => ({ apps: [{ name: "iwci-ffff" }, { name: "iwci-0000" }] }),
      ],
      [
        "GET /v1/apps?org_slug=acme",
        () => ({ apps: [{ name: "web" }, { name: APP }], next_cursor: "2" }),
      ],
      [`GET /v1/apps/${APP}/machines`, () => [machine()]],
      ["GET /v1/apps/iwci-ffff/machines", () => [machine({ id: "m9", state: "destroyed" })]],
      ["GET /v1/apps/iwci-0000/machines", () => [{ id: "m8", config: { metadata: {} } }]],
    ]);
    const listed = await flyCiListTagged(api, "acme", "infrawrench-ci");
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ handle: { id: "m1", data: { app: APP } }, tags, live: true });
    expect(listed[1]).toMatchObject({ handle: { id: "m9" }, live: false, tags });
  });

  it("names an app deploy token as not enough", async () => {
    const { api } = fly([
      ["GET /v1/apps", () => new FakeHttpReply(401, { error: "unauthorized" })],
      ["GET /v1/platform/regions", () => ({ regions: [{ code: "iad" }] })],
    ]);
    const result = await flyCiPreflight(api, "acme", "container");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["Organization token"]);
    const ok = fly([
      ["GET /v1/apps", () => ({ apps: [] })],
      ["GET /v1/platform/regions", () => ({ regions: [{ code: "iad" }] })],
    ]).api;
    expect(await flyCiPreflight(ok, "acme", "container")).toMatchObject({
      ok: true,
      region: "iad",
    });
    expect(await flyCiPreflight(ok, "acme", "container", "xyz")).toMatchObject({ ok: false });
  });
});
