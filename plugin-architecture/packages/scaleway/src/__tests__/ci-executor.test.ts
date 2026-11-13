import { describe, expect, it } from "vitest";

import { ciTagStrings } from "@infrawrench/plugin-base";

import {
  scalewayCiListTagged,
  scalewayCiPreflight,
  scalewayCiStart,
  scalewayCiStatus,
  scalewayCiTeardown,
  serverBody,
} from "../ci-executor.js";
import { definitionBody } from "../ci-jobs.js";
import type { ScwCiContext } from "../ci-shared.js";
import { ScalewayHttpError } from "../lists.js";

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
const IMAGE = "a85e8bd8-1111-4222-8333-944445555666";

type Route = (path: string, init?: RequestInit) => unknown;

/** A fake Scaleway REST surface: `METHOD path` prefixes to answers. No network. */
function fakeScw(routes: Array<[string, Route]>, projectId = "proj-1") {
  const sent: Array<{ method: string; path: string; body?: unknown; headers?: unknown }> = [];
  const ctx: ScwCiContext = {
    accessKey: "SCWKEY",
    sleep: async () => {},
    rest: {
      projectId,
      fetch: async <T>(path: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const raw = init?.body === undefined ? undefined : String(init.body);
        let body: unknown = raw;
        try {
          body = raw === undefined ? undefined : JSON.parse(raw);
        } catch {
          // text
        }
        sent.push({ method, path, body, headers: init?.headers });
        const match = routes.find(([pattern]) => {
          const [m, p] = pattern.split(" ");
          return m === method && path.startsWith(p ?? "");
        });
        if (!match) throw new Error(`unexpected ${method} ${path}`);
        return (await match[1](path, init)) as T;
      },
    },
  };
  return { ctx, sent };
}

const status = (code: number) => () => {
  throw new ScalewayHttpError(code, `Scaleway API error ${code} for x`);
};

