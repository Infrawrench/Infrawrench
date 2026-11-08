import { describe, expect, it } from "vitest";
import { handle, tick, type Deps } from "../app";
import { Pool } from "../pool";
import { MemoryStore } from "../store";
import { MemoryValues, open, secretsKey } from "../values";

/** A fixed test key; 32 bytes of 7, not a real secret. */
const TEST_SECRETS_KEY = btoa(String.fromCharCode(...new Array<number>(32).fill(7)));

const PROXY_KEY = "proxy-test-key-not-a-real-secret";
const RUNNER_KEY = "runner-test-key-not-a-real-secret";

/** A runner as the proxy sees it: just enough of `iwci serve`. */
class FakeRunner {
  slotsFree: number;
  runs: Array<{ id: string; body: Record<string, unknown> }> = [];
  schedules: unknown = {
    owner: "github.com-acme",
    "repo-id": "web",
    branch: "main",
    commit: "c0ffee",
    pipelines: [
      {
        file: ".infrawrench/ci/nightly.yml",
        name: "Nightly",
        cron: ["0 3 * * *"],
        text: "name: Nightly",
      },
    ],
    problems: [],
  };
  down = false;

  constructor(
    readonly url: string,
    readonly slotsTotal: number,
    free: number,
  ) {
    this.slotsFree = free;
  }

