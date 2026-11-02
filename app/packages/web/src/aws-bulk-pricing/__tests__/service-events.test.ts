import { describe, expect, it } from "vitest";

import type { Column } from "@infrawrench/server-core/aws-pricing-warehouse/schema";

import {
  CATALOG_URL,
  CURRENT_URL,
  HISTORY_URL,
  datedUpdates,
  decodeFeed,
  impactWindow,
  mergeEvents,
  parseClock,
  readCatalog,
  readFeed,
  syncServiceEvents,
  toRows,
  type ServiceEvent,
} from "../service-events";
import type { ClickHouseHttp } from "../warehouse";

const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  Date.UTC(y, mo - 1, d, h, mi) / 1000;

// The shapes below are trimmed copies of AWS's own feeds.

/** `historyevents.json`: service key to events; the title often only on the updates. */
const HISTORY = {
  "sns-eu-west-1": [
    {
      arn: "",
      status: "1",
      date: String(at(2023, 4, 6, 16, 20)),
      event_log: [
        {
          summary: "Increased Error Rates",
          message: "Starting at 6:14 AM PDT, we began to experience increased error rates.",
          status: "1",
          timestamp: at(2023, 4, 6, 16, 20),
        },
        {
          summary: "[RESOLVED] Increased Error Rates",
          message:
            "Between 6:14 AM and 9:33 AM PDT, we experienced increased error rates for the Amazon SNS Publish API in the EU-WEST-1 Region. The issue has been resolved and the service is operating normally.",
          status: "0",
          timestamp: at(2023, 4, 6, 16, 41),
        },
      ],
    },
  ],
  "ec2-us-east-1": [
    {
      arn: "arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/ISSUE_1",
      status: "1",
      // A minute off the current feed's copy of the same event.
      date: String(at(2026, 7, 6, 12, 44)),
      summary: "Increased Launch Template API Error Rates",
      event_log: [
        {
          summary: "Increased Launch Template API Error Rates",
          message: "We are investigating increased error rates for EC2 Launch Template APIs.",
          status: 1,
          timestamp: at(2026, 7, 6, 12, 45),
        },
      ],
    },
  ],
};

/** `currentevents`: open events, with what else they affect. */
const CURRENT = [
  {
    date: String(at(2026, 7, 6, 12, 45)),
    arn: "arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/ISSUE_1",
    region_name: "N. Virginia",
    status: "2",
    service: "ec2-us-east-1",
    service_name: "Amazon Elastic Compute Cloud",
    summary: "Increased Launch Template API Error Rates",
    event_log: [
      {
        summary: "Increased Launch Template API Error Rates",
        message: "We are investigating increased error rates for EC2 Launch Template APIs.",
        status: 2,
        timestamp: at(2026, 7, 6, 12, 45),
      },
    ],
    impacted_services: {
      "eks-us-east-1": {
        service_name: "Amazon Elastic Kubernetes Service",
        current: "1",
        max: "1",
      },
    },
  },
];

/** The old dashboard's `data.json`: pre-2011 keys, updates as HTML with a clock time only. */
const LEGACY = {
  archive: [
    {
      service: "EC2EU",
      service_name: "Amazon Elastic Compute Cloud (Ireland)",
      summary: "[RESOLVED] Instance connectivity",
      date: String(at(2011, 8, 7, 18, 0)),
      status: 3,
      details: "",
      description:
        '<div><span class="yellowfg">11:13 AM PDT</span>&nbsp;We are investigating connectivity issues.</div>' +
        '<div><span class="yellowfg">11:55 PM PDT</span>&nbsp;We continue to work on it.</div>' +
        '<div><span class="yellowfg"> 1:20 AM PDT</span>&nbsp;Between 10:41 AM PDT on August 7th and 1:05 AM PDT we saw connectivity issues &amp; API errors.</div>',
    },
  ],
  current: [],
};

const CATALOG = [
  {
    service: "sns-eu-west-1",
    service_name: "Amazon Simple Notification Service",
    region_id: "eu-west-1",
    region_name: "Ireland",
  },
  {
    service: "ec2-us-east-1",
    service_name: "Amazon Elastic Compute Cloud",
    region_id: "us-east-1",
    region_name: "N. Virginia",
  },
];

const rows = () =>
  mergeEvents(
    [],
    toRows([...readFeed(LEGACY), ...readFeed(HISTORY), ...readFeed(CURRENT)], readCatalog(CATALOG)),
    { closeMissing: true },
  ).events;