describe("Scaleway CI executor: Instances", () => {
  it("writes a server with an SBS root, a dynamic address and its tags", () => {
    const body = serverBody(spec, IMAGE, "proj-1");
    expect(body).toMatchObject({
      name: NAME,
      commercial_type: "PLAY2-NANO",
      image: IMAGE,
      project: "proj-1",
      dynamic_ip_required: true,
      volumes: { "0": { volume_type: "sbs_volume" } },
    });
    expect(body.tags).toEqual(ciTagStrings(tags));
  });

  it("creates the server stopped, gives it user data, then powers it on", async () => {
    const { ctx, sent } = fakeScw([
      ["GET /instance/v1/zones/fr-par-1/servers?name=", () => ({ servers: [] })],
      [
        "GET /marketplace/v2/local-images",
        () => ({
          local_images: [
            { id: "arm", arch: "arm64", compatible_commercial_types: ["COPARM1-2C-8G"] },
            { id: IMAGE, arch: "x86_64", compatible_commercial_types: ["PLAY2-NANO"] },
          ],
        }),
      ],
      [
        "POST /instance/v1/zones/fr-par-1/servers",
        () => ({
          server: {
            id: "s-1",
            state: "stopped",
            volumes: { "0": { id: "v-1", volume_type: "sbs_volume" } },
          },
        }),
      ],
      ["PATCH /instance/v1/zones/fr-par-1/servers/s-1/user_data/cloud-init", () => undefined],
      ["POST /instance/v1/zones/fr-par-1/servers/s-1/action", () => ({ task: {} })],
    ]);
    expect(await scalewayCiStart(ctx, spec)).toEqual({
      id: "s-1",
      region: "fr-par-1",
      label: "scaleway instance s-1 (fr-par-1)",
      data: { kind: "vm", volumes: "v-1" },
    });
    const methods = sent.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(methods.slice(2)).toEqual([
      "POST /instance/v1/zones/fr-par-1/servers",
      "PATCH /instance/v1/zones/fr-par-1/servers/s-1/user_data/cloud-init",
      "POST /instance/v1/zones/fr-par-1/servers/s-1/action",
    ]);
    const userData = sent.find((c) => c.method === "PATCH");
    expect(userData?.headers).toEqual({ "Content-Type": "text/plain" });
    expect(String(userData?.body)).toMatch(/^#!\/bin\/bash\nshutdown -h \+60 /);
    expect(sent.at(-1)?.body).toEqual({ action: "poweron" });
  });

  it("boots a server a first start made but did not power on", async () => {
    const { ctx, sent } = fakeScw([
      [
        "GET /instance/v1/zones/fr-par-1/servers?name=",
        () => ({
          servers: [
            { id: "s-1", name: NAME, state: "stopped" },
            { id: "s-2", name: `${NAME}0`, state: "running" },
          ],
        }),
      ],
      ["PATCH /instance/v1/zones/fr-par-1/servers/s-1/user_data/cloud-init", () => undefined],
      ["POST /instance/v1/zones/fr-par-1/servers/s-1/action", () => ({ task: {} })],
    ]);
    expect((await scalewayCiStart(ctx, spec)).id).toBe("s-1");
    expect(sent.some((c) => c.method === "POST" && c.path.endsWith("/servers"))).toBe(false);
  });

  it("terminates, waits for the server to go, then deletes its root volume", async () => {
    let gets = 0;
    const { ctx, sent } = fakeScw([
      [
        "GET /instance/v1/zones/fr-par-1/servers/s-1",
        () => {
          gets++;
          if (gets > 2) return status(404)();
          return {
            server: {
              id: "s-1",
              state: "running",
              volumes: { "0": { id: "v-1", volume_type: "sbs_volume" } },
            },
          };
        },
      ],
      ["POST /instance/v1/zones/fr-par-1/servers/s-1/action", () => ({ task: {} })],
      ["DELETE /block/v1/zones/fr-par-1/volumes/v-1", () => undefined],
    ]);
    await scalewayCiTeardown(ctx, {
      id: "s-1",
      region: "fr-par-1",
      label: "x",
      data: { kind: "vm" },
    });
    expect(sent.find((c) => c.method === "POST")?.body).toEqual({ action: "terminate" });
    expect(sent.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/block/v1/zones/fr-par-1/volumes/v-1",
    });

    const gone = fakeScw([
      ["GET /instance/v1/zones/fr-par-1/servers/s-1", status(404)],
      ["DELETE /block/v1/zones/fr-par-1/volumes/v-1", status(404)],
    ]);
    await expect(
      scalewayCiTeardown(gone.ctx, {
        id: "s-1",
        region: "fr-par-1",
        label: "x",
        data: { kind: "vm", volumes: "v-1" },
      }),
    ).resolves.toBeUndefined();
    expect(await scalewayCiStatus(gone.ctx, { id: "s-1", region: "fr-par-1", label: "x" })).toEqual(
      { state: "gone" },
    );
  });

  it("lists tagged servers per zone", async () => {
    const { ctx } = fakeScw([
      [
        "GET /instance/v1/zones/nl-ams-1/servers",
        () => ({
          servers: [
            {
              id: "a",
              state: "running",
              creation_date: "2026-11-13T10:00:00Z",
              tags: ciTagStrings(tags),
            },
            { id: "b", state: "running", tags: ["web"] },
          ],
        }),
      ],
    ]);
    const found = await scalewayCiListTagged(ctx, "infrawrench-ci", ["nl-ams-1"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ handle: { id: "a", region: "nl-ams-1" }, tags, live: true });
  });

  it("reads the application's permission sets", async () => {
    const routes: Array<[string, Route]> = [
      [
        "GET /iam/v1alpha1/api-keys/SCWKEY",
        () => ({ application_id: "app-1", default_project_id: "proj-1" }),
      ],
      ["GET /iam/v1alpha1/policies?application_ids=", () => ({ policies: [{ id: "pol-1" }] })],
      ["GET /iam/v1alpha1/groups", () => ({ groups: [] })],
      [
        "GET /iam/v1alpha1/rules",
        () => ({ rules: [{ permission_set_names: ["InstancesFullAccess"] }] }),
      ],
      ["GET /instance/v1/zones/fr-par-1/servers", () => ({ servers: [] })],
      [
        "GET /marketplace/v2/local-images",
        () => ({ local_images: [{ id: IMAGE, arch: "x86_64" }] }),
      ],
    ];
    const { ctx } = fakeScw(routes);
    const result = await scalewayCiPreflight(ctx, "vm");
    expect(result.missing.map((m) => m.permission)).toEqual(["BlockStorageFullAccess"]);

    const blind = fakeScw([
      ["GET /iam/v1alpha1/api-keys/SCWKEY", status(403)],
      ["GET /instance/v1/zones/fr-par-1/servers", () => ({ servers: [] })],
      [
        "GET /marketplace/v2/local-images",
        () => ({ local_images: [{ id: IMAGE, arch: "x86_64" }] }),
      ],
    ]);
    expect(await scalewayCiPreflight(blind.ctx, "vm")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "fr-par-1",
    });
  });
});

