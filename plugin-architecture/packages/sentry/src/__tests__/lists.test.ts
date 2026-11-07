import { showcaseFields } from "@infrawrench/plugin-base";
import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentryClient } from "../client.js";
import { plugin } from "../plugin.js";
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
    body: [
      {
        id: String(page),
        slug: `row-${page}`,
        dateCreated: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
    headers: nextLink(`https://us.sentry.io${call.url.pathname}?cursor=${page + 1}`),
  };
}

describe("page caps", () => {
  it("reads an inventory list past the old 20 pages", async () => {
    const { c, calls } = client((call) => {
      const page = Number(call.url.searchParams.get("cursor") ?? 0);
      return {
        body: [{ id: String(page), slug: `team-${page}` }],
        headers: nextLink(`https://us.sentry.io${ORG}/teams/?cursor=${page + 1}`, page < 149),
      };
    });
    await expect(c.listResources("team", ACCOUNT)).resolves.toHaveLength(150);
    expect(calls).toHaveLength(150);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
  });

  it("throws rather than return part of an inventory list, after exactly 500 pages", async () => {
    const { c, calls } = client(endless);
    await expect(c.listResources("team", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(500);
  });

  it("offers every organization in the picker, past the old 5 pages", async () => {
    const { http, calls } = makeHttp((call) => {
      const page = Number(call.url.searchParams.get("cursor") ?? 0);
      return {
        body: [{ slug: `org-${page}`, name: `Org ${page}` }],
        headers: nextLink(`https://us.sentry.io/api/0/organizations/?cursor=${page + 1}`, page < 7),
      };
    });
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "organization",
      { region: "us", authToken: "sntryu_X" },
      { http } as never,
    );
    expect(options).toHaveLength(8);
    expect(calls).toHaveLength(8);
  });

  it("charts the newest ten pages of check-ins and stops there", async () => {
    const { c, calls } = client((call) => {
      const page = Number(call.url.searchParams.get("cursor") ?? 0);
      return {
        body: [
          {
            id: String(page),
            status: "ok",
            duration: 1000,
            dateCreated: new Date(Date.now() - 3_600_000).toISOString(),
          },
        ],
        headers: nextLink(`https://us.sentry.io${call.url.pathname}?cursor=${page + 1}`),
      };
    });
    const series = await c.fetchMetricSeries!(
      "cron-monitor",
      `${ACCOUNT}:cron-monitor:nightly`,
      ACCOUNT,
    );
    expect(calls).toHaveLength(10);
    expect(series.find((s) => s.label === "Run duration")?.points).toHaveLength(10);
  });

  it("lists the newest page of releases, and fails on one that is not a list", async () => {
    const { c, calls } = client(() => ({
      body: [{ version: "1.0.0" }],
      headers: nextLink(`https://us.sentry.io${ORG}/releases/?cursor=1`),
    }));
    await expect(c.listResources("release", ACCOUNT)).resolves.toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
    const bad = client(() => ({ results: [] }));
    await expect(bad.c.listResources("release", ACCOUNT)).rejects.toThrow("is not a list");
  });
});

describe("pages that are not lists", () => {
  it("fails on the first page and on a later one", async () => {
    const first = client(() => ({ teams: [] }));
    await expect(first.c.listResources("team", ACCOUNT)).rejects.toThrow("is not a list");
    const later = client((call) =>
      call.url.searchParams.get("cursor")
        ? { teams: [] }
        : {
            body: [{ id: "1", slug: "a" }],
            headers: nextLink(`https://us.sentry.io${ORG}/teams/?cursor=1`),
          },
    );
    await expect(later.c.listResources("team", ACCOUNT)).rejects.toThrow("is not a list");
  });

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

  it("fails on an answer to the issue list that is not a list", async () => {
    const { c } = client(() => ({ issues: [] }));
    await expect(c.listResources("issue", ACCOUNT)).rejects.toThrow("is not a list");
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

  it("carries a refusal through the project lookup a monitor list makes", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/projects/")
        ? { body: [], headers: nextLink("https://evil.example/api/0/x/") }
        : [],
    );
    await expect(c.listResources("monitor", ACCOUNT)).rejects.toThrow(REFUSED);
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

describe("a failed read behind a list", () => {
  it("fails the monitor list when the project lookup fails", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/projects/") ? { status: 500, body: { detail: "down" } } : [],
    );
    await expect(c.listResources("monitor", ACCOUNT)).rejects.toThrow(/500/);
  });

  it("lists monitors without slugs for a token that may not read projects", async () => {
    const { c } = client((call) =>
      call.url.pathname.endsWith("/projects/")
        ? { status: 403, body: { detail: "no" } }
        : [{ id: "7", name: "Errors", type: "metric_issue", projectId: "11" }],
    );
    const [m] = await c.listResources("monitor", ACCOUNT);
    expect(m?.externalId).toBe("7");
  });

  it("still shows an organization when the project lookup for its usage fails", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === `${ORG}/`) return { id: "1", slug: "acme", name: "Acme" };
      return { status: 500, body: { detail: "down" } };
    });
    await expect(
      c.getResource("organization", `${ACCOUNT}:organization:acme`, ACCOUNT),
    ).resolves.toMatchObject({ externalId: "acme" });
  });

  const today = new Date().toISOString().slice(0, 10);
  const range = { fromDate: `${today.slice(0, 7)}-01`, toDate: today };

  /** Everything cost collection reads, with the uptime list answered by `uptime`. */
  const costRoute = (uptime: () => unknown) => (call: Call) => {
    if (call.url.pathname.endsWith("/stats_v2/")) return stats(range.fromDate, 1, []);
    if (call.url.pathname.endsWith("/uptime/")) return uptime();
    return [];
  };
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