describe("decodeFeed", () => {
  it("reads UTF-8, gzip and the current feed's UTF-16 with a byte order mark", async () => {
    expect(await decodeFeed(new TextEncoder().encode("[1]"))).toBe("[1]");
    const gzipped = new Uint8Array(
      await new Response(
        new Blob([new TextEncoder().encode('{"a":1}')])
          .stream()
          .pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    expect(await decodeFeed(gzipped)).toBe('{"a":1}');
    const utf16be = new Uint8Array([0xfe, 0xff, 0, 0x5b, 0, 0x31, 0, 0x5d]);
    expect(await decodeFeed(utf16be)).toBe("[1]");
  });
});

describe("clock times", () => {
  it("parses AWS's ways of writing a time", () => {
    expect(parseClock(" 6:06 PM PDT")).toEqual({ hour: 18, minute: 6, zone: "PDT" });
    expect(parseClock("8:03AM")).toEqual({ hour: 8, minute: 3 });
    expect(parseClock("12:15 AM PST on October 20th")).toEqual({
      hour: 0,
      minute: 15,
      zone: "PST",
      month: 9,
      day: 20,
    });
  });

  it("dates the old dashboard's updates, rolling past midnight", () => {
    const updates = datedUpdates(LEGACY.archive[0]!.description, at(2011, 8, 7, 18, 0));
    expect(updates.map((u) => u.at)).toEqual([
      at(2011, 8, 7, 18, 13),
      at(2011, 8, 8, 6, 55),
      at(2011, 8, 8, 8, 20),
    ]);
    expect(updates[2]!.message).toContain("connectivity issues & API errors");
  });

  it("reads the impact window from a resolution message", () => {
    expect(
      impactWindow(
        "Between 6:14 AM and 9:33 AM PDT, we experienced errors.",
        at(2023, 4, 6, 16, 41),
      ),
    ).toEqual({ start: at(2023, 4, 6, 13, 14), end: at(2023, 4, 6, 16, 33) });
    // Across midnight, the start on the day before.
    expect(
      impactWindow("Between 11:20 PM and 2:05 AM PST, some instances...", at(2024, 1, 10, 10, 30)),
    ).toEqual({ start: at(2024, 1, 10, 7, 20), end: at(2024, 1, 10, 10, 5) });
    expect(impactWindow("We are investigating.", at(2024, 1, 1, 0, 0))).toBeNull();
  });

  it("spans every phase a long outage's message describes", () => {
    const message =
      "Between 11:49 PM PDT on October 19 and 2:24 AM PDT on October 20, we experienced increased error rates and latencies for AWS Services in the US-EAST-1 Region. We recovered the Network Load Balancer health checks at 9:38 AM. By 3:01 PM, all AWS services returned to normal operations.";
    expect(impactWindow(message, at(2025, 10, 20, 22, 53))).toEqual({
      start: at(2025, 10, 20, 6, 49),
      end: at(2025, 10, 20, 22, 1),
    });
  });
});

describe("toRows", () => {
  it("turns a history event into a resolved row with its impact window", () => {
    const sns = rows().find((e) => e.service === "sns")!;
    expect(sns).toMatchObject({
      provider: "aws",
      event_key: `sns-eu-west-1|${at(2023, 4, 6, 16, 20)}`,
      service_name: "Amazon Simple Notification Service",
      region: "eu-west-1",
      severity: "impacted",
      summary: "Increased Error Rates",
      posted_at: at(2023, 4, 6, 16, 20),
      resolved_at: at(2023, 4, 6, 16, 41),
      impact_started_at: at(2023, 4, 6, 13, 14),
      impact_ended_at: at(2023, 4, 6, 16, 33),
      updates: 2,
    });
    expect(sns.description).toMatch(/^Between 6:14 AM/);
    expect(sns.event_log).toMatch(/^2023-04-06 16:20 UTC {2}Starting at 6:14 AM PDT/);
  });

  it("maps the old dashboard's pre-2011 keys to today's service and region", () => {
    const ec2 = rows().find((e) => e.region === "eu-west-1" && e.service === "ec2")!;
    expect(ec2).toMatchObject({
      event_key: `EC2EU|${at(2011, 8, 7, 18, 0)}`,
      service_name: "Amazon Elastic Compute Cloud",
      arn: "",
      severity: "disrupted",
      summary: "Instance connectivity",
      resolved_at: at(2011, 8, 8, 8, 20),
      impact_started_at: at(2011, 8, 7, 17, 41),
      impact_ended_at: at(2011, 8, 8, 8, 5),
      updates: 3,
    });
  });

  it("keeps one row for an event in both feeds, open while the current feed lists it", () => {
    const open = rows().filter((e) => e.region === "us-east-1");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      // The key the event was first seen under; its ARN matched the other copy.
      event_key: `ec2-us-east-1|${at(2026, 7, 6, 12, 44)}`,
      severity: "degraded",
      summary: "Increased Launch Template API Error Rates",
      resolved_at: null,
      impacted_services: { "eks-us-east-1": "Amazon Elastic Kubernetes Service" },
    });
  });
});

