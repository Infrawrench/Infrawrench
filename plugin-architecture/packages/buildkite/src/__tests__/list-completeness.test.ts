import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bkPaged } from "../api.js";
import { BuildkiteClient } from "../client.js";
import { plugin } from "../plugin.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";
const ORG = "/v2/organizations/acme";
const SUITES = "/v2/analytics/organizations/acme/suites";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
const TRUNCATED = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";
const FOREIGN = "Refusing to send the account's credentials there";

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  const c = hostClient(
    new BuildkiteClient({ apiToken: "bkua_test", organization: "acme" }, { http }),
  );
  c.setSleep(async () => {});
  return { c, calls };
}

/** Pretends to be a host that tracks unread rows, as the server's sync does. */
function trackUnread() {
  const parts: Array<{ parentResourceIds?: readonly string[]; idPrefixes?: readonly string[] }> =
    [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: (typeof parts)[number]) => void parts.push(part));
  return parts;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  vi.restoreAllMocks();
});

/** A page of one row which always says there is another. */
function endless(call: Call, id = "x") {
  const page = Number(call.url.searchParams.get("page") ?? 1);
  const next = new URL(call.url);
  next.searchParams.set("page", String(page + 1));
  return {
    body: [{ id: `${id}${page}`, slug: `${id}${page}`, name: id }],
    headers: { Link: `<${next.href}>; rel="next"` },
  };
}

/** `count` pages then the end. */
function pages(call: Call, count: number) {
  const page = Number(call.url.searchParams.get("page") ?? 1);
  if (page >= count) return [{ id: `p${page}`, slug: `p${page}`, name: "p" }];
  return endless(call, "p");
}

describe("lists that reach a sync", () => {
  it.each([
    ["pipeline", `${ORG}/pipelines`],
    ["cluster", `${ORG}/clusters`],
    ["agent", `${ORG}/agents`],
    ["test-suite", SUITES],
  ])("%s refuses to return part of a list at the cap", async (type, path) => {
    const { c, calls } = client((call) => (call.url.pathname === path ? endless(call) : []));
    await expect(c.listResources(type, ACC)).rejects.toThrow(TRUNCATED);
    expect(calls.filter((x) => x.url.pathname === path)).toHaveLength(100);
  });

  it("reads a list past the old 20 page stop to its end", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === `${ORG}/agents` ? pages(call, 90) : [],
    );
    expect(await c.listResources("agent", ACC)).toHaveLength(90);
    expect(calls).toHaveLength(90);
  });

  it("waits out the whole rate limit window while reading a list", async () => {
    const waits: number[] = [];
    let n = 0;
    const { http } = makeHttp(() =>
      n++ === 0 ? { status: 429, headers: { "RateLimit-User-Reset": "50" }, body: {} } : [],
    );
    await bkPaged({ token: "t", http, sleep: async (ms) => void waits.push(ms) }, `${ORG}/agents`);
    expect(waits).toEqual([50_000]);
  });

  it.each([
    ["a renamed key", { body: { agents: [] } }],
    ["an empty body", { status: 200 }],
    ["a body that is not JSON", { body: "<html>maintenance</html>" }],
  ])("reads %s as an unreadable page, on the first and a later page", async (_, reply) => {
    const first = client(() => reply);
    await expect(first.c.listResources("agent", ACC)).rejects.toThrow(NOT_A_LIST);

    const later = client((call) =>
      call.url.searchParams.get("page") === "2" ? reply : endless(call),
    );
    await expect(later.c.listResources("agent", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a next link to another host and sends it nothing", async () => {
    const { c, calls } = client(() => ({
      body: [{ id: "a" }],
      headers: { Link: `<https://evil.example/v2/agents?page=2>; rel="next"` },
    }));
    await expect(c.listResources("agent", ACC)).rejects.toThrow(FOREIGN);
    expect(calls.map((x) => x.url.host)).toEqual(["api.buildkite.com"]);
  });

  it.each([
    ["pipeline's cluster names", "pipeline", `${ORG}/clusters`],
    ["cluster's agent counts", "cluster", `${ORG}/agents`],
    ["queue's agent counts", "queue", `${ORG}/agents`],
    ["organization's pipeline counts", "organization", `${ORG}/pipelines`],
    ["organization's agent counts", "organization", `${ORG}/agents`],
    ["organization's cluster counts", "organization", `${ORG}/clusters`],
  ])("a refused list reaches the caller through the %s", async (_, type, path) => {
    const { c } = client((call) => {
      if (call.url.pathname === path) return { body: { renamed: [] } };
      if (call.url.pathname === ORG) return { id: "o", slug: "acme", name: "Acme" };
      if (call.url.pathname.endsWith("/usage") || call.url.pathname.endsWith("/rate_limit"))
        return {};
      return [];
    });
    await expect(c.listResources(type, ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("a refused list reaches the caller through a cluster's queue count", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === `${ORG}/clusters`) return [{ id: "c1", name: "C" }];
      if (call.url.pathname === `${ORG}/clusters/c1/queues`) return { body: { renamed: [] } };
      return [];
    });
    await expect(c.listResources("cluster", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("a refused list reaches the caller through a suite's flaky count", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === SUITES) return [{ id: "s", slug: "rspec", name: "RSpec" }];
      return { body: { renamed: [] } };
    });
    await expect(c.listResources("test-suite", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("leaves a count off when only the decoration fails", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === `${ORG}/clusters`) return [{ id: "c1", name: "C" }];
      return { status: 500, body: { message: "boom" } };
    });
    const [cluster] = await c.listResources("cluster", ACC);
    expect(cluster!.externalId).toBe("c1");
    expect(cluster!.fields["queueCount"]).toBeUndefined();
  });
});

