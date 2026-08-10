import { describe, expect, it } from "vitest";
import {
  firstValidIso,
  parseStatusFeed,
  pickLatestMessage,
  toIsoTimestamp,
} from "../status-feed.js";

describe("toIsoTimestamp / firstValidIso", () => {
  it("returns ISO for valid input and null for invalid", () => {
    expect(toIsoTimestamp("2026-07-01T12:00:00Z")).toBe("2026-07-01T12:00:00.000Z");
    expect(toIsoTimestamp("not-a-date")).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
    expect(toIsoTimestamp("")).toBeNull();
  });

  it("falls back through candidates to epoch", () => {
    expect(firstValidIso("bogus", "also-bad")).toBe(new Date(0).toISOString());
    expect(firstValidIso("bogus", "2026-01-15T00:00:00Z")).toBe("2026-01-15T00:00:00.000Z");
    expect(firstValidIso(undefined, null, "2026-03-01T08:30:00Z")).toBe("2026-03-01T08:30:00.000Z");
  });
});

describe("pickLatestMessage", () => {
  it("picks the newest parseable datetime, ignoring invalid ones", () => {
    const latest = pickLatestMessage([
      { details: "old", datetime: "2026-07-01T10:00:00Z" },
      { details: "bad", datetime: "not-a-date" },
      { details: "new", datetime: "2026-07-01T12:00:00Z" },
    ]);
    expect(latest?.details).toBe("new");
  });

  it("returns undefined when every datetime is invalid", () => {
    expect(
      pickLatestMessage([
        { details: "a", datetime: "nope" },
        { details: "b", datetime: "still-nope" },
      ]),
    ).toBeUndefined();
  });
});

describe("parseStatusFeed timestamps", () => {
  it("uses epoch when primary and secondary open times are invalid", () => {
    const body = JSON.stringify({
      result: {
        status: [],
        incidents: [
          {
            id: "inc-1",
            name: "Connectivity",
            datetime_open: "not-a-date",
            datetime_opened: "also-bad",
            containers_affected: [],
            messages: [{ details: "investigating", datetime: "garbage" }],
          },
        ],
      },
    });
    const [incident] = parseStatusFeed(body);
    expect(incident?.startedAt).toBe(new Date(0).toISOString());
    expect(incident?.lastUpdateAt).toBeUndefined();
    // Details from a message with invalid datetime are still usable when it
    // was the only candidate, but pickLatestMessage drops all-invalid lists.
    expect(incident?.lastUpdateText).toBeUndefined();
  });

  it("uses child.updated when valid, epoch when not", () => {
    const body = JSON.stringify({
      result: {
        status: [
          {
            name: "Database Connectivity",
            containers: [
              {
                id: "c1",
                name: "AWS us-east-1",
                status: "degraded",
                status_code: 300,
                updated: "not-valid",
              },
              {
                id: "c2",
                name: "AWS eu-west-1",
                status: "degraded",
                status_code: 300,
                updated: "2026-06-01T09:00:00Z",
              },
            ],
          },
        ],
        incidents: [],
      },
    });
    const incidents = parseStatusFeed(body);
    const east = incidents.find((i) => i.externalId === "container:c1");
    const west = incidents.find((i) => i.externalId === "container:c2");
    expect(east?.startedAt).toBe(new Date(0).toISOString());
    expect(west?.startedAt).toBe("2026-06-01T09:00:00.000Z");
  });
});
