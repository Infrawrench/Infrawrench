import { describe, expect, it } from "vitest";
import { consoleUrl, normaliseApiUrl, puPaged, statusOf } from "../api.js";
import { PulumiCloudClient, decodePlaintext, tailLines, unwrapEscValue } from "../client.js";
import { updateSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { mapComponent } from "../status-feed.js";
import { fetchUsageCost, ratesFor } from "../usage.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";
const SECRET = {
  "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
  ciphertext: "Q0lQSEVS",
};

function client(
  route: (call: Call) => unknown,
  creds: Record<string, string> = {},
  secrets?: Map<string, string>,
) {
  const { http, calls } = makeHttp(route);
  const services = {
    http,
    ...(secrets
      ? {
          secrets: {
            getPlaintext: async (r: string, k: string) => secrets.get(`${r}|${k}`) ?? null,
            setPlaintext: async (r: string, k: string, v: string) =>
              void secrets.set(`${r}|${k}`, v),
          },
        }
      : {}),
  };
  return {
    c: new PulumiCloudClient(
      { accessToken: "pul-t", organization: "acme", ...creds },
      services as never,
    ),
    calls,
  };
}

describe("api", () => {
  it("sends `token` auth and the Pulumi media type, and follows continuation tokens", async () => {
    const { http, calls } = makeHttp((call) => {
      expect(call.headers["Authorization"]).toBe("token t");
      expect(call.headers["Accept"]).toBe("application/vnd.pulumi+8");
      return call.url.searchParams.get("continuationToken")
        ? { stacks: [{ stackName: "b" }] }
        : { stacks: [{ stackName: "a" }], continuationToken: "next" };
    });
    const out = await puPaged<{ stackName: string }>(
      { token: "t", apiUrl: "https://api.pulumi.com", http },
      "/api/user/stacks",
      "stacks",
    );
    expect(out.map((s) => s.stackName)).toEqual(["a", "b"]);
    expect(calls[1]!.url.searchParams.get("continuationToken")).toBe("next");
  });

  it("keeps the status on errors", async () => {
    const { http } = makeHttp(() => ({
      status: 404,
      body: { code: 404, message: "Not Found: stack" },
    }));
    const err = await puPaged(
      { token: "t", apiUrl: "https://api.pulumi.com", http },
      "/x",
      "y",
    ).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(404);
    expect(String((err as Error).message)).toContain("Not Found: stack");
  });

  it("normalises self-hosted URLs", () => {
    expect(normaliseApiUrl("")).toBe("https://api.pulumi.com");
    expect(normaliseApiUrl("api.pulumi.example.com/")).toBe("https://api.pulumi.example.com");
    expect(() => normaliseApiUrl("http://x.example.com")).toThrow(/https/);
    expect(consoleUrl("https://api.pulumi.com")).toBe("https://app.pulumi.com");
  });
});

describe("organization picker", () => {
  it("lists the user's organizations and the token's own", async () => {
    const { http } = makeHttp(() => ({
      organizations: [{ githubLogin: "zeta", name: "Zeta", role: "admin" }],
      tokenInfo: { organization: "acme", name: "ci", team: "" },
    }));
    const opts = await plugin.listCredentialOptions!("organization", { accessToken: "t" }, {
      http,
    } as never);
    expect(opts.map((o) => o.id)).toEqual(["acme", "zeta"]);
  });
});

describe("listing", () => {
  it("groups stacks into projects", async () => {
    const { c } = client(() => ({
      stacks: [
        {
          orgName: "acme",
          projectName: "net",
          stackName: "prod",
          resourceCount: 10,
          lastUpdate: 1_790_000_000,
        },
        { orgName: "acme", projectName: "net", stackName: "dev", resourceCount: 3 },
        { orgName: "acme", projectName: "app", stackName: "prod", resourceCount: 1 },
      ],
    }));
    const projects = await c.listResources("project", ACC);
    expect(
      projects.map((p) => [p.externalId, p.fields["stackCount"], p.fields["resourceCount"]]),
    ).toEqual([
      ["net", 2, 13],
      ["app", 1, 1],
    ]);
    const stacks = await c.listResources("stack", ACC);
    expect(stacks[0]).toMatchObject({
      externalId: "net/prod",
      parentResourceId: `${ACC}:project:net`,
    });
    expect(stacks[0]!.resolvedOutputs["url"]).toBe("https://app.pulumi.com/acme/net/prod");
  });

  it("lists outputs, hiding secret values", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/api/user/stacks"
        ? { stacks: [{ orgName: "acme", projectName: "net", stackName: "prod", resourceCount: 2 }] }
        : { outputs: { vpcId: "vpc-1", dbPassword: SECRET, subnets: ["a"] } },
    );
    const outs = await c.listResources("stack-output", ACC);
    const by = Object.fromEntries(outs.map((o) => [o.fields["name"], o]));
    expect(by["vpcId"]!.resolvedOutputs["value"]).toBe("vpc-1");
    expect(by["dbPassword"]!.fields["secret"]).toBe(true);
    expect(by["dbPassword"]!.resolvedOutputs["value"]).toBeUndefined();
    expect(by["subnets"]!.resolvedOutputs["value"]).toBe('["a"]');
  });

  it("lists nothing for admin-only lists the token cannot read", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "forbidden" } }));
    expect(await c.listResources("team", ACC)).toEqual([]);
  });
});

