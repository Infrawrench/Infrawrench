import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { SentryClient } from "../client.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

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
