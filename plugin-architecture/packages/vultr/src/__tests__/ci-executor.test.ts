import { describe, expect, it } from "vitest";

import { base64ToUtf8, ciTagStrings } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createVultrApi } from "../api.js";
import {
  instanceBody,
  vultrCiListTagged,
  vultrCiPreflight,
  vultrCiStart,
  vultrCiStatus,
  vultrCiTeardown,
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
const LABEL = "iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function vultr(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return {
    api: createVultrApi({ apiKey: "secret-key", services: { http }, retryDelayMs: 0 }),
    sent,
  };
}

describe("Vultr CI executor", () => {
  it("writes an instance with base64 user data, Ubuntu 24.04 and its tags", () => {
    const body = instanceBody(spec);
    expect(body).toMatchObject({
      region: "ewr",
      plan: "vc2-2c-4gb",
      os_id: 2284,
      label: LABEL,
      hostname: LABEL,
      backups: "disabled",
      activation_email: false,
    });
    expect(base64ToUtf8(body.user_data)).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    expect(body.tags).toEqual(ciTagStrings(tags));
    expect(instanceBody({ ...spec, image: "1743" })).toMatchObject({ os_id: 1743 });
    expect(instanceBody({ ...spec, image: "docker" })).toMatchObject({ image_id: "docker" });
  });

  it("looks for the job's label before deploying", async () => {
    const { api, sent } = vultr([
      ["GET /v2/instances", () => ({ instances: [], meta: { total: 0, links: { next: "" } } })],
      [
        "POST /v2/instances",
        () => new FakeHttpReply(202, { instance: { id: "abc", region: "ewr" } }),
      ],
    ]);
    expect(await vultrCiStart(api, spec)).toEqual({
      id: "abc",
      region: "ewr",
      label: "vultr instance abc (ewr)",
    });
    expect(sent[0]!.url.searchParams.get("label")).toBe(LABEL);
    expect(JSON.stringify(sent[1]?.body)).not.toContain("secret-key");

    const again = vultr([
      [
        "GET /v2/instances",
        () => ({ instances: [{ id: "abc", label: LABEL, region: "fra" }], meta: { links: {} } }),
      ],
    ]);
    expect((await vultrCiStart(again.api, spec)).region).toBe("fra");
    expect(again.sent).toHaveLength(1);
  });

  it("maps states, and tears down even what is already gone", async () => {
    const cases = [
      [{ status: "pending", power_status: "running", server_status: "none" }, "starting"],
      [
        { status: "active", power_status: "running", server_status: "installingbooting" },
        "starting",
      ],
      [{ status: "active", power_status: "running", server_status: "ok" }, "running"],
      [{ status: "active", power_status: "stopped", server_status: "ok" }, "stopped"],
    ] as const;
    for (const [instance, state] of cases) {
      const { api } = vultr([
        ["GET /v2/instances/abc", () => ({ instance: { id: "abc", ...instance } })],
      ]);
      expect((await vultrCiStatus(api, { id: "abc", label: "x" })).state).toBe(state);
    }
    const { api } = vultr([
      ["GET /v2/instances/abc", () => new FakeHttpReply(404, { error: "Invalid instance-id." })],
      ["DELETE /v2/instances/abc", () => new FakeHttpReply(404, { error: "Invalid instance-id." })],
    ]);
    expect(await vultrCiStatus(api, { id: "abc", label: "x" })).toEqual({ state: "gone" });
    await expect(vultrCiTeardown(api, { id: "abc", label: "x" })).resolves.toBeUndefined();
  });

  it("lists instances by the CI tag with their tags as sent", async () => {
    const { api, sent } = vultr([
      [
        "GET /v2/instances",
        () => ({
          instances: [
            {
              id: "a",
              region: "ewr",
              power_status: "running",
              date_created: "2026-11-13T10:00:00+00:00",
              tags: ciTagStrings(tags),
            },
            { id: "b", region: "ewr", power_status: "stopped", tags: ciTagStrings(tags) },
            { id: "c", region: "ewr", tags: ["web"] },
          ],
          meta: { links: { next: "" } },
        }),
      ],
    ]);
    const found = await vultrCiListTagged(api, "infrawrench-ci");
    expect(sent[0]!.url.searchParams.get("tag")).toBe("iwci");
    expect(found.map((f) => [f.handle.id, f.live])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
  });

  it("names the ACLs a sub-user lacks", async () => {
    const { api } = vultr([
      ["GET /v2/account", () => ({ account: { acls: ["subscriptions_view", "subscriptions"] } })],
      ["GET /v2/instances", () => ({ instances: [], meta: { links: {} } })],
      ["GET /v2/regions", () => ({ regions: [{ id: "ewr" }] })],
    ]);
    const result = await vultrCiPreflight(api, "vm");
    expect(result.missing.map((m) => m.permission)).toEqual(["provisioning"]);
    const admin = vultr([
      ["GET /v2/account", () => ({ account: { acls: ["manage_users"] } })],
      ["GET /v2/instances", () => ({ instances: [], meta: { links: {} } })],
      ["GET /v2/regions", () => ({ regions: [{ id: "ewr" }] })],
    ]);
    expect(await vultrCiPreflight(admin.api, "vm", "ewr")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "ewr",
    });
  });
});
