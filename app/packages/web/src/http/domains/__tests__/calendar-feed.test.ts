import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The token resolver and the event feed reach Postgres; the transport is what
// is under test: the `.ics` suffix, one 404 for unknown and revoked tokens,
// and the calendar body with its headers.
const mockResolve = vi.fn();
vi.mock("@infrawrench/server-core/calendar/subscriptions", () => ({
  resolveCalendarToken: (...a: unknown[]) => mockResolve(...a),
}));
const mockEvents = vi.fn();
vi.mock("@infrawrench/server-core/calendar/feed", () => ({
  listCalendarEvents: (...a: unknown[]) => mockEvents(...a),
}));

const { calendarFeedDomain } = await import("@/http/domains/calendar-feed/index");
const get = (path: string) =>
  buildTestApi(calendarFeedDomain, { permissions: [] }).request(`/api/calendar/${path}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/calendar/:token.ics", () => {
  it("answers a path without the .ics suffix with a plain-text 404", async () => {
    const res = await get("tok");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("Not found");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("answers an unknown or revoked token with the same 404", async () => {
    mockResolve.mockResolvedValue(null);
    const res = await get("tok.ics");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(mockResolve).toHaveBeenCalledWith("tok");
    expect(mockEvents).not.toHaveBeenCalled();
  });

  it("serves the subscription's kinds as an iCalendar body", async () => {
    mockResolve.mockResolvedValue({
      organizationId: "org-9",
      name: "On-call",
      kinds: ["change_freeze"],
    });
    mockEvents.mockResolvedValue({ events: [] });
    const res = await get("tok.ics");
    expect(res.status).toBe(200);
    expect(mockEvents).toHaveBeenCalledWith(
      "org-9",
      expect.objectContaining({ kinds: ["change_freeze"] }),
    );
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="infrawrench.ics"');
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(body).toContain("On-call");
  });
});
