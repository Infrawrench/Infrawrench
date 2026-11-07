import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { NomadApiError, normaliseAddress } from "../api.js";
import { durationNs, NomadClient, parseItems, parsePolicyList } from "../client.js";
import { nomadTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown, creds: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return {
    c: hostClient(
      new NomadClient(
        { address: "nomad.example.com:4646/ui/", token: "tok", region: "eu", ...creds },
        { http } as never,
      ),
    ),
    calls,
  };
}

describe("helpers", () => {
  it("normalises the address", () => {
    expect(normaliseAddress("nomad.example.com:4646/ui/jobs")).toBe(
      "https://nomad.example.com:4646",
    );
    expect(normaliseAddress("localhost:4646")).toBe("http://localhost:4646");
  });

  it("parses variable items typed by a person", () => {
    expect(parseItems('{"a": 1, "b": "x"}')).toEqual({ a: "1", b: "x" });
    expect(parseItems('USER=app\nPASS="x=y"\n# comment')).toEqual({ USER: "app", PASS: "x=y" });
  });

  it("reads drain deadlines and policy lists", () => {
    expect(durationNs("1h")).toBe(3_600_000_000_000);
    expect(() => durationNs("soon")).toThrow(NomadApiError);
    expect(parsePolicyList('["a","b"]')).toEqual(["a", "b"]);
    expect(parsePolicyList("a, b")).toEqual(["a", "b"]);
  });
});

describe("requests", () => {
  it("sends the token and region and lists jobs in every namespace", async () => {
    const { c, calls } = client(() => [
      {
        ID: "web",
        Name: "web",
        Namespace: "prod",
        Type: "service",
        Status: "running",
        JobSummary: { Summary: { g: { Running: 2, Failed: 1 } } },
      },
    ]);
    const jobs = await c.listResources("nomad-job", ACCOUNT);
    expect(calls[0]!.url.toString()).toBe(
      "https://nomad.example.com:4646/v1/jobs?region=eu&namespace=*",
    );
    expect(calls[0]!.headers["X-Nomad-Token"]).toBe("tok");
    expect(jobs[0]!.id).toBe("acct:nomad-job:prod/web");
    expect(jobs[0]!.fields).toMatchObject({ running: 2, failed: 1 });
  });

  it("parses HCL on the server, then registers it with its source", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v1/jobs/parse")
        return { ID: "example", Namespace: "default", TaskGroups: [] };
      if (call.url.pathname === "/v1/jobs") return { EvalID: "e" };
      return { ID: "example", Namespace: "team", Type: "service" };
    });
    await c.createResource("nomad-job", ACCOUNT, {
      namespace: "team",
      jobspec: 'job "example" {}',
    });
    expect(calls[0]!.body).toEqual({ JobHCL: 'job "example" {}', Canonicalize: true });
    expect(calls[1]!.url.searchParams.get("namespace")).toBe("team");
    expect(calls[1]!.body).toMatchObject({
      Job: { ID: "example", Namespace: "team" },
      Submission: { Source: 'job "example" {}', Format: "hcl2" },
    });
  });

  it("scales a task group", async () => {
    const { c, calls } = client(() => ({}));
    await c.executeNoSqlCommand("nomad-job", "acct:nomad-job:prod/web", ACCOUNT, "scale", [
      JSON.stringify({ group: "g", count: "3" }),
    ]);
    expect(calls[0]!.url.pathname).toBe("/v1/job/web/scale");
    expect(calls[0]!.body).toEqual({
      Count: 3,
      Target: { Group: "g" },
      Message: "Scaled from Infrawrench",
    });
  });

  it("tails task logs as plain text", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname.startsWith("/v1/client/fs/logs")
        ? { text: "a\nb\nc\n" }
        : { ID: "a1", TaskStates: { web: { State: "running" } } },
    );
    const res = await c.getLogs("nomad-allocation", "acct:nomad-allocation:a1", ACCOUNT, {
      tailLines: 2,
      container: "web (stderr)",
    });
    expect(res.containers).toEqual(["web (stdout)", "web (stderr)"]);
    const q = calls[1]!.url.searchParams;
    expect([q.get("task"), q.get("type"), q.get("origin"), q.get("plain")]).toEqual([
      "web",
      "stderr",
      "end",
      "true",
    ]);
    expect(res.text).toBe("b\nc\n");
  });

  it("writes variables with check-and-set from the manifest editor", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET" ? { Path: "app", Namespace: "prod", ModifyIndex: 42, Items: {} } : {},
    );
    await c.applyManifest("acct:nomad-variable:prod/app", ACCOUNT, '{"K": "v"}');
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.url.searchParams.get("cas")).toBe("42");
    expect(put.body).toEqual({ Namespace: "prod", Path: "app", Items: { K: "v" } });
  });

  it("treats disabled ACLs as an empty list and maps errors to a status", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/v1/acl/tokens"
        ? { status: 400, text: "ACL support disabled" }
        : { status: 403, text: "Permission denied" },
    );
    expect(await c.listResources("nomad-acl-token", ACCOUNT)).toEqual([]);
    const err = await c.listResources("nomad-node", ACCOUNT).catch((e: unknown) => e);
    expect((err as NomadApiError).status).toBe(403);
  });

  it("refuses to delete built-in node pools", async () => {
    const { c } = client(() => ({}));
    await expect(
      c.deleteResource("nomad-node-pool", "acct:nomad-node-pool:default"),
    ).rejects.toThrow(/built in/);
  });
});

