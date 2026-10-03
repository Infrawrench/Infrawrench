import { afterEach, describe, expect, it, vi } from "vitest";
import { plugin } from "../plugin.js";
import { flowSeries, flowWindow, formatFlowLogs } from "../network-flows.js";

const device = {
  id: "123",
  nodeId: "node-1",
  name: "web.tail.example",
  hostname: "web",
  addresses: ["100.64.0.1"],
  authorized: true,
};
const peer = { ...device, id: "456", nodeId: "node-2", hostname: "db", addresses: ["100.64.0.2"] };

const START = Date.parse("2026-09-01T00:00:00Z");
const logs = [
  {
    nodeId: "node-1",
    start: "2026-09-01T00:00:05Z",
    logged: "2026-09-01T00:00:12Z",
    virtualTraffic: [
      {
        proto: "tcp",
        src: "100.64.0.1:5000",
        dst: "100.64.0.2:5432",
        txBytes: 6000,
        txPkts: 6,
        rxBytes: 1200,
        rxPkts: 3,
      },
    ],
    physicalTraffic: [
      { proto: "udp", src: "100.64.0.1:0", dst: "203.0.113.9:41641", txBytes: 6600, rxBytes: 1500 },
    ],
  },
  {
    nodeId: "node-2",
    start: "2026-09-01T00:03:00Z",
    exitTraffic: [
      { proto: "tcp", src: "100.64.0.2:6000", dst: "198.51.100.1:443", txBytes: 120, rxBytes: 600 },
    ],
  },
];

function client() {
  const request = vi.fn(async ({ url }: { url: string }) => {
    if (url.includes("/logging/network"))
      return { status: 200, headers: {}, body: JSON.stringify({ logs }) };
    if (url.includes("/logging/configuration"))
      return { status: 200, headers: {}, body: JSON.stringify({ logs: [] }) };
    return { status: 200, headers: {}, body: JSON.stringify({ devices: [device, peer] }) };
  });
  return {
    request,
    client: plugin.createClient({ apiKey: "tskey-api-secret" }, { http: { request } }),
  };
}

afterEach(() => vi.useRealTimers());

describe("network flow metrics", () => {
  it("charts the tailnet and devices, nothing else", () => {
    const ids = plugin.resourceTypes.filter((t) => t.supportsMetrics).map((t) => t.id);
    expect(ids.sort()).toEqual(["device", "tailnet"]);
  });

  it("buckets one device's traffic into byte and packet rates", () => {
    const series = flowSeries(logs, { startMs: START, endMs: START + 60 * 60_000 }, "node-1");
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    // No subnet or exit traffic from this device, so those series are omitted.
    expect(Object.keys(byLabel)).toEqual([
      "Tailnet traffic sent",
      "Tailnet traffic received",
      "Physical traffic sent",
      "Physical traffic received",
      "Tailnet packets sent",
      "Tailnet packets received",
    ]);
    expect(byLabel["Tailnet traffic sent"]!.unit).toBe("bytes/s");
    expect(byLabel["Tailnet traffic sent"]!.points).toHaveLength(60);
    // 6000 bytes over a one-minute bucket.
    expect(byLabel["Tailnet traffic sent"]!.points[0]).toEqual({ timestamp: START, value: 100 });
    expect(byLabel["Physical traffic received"]!.points[0]!.value).toBe(25);
    expect(byLabel["Tailnet packets sent"]!.points[0]!.value).toBeCloseTo(0.1);
  });

  it("sums the tailnet and counts the devices reporting", () => {
    const series = flowSeries(logs, { startMs: START, endMs: START + 60 * 60_000 });
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    expect(byLabel["Exit node traffic received"]!.points[3]!.value).toBe(10);
    expect(byLabel["Devices reporting traffic"]!.points.slice(0, 4).map((p) => p.value)).toEqual([
      1, 0, 0, 1,
    ]);
  });

  it("clamps the window to a day and to retention", () => {
    const now = START;
    expect(flowWindow(undefined, now)).toEqual({ startMs: now - 3_600_000, endMs: now });
    expect(flowWindow({ startMs: now - 7 * 86_400_000, endMs: now }, now).startMs).toBe(
      now - 86_400_000,
    );
  });

  it("formats flow lines with device names", () => {
    const names = new Map([
      ["node-1", "web"],
      ["100.64.0.1", "web"],
      ["100.64.0.2", "db"],
    ]);
    const lines = formatFlowLogs(logs, names);
    expect(lines[0]).toBe(
      "2026-09-01T00:00:05Z web tailnet tcp web:5000 -> db:5432 tx 6000B/6p rx 1200B/3p",
    );
    expect(formatFlowLogs(logs, names, "node-2")).toEqual([
      "2026-09-01T00:03:00Z exit node tcp db:6000 -> 198.51.100.1:443 tx 120B/0p rx 600B/0p",
    ]);
  });

  it("fetches device series and flow logs through the network logging endpoint", async () => {
    // Inside the 30-day retention the window is taken as asked.
    vi.useFakeTimers({ now: START + 2 * 60 * 60_000 });
    const { request, client: c } = client();
    const series = await c.fetchMetricSeries!("device", "acct:device:node-1", "acct", {
      startMs: START,
      endMs: START + 60 * 60_000,
    });
    expect(request.mock.calls[0]![0].url).toBe(
      "https://api.tailscale.com/api/v2/tailnet/-/logging/network?start=2026-09-01T00%3A00%3A00.000Z&end=2026-09-01T01%3A00%3A00.000Z",
    );
    expect(series.find((s) => s.label === "Tailnet traffic sent")!.points[0]!.value).toBe(100);

    const result = await c.getLogs!("tailnet", "acct:tailnet:-", "acct", { container: "network" });
    expect(result.containers).toEqual(["configuration", "network"]);
    expect(result.activeContainer).toBe("network");
    expect(result.text).toContain("web tailnet tcp web:5000 -> db:5432");

    const deviceLogs = await c.getLogs!("device", "acct:device:node-2", "acct", {});
    expect(deviceLogs.containers).toEqual(["network"]);
    expect(deviceLogs.text).not.toContain("web:5000");
  });

  it("explains a 403 from the flow log endpoint", async () => {
    const request = vi.fn().mockResolvedValue({ status: 403, body: "forbidden" });
    const c = plugin.createClient({ apiKey: "tskey-api-secret" }, { http: { request } });
    await expect(c.fetchMetricSeries!("tailnet", "acct:tailnet:-", "acct")).rejects.toThrow(
      /Premium or Enterprise plan/,
    );
  });
});
