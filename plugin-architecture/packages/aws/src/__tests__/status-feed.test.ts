import { describe, expect, it } from "vitest";
import { parseStatusFeed } from "../status-feed.js";

describe("parseStatusFeed event_log", () => {
  it("picks the newest timestamped log entry", () => {
    const body = JSON.stringify([
      {
        arn: "arn:aws:health:event/1",
        service: "ec2-us-east-1",
        service_name: "Amazon EC2",
        summary: "Elevated API errors",
        date: "1720000000",
        event_log: [
          { summary: "old", message: "started", timestamp: "2026-07-01T10:00:00Z" },
          { summary: "new", message: "still ongoing", timestamp: "2026-07-01T12:00:00Z" },
        ],
      },
    ]);
    const [incident] = parseStatusFeed(body);
    expect(incident?.lastUpdateText).toBe("still ongoing");
    expect(incident?.lastUpdateAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("emits no lastUpdate fields when every event_log timestamp is invalid", () => {
    const body = JSON.stringify([
      {
        arn: "arn:aws:health:event/2",
        service: "ec2-us-east-1",
        service_name: "Amazon EC2",
        summary: "Elevated API errors",
        date: "1720000000",
        event_log: [
          { summary: "a", message: "should not surface", timestamp: "not-a-date" },
          { summary: "b", message: "also garbage", timestamp: "???" },
        ],
      },
    ]);
    const [incident] = parseStatusFeed(body);
    expect(incident?.lastUpdateText).toBeUndefined();
    expect(incident?.lastUpdateAt).toBeUndefined();
  });
});
