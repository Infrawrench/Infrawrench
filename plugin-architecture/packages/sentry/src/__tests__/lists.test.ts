import { showcaseFields } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentryClient } from "../client.js";
import { ProjectResourceType } from "../resource-types.js";
import type { Call } from "./helpers.js";
import { makeHttp, stats } from "./helpers.js";

const creds = { region: "us", authToken: "sntryi_TEST", organization: "acme" };
const ACCOUNT = "acct";
const REFUSED = "Refusing to send the account's credentials there";
const ORG = "/api/0/organizations/acme";

function client(route: (call: Call) => unknown, extra: Record<string, string> = {}) {
  const { http, calls } = makeHttp(route);
  return { c: hostClient(new SentryClient({ ...creds, ...extra }, { http } as never)), calls };
}

const nextLink = (url: string, results = true) => ({
  Link: `<${url}>; rel="next"; results="${results}"`,
});

/** A list that always says there is more, with one row on each page. */
function endless(call: Call) {
  const page = Number(call.url.searchParams.get("cursor") ?? 0);
  return {
    body: [{ id: String(page), slug: `row-${page}`, dateCreated: new Date().toISOString() }],
    headers: nextLink(`https://us.sentry.io${call.url.pathname}?cursor=${page + 1}`),
  };
}

describe("pages that are not lists", () => {
  it("keeps walking past an empty page while the link says there are results", async () => {
    const { c, calls } = client((call) => {
      const cursor = call.url.searchParams.get("cursor");
      return cursor
        ? {
            body: [{ id: "2", slug: "b" }],
            headers: nextLink(`https://us.sentry.io${ORG}/teams/`, false),
          }
        : { body: [], headers: nextLink(`https://us.sentry.io${ORG}/teams/?cursor=1`) };
    });
    await expect(c.listResources("team", ACCOUNT)).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe("next links", () => {
  it("refuses a link to another host, and nothing reaches it", async () => {
    const { c, calls } = client(() => ({
      body: [{ id: "1", slug: "a" }],
      headers: nextLink("https://evil.example/api/0/organizations/acme/teams/?cursor=1"),
    }));
    await expect(c.listResources("team", ACCOUNT)).rejects.toThrow(REFUSED);
    expect(calls.map((x) => x.url.host)).toEqual(["us.sentry.io"]);
  });

  it("refuses a look-alike host and plain http under sentry.io", async () => {
    for (const link of [
      "https://sentry.io.evil.example/api/0/x/",
      "https://evilsentry.io/api/0/x/",
      "http://sentry.io/api/0/x/",
    ]) {
      const { c, calls } = client(() => ({
        body: [{ id: "1", slug: "a" }],
        headers: nextLink(link),
      }));
      await expect(c.listResources("team", ACCOUNT)).rejects.toThrow(REFUSED);
      expect(calls).toHaveLength(1);
    }
  });

  it("follows Sentry's links from a regional host to sentry.io", async () => {
    const { c, calls } = client((call) =>
      call.url.host === "sentry.io"
        ? {
            body: [{ id: "2", slug: "b" }],
            headers: nextLink(`https://sentry.io${ORG}/teams/`, false),
          }
        : {
            body: [{ id: "1", slug: "a" }],
            headers: nextLink(`https://sentry.io${ORG}/teams/?cursor=1`),
          },
    );
    await expect(c.listResources("team", ACCOUNT)).resolves.toHaveLength(2);
    expect(calls.map((x) => x.url.host)).toEqual(["us.sentry.io", "sentry.io"]);
  });

  it("keeps a self-hosted token on the configured host whatever the link names", async () => {
    const extra = { region: "self-hosted", baseUrl: "https://sentry.internal.example/" };
    const { c, calls } = client((call) => {
      const cursor = call.url.searchParams.get("cursor");
      return cursor
        ? {
            body: [{ id: "2", slug: "b" }],
            headers: nextLink(`https://sentry.public.example${ORG}/teams/`, false),
          }
        : {
            body: [{ id: "1", slug: "a" }],
            // What `system.url-prefix` writes when it differs from the address connected to.
            headers: nextLink(`https://sentry.public.example${ORG}/teams/?cursor=a,b`),
          };
    }, extra);
    await expect(c.listResources("team", ACCOUNT)).resolves.toHaveLength(2);
    expect(calls.map((x) => x.url.host)).toEqual([
      "sentry.internal.example",
      "sentry.internal.example",
    ]);
    expect(calls[1]!.url.pathname).toBe(`${ORG}/teams/`);
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("a,b");
  });

  it("does not trust sentry.io from a self-hosted connection", async () => {
    const extra = { region: "self-hosted", baseUrl: "https://sentry.internal.example" };
    const { c, calls } = client(
      () => ({ body: [{ id: "1", slug: "a" }], headers: nextLink("https://sentry.io/elsewhere/") }),
      extra,
    );
    await expect(c.listResources("team", ACCOUNT)).rejects.toThrow(REFUSED);
    expect(calls).toHaveLength(1);
  });
});

describe("host HTTP", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes through the host's service, with no CA on the call and no fetch", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchStub);
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "[]" }));
    const c = hostClient(new SentryClient(creds, { http: { request } } as never));
    await c.listResources("team", ACCOUNT);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).not.toHaveProperty("0.caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("writes with a blank id", () => {
  it("refuses, and sends nothing", async () => {
    const { c, calls } = client(() => ({}));
    const blank = (type: string) => `${ACCOUNT}:${type}:`;
    await expect(c.deleteResource("project", blank("project"), ACCOUNT)).rejects.toThrow(/id/);
    await expect(c.deleteResource("team", blank("team"), ACCOUNT)).rejects.toThrow(/id/);
    await expect(c.invokeAction!("issue", blank("issue"), "resolve", ACCOUNT)).rejects.toThrow(
      /id/,
    );
    await expect(c.invokeAction!("alert", blank("alert"), "disable", ACCOUNT)).rejects.toThrow(
      /id/,
    );
    await expect(c.invokeAction!("monitor", blank("monitor"), "disable", ACCOUNT)).rejects.toThrow(
      /id/,
    );
    await expect(
      c.updateResource("project", blank("project"), ACCOUNT, { name: "x" }),
    ).rejects.toThrow(/id/);
    expect(calls).toHaveLength(0);
  });
});