describe("outputs and ESC", () => {
  it("decrypts a service-encrypted secret output", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname.endsWith("/outputs"))
        return { outputs: { dbPassword: SECRET }, secretsProviders: { type: "service" } };
      expect(call.url.pathname).toBe("/api/stacks/acme/net/prod/decrypt");
      expect(call.body).toEqual({ ciphertext: "Q0lQSEVS" });
      return { plaintext: btoa('"hunter2"') };
    });
    expect(
      await c.resolveOutput(
        "stack-output",
        `${ACC}:stack-output:net/prod/dbPassword`,
        "value",
        ACC,
      ),
    ).toBe("hunter2");
    expect(calls).toHaveLength(2);
  });

  it("refuses secrets from other secrets providers", async () => {
    const { c } = client(() => ({ outputs: { k: SECRET }, secretsProviders: { type: "awskms" } }));
    await expect(
      c.resolveOutput("stack-output", `${ACC}:stack-output:net/prod/k`, "value", ACC),
    ).rejects.toThrow(/awskms/);
  });

  it("opens an environment and flattens its values", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.endsWith("/open")) return { id: "sess" };
      return {
        properties: {
          environmentVariables: {
            value: {
              AWS_REGION: { value: "eu-west-1", trace: {} },
              TOKEN: { value: "s3cret", secret: true },
            },
            trace: {},
          },
        },
      };
    });
    expect(
      await c.resolveOutput(
        "environment",
        `${ACC}:environment:default/aws`,
        "environmentVariables",
        ACC,
      ),
    ).toBe("AWS_REGION=eu-west-1\nTOKEN=s3cret");
  });

  it("unwraps nested ESC values and decodes plaintext", () => {
    expect(unwrapEscValue({ a: { value: [{ value: 1, trace: {} }], trace: {} } })).toEqual({
      a: [1],
    });
    expect(decodePlaintext(btoa('{"x":1}'))).toEqual({ x: 1 });
  });

  it("writes ESC definitions as YAML", async () => {
    const { c, calls } = client(() => ({}));
    await c.applyManifest(`${ACC}:environment:default/aws`, ACC, "values:\n  a: 1\n");
    expect(calls[0]).toMatchObject({ method: "PATCH" });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/x-yaml");
  });

  it("surfaces ESC diagnostics as an error", async () => {
    const { c } = client(() => ({
      diagnostics: [{ path: "values.a", summary: "unknown function" }],
    }));
    await expect(c.applyManifest(`${ACC}:environment:default/aws`, ACC, "x")).rejects.toThrow(
      /values.a: unknown function/,
    );
  });
});

