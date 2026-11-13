import { describe, expect, it } from "vitest";

import { base64ToUtf8, ciTagStrings } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createLinodeApi } from "../api.js";
import {
  instanceBody,
  linodeCiListTagged,
  linodeCiPreflight,
  linodeCiStart,
  linodeCiStatus,
  linodeCiTeardown,
  scopesAllowLinodes,
} from "../ci-executor.js";

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
const LABEL = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function linode(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createLinodeApi({ token: "secret-token", services: { http } }), sent };
}

describe("Linode CI executor", () => {
  it("writes a Linode with cloud-init user data, tags that fit and a password nobody keeps", () => {
    const body = instanceBody(spec);
    expect(body).toMatchObject({
      label: LABEL,
      region: "us-east",
      type: "g6-standard-2",
      image: "linode/ubuntu24.04",
      booted: true,
      backups_enabled: false,
    });
    expect(body.label).toMatch(/^[a-zA-Z]((?!--|__|\.\.)[a-zA-Z0-9-_.])+$/);
    expect(base64ToUtf8(body.metadata.user_data)).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    for (const tag of body.tags) {
      expect(tag.length).toBeGreaterThanOrEqual(3);
      expect(tag.length).toBeLessThanOrEqual(50);
    }
    expect(body.root_pass.length).toBeGreaterThanOrEqual(32);
    expect(instanceBody(spec).root_pass).not.toBe(body.root_pass);
  });

  it("looks for the job's label before creating, and finds it on a retry", async () => {
    const { api, sent } = linode([
      ["GET /v4/linode/instances", () => ({ data: [], page: 1, pages: 1, results: 0 })],
      ["POST /v4/linode/instances", () => ({ id: 123, status: "provisioning", region: "us-east" })],
    ]);
    expect(await linodeCiStart(api, spec)).toEqual({
      id: "123",
      region: "us-east",
      label: "linode 123 (us-east)",
    });
    expect(JSON.parse(sent[0]!.headers["X-Filter"] ?? "{}")).toEqual({ label: LABEL });
    expect(JSON.stringify(sent[1]?.body)).not.toContain("secret-token");

    const again = linode([
      [
        "GET /v4/linode/instances",
        () => ({ data: [{ id: 123, status: "running", region: "eu-central" }], pages: 1 }),
      ],
    ]);
    expect((await linodeCiStart(again.api, spec)).region).toBe("eu-central");
    expect(again.sent).toHaveLength(1);
  });

  it("maps states, and tears down even what is already gone", async () => {
    for (const [status, state] of [
      ["provisioning", "starting"],
      ["running", "running"],
      ["offline", "stopped"],
      ["deleting", "gone"],
    ] as const) {
      const { api } = linode([["GET /v4/linode/instances/123", () => ({ id: 123, status })]]);
      expect((await linodeCiStatus(api, { id: "123", label: "x" })).state).toBe(state);
    }
    const { api } = linode([
      [
        "GET /v4/linode/instances/123",
        () => new FakeHttpReply(404, { errors: [{ reason: "Not found" }] }),
      ],
      [
        "DELETE /v4/linode/instances/123",
        () => new FakeHttpReply(404, { errors: [{ reason: "Not found" }] }),
      ],
    ]);
    expect(await linodeCiStatus(api, { id: "123", label: "x" })).toEqual({ state: "gone" });
    await expect(linodeCiTeardown(api, { id: "123", label: "x" })).resolves.toBeUndefined();
  });

  it("lists Linodes by the CI tag with their tags as sent", async () => {
    const { api, sent } = linode([
      [
        "GET /v4/linode/instances",
        () => ({
          data: [
            {
              id: 1,
              status: "running",
              created: "2026-11-13T10:00:00",
              region: "us-east",
              tags: [...ciTagStrings(tags), "prod"],
            },
            { id: 2, status: "offline", region: "us-east", tags: ciTagStrings(tags) },
            { id: 3, status: "running", region: "us-east", tags: ["iwci-other"] },
          ],
          page: 1,
          pages: 1,
        }),
      ],
    ]);
    const found = await linodeCiListTagged(api, "infrawrench-ci");
    expect(JSON.parse(sent[0]!.headers["X-Filter"] ?? "{}")).toEqual({ tags: "iwci" });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      handle: { id: "1", region: "us-east" },
      tags,
      createdAt: "2026-11-13T10:00:00Z",
      live: true,
    });
    expect(found[1]?.live).toBe(false);
  });

  it("reads the token's scopes and a restricted user's grants", async () => {
    expect(scopesAllowLinodes("*")).toBe(true);
    expect(scopesAllowLinodes("account:read_only,linodes:read_write")).toBe(true);
    expect(scopesAllowLinodes("linodes:read_only")).toBe(false);

    const { http } = fakeCiHttp([
      ["GET /v4/profile/grants", () => ({ global: { add_linodes: false } })],
      ["GET /v4/profile", () => ({ username: "ci" })],
    ]);
    const scoped: typeof http = {
      request: async (req) => {
        const res = await http.request(req);
        return { ...res, headers: { ...res.headers, "x-oauth-scopes": "linodes:read_only" } };
      },
    };
    const result = await linodeCiPreflight(
      createLinodeApi({ token: "t", services: { http: scoped } }),
      "vm",
    );
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["linodes:read_write", "add_linodes"]);

    const fine = linode([
      ["GET /v4/profile/grants", () => undefined],
      ["GET /v4/profile", () => ({ username: "ci" })],
    ]);
    expect(await linodeCiPreflight(fine.api, "vm")).toMatchObject({ ok: true, missing: [] });
  });
});
