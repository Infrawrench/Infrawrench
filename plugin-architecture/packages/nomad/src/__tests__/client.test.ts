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
    c: new NomadClient(
      { address: "nomad.example.com:4646/ui/", token: "tok", region: "eu", ...creds },
      { http } as never,
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
