import { describe, expect, it } from "vitest";

import { base64ToUtf8 } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { OpenStackApi } from "../api.js";
import {
  openstackCiListTagged,
  openstackCiPreflight,
  openstackCiStart,
  openstackCiStatus,
  openstackCiTeardown,
  serverBody,
} from "../ci-executor.js";
import { APP, CATALOG } from "./harness.js";

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
const IMAGE = "0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

const catalog = [
  ...CATALOG,
  {
    type: "image",
    endpoints: [{ interface: "public", region_id: "RegionOne", url: "https://glance.example.com" }],
  },
];

const auth: Parameters<typeof fakeCiHttp>[0][number] = [
  "POST /v3/auth/tokens",
  () =>
    new FakeHttpReply(
      201,
      {
        token: {
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          project: { id: "proj1", name: "demo" },
          user: { id: "u1" },
          catalog,
        },
      },
      { "x-subject-token": "tok" },
    ),
];

function openstack(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp([auth, ...routes]);
  return { api: new OpenStackApi(APP, http), sent };
}

const flavors = {
  flavors: [
    { id: "f-1", name: "m1.small", vcpus: 1, ram: 2048, disk: 20 },
    { id: "f-3", name: "m1.large", vcpus: 4, ram: 8192, disk: 40 },
    { id: "f-2", name: "m1.medium", vcpus: 2, ram: 4096, disk: 40 },
  ],
};
const images = {
  images: [
    { id: "x", name: "Ubuntu 22.04" },
    { id: IMAGE, name: "Ubuntu 24.04 LTS" },
  ],
};

