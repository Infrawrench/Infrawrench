import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clickhouse/client-web", () => ({
  createClient: () => ({
    query: async () => ({ json: async () => [] }),
    command: async () => undefined,
    close: async () => undefined,
  }),
}));

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ClickHouseClient } from "../client.js";
import { postgresLogLines, serviceActivityLines } from "../logs.js";
import { clickPipeMetricSeries } from "../prometheus.js";

const ORG = "/v1/organizations/org-1";
let calls: string[] = [];

function route(routes: Array<[string, unknown]>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    const path = String(url).replace("https://api.clickhouse.cloud", "");
    calls.push(path);
    for (const [prefix, body] of routes) {
      if (path.startsWith(prefix)) {
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return { ok: true, status: 200, text: async () => text } as Response;
      }
    }
    throw new Error(`unrouted: ${path}`);
  }) as typeof fetch);
}

function client() {
  return new ClickHouseClient({ apiKeyId: "kid", apiKeySecret: "secret", organizationId: "org-1" });
}

function resource(typeId: string, externalId: string): ResourceInstance {
  return {
    id: `acct:${typeId}:${externalId}`,
    pluginId: "clickhouse",
    resourceTypeId: typeId,
    accountId: "acct",
    displayName: externalId,
    fields: { state: "running" },
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  };
}

afterEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

describe("clickPipeMetricSeries", () => {
  const body = [
    "# TYPE ClickPipes_SentEvents_Total counter",
    'ClickPipes_SentEvents_Total{clickpipe_id="p1",clickpipe_name="orders"} 120',
    'ClickPipes_SentEvents_Total{clickpipe_id="p2",clickpipe_name="other"} 999',
    'ClickPipes_SentBytes_Total{clickpipe_id="p1"} 2048',
    'ClickPipes_Errors_Total{clickpipe_id="p1"} 0',
    'ClickPipes_Info{clickpipe_id="p1"} 1',
  ].join("\n");

  it("keeps only the pipe's own samples and reports bytes raw", () => {
    expect(clickPipeMetricSeries(body, "p1", 5)).toEqual([
      { label: "Sent events (cumulative)", points: [{ timestamp: 5, value: 120 }] },
      { label: "Errors (cumulative)", points: [{ timestamp: 5, value: 0 }] },
      { label: "Sent data (cumulative)", unit: "bytes", points: [{ timestamp: 5, value: 2048 }] },
    ]);
  });

  it("reads the parent service's full scrape", async () => {
    route([[`${ORG}/services/svc1/prometheus`, body]]);
    const series = await client().fetchMetricSeries(
      "ch-clickpipe",
      "acct:ch-clickpipe:svc1/p1",
      "acct",
    );
    expect(calls).toEqual([`${ORG}/services/svc1/prometheus`]);
    expect(series).toHaveLength(3);
  });
});

describe("logs", () => {
  it("prints a service's activities oldest first and drops other services", () => {
    const text = serviceActivityLines(
      [
        {
          createdAt: "2026-10-02T10:00:00Z",
          type: "service_stop",
          serviceId: "svc1",
          actorType: "user",
          actorDetails: "a@b.c",
          actorIpAddress: "203.0.113.4",
        },
        {
          createdAt: "2026-10-01T10:00:00Z",
          type: "service_idle",
          serviceId: "svc1",
          actorType: "system",
        },
        { createdAt: "2026-10-01T11:00:00Z", type: "service_start", serviceId: "svc2" },
      ],
      "svc1",
      10,
    );
    expect(text).toBe(
      "2026-10-01 10:00:00  service_idle  by system\n" +
        "2026-10-02 10:00:00  service_stop  by user: a@b.c from 203.0.113.4\n",
    );
  });

  it("orders Postgres log entries oldest first", () => {
    expect(
      postgresLogLines([
        { timestamp: "2026-10-01T10:00:02.123Z", severity: "ERROR", body: "boom" },
        { timestamp: "2026-10-01T10:00:01Z", severity: "LOG", body: "checkpoint" },
      ]),
    ).toBe("2026-10-01 10:00:01  LOG      checkpoint\n2026-10-01 10:00:02  ERROR    boom\n");
  });

  it("filters the Postgres log by the chosen severity", async () => {
    route([[`${ORG}/postgres/pg1/logs`, { result: [] }]]);
    const result = await client().getLogs("ch-postgres", "acct:ch-postgres:pg1", "acct", {
      tailLines: 50,
      container: "ERROR",
    });
    expect(calls[0]).toContain("severity=ERROR");
    expect(calls[0]).toContain("limit=50");
    expect(calls[0]).toContain("sort_order=desc");
    expect(result.containers).toEqual(["all", "ERROR", "WARNING", "FATAL"]);
    expect(result.activeContainer).toBe("ERROR");
  });

  it("reads service activity from the organization log", async () => {
    route([
      [
        `${ORG}/activities`,
        {
          result: [{ createdAt: "2026-10-01T10:00:00Z", type: "service_start", serviceId: "svc1" }],
        },
      ],
    ]);
    const result = await client().getLogs("ch-service", "acct:ch-service:svc1", "acct", {});
    expect(calls[0]).toMatch(/activities\?from_date=.*&to_date=/);
    expect(result.text).toContain("service_start");
  });

  it("declares the tabs on the types that have them", () => {
    const c = client();
    expect(c.renderDetail(resource("ch-postgres", "pg1")).logs).toBeDefined();
    expect(c.renderDetail(resource("ch-clickpipe", "svc1/p1")).metricsCapability).toEqual({});
    expect(c.renderDetail(resource("ch-backup", "b1")).logs).toBeUndefined();
  });
});
