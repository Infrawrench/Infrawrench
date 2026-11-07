import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { PromClient } from "../client.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acct";

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  return {
    c: hostClient(
      new PromClient({ url: "prom.internal:9090", alertmanagerUrl: "am.internal:9093" }, {
        http,
      } as never),
    ),
    calls,
  };
}
const ok = (data: unknown) => ({ status: "success", data });

function targets(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    scrapePool: "node",
    scrapeUrl: `http://host-${i}:9100/metrics`,
    health: "up",
    labels: { instance: `host-${i}` },
  }));
}

describe("lists that feed the sync", () => {
  it("reads every active target, past the old 3,000", async () => {
    const { c } = client(() => ok({ activeTargets: targets(3500), droppedTargets: null }));
    expect(await c.listResources("prometheus-target", ACCOUNT)).toHaveLength(3500);
  });

  it("refuses more targets than one sync can hold rather than dropping the rest", async () => {
    const { c } = client(() => ok({ activeTargets: targets(100_001) }));
    await expect(c.listResources("prometheus-target", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("reads a Go nil slice of targets as none", async () => {
    const { c } = client(() => ok({ activeTargets: null }));
    expect(await c.listResources("prometheus-target", ACCOUNT)).toEqual([]);
  });

  it.each([
    ["prometheus-target", "/api/v1/targets"],
    ["prometheus-scrape-pool", "/api/v1/targets"],
    ["prometheus-rule-group", "/api/v1/rules"],
    ["prometheus-rule", "/api/v1/rules"],
    ["prometheus-alert", "/api/v1/alerts"],
  ])("does not read %s from an answer without its list as none", async (type, path) => {
    const { c } = client((call) =>
      call.url.pathname === path ? ok({}) : ok({ scrapePools: [], activeTargets: [] }),
    );
    await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("does not read a login page answered with 200 as no targets", async () => {
    const { c } = client(() => ({ text: "<html>Sign in</html>" }));
    await expect(c.listResources("prometheus-target", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each([
    ["prometheus-silence", "/api/v2/silences"],
    ["prometheus-am-alert", "/api/v2/alerts"],
    ["prometheus-receiver", "/api/v2/receivers"],
  ])("does not read an empty Alertmanager answer for %s as none", async (type, path) => {
    const { c } = client((call) => (call.url.pathname === path ? { text: "" } : []));
    await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });
});
