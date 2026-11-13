import { describe, expect, it } from "vitest";

import { ciTagStrings } from "@infrawrench/plugin-base";

import {
  doCiListTagged,
  doCiPreflight,
  doCiStart,
  doCiStatus,
  doCiTeardown,
  dropletBody,
} from "../ci-executor.js";
import { fakeApi } from "./fake-api.js";

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
const jobTag = "iwci-job:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

function httpError(status: number) {
  return Object.assign(new Error(`DO API error ${status} for x: {}`), { status });
}

type Route = (path: string, init?: RequestInit) => unknown;

/** A fake DigitalOcean: `METHOD path` prefixes to answers, recording each call. No network. */
function fakeDo(routes: Array<[string, Route]>) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = fakeApi((path, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });
    const match = routes.find(([pattern]) => {
      const [m, p] = pattern.split(" ");
      return m === method && path.startsWith(p ?? "");
    });
    if (!match) throw new Error(`unexpected ${method} ${path}`);
    return match[1](path, init);
  });
  return { api, sent };
}

describe("DigitalOcean CI executor", () => {
  it("writes a Droplet with the bootstrap as user data, tags and no token", () => {
    const body = dropletBody(spec, 42);
    expect(body.name).toBe("iwci-0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect(body.region).toBe("nyc3");
    expect(body.size).toBe("s-2vcpu-4gb");
    expect(body.image).toBe("ubuntu-24-04-x64");
    expect(body.ssh_keys).toEqual([42]);
    expect(body.user_data).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    expect(body.user_data).toContain("echo hi");
    expect(body.tags).toEqual(ciTagStrings(tags));
    expect(body.tags).toContain(jobTag);
    expect(body.with_droplet_agent).toBe(false);
  });

  it("starts with a throwaway key, removes the key, and finds the Droplet on a retry", async () => {
    const { api, sent } = fakeDo([
      ["GET /droplets", () => ({ droplets: [] })],
      ["POST /account/keys", () => ({ ssh_key: { id: 7, name: "k", public_key: "x" } })],
      ["POST /droplets", () => ({ droplet: { id: 99, status: "new", region: { slug: "nyc3" } } })],
      ["DELETE /account/keys/7", () => undefined],
    ]);
    const handle = await doCiStart(api, spec);
    expect(handle).toEqual({
      id: "99",
      region: "nyc3",
      label: "digitalocean droplet 99 (nyc3)",
      data: { sshKey: "7" },
    });
    expect(sent[0]?.path).toBe(`/droplets?tag_name=${encodeURIComponent(jobTag)}&per_page=20`);
    const key = sent.find((c) => c.method === "POST" && c.path === "/account/keys");
    expect((key?.body as { public_key: string }).public_key).toMatch(/^ssh-ed25519 /);
    const create = sent.find((c) => c.method === "POST" && c.path === "/droplets");
    expect((create?.body as { ssh_keys: number[] }).ssh_keys).toEqual([7]);
    expect(JSON.stringify(create?.body)).not.toContain("dop_v1");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", path: "/account/keys/7" });

    const again = fakeDo([
      [
        "GET /droplets",
        () => ({ droplets: [{ id: 99, status: "active", region: { slug: "fra1" } }] }),
      ],
    ]);
    expect((await doCiStart(again.api, spec)).id).toBe("99");
    expect(again.sent).toHaveLength(1);
  });

  it("removes the key even when the create fails", async () => {
    const { api, sent } = fakeDo([
      ["GET /droplets", () => ({ droplets: [] })],
      ["POST /account/keys", () => ({ ssh_key: { id: 7, name: "k", public_key: "x" } })],
      [
        "POST /droplets",
        () => {
          throw httpError(422);
        },
      ],
      ["DELETE /account/keys/7", () => undefined],
    ]);
    await expect(doCiStart(api, spec)).rejects.toThrow("422");
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", path: "/account/keys/7" });
  });

  it("maps Droplet states", async () => {
    for (const [status, state] of [
      ["new", "starting"],
      ["active", "running"],
      ["off", "stopped"],
      ["archive", "gone"],
    ] as const) {
      const { api } = fakeDo([["GET /droplets/99", () => ({ droplet: { id: 99, status } })]]);
      expect((await doCiStatus(api, { id: "99", label: "x" })).state).toBe(state);
    }
    const { api } = fakeDo([
      [
        "GET /droplets/99",
        () => {
          throw httpError(404);
        },
      ],
    ]);
    expect(await doCiStatus(api, { id: "99", label: "x" })).toEqual({ state: "gone" });
  });

  it("tears down the Droplet and the job's own tags, and succeeds when all is gone", async () => {
    const { api, sent } = fakeDo([
      [
        "GET /droplets/99",
        () => ({ droplet: { id: 99, status: "active", tags: ciTagStrings(tags) } }),
      ],
      ["DELETE /droplets/99", () => undefined],
      [
        "DELETE /account/keys/7",
        () => {
          throw httpError(404);
        },
      ],
      ["GET /tags/iwci-run", () => ({ tag: { name: "x", resources: { count: 1 } } })],
      ["GET /tags/iwci-job", () => ({ tag: { name: "x", resources: { count: 0 } } })],
      ["DELETE /tags/iwci-job", () => undefined],
    ]);
    await doCiTeardown(api, { id: "99", label: "x", data: { sshKey: "7" } });
    const deletes = sent.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual([
      "/droplets/99",
      "/account/keys/7",
      `/tags/${encodeURIComponent(jobTag)}`,
    ]);

    const gone = fakeDo([
      [
        "GET /droplets/99",
        () => {
          throw httpError(404);
        },
      ],
    ]);
    await expect(doCiTeardown(gone.api, { id: "99", label: "x" })).resolves.toBeUndefined();
  });

  it("lists Droplets carrying the CI marker with their tags as sent", async () => {
    const { api, sent } = fakeDo([
      [
        "GET /droplets",
        () => ({
          droplets: [
            {
              id: 1,
              status: "active",
              created_at: "2026-11-13T10:00:00Z",
              tags: [...ciTagStrings(tags), "team:web"],
              region: { slug: "fra1" },
            },
            { id: 2, status: "off", tags: ciTagStrings(tags), region: { slug: "nyc3" } },
            { id: 3, status: "active", tags: ["other"], region: { slug: "nyc3" } },
          ],
          meta: { total: 3 },
        }),
      ],
    ]);
    const found = await doCiListTagged(api, "infrawrench-ci");
    expect(sent[0]?.path).toContain("tag_name=iwci");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      handle: { id: "1", region: "fra1" },
      tags,
      createdAt: "2026-11-13T10:00:00Z",
      live: true,
    });
    expect(found[1]?.live).toBe(false);
  });

  it("names each scope a 403 refuses, and a region that cannot take the job", async () => {
    const { api } = fakeDo([
      ["GET /droplets", () => ({ droplets: [] })],
      [
        "POST /droplets",
        () => {
          throw httpError(403);
        },
      ],
      [
        "DELETE /droplets/0",
        () => {
          throw httpError(404);
        },
      ],
      ["GET /tags", () => ({ tags: [] })],
      [
        "POST /tags",
        () => {
          throw httpError(422);
        },
      ],
      [
        "DELETE /tags",
        () => {
          throw httpError(403);
        },
      ],
      ["GET /account/keys", () => ({ ssh_keys: [] })],
      [
        "POST /account/keys",
        () => {
          throw httpError(422);
        },
      ],
      [
        "DELETE /account/keys/0",
        () => {
          throw httpError(404);
        },
      ],
      [
        "GET /regions",
        () => ({ regions: [{ slug: "nyc3", available: true, sizes: ["s-1vcpu-1gb"] }] }),
      ],
    ]);
    const result = await doCiPreflight(api, "vm");
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.permission)).toEqual(["droplet:create", "tag:delete"]);
    expect(result.problems[0]).toContain("s-2vcpu-4gb");
    expect(result.region).toBe("nyc3");
    await expect(doCiPreflight(api, "container")).rejects.toThrow("`vm`");
  });
});