  async handle(path: string, init: RequestInit): Promise<Response> {
    if (this.down) throw new Error("connection refused");
    const auth = new Headers(init.headers).get("Authorization");
    if (auth !== `Bearer ${RUNNER_KEY}`) return new Response("{}", { status: 401 });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/v1/capacity") {
      return json(200, {
        slots_total: this.slotsTotal,
        slots_free: this.slotsFree,
        runs_active: this.runs.length,
      });
    }
    if (path.startsWith("/v1/runs") && init.method === "POST") {
      if (this.slotsFree === 0) return json(429, { error: "full" });
      const id = (this.runs.length + 1).toString(16).padStart(32, "0");
      this.runs.push({ id, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      this.slotsFree--;
      return json(202, { id, state: "running", url: `/v1/runs/${id}` });
    }
    const logs = /^\/v1\/runs\/([0-9a-f]{32})\/logs$/.exec(path);
    if (logs) {
      return new Response("event: run-finished\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    const status = /^\/v1\/runs\/([0-9a-f]{32})$/.exec(path);
    if (status) return json(200, { id: status[1], state: "finished", runner: this.url });
    if (path === "/v1/schedules/read") return json(200, this.schedules);
    if (path.startsWith("/v1/usage/")) return json(200, { runner: this.url });
    return json(404, { error: "no route" });
  }
}

async function setup(runners: FakeRunner[], now = 1_800_000_000, withKey = true) {
  const byUrl = new Map(runners.map((r) => [r.url, r]));
  const fetchFn = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const runner = byUrl.get(url.origin);
    if (!runner) throw new Error("no such host");
    return runner.handle(url.pathname + url.search, init);
  };
  const store = new MemoryStore();
  const clock = { now };
  const values = new MemoryValues();
  const deps: Deps = {
    pool: Pool.fromList(runners.map((r) => r.url).join(","), RUNNER_KEY, fetchFn),
    store,
    values,
    secretsKey: withKey ? await secretsKey(TEST_SECRETS_KEY) : null,
    proxyKey: PROXY_KEY,
    now: () => clock.now,
  };
  const call = (method: string, path: string, body?: unknown, key = PROXY_KEY) =>
    handle(
      new Request(`https://proxy.example${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      deps,
    );
  return { deps, store, values, call, clock };
}

describe("proxy", () => {
  it("needs the proxy key everywhere but /healthz", async () => {
    const { call } = await setup([new FakeRunner("http://a.test", 4, 4)]);
    expect((await call("GET", "/healthz", undefined, "")).status).toBe(200);
    expect((await call("GET", "/v1/capacity", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/v1/capacity", undefined, RUNNER_KEY)).status).toBe(401);
    expect((await call("GET", "/v1/capacity")).status).toBe(200);
  });

  it("places runs on the runner with the most free slots and routes back by id", async () => {
    const a = new FakeRunner("http://a.test", 8, 1);
    const b = new FakeRunner("http://b.test", 8, 5);
    const { call } = await setup([a, b]);
    const res = await call("POST", "/v1/runs", {
      repo: "https://github.com/acme/web",
      branch: "main",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; url: string };
    expect(b.runs.length).toBe(1);
    expect(body.id).toMatch(/^1\.[0-9a-f]{32}$/);
    expect(body.url).toBe(`/v1/runs/${body.id}`);
    const status = (await (await call("GET", `/v1/runs/${body.id}`)).json()) as {
      runner: string;
      id: string;
    };
    expect(status.runner).toBe("http://b.test");
    expect(status.id).toBe(body.id);
    const logs = await call("GET", `/v1/runs/${body.id}/logs`);
    expect(logs.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await logs.text()).toContain("run-finished");
    expect((await call("GET", "/v1/runs/9.00000000000000000000000000000001")).status).toBe(404);
  });

  it("passes over full and down runners, and says 429 only when all are", async () => {
    const a = new FakeRunner("http://a.test", 2, 0);
    const b = new FakeRunner("http://b.test", 2, 1);
    const c = new FakeRunner("http://c.test", 2, 2);
    c.down = true;
    const { call } = await setup([a, b, c]);
    expect((await call("POST", "/v1/runs", { repo: "r", branch: "main" })).status).toBe(202);
    expect(b.runs.length).toBe(1);
    const res = await call("POST", "/v1/runs", { repo: "r", branch: "main" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
    const cap = (await (await call("GET", "/v1/capacity")).json()) as {
      slots_total: number;
      runners: Array<{ up: boolean }>;
    };
    expect(cap.slots_total).toBe(4);
    expect(cap.runners.map((r) => r.up)).toEqual([true, true, false]);
  });

  it("forwards storage and usage to a runner that answers", async () => {
    const a = new FakeRunner("http://a.test", 2, 2);
    a.down = true;
    const b = new FakeRunner("http://b.test", 2, 2);
    const { call } = await setup([a, b]);
    const usage = (await (await call("GET", "/v1/usage/github.com-acme?month=2026-11")).json()) as {
      runner: string;
    };
    expect(usage.runner).toBe("http://b.test");
  });

  it("registers schedules without tokens and fires each due pipeline once", async () => {
    const runner = new FakeRunner("http://a.test", 4, 4);
    const { call, deps, store, clock } = await setup([runner]);
    expect(
      (await call("PUT", "/v1/schedules", { repo: "https://github.com/acme/web", token: "x" }))
        .status,
    ).toBe(400);
    const reg = await call("PUT", "/v1/schedules", {
      repo: "https://github.com/acme/web",
      "storage-quota": 1024,
    });
    expect(reg.status).toBe(201);
    const listed = (await (await call("GET", "/v1/schedules/github.com-acme")).json()) as {
      schedules: Array<{ pipelines: Array<{ cron: string[]; text?: string }> }>;
    };
    expect(listed.schedules[0]?.pipelines[0]?.cron).toEqual(["0 3 * * *"]);
    expect(listed.schedules[0]?.pipelines[0]?.text).toBeUndefined();

    // 03:00 UTC on some day: due. Twice for the same minute fires once.
    const three = Date.UTC(2026, 10, 9, 3, 0) / 1000;
    expect((await tick(deps, three)).started).toEqual([
      "github.com-acme/web/.infrawrench/ci/nightly.yml",
    ]);
    expect((await tick(deps, three + 20)).started).toEqual([]);
    expect(runner.runs.length).toBe(1);
    expect(runner.runs[0]?.body).toMatchObject({
      event: "schedule",
      branch: "main",
      pipeline: "name: Nightly",
      "storage-quota": 1024,
    });
    // Not due a minute later.
    expect((await tick(deps, three + 60)).started).toEqual([]);

    // Full: skipped and recorded, not queued.
    runner.slotsFree = 0;
    const next = Date.UTC(2026, 10, 10, 3, 0) / 1000;
    expect((await tick(deps, next)).skipped).toHaveLength(1);
    expect([...store.fires.values()].some((f) => f.outcome === "no-capacity")).toBe(true);

    // A refresh that fails keeps the pipelines it had.
    clock.now += 3600;
    runner.down = true;
    const refreshed = await tick(deps, Date.UTC(2026, 10, 11, 4, 0) / 1000);
    expect(refreshed.refreshed).toBe(1);
    const row = (await store.all())[0];
    expect(row?.pipelines).toHaveLength(1);
    expect(row?.error).toBeTruthy();

    expect((await call("DELETE", "/v1/schedules/github.com-acme/web")).status).toBe(200);
    expect((await store.all()).length).toBe(0);
  });
});

describe("secrets and variables", () => {
  const repo = "https://github.com/acme/web";

  it("seals secrets, never lists their values, and scopes by org and repo", async () => {
    const { call, values, deps } = await setup([new FakeRunner("http://a.test", 4, 4)]);
    expect(
      (await call("PUT", "/v1/orgs/github.com-acme/secrets/NPM_TOKEN", { value: "org-token" }))
        .status,
    ).toBe(200);
    expect(
      (
        await call("PUT", "/v1/orgs/github.com-acme/repos/web/secrets/NPM_TOKEN", {
          value: "repo-token",
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("PUT", "/v1/orgs/github.com-acme/vars/REGION", { value: "eu" })).status,
    ).toBe(200);
    // Stored sealed, bound to its scope: the org's row will not open as the repo's.
    const row = (await values.list("secret", "github.com-acme", ""))[0];
    expect(row?.value.startsWith("v1.")).toBe(true);
    expect(row?.value).not.toContain("org-token");
    const key = deps.secretsKey;
    if (key === null) throw new Error("no key");
    expect(await open(key, "github.com-acme", "", "NPM_TOKEN", row?.value ?? "")).toBe("org-token");
    expect(await open(key, "github.com-acme", "web", "NPM_TOKEN", row?.value ?? "")).toBeNull();
    // Listing names, not values; variables do show values.
    const listed = await (await call("GET", "/v1/orgs/github.com-acme/secrets")).text();
    expect(listed).toContain("NPM_TOKEN");
    expect(listed).not.toContain("org-token");
    const vars = (await (await call("GET", "/v1/orgs/github.com-acme/vars")).json()) as {
      vars: Array<{ value: string }>;
    };
    expect(vars.vars[0]?.value).toBe("eu");
    // Bad names and bad bodies.
    expect((await call("PUT", "/v1/orgs/github.com-acme/secrets/9X", { value: "v" })).status).toBe(
      400,
    );
    expect((await call("PUT", "/v1/orgs/github.com-acme/secrets/X", { v: "v" })).status).toBe(400);
    expect((await call("PUT", "/v1/orgs/a..b/secrets/X", { value: "v" })).status).toBe(400);
    expect(
      (await call("DELETE", "/v1/orgs/github.com-acme/repos/web/secrets/NPM_TOKEN")).status,
    ).toBe(200);
    expect(
      (await call("DELETE", "/v1/orgs/github.com-acme/repos/web/secrets/NPM_TOKEN")).status,
    ).toBe(404);
  });

  it("refuses to store secrets without SECRETS_KEY", async () => {
    const { call } = await setup([new FakeRunner("http://a.test", 4, 4)], 1_800_000_000, false);
    expect((await call("PUT", "/v1/orgs/o/secrets/X", { value: "v" })).status).toBe(503);
    expect((await call("PUT", "/v1/orgs/o/vars/X", { value: "v" })).status).toBe(200);
  });

  it("hands runs the repo's values over the org's, and keeps secrets from untrusted pull requests", async () => {
    const runner = new FakeRunner("http://a.test", 8, 8);
    const { call } = await setup([runner]);
    await call("PUT", "/v1/orgs/github.com-acme/secrets/TOKEN", { value: "org" });
    await call("PUT", "/v1/orgs/github.com-acme/repos/web/secrets/TOKEN", { value: "repo" });
    await call("PUT", "/v1/orgs/github.com-acme/secrets/ONLY_ORG", { value: "o" });
    await call("PUT", "/v1/orgs/github.com-acme/vars/REGION", { value: "eu" });

    expect((await call("POST", "/v1/runs", { repo, branch: "main" })).status).toBe(202);
    expect(runner.runs[0]?.body).toMatchObject({
      secrets: { TOKEN: "repo", ONLY_ORG: "o" },
      vars: { REGION: "eu" },
    });

    await call("POST", "/v1/runs", { repo, branch: "fix", event: "pull-request" });
    expect(runner.runs[1]?.body.secrets).toBeUndefined();
    expect(runner.runs[1]?.body.vars).toEqual({ REGION: "eu" });

    await call("POST", "/v1/runs", {
      repo,
      branch: "fix",
      event: "pull-request",
      trusted: true,
      vars: { REGION: "us" },
    });
    expect(runner.runs[2]?.body).toMatchObject({
      secrets: { TOKEN: "repo" },
      vars: { REGION: "us" },
    });
    expect("trusted" in (runner.runs[2]?.body ?? {})).toBe(false);
  });

  it("gives scheduled runs their secrets", async () => {
    const runner = new FakeRunner("http://a.test", 4, 4);
    const { call, deps } = await setup([runner]);
    runner.schedules = {
      owner: "github.com-acme",
      "repo-id": "web",
      branch: "main",
      commit: "c0ffee",
      pipelines: [{ file: "n.yml", name: "N", cron: ["* * * * *"], text: "name: N" }],
      problems: [],
    };
    await call("PUT", "/v1/schedules", { repo });
    await call("PUT", "/v1/orgs/github.com-acme/secrets/TOKEN", { value: "nightly" });
    await tick(deps, Date.UTC(2026, 10, 9, 3, 0) / 1000);
    expect(runner.runs[0]?.body).toMatchObject({
      event: "schedule",
      secrets: { TOKEN: "nightly" },
    });
  });
});
