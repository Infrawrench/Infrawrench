import { showcaseFields } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
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