describe("flaky tests", () => {
  const suites = [
    { id: "1", slug: "a", name: "A" },
    { id: "2", slug: "b", name: "B" },
  ];
  const tests = [{ id: "t", name: "works" }];

  it.each([500, 429])(
    "a %i on one suite fails the type rather than dropping its tests",
    async (status) => {
      const { c } = client((call) => {
        if (call.url.pathname === SUITES) return suites;
        if (call.url.pathname === `${SUITES}/a/tests`) return { status, body: { message: "no" } };
        return tests;
      });
      await expect(c.listResources("test", ACC)).rejects.toThrow(`error ${status}`);
    },
  );

  it("reads past the old three page stop and throws at the cap", async () => {
    const { c } = client((call) => (call.url.pathname === SUITES ? [suites[0]] : pages(call, 4)));
    expect(await c.listResources("test", ACC)).toHaveLength(4);

    const long = client((call) => (call.url.pathname === SUITES ? [suites[0]] : endless(call)));
    await expect(long.c.listResources("test", ACC)).rejects.toThrow(TRUNCATED);
    expect(long.calls.filter((x) => x.url.pathname.endsWith("/tests"))).toHaveLength(100);
  });

  it("a suite gone since the listing has none", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === SUITES) return suites;
      if (call.url.pathname === `${SUITES}/a/tests`)
        return { status: 404, body: { message: "Not Found" } };
      return tests;
    });
    expect((await c.listResources("test", ACC)).map((t) => t.externalId)).toEqual(["b/t"]);
  });

  it("names a suite that refuses, so its stored tests stay", async () => {
    const parts = trackUnread();
    const { c } = client((call) => {
      if (call.url.pathname === SUITES) return suites;
      if (call.url.pathname === `${SUITES}/a/tests`)
        return { status: 403, body: { message: "no" } };
      return tests;
    });
    expect((await c.listResources("test", ACC)).map((t) => t.externalId)).toEqual(["b/t"]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACC}:test-suite:a`] }]);
  });

  it("shows a refusal of one suite where nothing keeps the rows", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === SUITES) return suites;
      if (call.url.pathname === `${SUITES}/a/tests`)
        return { status: 403, body: { message: "no" } };
      return tests;
    });
    await expect(c.listResources("test", ACC)).rejects.toThrow("error 403");
  });

  it("shows a refusal of every suite where nothing keeps the rows", async () => {
    const { c } = client((call) =>
      call.url.pathname === SUITES ? suites : { status: 403, body: { message: "no" } },
    );
    await expect(c.listResources("test", ACC)).rejects.toThrow("error 403");
  });
});

describe("a token refused", () => {
  it.each([
    "agent",
    "pipeline",
    "build",
    "job",
    "cluster",
    "queue",
    "schedule",
    "test-suite",
    "test",
  ])("keeps %s's rows with no error when the whole type is refused", async (type) => {
    const parts = trackUnread();
    const { c } = client(() => ({ status: 403, body: { message: "Forbidden" } }));
    expect(await c.listResources(type, ACC)).toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it("shows the refusal on a host that keeps no track", async () => {
    const { c } = client(() => ({ status: 403, body: { message: "Forbidden" } }));
    await expect(c.listResources("agent", ACC)).rejects.toThrow("error 403");
    await expect(c.listResources("test-suite", ACC)).rejects.toThrow("error 403");
  });

  it.each([401, 500])("a %i still fails the type", async (status) => {
    const parts = trackUnread();
    const { c } = client(() => ({ status, body: { message: "no" } }));
    await expect(c.listResources("agent", ACC)).rejects.toThrow(`error ${status}`);
    expect(parts).toEqual([]);
  });

  it("keeps templates on a 403, which is also how a plan without them may answer", async () => {
    const parts = trackUnread();
    const { c } = client(() => ({ status: 403, body: { message: "Forbidden" } }));
    expect(await c.listResources("pipeline-template", ACC)).toEqual([]);
    expect(parts).toEqual([{ idPrefixes: [""] }]);
  });

  it.each(["pipeline-template", "test-suite", "test"])(
    "%s does not read a lost organization as having none",
    async (type) => {
      const { c } = client(() => ({ status: 404, body: { message: "No organization found" } }));
      await expect(c.listResources(type, ACC)).rejects.toThrow("No organization found");
    },
  );

  it.each(["pipeline-template", "test-suite"])("%s reads a plain 404 as none", async (type) => {
    const { c } = client(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await c.listResources(type, ACC)).toEqual([]);
  });

  it("names a cluster that refuses", async () => {
    const parts = trackUnread();
    const { c } = client((call) => {
      if (call.url.pathname === `${ORG}/clusters`) {
        return [
          { id: "c1", name: "One" },
          { id: "c2", name: "Two" },
        ];
      }
      if (call.url.pathname === `${ORG}/clusters/c1/secrets`) return { status: 403, body: {} };
      if (call.url.pathname === `${ORG}/clusters/c2/secrets`) return [{ id: "s", key: "K" }];
      return [];
    });
    expect((await c.listResources("cluster-secret", ACC)).map((s) => s.externalId)).toEqual([
      "c2/s",
    ]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACC}:cluster:c1`] }]);
  });
});

