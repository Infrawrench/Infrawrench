import { describe, expect, it } from "vitest";
import {
  describeHeartbeatSchedule,
  heartbeatCurlSnippet,
  heartbeatDeadline,
  heartbeatNextExpected,
  heartbeatPingUrls,
  normalizeProviderSchedule,
  validateHeartbeatSchedule,
} from "../heartbeats";

const cron = (cronExpression: string, timezone = "UTC") => ({
  kind: "cron" as const,
  cronExpression,
  timezone,
});

describe("normalizeProviderSchedule", () => {
  it.each([
    ["0 2 * * *", undefined, cron("0 2 * * *")],
    ["*/15 * * * *", "Europe/Paris", cron("*/15 * * * *", "Europe/Paris")],
    ["@hourly", undefined, cron("0 * * * *")],
    ["@daily UTC", undefined, cron("0 0 * * *")],
    ["CRON_TZ=America/New_York 30 6 * * 1-5", undefined, cron("30 6 * * 1-5", "America/New_York")],
    ["0 * * * * Europe/Berlin", undefined, cron("0 * * * *", "Europe/Berlin")],
    ["0 9 * * * +09:00", undefined, cron("0 9 * * *", "Etc/GMT-9")],
    [
      "USING CRON 0 9 * * * America/Los_Angeles",
      undefined,
      cron("0 9 * * *", "America/Los_Angeles"),
    ],
    // AWS: six fields with a year, `?`, 1-7 = SUN-SAT.
    ["cron(0 12 ? * 2 *)", undefined, cron("0 12 * * 1")],
    ["cron(0/5 8-17 ? * MON-FRI *)", undefined, cron("0/5 8-17 * * MON-FRI")],
    // Quartz: seconds first, optional year.
    ["0 30 12 * * ? *", undefined, cron("30 12 * * *")],
    ["0 0 6 ? * 1", "Europe/London", cron("0 6 * * 0", "Europe/London")],
    ["cron 0 9 * * * (Asia/Tokyo)", undefined, cron("0 9 * * *", "Asia/Tokyo")],
  ])("reads %s", (raw, zone, expected) => {
    expect(normalizeProviderSchedule(raw, zone)).toEqual(expected);
  });

  it.each([
    ["rate(5 minutes)", 5],
    ["rate(1 hour)", 60],
    ["5 MINUTE", 5],
    ["10 minute", 10],
    ["every 2 hours", 120],
    ["every 1 day", 1440],
    ["@every 1h30m", 90],
    ["every 1h 30m", 90],
    ["15m", 15],
  ])("reads %s as an interval", (raw, minutes) => {
    expect(normalizeProviderSchedule(raw)).toEqual({ kind: "interval", intervalMinutes: minutes });
  });

  it.each([
    ["mon..fri 22"],
    ["0 0 L * ?"],
    ["0 15 10 ? * 6#3"],
    ["0 * * * *, */5 * * * *"],
    ["cron(0 12 * * ? 2027)"],
    ["0 9 * * * +05:30"],
    ["1 month"],
    [""],
    [42],
  ])("refuses %s", (raw) => {
    expect(normalizeProviderSchedule(raw)).toBeNull();
  });

  it("refuses a zone that is not an IANA name rather than assuming UTC", () => {
    expect(normalizeProviderSchedule("0 2 * * *", "Pacific Time (US & Canada)")).toBeNull();
    expect(normalizeProviderSchedule("0 2 * * *", "utc")).toEqual(cron("0 2 * * *"));
  });
});

describe("schedule arithmetic", () => {
  it("expects an interval job one interval after its ping", () => {
    const at = new Date("2026-11-18T10:00:00Z");
    expect(
      heartbeatNextExpected({ kind: "interval", intervalMinutes: 15 }, at)?.toISOString(),
    ).toBe("2026-11-18T10:15:00.000Z");
    expect(heartbeatDeadline({ kind: "interval", intervalMinutes: 15 }, 5, at)?.toISOString()).toBe(
      "2026-11-18T10:20:00.000Z",
    );
  });

  it("expects a cron job at its next occurrence in its zone", () => {
    const at = new Date("2026-11-18T02:03:00Z");
    expect(heartbeatNextExpected(cron("0 2 * * *"), at)?.toISOString()).toBe(
      "2026-11-19T02:00:00.000Z",
    );
    expect(heartbeatNextExpected(cron("0 2 * * *", "Europe/Paris"), at)?.toISOString()).toBe(
      "2026-11-19T01:00:00.000Z",
    );
  });

  it("does not expect a job again at the run it pinged a little early for", () => {
    const early = new Date("2026-11-18T01:59:50Z");
    expect(heartbeatNextExpected(cron("0 2 * * *"), early)?.toISOString()).toBe(
      "2026-11-19T02:00:00.000Z",
    );
  });

  it("validates schedules with the words the editors show", () => {
    expect(validateHeartbeatSchedule(cron("0 2 * * *"))).toBeNull();
    expect(validateHeartbeatSchedule(cron("0 2 * *"))).toMatch(/not valid/);
    expect(validateHeartbeatSchedule(cron("0 2 * * *", "Mars/Olympus"))).toMatch(/time zone/);
    expect(validateHeartbeatSchedule(cron("0 0 30 2 *"))).toMatch(/never fires/);
    expect(validateHeartbeatSchedule({ kind: "interval", intervalMinutes: 0 })).toMatch(/between/);
  });
});

describe("presentation", () => {
  it("describes schedules", () => {
    expect(describeHeartbeatSchedule({ kind: "interval", intervalMinutes: 60 })).toBe("every hour");
    expect(describeHeartbeatSchedule({ kind: "interval", intervalMinutes: 2880 })).toBe(
      "every 2 days",
    );
    expect(describeHeartbeatSchedule(cron("0 2 * * *", "Europe/Paris"))).toBe(
      "cron 0 2 * * * (Europe/Paris)",
    );
  });

  it("builds the three ping URLs and the snippet from them", () => {
    const urls = heartbeatPingUrls("https://app.example.test/api/ping/abc/");
    expect(urls).toEqual({
      success: "https://app.example.test/api/ping/abc",
      start: "https://app.example.test/api/ping/abc/start",
      fail: "https://app.example.test/api/ping/abc/fail",
    });
    const snippet = heartbeatCurlSnippet("https://app.example.test/api/ping/abc");
    expect(snippet).toContain(urls.start);
    expect(snippet).toContain(urls.fail);
  });
});