describe("deployments", () => {
  it("starts a deployment with the stack's settings", async () => {
    const { c, calls } = client(() => ({ id: "dep-1", version: 7, consoleUrl: "" }));
    const r = await c.createResource(
      "deployment",
      ACC,
      { operation: "refresh" },
      `${ACC}:stack:net/prod`,
    );
    expect(calls[0]!.url.pathname).toBe("/api/stacks/acme/net/prod/deployments");
    expect(calls[0]!.body).toEqual({ operation: "refresh", inheritSettings: true });
    expect((r as { externalId: string }).externalId).toBe("net/prod/dep-1");
  });

  it("streams logs through continuation tokens and tails them", async () => {
    let n = 0;
    const { c } = client(() =>
      n++ === 0
        ? { lines: [{ header: "Get source" }, { line: "cloning" }], nextToken: "t1" }
        : { lines: [{ line: "\u001b[32mdone\u001b[0m" }], nextToken: "" },
    );
    const out = await c.getLogs("deployment", `${ACC}:deployment:net/prod/dep-1`, ACC, {
      tailLines: 2,
    });
    expect(out.text).toBe("cloning\ndone\n");
    expect(tailLines("a\nb\n", 5)).toBe("a\nb\n");
  });

  it("keeps a new organization token as a secret output", async () => {
    const secrets = new Map<string, string>();
    const { c, calls } = client(() => ({ id: "tok-1", tokenValue: "pul-secret" }), {}, secrets);
    const res = (await c.createResource("access-token", ACC, {
      name: "ci",
      admin: "false",
      expiresDays: "30",
    })) as {
      resource: { id: string };
    };
    expect((calls[0]!.body as { expires: number }).expires).toBeGreaterThan(Date.now() / 1000);
    expect(await c.resolveOutput("access-token", res.resource.id, "token", ACC)).toBe("pul-secret");
  });
});

describe("usage and cost", () => {
  it("prices daily usage at the plan's rates", async () => {
    const { http } = makeHttp((call) => {
      expect(call.url.searchParams.get("granularity")).toBe("daily");
      if (call.url.pathname.endsWith("/resources/summary")) {
        return {
          summary: [{ year: 2026, month: 10, day: 1, resourceHours: 2400, resources: 100 }],
        };
      }
      if (call.url.pathname.endsWith("/deployments/summary")) return { status: 204, body: "" };
      return { summary: [{ year: 2026, month: 10, day: 1, resourceHours: 240 }] };
    });
    const rows = await fetchUsageCost(
      { token: "t", apiUrl: "https://api.pulumi.com", http },
      "acme",
      ratesFor("pro", ""),
      {
        fromDate: "2026-09-30",
        toDate: "2026-10-01",
      },
    );
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: "IaC resources",
        currency: "USD",
        amount: 1.2,
        usageAmount: 2400,
        usageUnit: "resource-hours",
        tags: { plan: "pro" },
      },
      {
        date: "2026-10-01",
        service: "ESC secrets",
        currency: "USD",
        amount: 0.24,
        usageAmount: 240,
        usageUnit: "secret-hours",
        tags: { plan: "pro" },
      },
    ]);
  });

  it("applies rate overrides and rejects junk", () => {
    expect(ratesFor("enterprise", "resourceHour=0.0004").resourceHour).toBe(0.0004);
    expect(() => ratesFor("pro", "bogus=1")).toThrow(/unknown rate/);
  });

  it("folds update history into daily series", () => {
    const day = Date.UTC(2026, 9, 1) / 1000;
    const s = updateSeries(
      [
        {
          startTime: day + 10,
          endTime: day + 70,
          result: "succeeded",
          resourceChanges: { create: 2, update: 1 },
          version: 2,
          resourceCount: 12,
        },
        { startTime: day + 100, endTime: day + 130, result: "failed", version: 1 },
      ],
      day * 1000 - 1,
      day * 1000 + 86_400_000,
    );
    const by = Object.fromEntries(s.map((x) => [x.label, x.points[0]!.value]));
    expect(by).toMatchObject({
      Updates: 2,
      "Failed updates": 1,
      "Resources created": 2,
      Resources: 12,
    });
  });
});

describe("status feed", () => {
  it("maps components", () => {
    expect(mapComponent("API")).toMatchObject({ providerWide: true });
    expect(mapComponent("ESC")!.resourceTypes).toEqual(["environment"]);
    expect(mapComponent("GitHub")).toBeNull();
  });
});