describe("fan-out past the rate limit", () => {
  const pipelines = Array.from({ length: 45 }, (_, i) => ({
    id: `p${i}`,
    slug: `p${String(i).padStart(2, "0")}`,
    name: `P${i}`,
  }));

  function schedules() {
    return client((call) => {
      if (call.url.pathname === `${ORG}/pipelines`) return pipelines;
      return [];
    });
  }

  const scheduleCalls = (calls: Call[]) =>
    calls
      .filter((x) => x.url.pathname.endsWith("/schedules"))
      .map((x) => x.url.pathname.split("/")[5]);

  it("reads what fits and names the rest, so their schedules stay", async () => {
    const parts = trackUnread();
    const { c, calls } = schedules();
    await c.listResources("schedule", ACC);
    const read = scheduleCalls(calls);
    expect(read).toHaveLength(40);
    const named = parts.flatMap((p) => p.parentResourceIds ?? []);
    expect(named).toHaveLength(5);
    expect(new Set([...read.map((s) => `${ACC}:pipeline:${s}`), ...named]).size).toBe(45);
  });

  it("moves on with the clock so every pipeline is read in time", async () => {
    trackUnread();
    const seen = new Set<string | undefined>();
    for (let minute = 0; minute < 12; minute++) {
      vi.spyOn(Date, "now").mockReturnValue(minute * 5 * 60_000);
      const { c, calls } = schedules();
      await c.listResources("schedule", ACC);
      for (const slug of scheduleCalls(calls)) seen.add(slug);
    }
    expect(seen.size).toBe(45);
  });

  it("reads every pipeline where the host keeps no track of the rest", async () => {
    const { c, calls } = schedules();
    await c.listResources("schedule", ACC);
    expect(scheduleCalls(calls)).toHaveLength(45);
  });

  it("reads everything with no report at or under the budget", async () => {
    const parts = trackUnread();
    const few = pipelines.slice(0, 40);
    const { c, calls } = client((call) => (call.url.pathname === `${ORG}/pipelines` ? few : []));
    await c.listResources("schedule", ACC);
    expect(scheduleCalls(calls)).toHaveLength(40);
    expect(parts).toEqual([]);
  });

  it("counts a suite's flaky tests only within the budget, the same ones each poll", async () => {
    const suites = pipelines.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
    const { c, calls } = client((call) => (call.url.pathname === SUITES ? suites : []));
    const rows = await c.listResources("test-suite", ACC);
    expect(rows).toHaveLength(45);
    expect(calls.filter((x) => x.url.pathname.endsWith("/tests"))).toHaveLength(40);
    expect(rows[0]!.fields["flakyTests"]).toBe(0);
    expect(rows[44]!.fields["flakyTests"]).toBeUndefined();
  });

  it("names tests' suites past the budget too", async () => {
    const parts = trackUnread();
    const suites = pipelines.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
    const { c, calls } = client((call) => (call.url.pathname === SUITES ? suites : []));
    await c.listResources("test", ACC);
    expect(calls.filter((x) => x.url.pathname.endsWith("/tests"))).toHaveLength(40);
    expect(parts.flatMap((p) => p.parentResourceIds ?? [])).toHaveLength(5);
  });
});