describe("terraform", () => {
  it("imports jobs as id@namespace and reads the spec from a file", () => {
    const out = nomadTerraformExport.mapResource({
      id: "acct:nomad-job:prod/web",
      pluginId: "nomad",
      resourceTypeId: "nomad-job",
      accountId: ACCOUNT,
      displayName: "web",
      fields: { id: "web", namespace: "prod" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.importId).toBe("web@prod");
    expect(out?.resource.attributes["jobspec"]).toEqual({
      kind: "ref",
      expr: 'file("${path.module}/jobs/web.nomad.hcl")',
    });
  });
});

describe("a job read in full", () => {
  const route = (job: Record<string, unknown>) => (call: Call) =>
    call.url.pathname.endsWith("/summary") ? {} : { ID: "web", Namespace: "prod", ...job };

  it("says a periodic job is periodic, from its schedule object", async () => {
    const { c } = client(route({ Periodic: { Enabled: true, Spec: "* * * * *" } }));
    const job = await c.getResource("nomad-job", "acct:nomad-job:prod/web", ACCOUNT);
    expect(job.fields["periodic"]).toBe(true);
    expect(job.fields["parameterized"]).toBe(false);
  });

  it("says a parameterized job is parameterized, from its config object", async () => {
    const { c } = client(route({ ParameterizedJob: { Payload: "required" }, Periodic: null }));
    const job = await c.getResource("nomad-job", "acct:nomad-job:prod/web", ACCOUNT);
    expect(job.fields["parameterized"]).toBe(true);
    expect(job.fields["periodic"]).toBe(false);
  });

  it("says an ordinary job is neither, not nothing", async () => {
    const { c } = client(route({ Periodic: null, ParameterizedJob: null }));
    const job = await c.getResource("nomad-job", "acct:nomad-job:prod/web", ACCOUNT);
    expect(job.fields).toMatchObject({ periodic: false, parameterized: false });
  });

  it("does not offer Dispatch on a job already dispatched", async () => {
    const { c } = client(route({ ParameterizedJob: { Payload: "optional" }, Dispatched: true }));
    const job = await c.getResource("nomad-job", "acct:nomad-job:prod/web", ACCOUNT);
    expect(job.fields["parameterized"]).toBe(false);
  });
});

describe("a node read in full", () => {
  const full = {
    ID: "n1",
    Name: "client-1",
    HTTPAddr: "10.0.0.5:4646",
    Attributes: { "nomad.version": "1.9.3" },
  };
  const route = (node: Record<string, unknown>) => (call: Call) =>
    call.url.pathname.endsWith("/allocations") ? [] : node;

  it("has the address and version a list row has", async () => {
    const { c } = client(route(full));
    const node = await c.getResource("nomad-node", "acct:nomad-node:n1", ACCOUNT);
    expect(node.fields).toMatchObject({ address: "10.0.0.5", version: "1.9.3" });
    expect(node.resolvedOutputs["address"]).toBe("10.0.0.5");
  });

  it("resolves the address output", async () => {
    const { c } = client(route(full));
    expect(await c.resolveOutput("nomad-node", "acct:nomad-node:n1", "address", ACCOUNT)).toBe(
      "10.0.0.5",
    );
  });

  it("takes an IPv6 address out of its brackets", async () => {
    const { c } = client(route({ ...full, HTTPAddr: "[fd00::5]:4646" }));
    const node = await c.getResource("nomad-node", "acct:nomad-node:n1", ACCOUNT);
    expect(node.fields["address"]).toBe("fd00::5");
  });

  it("leaves a listed node's address and version as they came", async () => {
    const { c } = client(() => [{ ID: "n1", Address: "10.0.0.9", Version: "1.8.0" }]);
    const [node] = await c.listResources("nomad-node", ACCOUNT);
    expect(node!.fields).toMatchObject({ address: "10.0.0.9", version: "1.8.0" });
    expect(node!.resolvedOutputs["address"]).toBe("10.0.0.9");
  });
});

describe("the version of a listed job", () => {
  const row = (ID: string, Namespace = "prod") => ({ ID, Name: ID, Namespace, Type: "service" });

  it("comes from the statuses route, in one request, with child jobs and version 0", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === "/v1/jobs/statuses"
        ? [
            { ID: "web", Namespace: "prod", Version: 7 },
            { ID: "web", Namespace: "dev", Version: 0 },
          ]
        : [row("web"), row("web", "dev"), row("new")],
    );
    const jobs = await c.listResources("nomad-job", ACCOUNT);
    expect(jobs.map((j) => j.fields["version"])).toEqual([7, 0, undefined]);
    const statuses = calls.filter((x) => x.url.pathname === "/v1/jobs/statuses");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.url.searchParams.get("namespace")).toBe("*");
    expect(statuses[0]!.url.searchParams.get("include_children")).toBe("true");
  });

  it.each([
    ["an agent older than the route", { status: 404, text: "Not Found" }],
    ["a token that may not read it", { status: 403, text: "Permission denied" }],
    ["an answer that is not a list", { nope: true }],
  ])("leaves it blank and keeps the jobs on %s", async (_name, statuses) => {
    const { c } = client((call) =>
      call.url.pathname === "/v1/jobs/statuses" ? statuses : [row("web")],
    );
    const jobs = await c.listResources("nomad-job", ACCOUNT);
    expect(jobs.map((j) => j.fields["id"])).toEqual(["web"]);
    expect(jobs[0]!.fields["version"]).toBeUndefined();
  });

  it("is filled in when the detail view reads the job", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/versions")
        ? { Versions: [{ Version: 3 }, { Version: 2 }] }
        : { ID: "web", Namespace: "prod", Version: 3, TaskGroups: [] },
    );
    const before = {
      id: "acct:nomad-job:prod/web",
      pluginId: "nomad",
      resourceTypeId: "nomad-job",
      accountId: ACCOUNT,
      displayName: "web",
      fields: { id: "web", status: "running" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "prod/web",
      createdAt: "",
      updatedAt: "",
    };
    const after = await c.enrichDetail!(before);
    expect(after.fields).toEqual({ id: "web", status: "running", version: 3 });
  });
});