describe("cron monitor max runtime", () => {
  const monitor = {
    id: "1",
    slug: "nightly",
    config: { schedule_type: "interval", schedule: [1, "day"] },
  };

  it("refuses more than the 10080 minutes Sentry allows", async () => {
    const { c, calls } = client(() => monitor);
    await expect(
      c.updateResource("cron-monitor", `${ACCOUNT}:cron-monitor:nightly`, ACCOUNT, {
        maxRuntime: "10081",
      }),
    ).rejects.toThrow(/between 1 and 10080 minutes/);
    expect(calls).toHaveLength(0);
  });

  it("sends 10080", async () => {
    const { c, calls } = client(() => monitor);
    await c.updateResource("cron-monitor", `${ACCOUNT}:cron-monitor:nightly`, ACCOUNT, {
      maxRuntime: "10080",
    });
    expect(calls.find((x) => x.method === "PUT")?.body).toMatchObject({
      config: { max_runtime: 10080 },
    });
  });
});

describe("listed projects", () => {
  it("shows on its tile only what the project list answers with", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/stats_v2/")
        ? stats("2026-10-03", 1, [{ by: { project: 11, outcome: "accepted" }, total: 900 }])
        : [
            {
              id: "11",
              slug: "web",
              name: "Web",
              platform: "javascript",
              teams: [{ slug: "front" }],
            },
          ],
    );
    const [p] = await c.listResources("project", ACCOUNT);
    const keys = showcaseFields(ProjectResourceType).map((f) => f.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(p!.fields[key], key).toBeDefined();
  });

  it("still reads a single project's status", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/api/0/projects/acme/web/"
        ? { id: "11", slug: "web", status: "active" }
        : [],
    );
    const p = await c.getResource("project", `${ACCOUNT}:project:web`, ACCOUNT);
    expect(p.fields["status"]).toBe("active");
  });
});