describe("OpenStack CI executor", () => {
  it("boots from the image, or from a volume it deletes with the server", () => {
    const local = serverBody(spec, { id: "f-2", disk: 40 }, IMAGE, [{ uuid: "net-1" }]).server;
    expect(local).toMatchObject({
      name: NAME,
      flavorRef: "f-2",
      imageRef: IMAGE,
      networks: [{ uuid: "net-1" }],
    });
    expect(local.metadata).toEqual(tags);
    expect(base64ToUtf8(local.user_data)).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    const volume = serverBody(spec, { id: "f-0", disk: 0 }, IMAGE, "auto").server;
    expect(volume).not.toHaveProperty("imageRef");
    expect(volume).toMatchObject({
      block_device_mapping_v2: [
        { uuid: IMAGE, destination_type: "volume", delete_on_termination: true },
      ],
      networks: "auto",
    });
  });

  it("picks the smallest 2 vCPU flavor, the Ubuntu image and the project's network", async () => {
    const { api, sent } = openstack([
      ["GET /v2.1/servers/detail", () => ({ servers: [] })],
      ["GET /v2.1/flavors/detail", () => flavors],
      ["GET /v2/images", () => images],
      [
        "GET /v2.0/networks",
        () => ({
          networks: [
            {
              id: "ext",
              name: "public",
              "router:external": true,
              shared: false,
              project_id: "admin",
            },
            { id: "net-1", name: "private", project_id: "proj1" },
          ],
        }),
      ],
      [
        "POST /v2.1/servers",
        () => new FakeHttpReply(202, { server: { id: "s-1", adminPass: "x" } }),
      ],
    ]);
    expect(await openstackCiStart(api, spec)).toEqual({
      id: "s-1",
      region: "RegionOne",
      label: "openstack server s-1 (RegionOne)",
    });
    expect(sent[1]!.url.searchParams.get("name")).toBe(`^${NAME}$`);
    const create = sent.find((c) => c.method === "POST" && c.url.pathname.endsWith("/servers"));
    expect(create?.body).toMatchObject({
      server: { flavorRef: "f-2", imageRef: IMAGE, networks: [{ uuid: "net-1" }] },
    });
    expect(JSON.stringify(create?.body)).not.toContain("s3cret");
  });

  it("finds the server a first start made", async () => {
    const { api, sent } = openstack([
      [
        "GET /v2.1/servers/detail",
        () => ({ servers: [{ id: "s-1", name: NAME, status: "BUILD" }] }),
      ],
    ]);
    expect((await openstackCiStart(api, spec)).id).toBe("s-1");
    expect(sent.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses to guess between several networks", async () => {
    const { api } = openstack([
      ["GET /v2.1/servers/detail", () => ({ servers: [] })],
      ["GET /v2.1/flavors/detail", () => flavors],
      ["GET /v2/images", () => images],
      [
        "GET /v2.0/networks",
        () => ({
          networks: [
            { id: "a", name: "one", project_id: "proj1" },
            { id: "b", name: "two", project_id: "proj1" },
          ],
        }),
      ],
    ]);
    await expect(openstackCiStart(api, spec)).rejects.toThrow("one, two");
  });

  it("maps states, and tears down even what is already gone", async () => {
    for (const [status, want] of [
      ["BUILD", "starting"],
      ["ACTIVE", "running"],
      ["SHUTOFF", "stopped"],
      ["ERROR", "stopped"],
      ["SOFT_DELETED", "gone"],
    ] as const) {
      const { api } = openstack([
        ["GET /v2.1/servers/s-1", () => ({ server: { id: "s-1", status } })],
      ]);
      expect((await openstackCiStatus(api, { id: "s-1", label: "x" })).state).toBe(want);
    }
    const { api } = openstack([
      ["GET /v2.1/servers/s-1", () => new FakeHttpReply(404, { itemNotFound: { message: "x" } })],
      [
        "DELETE /v2.1/servers/s-1",
        () => new FakeHttpReply(404, { itemNotFound: { message: "x" } }),
      ],
    ]);
    expect(await openstackCiStatus(api, { id: "s-1", label: "x" })).toEqual({ state: "gone" });
    await expect(openstackCiTeardown(api, { id: "s-1", label: "x" })).resolves.toBeUndefined();
  });

  it("lists CI servers by name, then by metadata", async () => {
    const { api, sent } = openstack([
      [
        "GET /v2.1/servers/detail",
        () => ({
          servers: [
            {
              id: "a",
              name: NAME,
              status: "ACTIVE",
              created: "2026-11-13T10:00:00Z",
              metadata: { ...tags, other: "x" },
            },
            { id: "b", name: "iwci-other", status: "SHUTOFF", metadata: tags },
            { id: "c", name: "iwci-mine", status: "ACTIVE", metadata: { team: "web" } },
          ],
        }),
      ],
    ]);
    const found = await openstackCiListTagged(api, "infrawrench-ci");
    expect(sent[1]!.url.searchParams.get("name")).toBe("^iwci-");
    expect(found.map((f) => [f.handle.id, f.live])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
  });

  it("reads the token's roles and names a read-only one", async () => {
    const reader = openstack([
      ["GET /v3/auth/tokens", () => ({ token: { roles: [{ id: "r", name: "reader" }] } })],
      ["GET /v2.1/servers", () => ({ servers: [] })],
      ["GET /v2/images", () => images],
      ["GET /v2.1/flavors/detail", () => flavors],
      ["GET /v2.0/networks", () => ({ networks: [{ id: "net-1", project_id: "proj1" }] })],
    ]);
    const result = await openstackCiPreflight(reader.api, "vm");
    expect(result.missing.map((m) => m.permission)).toEqual(["member"]);
    const subject = reader.sent.find(
      (c) => c.method === "GET" && c.url.pathname === "/v3/auth/tokens",
    );
    expect(subject?.headers["X-Subject-Token"]).toBe("tok");

    const member = openstack([
      [
        "GET /v3/auth/tokens",
        () => ({ token: { roles: [{ name: "member" }, { name: "reader" }] } }),
      ],
      ["GET /v2.1/servers", () => ({ servers: [] })],
      ["GET /v2/images", () => images],
      ["GET /v2.1/flavors/detail", () => flavors],
      ["GET /v2.0/networks", () => ({ networks: [{ id: "net-1", project_id: "proj1" }] })],
    ]);
    expect(await openstackCiPreflight(member.api, "vm")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "RegionOne",
    });
  });
});