describe("Scaleway CI executor: Serverless Jobs", () => {
  const job = { ...spec, kind: "container" as const };

  it("defines a job with the bootstrap under a watchdog and a timeout", () => {
    const body = definitionBody(job, "proj-1");
    expect(body).toMatchObject({
      name: NAME,
      project_id: "proj-1",
      cpu_limit: 2000,
      memory_limit: 4096,
      image_uri: "docker.io/library/buildpack-deps:noble-curl",
      startup_command: ["/bin/sh", "-c"],
      job_timeout: "3600s",
      retry_policy: { max_retries: 0 },
    });
    expect(body.args.at(-1)).toContain("# Infrawrench CI: install what the job needs");
    expect(body.args.at(-1)).toContain("echo hi");
    expect(JSON.parse(body.description)).toEqual(tags);
    expect(() => definitionBody({ ...job, machine: "8vcpu-32gb" }, "p")).toThrow("6 vCPUs");
    expect(() => definitionBody({ ...job, machine: "big" }, "p")).toThrow("vcpu");
    expect(() => definitionBody({ ...job, maxSeconds: 90_000 }, "p")).toThrow("24 hours");
  });

  it("creates the definition, starts it once, and finds both on a retry", async () => {
    const { ctx, sent } = fakeScw([
      [
        "GET /serverless-jobs/v1alpha2/regions/fr-par/job-definitions?",
        () => ({ job_definitions: [] }),
      ],
      [
        "POST /serverless-jobs/v1alpha2/regions/fr-par/job-definitions/d-1/start",
        () => ({ job_runs: [{ id: "r-1" }] }),
      ],
      ["POST /serverless-jobs/v1alpha2/regions/fr-par/job-definitions", () => ({ id: "d-1" })],
    ]);
    expect(await scalewayCiStart(ctx, job)).toEqual({
      id: "d-1",
      region: "fr-par",
      label: "scaleway job r-1 (fr-par)",
      data: { kind: "container", run: "r-1" },
    });
    expect(sent.filter((c) => c.method === "POST")).toHaveLength(2);

    const again = fakeScw([
      [
        "GET /serverless-jobs/v1alpha2/regions/fr-par/job-definitions?",
        () => ({ job_definitions: [{ id: "d-1", name: NAME }] }),
      ],
      [
        "GET /serverless-jobs/v1alpha2/regions/fr-par/job-runs?",
        () => ({ job_runs: [{ id: "r-1", state: "running" }] }),
      ],
    ]);
    expect((await scalewayCiStart(again.ctx, job)).data).toEqual({ kind: "container", run: "r-1" });
    expect(again.sent.some((c) => c.method === "POST")).toBe(false);
  });

  it("maps run states, stops a live run and deletes the definition", async () => {
    const handle = {
      id: "d-1",
      region: "fr-par",
      label: "x",
      data: { kind: "container", run: "r-1" },
    };
    for (const [state, want] of [
      ["queued", "starting"],
      ["running", "running"],
      ["succeeded", "stopped"],
      ["failed", "stopped"],
    ] as const) {
      const { ctx } = fakeScw([
        ["GET /serverless-jobs/v1alpha2/regions/fr-par/job-runs/r-1", () => ({ id: "r-1", state })],
      ]);
      expect((await scalewayCiStatus(ctx, handle)).state).toBe(want);
    }
    const { ctx, sent } = fakeScw([
      [
        "GET /serverless-jobs/v1alpha2/regions/fr-par/job-runs?",
        () => ({ job_runs: [{ id: "r-1", state: "running" }] }),
      ],
      ["POST /serverless-jobs/v1alpha2/regions/fr-par/job-runs/r-1/stop", () => ({})],
      ["DELETE /serverless-jobs/v1alpha2/regions/fr-par/job-definitions/d-1", () => undefined],
    ]);
    await scalewayCiTeardown(ctx, handle);
    expect(sent.map((c) => c.method)).toEqual(["GET", "POST", "DELETE"]);
    const gone = fakeScw([
      ["GET /serverless-jobs/v1alpha2/regions/fr-par/job-runs?", status(404)],
      ["DELETE /serverless-jobs/v1alpha2/regions/fr-par/job-definitions/d-1", status(404)],
    ]);
    await expect(scalewayCiTeardown(gone.ctx, handle)).resolves.toBeUndefined();
  });

  it("lists definitions it made, with tags from their description", async () => {
    const { ctx } = fakeScw([
      [
        "GET /serverless-jobs/v1alpha2/regions/fr-par/job-definitions?",
        () => ({
          job_definitions: [
            {
              id: "d-1",
              name: NAME,
              description: JSON.stringify(tags),
              created_at: "2026-11-13T10:00:00Z",
            },
            { id: "d-2", name: "nightly", description: "mine" },
          ],
        }),
      ],
      [
        "GET /serverless-jobs/v1alpha2/regions/fr-par/job-runs?",
        () => ({ job_runs: [{ id: "r-1", state: "succeeded" }] }),
      ],
    ]);
    const found = await scalewayCiListTagged(ctx, "infrawrench-ci", ["fr-par"]);
    expect(found).toEqual([
      {
        handle: {
          id: "d-1",
          region: "fr-par",
          label: "scaleway job r-1 (fr-par)",
          data: { kind: "container", run: "r-1" },
        },
        tags,
        createdAt: "2026-11-13T10:00:00Z",
        live: false,
      },
    ]);
  });
});
