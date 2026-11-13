import { describe, expect, it } from "vitest";

import { IbmApi } from "../api.js";
import { ceResources, ensureProject, jobRunBody } from "../ci-code-engine.js";
import { fromIbmTags, ibmTag, ibmTags } from "../ci-shared.js";
import { plugin } from "../plugin.js";
import { TEST_TOKEN, makeClient, type Recorded, type Reply } from "./helpers.js";

const tags = {
  "infrawrench-ci": "org_01HXyZ",
  "infrawrench-ci-run": "Run/7",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const spec = { bootstrap: "#!/bin/sh\necho hi\n", tags, name: "ci build", maxSeconds: 3600 };

const json = (req: Recorded): Record<string, any> =>
  typeof req.body === "string" && req.body ? JSON.parse(req.body) : {};

/** A region whose CI network is there, unless `fresh`. */
function vpcRegion(opts: { fresh?: boolean } = {}) {
  const made: string[] = [];
  const route = (req: Recorded): Reply | undefined => {
    const p = req.url.pathname;
    const m = req.method;
    const has = (what: string) => !opts.fresh || made.includes(what);
    if (m === "GET" && p === "/v1/vpcs") {
      return {
        body: {
          vpcs: has("vpc")
            ? [{ id: "vpc-ci", name: "infrawrench-ci", status: "available" }]
            : [{ id: "vpc-app", name: "app" }],
        },
      };
    }
    if (m === "POST" && p === "/v1/vpcs") {
      made.push("vpc");
      return { body: { id: "vpc-ci", name: "infrawrench-ci", status: "available" } };
    }
    if (m === "GET" && p === "/v1/vpcs/vpc-ci")
      return { body: { id: "vpc-ci", status: "available" } };
    if (m === "GET" && p === "/v1/regions/us-south/zones") {
      return {
        body: {
          zones: [
            { name: "us-south-2", status: "available" },
            { name: "us-south-1", status: "available" },
          ],
        },
      };
    }
    if (m === "GET" && p === "/v1/subnets")
      return {
        body: {
          subnets: has("subnet")
            ? [{ id: "sn-ci", name: "infrawrench-ci", status: "available" }]
            : [],
        },
      };
    if (m === "GET" && p === "/v1/public_gateways") return { body: { public_gateways: [] } };
    if (m === "POST" && p === "/v1/public_gateways") {
      made.push("gateway");
      return { body: { id: "pgw-ci", status: "available" } };
    }
    if (m === "GET" && p === "/v1/public_gateways/pgw-ci")
      return { body: { id: "pgw-ci", status: "available" } };
    if (m === "POST" && p === "/v1/subnets") {
      made.push("subnet");
      return { body: { id: "sn-ci", status: "available" } };
    }
    if (m === "GET" && p === "/v1/subnets/sn-ci")
      return { body: { id: "sn-ci", status: "available" } };
    if (m === "GET" && p === "/v1/security_groups")
      return {
        body: { security_groups: has("group") ? [{ id: "sg-ci", name: "infrawrench-ci" }] : [] },
      };
    if (m === "POST" && p === "/v1/security_groups") {
      made.push("group");
      return { body: { id: "sg-ci", name: "infrawrench-ci" } };
    }
    if (m === "GET" && p === "/v1/images") {
      return {
        body: {
          images: [
            {
              id: "r006-old",
              created_at: "2026-01-01T00:00:00Z",
              operating_system: { name: "ubuntu-24-04-amd64" },
            },
            {
              id: "r006-new",
              created_at: "2026-09-01T00:00:00Z",
              operating_system: { name: "ubuntu-24-04-amd64" },
            },
            {
              id: "r006-rhel",
              created_at: "2026-10-01T00:00:00Z",
              operating_system: { name: "red-9-amd64" },
            },
          ],
        },
      };
    }
    return undefined;
  };
  return { made, route };
}

describe("IBM Cloud CI executor", () => {
  it("declares vm and container, and leaves build out", () => {
    expect(plugin.manifest.ciExecutor?.kinds.map((k) => k.kind)).toEqual(["vm", "container"]);
  });

  it("writes tags IBM lowercases so they read back exactly as sent", () => {
    const written = ibmTags(tags);
    for (const t of written) {
      expect(t).toBe(t.toLowerCase());
      expect(t).toMatch(/^[a-z0-9 _.:-]+$/);
    }
    expect(ibmTag("infrawrench-ci", "org_01HXyZ")).toBe("infrawrench-ci:org__01_h_xy_z");
    expect(fromIbmTags([...written, "env:prod-ish", "nocolon"])).toEqual({
      ...tags,
      env: "prod-ish",
    });
    expect(fromIbmTags([ibmTag("k", "é/ü ok")])).toEqual({ k: "é/ü ok" });
  });

  it("starts an instance on the CI network with no metadata service, then tags it", async () => {
    const net = vpcRegion();
    const { client, calls } = makeClient((req) => {
      const p = req.url.pathname;
      if (req.method === "GET" && p === "/v1/instances") return { body: { instances: [] } };
      if (req.method === "POST" && p === "/v1/instances")
        return { status: 201, body: { id: "0717_inst", crn: "crn:v1:inst" } };
      if (req.url.host === "tags.global-search-tagging.cloud.ibm.com")
        return { body: { results: [] } };
      return net.route(req);
    });
    const handle = await client.ciStart!({ ...spec, kind: "vm" });
    expect(handle).toMatchObject({ id: "0717_inst", region: "us-south", data: { kind: "vm" } });
    const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/instances")!;
    expect(create.url.searchParams.get("generation")).toBe("2");
    const body = json(create);
    expect(body).toMatchObject({
      name: `iwci-${key}`,
      profile: { name: "bx2-2x8" },
      zone: { name: "us-south-1" },
      vpc: { id: "vpc-ci" },
      image: { id: "r006-new" },
      metadata_service: { enabled: false },
      boot_volume_attachment: { delete_volume_on_instance_delete: true },
      primary_network_attachment: {
        virtual_network_interface: {
          subnet: { id: "sn-ci" },
          security_groups: [{ id: "sg-ci" }],
          auto_delete: true,
        },
      },
    });
    expect(body["default_trusted_profile"]).toBeUndefined();
    expect(body["keys"]).toBeUndefined();
    expect(body["user_data"]).toContain("echo hi");
    const attach = calls.find((c) => c.url.pathname === "/v3/tags/attach")!;
    expect(attach.url.searchParams.get("tag_type")).toBe("user");
    expect(json(attach)).toEqual({
      resources: [{ resource_id: "crn:v1:inst" }],
      tag_names: ibmTags(tags),
    });
    expect(net.made).toEqual([]);
  });

  it("deletes an instance it could not tag, so nothing is left the reaper cannot find", async () => {
    const net = vpcRegion();
    const { client, calls } = makeClient((req) => {
      const p = req.url.pathname;
      if (req.method === "GET" && p === "/v1/instances") return { body: { instances: [] } };
      if (req.method === "POST" && p === "/v1/instances")
        return { status: 201, body: { id: "0717_inst", crn: "crn:v1:inst" } };
      if (req.method === "DELETE" && p === "/v1/instances/0717_inst") return { status: 204 };
      if (p === "/v3/tags/attach")
        return { status: 403, body: { errors: [{ code: "forbidden", message: "no tag access" }] } };
      return net.route(req);
    });
    await expect(client.ciStart!({ ...spec, kind: "vm" })).rejects.toThrow("could not tag");
    expect(
      calls.some((c) => c.method === "DELETE" && c.url.pathname === "/v1/instances/0717_inst"),
    ).toBe(true);
  });

  it("returns the instance an earlier start made", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method === "GET" && req.url.pathname === "/v1/instances") {
        expect(req.url.searchParams.get("name")).toBe(`iwci-${key}`);
        return { body: { instances: [{ id: "0717_old", crn: "crn:v1:old" }] } };
      }
      return undefined;
    });
    expect((await client.ciStart!({ ...spec, kind: "vm" })).id).toBe("0717_old");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("makes the CI network in a new region: gateway, subnet behind it, outbound-only group", async () => {
    const net = vpcRegion({ fresh: true });
    const { client, calls } = makeClient((req) => {
      const p = req.url.pathname;
      if (req.method === "GET" && p === "/v1/instances") return { body: { instances: [] } };
      if (req.method === "POST" && p === "/v1/instances")
        return { status: 201, body: { id: "i", crn: "crn:i" } };
      if (p === "/v3/tags/attach") return { body: {} };
      return net.route(req);
    });
    await client.ciStart!({ ...spec, kind: "vm" });
    expect(net.made).toEqual(["vpc", "gateway", "subnet", "group"]);
    const subnet = json(
      calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/subnets")!,
    );
    expect(subnet).toMatchObject({
      zone: { name: "us-south-1" },
      public_gateway: { id: "pgw-ci" },
      total_ipv4_address_count: 256,
    });
    const group = json(
      calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/security_groups")!,
    );
    expect(group.rules).toEqual([
      { direction: "outbound", protocol: "any", remote: { cidr_block: "0.0.0.0/0" } },
    ]);
  });

  it("runs a Code Engine job run with no identity in the CI project", async () => {
    const { client, calls } = makeClient((req) => {
      const p = req.url.pathname;
      if (req.method === "GET" && p === "/v2/projects")
        return { body: { projects: [{ id: "proj-1", name: "infrawrench-ci", status: "active" }] } };
      if (req.method === "POST" && p === "/v2/projects/proj-1/job_runs")
        return { status: 202, body: {} };
      return undefined;
    });
    const handle = await client.ciStart!({ ...spec, kind: "container", machine: "2vcpu-8gb" });
    expect(handle).toMatchObject({
      id: `iwci-${key}`,
      region: "us-south",
      data: { kind: "container", project: "proj-1" },
    });
    const run = calls.find((c) => c.method === "POST")!;
    expect(run.url.host).toBe("api.us-south.codeengine.cloud.ibm.com");
    const body = json(run);
    expect(body).toMatchObject({
      name: `iwci-${key}`,
      image_reference: "docker.io/library/buildpack-deps:noble-curl",
      run_commands: ["/bin/sh", "-c"],
      run_mode: "task",
      run_service_account: "none",
      run_compute_resource_token_enabled: false,
      scale_cpu_limit: "2",
      scale_memory_limit: "8G",
      scale_ephemeral_storage_limit: "8G",
      scale_max_execution_time: 3600,
      scale_retry_limit: 0,
    });
    expect(body["job_name"]).toBeUndefined();
    expect(JSON.parse(body.run_env_variables[0].value)).toEqual(tags);
  });

  it("makes the CI project on first use and waits for it", async () => {
    let reads = 0;
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const http = {
      async request(req: { url: string; method: string; body?: string | Uint8Array }) {
        const url = new URL(req.url);
        if (url.host === "iam.cloud.ibm.com") {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ access_token: TEST_TOKEN, expires_in: 3600 }),
          };
        }
        const body = typeof req.body === "string" && req.body ? JSON.parse(req.body) : undefined;
        sent.push({ method: req.method, path: url.pathname, body });
        const reply = (() => {
          if (req.method === "GET" && url.pathname === "/v2/projects") return { projects: [] };
          if (req.method === "POST")
            return { id: "proj-new", name: "infrawrench-ci", status: "creating" };
          return { id: "proj-new", status: ++reads > 1 ? "active" : "creating" };
        })();
        return { status: 200, headers: {}, body: JSON.stringify(reply) };
      },
    };
    const waits: number[] = [];
    const ctx = {
      api: new IbmApi("key", http, ""),
      homeRegion: "us-south",
      sleep: async (ms: number) => void waits.push(ms),
    };
    expect(await ensureProject(ctx, "us-south")).toBe("proj-new");
    expect(waits.length).toBe(2);
    expect(sent.find((c) => c.method === "POST")!.body).toEqual({
      name: "infrawrench-ci",
      tags: ["infrawrench-ci-network:true"],
    });
  });

  it("refuses what Code Engine cannot do before making anything", async () => {
    const { client, calls } = makeClient(() => undefined);
    await expect(
      client.ciStart!({ ...spec, kind: "container", maxSeconds: 90_000 }),
    ).rejects.toThrow("24 hours");
    await expect(
      client.ciStart!({ ...spec, kind: "container", machine: "3vcpu-5gb" }),
    ).rejects.toThrow("Code Engine sizes");
    await expect(client.ciStart!({ ...spec, kind: "container", region: "eu-fr2" })).rejects.toThrow(
      "not offered",
    );
    expect(calls).toEqual([]);
  });

  it("reads status, tears down idempotently and lists what is tagged", async () => {
    const { client, calls } = makeClient((req) => {
      const p = req.url.pathname;
      if (p === "/v1/instances/i-run")
        return req.method === "DELETE"
          ? { status: 204 }
          : { body: { id: "i-run", status: "running" } };
      if (p === "/v1/instances/i-gone")
        return { status: 404, body: { errors: [{ code: "not_found", message: "" }] } };
      if (p === `/v2/projects/proj-1/job_runs/iwci-${key}`)
        return req.method === "DELETE" ? { status: 202 } : { body: { status: "completed" } };
      if (p === "/v1/vpcs") return { body: { vpcs: [{ id: "vpc-ci", name: "infrawrench-ci" }] } };
      if (p === "/v1/instances") {
        expect(req.url.searchParams.get("vpc.id")).toBe("vpc-ci");
        return {
          body: {
            instances: [
              {
                id: "i-run",
                name: `iwci-${key}`,
                crn: "crn:i-run",
                status: "running",
                created_at: "2026-11-13T10:00:00Z",
              },
              { id: "i-other", name: "iwci-other", crn: "crn:i-other", status: "running" },
            ],
          },
        };
      }
      if (p === "/v3/tags") {
        const crn = req.url.searchParams.get("attached_to");
        return {
          body: {
            items: (crn === "crn:i-run" ? ibmTags(tags) : ["team:web"]).map((name) => ({ name })),
          },
        };
      }
      if (p === "/v2/projects")
        return { body: { projects: [{ id: "proj-1", name: "infrawrench-ci", status: "active" }] } };
      if (p === "/v2/projects/proj-1/job_runs") {
        return {
          body: {
            job_runs: [
              {
                name: `iwci-${key}`,
                status: "running",
                run_env_variables: [
                  { type: "literal", name: "INFRAWRENCH_CI_TAGS", value: JSON.stringify(tags) },
                ],
              },
            ],
          },
        };
      }
      return undefined;
    });
    const vm = { id: "i-run", region: "us-south", label: "", data: { kind: "vm" } };
    expect(await client.ciStatus!(vm)).toMatchObject({ state: "running" });
    expect(await client.ciStatus!({ ...vm, id: "i-gone" })).toEqual({ state: "gone" });
    await client.ciTeardown!(vm);
    await client.ciTeardown!({ ...vm, id: "i-gone" });
    const job = {
      id: `iwci-${key}`,
      region: "us-south",
      label: "",
      data: { kind: "container", project: "proj-1" },
    };
    expect(await client.ciStatus!(job)).toMatchObject({ state: "stopped" });
    await client.ciTeardown!(job);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual([
      "/v1/instances/i-run",
      "/v1/instances/i-gone",
      `/v2/projects/proj-1/job_runs/iwci-${key}`,
    ]);

    const listed = await client.ciListTagged!("infrawrench-ci", ["us-south"]);
    expect(listed.map((t) => [t.handle.id, t.live])).toEqual([
      ["i-run", true],
      [`iwci-${key}`, true],
    ]);
    expect(listed[0]!.tags).toEqual(tags);
    expect(listed[1]!.tags).toEqual(tags);
  });

  it("names the role a refused read needs", async () => {
    const { client } = makeClient((req) => {
      if (req.url.pathname === "/v1/instances")
        return { status: 403, body: { errors: [{ code: "forbidden", message: "" }] } };
      if (req.url.pathname === "/v2/projects")
        return { body: { projects: [{ id: "proj-1", name: "infrawrench-ci" }] } };
      if (req.url.pathname === "/v2/projects/proj-1/job_runs")
        return { status: 403, body: { errors: [{ code: "forbidden", message: "" }] } };
      return undefined;
    });
    const vm = await client.ciPreflight!("vm");
    expect(vm.missing.map((m) => m.permission)).toEqual([
      "Editor (platform role) on VPC Infrastructure Services",
    ]);
    const container = await client.ciPreflight!("container");
    expect(container.missing.map((m) => m.permission)).toEqual([
      "Writer (service role) on Code Engine",
    ]);
    expect((await client.ciPreflight!("container", "eu-fr2")).problems[0]).toContain("not offered");
  });
});

describe("IBM Cloud CI helpers", () => {
  it("sizes job runs from Code Engine's combinations", () => {
    expect(ceResources("0.5vcpu-1gb")).toEqual({ cpu: "0.5", memory: "1G" });
    expect(ceResources("0.125vcpu-0.25gb")).toEqual({ cpu: "0.125", memory: "250M" });
    expect(() => ceResources("8vcpu-8gb")).toThrow();
    expect(
      jobRunBody({ ...spec, kind: "container", maxSeconds: 10 }).scale_max_execution_time,
    ).toBe(60);
  });
});