describe("mergeEvents", () => {
  const event = (over: Partial<ServiceEvent>): ServiceEvent => ({
    provider: "aws",
    event_key: "ec2-eu-west-1|1",
    service: "ec2",
    service_name: "Amazon Elastic Compute Cloud",
    region: "eu-west-1",
    arn: "",
    severity: "impacted",
    summary: "Errors",
    posted_at: 1,
    last_update_at: 2,
    resolved_at: null,
    impact_started_at: null,
    impact_ended_at: null,
    updates: 2,
    description: "",
    event_log: "",
    impacted_services: {},
    ...over,
  });

  it("never replaces an event with a copy that has fewer updates", () => {
    const stored = event({ updates: 3, summary: "Later" });
    const { events, changed } = mergeEvents([stored], [event({ updates: 2 })]);
    expect(changed).toBe(0);
    expect(events).toEqual([stored]);
  });

  it("counts nothing when the feeds say what is stored", () => {
    const stored = event({ impacted_services: { a: "A", b: "B" } });
    const again = event({ impacted_services: { b: "B", a: "A" } });
    expect(mergeEvents([stored], [again, again]).changed).toBe(0);
  });

  it("keeps a known service name when a copy has none", () => {
    const { events } = mergeEvents([event({})], [event({ updates: 3, service_name: "" })]);
    expect(events[0]!.service_name).toBe("Amazon Elastic Compute Cloud");
  });

  it("closes an open event the current feed no longer lists", () => {
    const { events, changed } = mergeEvents([event({ last_update_at: 50 })], [], {
      closeMissing: true,
    });
    expect(changed).toBe(1);
    expect(events[0]!.resolved_at).toBe(50);
  });
});

describe("syncServiceEvents", () => {
  const json = (v: unknown) => new Response(JSON.stringify(v));
  const fetcher = (async (url: string | URL | Request) => {
    if (String(url) === HISTORY_URL) return json(HISTORY);
    if (String(url) === CURRENT_URL) return json(CURRENT);
    if (String(url) === CATALOG_URL) return json(CATALOG);
    return new Response("", { status: 404 });
  }) as typeof fetch;

  /** `staged` is what a count of the staging table returns after an insert. */
  function fakeClickHouse(stored: ServiceEvent[], staged = 0) {
    const statements: string[] = [];
    let inserted = 0;
    const ch = {
      async exec(sql: string) {
        statements.push(sql);
        return "";
      },
      async rows(sql: string) {
        if (sql.includes("count()")) return [{ n: String(inserted) }];
        return stored;
      },
      async insert(table: string, _columns: readonly Column[], _body: Uint8Array) {
        statements.push(`INSERT ${table}`);
        inserted = staged;
      },
    };
    return { ch: ch as unknown as ClickHouseHttp, statements };
  }

  it("writes the merged events and swaps them in", async () => {
    const { ch, statements } = fakeClickHouse([], 2);
    const result = await syncServiceEvents(ch, { fetch: fetcher, log: () => {} });
    // Two from the feeds, merged by ARN, and none stored before.
    expect(result).toEqual({ events: 2, changed: 2 });
    expect(statements).toContain("INSERT staging.service_events");
    expect(statements).toContain(
      "ALTER TABLE service_events REPLACE PARTITION 'aws' FROM staging.service_events",
    );
  });

  it("writes nothing when no event moved", async () => {
    const current = mergeEvents(
      [],
      toRows([...readFeed(HISTORY), ...readFeed(CURRENT)], readCatalog(CATALOG)),
      { closeMissing: true },
    ).events;
    const { ch, statements } = fakeClickHouse(current);
    const result = await syncServiceEvents(ch, { fetch: fetcher, log: () => {} });
    expect(result.changed).toBe(0);
    expect(statements.filter((s) => s.startsWith("INSERT") || s.startsWith("ALTER"))).toEqual([]);
  });
});
