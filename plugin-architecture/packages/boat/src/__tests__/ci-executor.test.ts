import { describe, expect, it } from "vitest";

import type { HostServices } from "@infrawrench/plugin-base";
import { FakeHttpReply, fakeCiHttp } from "@infrawrench/plugin-base/test-harness";

import { createBoatApi } from "../api.js";
import {
  BOOTSTRAP_PATH,
  boatCiListTagged,
  boatCiPreflight,
  boatCiStart,
  boatCiStatus,
  boatCiTeardown,
  createBody,
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
const KEY = "boat_secret_key";

function boat(routes: Parameters<typeof fakeCiHttp>[0]) {
  const { http, sent } = fakeCiHttp(routes);
  return { api: createBoatApi(KEY, "", "", { http } as HostServices), sent };
}

function sandbox(over: Record<string, unknown> = {}) {
  return {
    id: "bx_23456789",
    name: NAME,
    state: "ready",
    labels: tags,
    createdAt: "2026-11-13T10:00:00Z",
    desktopAvailable: false,
    snapshotAvailable: false,
    ...over,
  };
}

describe("boat CI executor", () => {
  it("asks for a private sandbox with nothing of the account's, stopped at the deadline", () => {
    const body = createBody(spec);
    expect(body).toMatchObject({
      name: NAME,
      type: "default",
      ttlSeconds: 3600,
      labels: tags,
      noEnv: true,
      snapshots: false,
      monitoring: false,
      visibility: "private",
      files: [{ path: BOOTSTRAP_PATH, content: spec.bootstrap }],
    });
    expect(body.setupScript).toContain(`exec sudo -n timeout -k 15 3600 bash ${BOOTSTRAP_PATH}`);
    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("from");
    expect(createBody({ ...spec, image: "ci-base" })).toMatchObject({ from: "ci-base" });
    expect(createBody({ ...spec, maxSeconds: 99_999_999 }).ttlSeconds).toBe(2_592_000);
    expect(() => createBody({ ...spec, machine: "huge" })).toThrow("small, default, large");
  });

  it("starts once, with an idempotency key, and never hands over the key", async () => {
    const { api, sent } = boat([
      ["GET /sandboxes", () => ({ ok: true, sandboxes: [] })],
      [
        "POST /sandboxes",
        () => new FakeHttpReply(202, { ok: true, sandbox: sandbox({ state: "provisioning" }) }),
      ],
    ]);
    expect(await boatCiStart(api, spec)).toEqual({
      id: "bx_23456789",
      label: "boat sandbox bx_23456789",
    });
    expect(decodeURIComponent(sent[0]!.url.search)).toBe(
      `?name=${NAME}&label=infrawrench-ci-job=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`,
    );
    const create = sent[1]!;
    expect(create.headers["Idempotency-Key"]).toBe("iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect(JSON.stringify(create.body)).not.toContain(KEY);
  });

  it("finds the sandbox a first start made", async () => {
    const { api, sent } = boat([
      ["GET /sandboxes", () => ({ ok: true, sandboxes: [sandbox({ state: "running" })] })],
    ]);
    expect(await boatCiStart(api, spec)).toMatchObject({ id: "bx_23456789" });
    expect(sent).toHaveLength(1);
  });

  it("looks again when the create races another", async () => {
    let lists = 0;
    const { api } = boat([
      [
        "GET /sandboxes",
        () => ({ ok: true, sandboxes: lists++ === 0 ? [] : [sandbox({ id: "bx_33333333" })] }),
      ],
      [
        "POST /sandboxes",
        () => new FakeHttpReply(409, { ok: false, code: "idempotency_in_progress", message: "x" }),
      ],
    ]);
    expect(await boatCiStart(api, spec)).toMatchObject({ id: "bx_33333333" });
  });

  it("refuses GPUs", async () => {
    const { api } = boat([]);
    await expect(boatCiStart(api, { ...spec, gpu: "h100" })).rejects.toThrow("no GPUs");
  });

  it("maps sandbox states", async () => {
    const status = async (state: string) =>
      (
        await boatCiStatus(
          boat([["GET /sandboxes/", () => ({ ok: true, sandbox: sandbox({ state }) })]]).api,
          { id: "bx_23456789", label: "x" },
        )
      ).state;
    expect(await status("provisioning")).toBe("starting");
    expect(await status("running")).toBe("running");
    expect(await status("archived")).toBe("stopped");
    expect(await status("error")).toBe("stopped");
    expect(await status("cancelled")).toBe("gone");
    const gone = boat([["GET /sandboxes/", () => new FakeHttpReply(404, { code: "not_found" })]]);
    expect(await boatCiStatus(gone.api, { id: "bx_23456789", label: "x" })).toEqual({
      state: "gone",
    });
  });

  it("deletes with the confirming header, and succeeds when it is gone", async () => {
    const { api, sent } = boat([["DELETE /sandboxes/bx_23456789", () => ({ ok: true })]]);
    await boatCiTeardown(api, { id: "bx_23456789", label: "x" });
    expect(sent[0]!.headers["X-Ascii-Confirm-Delete"]).toBe("bx_23456789");
    const gone = boat([
      ["DELETE /sandboxes/", () => new FakeHttpReply(404, { code: "not_found" })],
    ]);
    await expect(
      boatCiTeardown(gone.api, { id: "bx_23456789", label: "x" }),
    ).resolves.toBeUndefined();
  });

  it("lists CI sandboxes by their labels", async () => {
    const { api, sent } = boat([
      [
        "GET /sandboxes",
        () => ({
          ok: true,
          sandboxes: [
            sandbox(),
            sandbox({ id: "bx_44444444", state: "archived" }),
            sandbox({ id: "bx_55555555", labels: {} }),
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      ],
    ]);
    const listed = await boatCiListTagged(api, "infrawrench-ci");
    expect(listed.map((t) => [t.handle.id, t.live])).toEqual([
      ["bx_23456789", true],
      ["bx_44444444", false],
    ]);
    expect(listed[0]!.tags).toEqual(tags);
    expect(sent[0]!.url.searchParams.get("namePrefix")).toBe("iwci-");
  });

  it("names a missing delete action and a read the key may not make", async () => {
    const { api } = boat([
      [
        "GET /sandboxes",
        () => new FakeHttpReply(403, { code: "api_key_action_forbidden", message: "no" }),
      ],
      [
        "DELETE /sandboxes/",
        () => new FakeHttpReply(403, { code: "api_key_action_forbidden", message: "no" }),
      ],
      ["GET /limits", () => ({ ok: true, canStart: true })],
    ]);
    const result = await boatCiPreflight(api, "vm");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["sandbox.read", "sandbox.delete-own"]);
    const ok = boat([
      ["GET /sandboxes", () => ({ ok: true, sandboxes: [] })],
      ["DELETE /sandboxes/", () => new FakeHttpReply(404, { code: "not_found" })],
      ["GET /limits", () => new FakeHttpReply(403, { code: "api_key_action_forbidden" })],
    ]);
    expect(await boatCiPreflight(ok.api, "vm")).toEqual({ ok: true, missing: [], problems: [] });
  });
});
