import { describe, expect, it } from "vitest";

import { base64ToUtf8 } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createExoscaleApi } from "../api.js";
import {
  exoscaleCiListTagged,
  exoscaleCiPreflight,
  exoscaleCiStart,
  exoscaleCiStatus,
  exoscaleCiTeardown,
  instanceBody,
  labelsOf,
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
const TYPE = "b6cd1ff5-3a2f-4e9d-a4d1-8988c1191fe8";
const TEMPLATE = "9d5d4b9e-0d2c-4b6c-8a2a-6f4f0e9c1a11";

function exoscale(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  const api = createExoscaleApi({
    apiKey: "EXOkey",
    apiSecret: "secret-value",
    services: { http },
    pollMs: 0,
    endpoint: (zone) => `https://api-${zone}.example.test/v2`,
  });
  return { api, sent };
}

describe("Exoscale CI executor", () => {
  it("labels with values Exoscale takes and writes base64 user data", () => {
    for (const value of Object.values(labelsOf(tags))) {
      expect(value).toMatch(/^[^0-9][A-Za-z0-9*+!\-_?]{0,127}$/);
    }
    const body = instanceBody(spec, TYPE, TEMPLATE);
    expect(body).toMatchObject({
      name: NAME,
      "instance-type": { id: TYPE },
      template: { id: TEMPLATE },
      "public-ip-assignment": "inet4",
    });
    expect(base64ToUtf8(body["user-data"])).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
  });

  it("resolves the instance type and template, and waits for the operation", async () => {
    let instances: unknown[] = [];
    const { api, sent } = exoscale([
      [
        "GET /v2/instance-type",
        () => ({ "instance-types": [{ id: TYPE, family: "standard", size: "medium" }] }),
      ],
      ["GET /v2/instance", () => ({ instances })],
      [
        "GET /v2/template",
        () => ({ templates: [{ id: TEMPLATE, name: "Linux Ubuntu 24.04 LTS 64-bit" }] }),
      ],
      ["POST /v2/instance", () => ({ id: "op-1", state: "pending" })],
      [
        "GET /v2/operation/op-1",
        () => ({ id: "op-1", state: "success", reference: { id: "inst-1" } }),
      ],
    ]);
    expect(await exoscaleCiStart(api, spec)).toEqual({
      id: "inst-1",
      region: "ch-gva-2",
      label: "exoscale instance inst-1 (ch-gva-2)",
    });
    const create = sent.find((c) => c.method === "POST");
    expect(create?.url.host).toBe("api-ch-gva-2.example.test");
    expect(JSON.stringify(create?.body)).not.toContain("secret-value");

    instances = [{ id: "inst-1", name: NAME, state: "running" }];
    const before = sent.length;
    expect((await exoscaleCiStart(api, spec)).id).toBe("inst-1");
    expect(sent.length - before).toBe(1);
  });

  it("maps states, and tears down even what is already gone", async () => {
    for (const [state, want] of [
      ["starting", "starting"],
      ["running", "running"],
      ["stopped", "stopped"],
      ["destroying", "gone"],
    ] as const) {
      const { api } = exoscale([["GET /v2/instance/inst-1", () => ({ id: "inst-1", state })]]);
      expect(
        (await exoscaleCiStatus(api, { id: "inst-1", region: "de-fra-1", label: "x" })).state,
      ).toBe(want);
    }
    const { api, sent } = exoscale([
      ["GET /v2/instance/inst-1", () => new FakeHttpReply(404, { message: "not found" })],
      ["DELETE /v2/instance/inst-1", () => new FakeHttpReply(404, { message: "not found" })],
    ]);
    expect(await exoscaleCiStatus(api, { id: "inst-1", region: "de-fra-1", label: "x" })).toEqual({
      state: "gone",
    });
    await expect(
      exoscaleCiTeardown(api, { id: "inst-1", region: "de-fra-1", label: "x" }),
    ).resolves.toBeUndefined();
    expect(sent.at(-1)?.url.host).toBe("api-de-fra-1.example.test");
  });

  it("lists labelled instances per zone with their tags as sent", async () => {
    const { api } = exoscale([
      [
        "GET /v2/instance",
        (call) =>
          call.url.host.startsWith("api-ch-gva-2")
            ? {
                instances: [
                  {
                    id: "a",
                    state: "running",
                    "created-at": "2026-11-13T10:00:00Z",
                    labels: labelsOf(tags),
                  },
                  { id: "b", state: "running", labels: { env: "prod" } },
                ],
              }
            : { instances: [{ id: "c", state: "stopped", labels: labelsOf(tags) }] },
      ],
    ]);
    const found = await exoscaleCiListTagged(api, "infrawrench-ci", ["ch-gva-2", "de-fra-1"]);
    expect(found.map((f) => [f.handle.id, f.handle.region, f.live])).toEqual([
      ["a", "ch-gva-2", true],
      ["c", "de-fra-1", false],
    ]);
    expect(found[0]?.tags).toEqual(tags);
  });

  it("reads the key's role and names a denied compute service", async () => {
    const { api } = exoscale([
      ["GET /v2/api-key/EXOkey", () => ({ key: "EXOkey", "role-id": "role-1" })],
      [
        "GET /v2/iam-role/role-1",
        () => ({
          policy: { "default-service-strategy": "allow", services: { compute: { type: "deny" } } },
        }),
      ],
      ["GET /v2/instance", () => new FakeHttpReply(403, { message: "forbidden" })],
      [
        "GET /v2/template",
        () => ({ templates: [{ id: TEMPLATE, name: "Linux Ubuntu 24.04 LTS 64-bit" }] }),
      ],
    ]);
    const result = await exoscaleCiPreflight(api, "vm");
    expect(result.missing.map((m) => m.permission)).toEqual(["compute"]);
    expect(result.ok).toBe(false);

    const blind = exoscale([
      ["GET /v2/api-key/EXOkey", () => new FakeHttpReply(403, { message: "forbidden" })],
      ["GET /v2/instance", () => ({ instances: [] })],
      [
        "GET /v2/template",
        () => ({ templates: [{ id: TEMPLATE, name: "Linux Ubuntu 24.04 LTS 64-bit" }] }),
      ],
    ]);
    expect(await exoscaleCiPreflight(blind.api, "vm", "de-fra-1")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "de-fra-1",
    });
  });
});
