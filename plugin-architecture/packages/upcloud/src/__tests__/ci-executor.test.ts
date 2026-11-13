import { describe, expect, it } from "vitest";

import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createUpCloudApi } from "../api.js";
import {
  serverBody,
  upcloudCiListTagged,
  upcloudCiPreflight,
  upcloudCiStart,
  upcloudCiStatus,
  upcloudCiTeardown,
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
const UBUNTU = "01000000-0000-4000-8000-000030240200";
const templates = {
  storages: {
    storage: [
      {
        uuid: "01000000-0000-4000-8000-000030220200",
        title: "Ubuntu Server 22.04 LTS (Jammy Jellyfish)",
        template_type: "cloud-init",
      },
      {
        uuid: UBUNTU,
        title: "Ubuntu Server 24.04 LTS (Noble Numbat)",
        template_type: "cloud-init",
      },
    ],
  },
};
const noWait = { sleep: async () => {}, now: () => new Date("2026-11-13T10:00:00Z") };

function upcloud(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createUpCloudApi({ apiToken: "secret-token", services: { http } }), sent };
}

describe("UpCloud CI executor", () => {
  it("clones the cloud-init template with user data, labels and a throwaway key", async () => {
    const { server } = await serverBody(spec, UBUNTU, "2026-11-13T10:00:00.000Z");
    expect(server).toMatchObject({
      zone: "de-fra1",
      hostname: "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      plan: "CLOUDNATIVE-2xCPU-4GB",
      metadata: "yes",
      password_delivery: "none",
      simple_backup: "no",
    });
    expect(server.user_data).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    expect(server.login_user.ssh_keys.ssh_key[0]).toMatch(/^ssh-ed25519 /);
    expect(server.storage_devices.storage_device[0]).toMatchObject({
      action: "clone",
      storage: UBUNTU,
    });
    expect(server.labels.label).toContainEqual({ key: "infrawrench-ci", value: "org-org_01HZX" });
    expect(server.labels.label).toContainEqual({
      key: "iwci-created",
      value: "2026-11-13T10:00:00.000Z",
    });
  });

  it("looks for the job's label, finds the template and creates once", async () => {
    const { api, sent } = upcloud([
      ["GET /1.3/server?label=", () => ({ servers: { server: [] } })],
      ["GET /1.3/storage/template", () => templates],
      [
        "POST /1.3/server",
        () =>
          new FakeHttpReply(202, {
            server: { uuid: "u-1", state: "maintenance", zone: "de-fra1" },
          }),
      ],
    ]);
    expect(await upcloudCiStart(api, spec, noWait)).toEqual({
      id: "u-1",
      region: "de-fra1",
      label: "upcloud server u-1 (de-fra1)",
    });
    expect(sent[0]!.url.searchParams.get("label")).toBe(
      "infrawrench-ci-job=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    );
    const create = sent.find((c) => c.method === "POST");
    expect(
      (create?.body as { server: { storage_devices: unknown } }).server.storage_devices,
    ).toMatchObject({
      storage_device: [{ storage: UBUNTU }],
    });
    expect(JSON.stringify(create?.body)).not.toContain("secret-token");

    const again = upcloud([
      [
        "GET /1.3/server?label=",
        () => ({
          servers: {
            server: [
              {
                uuid: "u-1",
                zone: "fi-hel1",
                labels: {
                  label: [{ key: "infrawrench-ci-job", value: tags["infrawrench-ci-job"] }],
                },
              },
            ],
          },
        }),
      ],
    ]);
    expect((await upcloudCiStart(again.api, spec, noWait)).region).toBe("fi-hel1");
    expect(again.sent).toHaveLength(1);
  });

  it("stops the server before deleting it with its disks", async () => {
    let state = "started";
    const { api, sent } = upcloud([
      ["GET /1.3/server/u-1", () => ({ server: { uuid: "u-1", state } })],
      [
        "POST /1.3/server/u-1/stop",
        () => {
          state = "stopped";
          return { server: { uuid: "u-1", state: "started" } };
        },
      ],
      ["DELETE /1.3/server/u-1", () => undefined],
    ]);
    await upcloudCiTeardown(api, { id: "u-1", label: "x" }, noWait);
    const stop = sent.find((c) => c.method === "POST");
    expect(stop?.body).toEqual({ stop_server: { stop_type: "hard" } });
    const del = sent.find((c) => c.method === "DELETE");
    expect(del?.url.search).toBe("?storages=1&backups=delete");

    const gone = upcloud([
      [
        "GET /1.3/server/u-1",
        () =>
          new FakeHttpReply(404, { error: { error_code: "SERVER_NOT_FOUND", error_message: "x" } }),
      ],
    ]);
    await expect(
      upcloudCiTeardown(gone.api, { id: "u-1", label: "x" }, noWait),
    ).resolves.toBeUndefined();
    expect(await upcloudCiStatus(gone.api, { id: "u-1", label: "x" })).toEqual({ state: "gone" });

    const busy = upcloud([
      ["GET /1.3/server/u-1", () => ({ server: { uuid: "u-1", state: "maintenance" } })],
    ]);
    await expect(upcloudCiTeardown(busy.api, { id: "u-1", label: "x" }, noWait)).rejects.toThrow(
      "maintenance",
    );
    expect(busy.sent.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("maps states", async () => {
    for (const [status, want] of [
      ["maintenance", "starting"],
      ["started", "running"],
      ["stopped", "stopped"],
    ] as const) {
      const { api } = upcloud([
        ["GET /1.3/server/u-1", () => ({ server: { uuid: "u-1", state: status } })],
      ]);
      expect((await upcloudCiStatus(api, { id: "u-1", label: "x" })).state).toBe(want);
    }
  });

  it("lists labelled servers with their tags and the creation time it wrote", async () => {
    const { api } = upcloud([
      [
        "GET /1.3/server",
        () => ({
          servers: {
            server: [
              {
                uuid: "u-1",
                state: "started",
                zone: "de-fra1",
                labels: {
                  label: [
                    ...Object.entries(tags).map(([key, value]) => ({ key, value })),
                    { key: "iwci-created", value: "2026-11-13T10:00:00.000Z" },
                  ],
                },
              },
              {
                uuid: "u-2",
                state: "started",
                zone: "de-fra1",
                labels: { label: [{ key: "env", value: "prod" }] },
              },
            ],
          },
        }),
      ],
    ]);
    const found = await upcloudCiListTagged(api, "infrawrench-ci");
    expect(found).toEqual([
      {
        handle: { id: "u-1", region: "de-fra1", label: "upcloud server u-1 (de-fra1)" },
        tags,
        createdAt: "2026-11-13T10:00:00.000Z",
        live: true,
      },
    ]);
  });

  it("checks with harmless reads", async () => {
    const { api } = upcloud([
      ["GET /1.3/account", () => ({ account: { username: "ci" } })],
      ["GET /1.3/server", () => ({ servers: { server: [] } })],
      ["GET /1.3/zone", () => ({ zones: { zone: [{ id: "de-fra1" }, { id: "fi-hel1" }] } })],
      ["GET /1.3/storage/template", () => templates],
    ]);
    expect(await upcloudCiPreflight(api, "vm")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "de-fra1",
    });
    expect((await upcloudCiPreflight(api, "vm", "mars-1")).problems[0]).toContain("mars-1");
  });
});
