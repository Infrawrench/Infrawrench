import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createHetznerApis } from "../api.js";
import {
  hetznerCiListTagged,
  hetznerCiPreflight,
  hetznerCiStart,
  hetznerCiStatus,
  hetznerCiTeardown,
  labelsOf,
  serverBody,
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
const NAME = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function hetzner(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createHetznerApis({ token: "secret-token", http }).cloud, sent };
}

describe("Hetzner CI executor", () => {
  it("labels with values Hetzner accepts", () => {
    const labels = labelsOf(tags);
    expect(labels["infrawrench-ci"]).toBe("org-org_5f01HZX");
    for (const value of Object.values(labels)) {
      expect(value).toMatch(/^[A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/);
    }
    const body = serverBody(spec, 5, 6);
    expect(body).toMatchObject({
      name: NAME,
      server_type: "cpx22",
      image: "ubuntu-24.04",
      location: "fsn1",
      ssh_keys: [5],
      public_net: { enable_ipv4: true, ipv4: 6, enable_ipv6: false },
    });
    expect(body.user_data).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
  });

  it("starts with its own address and a throwaway key, then removes the key", async () => {
    const { api, sent } = hetzner([
      ["GET /servers", () => ({ servers: [] })],
      ["GET /primary_ips", () => ({ primary_ips: [] })],
      ["POST /primary_ips", () => ({ primary_ip: { id: 6 } })],
      ["GET /ssh_keys", () => ({ ssh_keys: [] })],
      ["POST /ssh_keys", () => ({ ssh_key: { id: 5 } })],
      [
        "POST /servers",
        () => ({
          server: { id: 77, status: "initializing", datacenter: { location: { name: "fsn1" } } },
        }),
      ],
      ["DELETE /ssh_keys/5", () => undefined],
    ]);
    const handle = await hetznerCiStart(api, spec);
    expect(handle).toEqual({
      id: "77",
      region: "fsn1",
      label: "hetzner server 77 (fsn1)",
      data: { kind: "server", primaryIp: "6" },
    });
    expect(decodeURIComponent(sent[0]!.url.search)).toBe(
      "?label_selector=infrawrench-ci-job==0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    );
    const ip = sent.find((c) => c.method === "POST" && c.url.pathname.endsWith("/primary_ips"));
    expect(ip?.body).toMatchObject({ name: NAME, type: "ipv4", auto_delete: true });
    const key = sent.find((c) => c.method === "POST" && c.url.pathname.endsWith("/ssh_keys"));
    expect((key?.body as { public_key: string }).public_key).toMatch(/^ssh-ed25519 /);
    const create = sent.find((c) => c.method === "POST" && c.url.pathname.endsWith("/servers"));
    expect(JSON.stringify(create?.body)).not.toContain("secret-token");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE" });
    expect(sent.at(-1)?.url.pathname).toBe("/v1/ssh_keys/5");
  });

  it("finds the server a first start made", async () => {
    const { api, sent } = hetzner([
      [
        "GET /servers",
        () => ({
          servers: [
            {
              id: 77,
              status: "running",
              datacenter: { location: { name: "nbg1" } },
              public_net: { ipv4: { id: 6 } },
            },
          ],
        }),
      ],
    ]);
    expect(await hetznerCiStart(api, spec)).toMatchObject({ id: "77", region: "nbg1" });
    expect(sent).toHaveLength(1);
  });

  it("gives back its address and key when the create fails", async () => {
    const { api, sent } = hetzner([
      ["GET /servers", () => ({ servers: [] })],
      ["GET /primary_ips", () => ({ primary_ips: [{ id: 6 }] })],
      ["GET /ssh_keys", () => ({ ssh_keys: [{ id: 5 }] })],
      ["POST /servers", () => new FakeHttpReply(422, { error: { code: "resource_unavailable" } })],
      ["DELETE /primary_ips/6", () => undefined],
      ["DELETE /ssh_keys/5", () => undefined],
    ]);
    await expect(hetznerCiStart(api, spec)).rejects.toThrow("422");
    const deletes = sent.filter((c) => c.method === "DELETE").map((c) => c.url.pathname);
    expect(deletes).toEqual(["/v1/primary_ips/6", "/v1/ssh_keys/5"]);
  });

  it("maps states and tears down idempotently", async () => {
    for (const [status, state] of [
      ["initializing", "starting"],
      ["running", "running"],
      ["off", "stopped"],
      ["deleting", "gone"],
    ] as const) {
      const { api } = hetzner([["GET /servers/77", () => ({ server: { id: 77, status } })]]);
      expect((await hetznerCiStatus(api, { id: "77", label: "x" })).state).toBe(state);
    }
    const missing = hetzner([
      ["GET /servers/77", () => new FakeHttpReply(404, { error: { code: "not_found" } })],
      ["DELETE /servers/77", () => new FakeHttpReply(404, { error: { code: "not_found" } })],
      ["DELETE /primary_ips/6", () => new FakeHttpReply(404, { error: { code: "not_found" } })],
    ]);
    expect(await hetznerCiStatus(missing.api, { id: "77", label: "x" })).toEqual({ state: "gone" });
    await expect(
      hetznerCiTeardown(missing.api, { id: "77", label: "x", data: { primaryIp: "6" } }),
    ).resolves.toBeUndefined();
    const deletes = missing.sent.filter((c) => c.method === "DELETE").map((c) => c.url.pathname);
    expect(deletes).toEqual(["/v1/servers/77", "/v1/primary_ips/6"]);
  });

  it("lists labelled servers and stray labelled addresses with their tags", async () => {
    const { api, sent } = hetzner([
      [
        "GET /servers",
        () => ({
          servers: [
            {
              id: 77,
              status: "running",
              created: "2026-11-13T10:00:00Z",
              labels: { ...labelsOf(tags), team: "web" },
              datacenter: { location: { name: "fsn1" } },
            },
          ],
          meta: { pagination: { total_entries: 1 } },
        }),
      ],
      [
        "GET /primary_ips",
        () => ({
          primary_ips: [
            {
              id: 6,
              ip: "192.0.2.1",
              assignee_id: null,
              labels: labelsOf(tags),
              location: { name: "fsn1" },
            },
            { id: 7, ip: "192.0.2.2", assignee_id: 77, labels: labelsOf(tags) },
          ],
          meta: { pagination: { total_entries: 2 } },
        }),
      ],
    ]);
    const found = await hetznerCiListTagged(api, "infrawrench-ci");
    expect(decodeURIComponent(sent[0]!.url.search)).toContain("label_selector=infrawrench-ci");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ handle: { id: "77" }, tags, live: true });
    expect(found[1]).toMatchObject({
      handle: { id: "6", data: { kind: "primary-ip" } },
      live: false,
    });
    const ipTeardown = hetzner([["DELETE /primary_ips/6", () => undefined]]);
    await hetznerCiTeardown(ipTeardown.api, found[1]!.handle);
    expect(ipTeardown.sent).toHaveLength(1);
  });

  it("reads a 403 on a write as a read-only token", async () => {
    const { api } = hetzner([
      ["GET /servers", () => ({ servers: [] })],
      ["DELETE /ssh_keys/0", () => new FakeHttpReply(403, { error: { code: "forbidden" } })],
      ["GET /locations", () => ({ locations: [] })],
    ]);
    const result = await hetznerCiPreflight(api, "vm", "mars1");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["Read & Write"]);
    expect(result.problems[0]).toContain("mars1");
    const fine = hetzner([
      ["GET /servers", () => ({ servers: [] })],
      ["DELETE /ssh_keys/0", () => new FakeHttpReply(404, { error: { code: "not_found" } })],
      ["GET /locations", () => ({ locations: [{ name: "fsn1" }] })],
    ]);
    expect(await hetznerCiPreflight(fine.api, "vm")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "fsn1",
    });
  });
});