describe("a single resource's page", () => {
  it("loses only the counts when a list cannot be trusted", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === ORG) return { id: "o", slug: "acme", name: "Acme" };
      if (call.url.pathname.endsWith("/usage") || call.url.pathname.endsWith("/rate_limit")) {
        return {};
      }
      return { body: { renamed: [] } };
    });
    const org = await c.getResource("organization", `${ACC}:organization:acme`, ACC);
    expect(org.fields["pipelineCount"]).toBeUndefined();
    expect(org.fields["agentCount"]).toBeUndefined();
  });
});

describe("bounded reads", () => {
  it("builds are a window of the newest: one page, whatever follows it", async () => {
    const { c, calls } = client((call) => endless(call, "b"));
    const rows = await c.listResources("build", ACC);
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("50");
  });

  it.each([
    ["build", { status: 200 }],
    ["job", { status: 200 }],
    ["build", { body: { renamed: [] } }],
  ])("%s does not read an unreadable page as no builds", async (type, reply) => {
    const { c } = client(() => reply);
    await expect(c.listResources(type, ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("charts what it read at the cap", async () => {
    const { c, calls } = client((call) => endless(call, "b"));
    await expect(
      c.fetchMetricSeries("organization", `${ACC}:organization:acme`, ACC),
    ).resolves.toEqual(expect.any(Array));
    expect(calls).toHaveLength(5);
  });

  it("a build's page shows its first artifacts", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname.endsWith("/artifacts")) return endless(call, "a");
      if (call.url.pathname.endsWith("/annotations")) return [];
      return { id: "b", number: 1, state: "passed" };
    });
    const build = await c.getResource("build", `${ACC}:build:web/1`, ACC);
    expect(calls.filter((x) => x.url.pathname.endsWith("/artifacts"))).toHaveLength(2);
    expect(
      JSON.parse(Object.values(build.resolvedOutputs).find((v) => v.includes("a2")) ?? "[]"),
    ).toHaveLength(2);
  });

  it("a create form offers what it read at the cap, rather than nothing", async () => {
    const { c, calls } = client((call) => endless(call, "p"));
    const form = await c.getCreateConfig("schedule");
    const field = form.fields.find((f) => f.key === "pipeline");
    expect(field?.options).toHaveLength(20);
    expect(calls).toHaveLength(20);
  });

  it("the organization picker offers what it read at the cap", async () => {
    const { http, calls } = makeHttp((call) => endless(call, "o"));
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "organization",
      { apiToken: "t" },
      { http },
    );
    expect(options).toHaveLength(20);
    expect(calls).toHaveLength(20);
  });
});
