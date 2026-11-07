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
});
