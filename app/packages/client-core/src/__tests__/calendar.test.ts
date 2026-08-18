import { describe, expect, it } from "vitest";

import {
  buildIcsCalendar,
  calendarDayKey,
  calendarMonthGrid,
  compareCalendarEvents,
  foldIcsLine,
  groupCalendarEventsByDay,
  icsDate,
  icsEscapeText,
  icsTimestamp,
  overlapsWindow,
  pairSleepWindows,
  parseCalendarKinds,
  type CalendarEvent,
} from "../calendar";

const NOW = "2026-08-17T09:00:00.000Z";

function event(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "id" | "startsAt">) {
  return {
    kind: "expiry" as const,
    title: "Something",
    detail: null,
    endsAt: null,
    openEnded: false,
    allDay: false,
    severity: "info" as const,
    link: null,
    ...overrides,
  } satisfies CalendarEvent;
}

describe("parseCalendarKinds", () => {
  it("accepts a comma string and an array alike", () => {
    expect(parseCalendarKinds("incident,expiry")).toEqual(["expiry", "incident"]);
    expect(parseCalendarKinds(["incident", "expiry"])).toEqual(["expiry", "incident"]);
  });

  it("drops unknown members rather than rejecting the whole list", () => {
    // A subscription written by a newer server must keep working here; a URL a
    // calendar client refreshes hourly is the worst place to start 400ing.
    expect(parseCalendarKinds("expiry,teleportation,incident")).toEqual(["expiry", "incident"]);
  });

  it("de-duplicates and returns a canonical order", () => {
    expect(parseCalendarKinds("incident,incident,change-freeze")).toEqual([
      "change-freeze",
      "incident",
    ]);
  });

  it("returns nothing for junk", () => {
    expect(parseCalendarKinds(undefined)).toEqual([]);
    expect(parseCalendarKinds(42)).toEqual([]);
    expect(parseCalendarKinds("")).toEqual([]);
  });
});

describe("overlapsWindow", () => {
  const window = {
    from: Date.parse("2026-08-01T00:00:00Z"),
    to: Date.parse("2026-09-01T00:00:00Z"),
  };

  it("keeps a span that straddles the whole window", () => {
    expect(
      overlapsWindow(
        Date.parse("2026-07-01T00:00:00Z"),
        Date.parse("2026-10-01T00:00:00Z"),
        window,
      ),
    ).toBe(true);
  });

  it("keeps a point inside and drops one after", () => {
    expect(overlapsWindow(Date.parse("2026-08-15T00:00:00Z"), null, window)).toBe(true);
    expect(overlapsWindow(Date.parse("2026-09-15T00:00:00Z"), null, window)).toBe(false);
  });

  it("keeps a deadline exactly on the lower bound", () => {
    // The day a deadline falls on is the day it must show up on.
    expect(overlapsWindow(window.from, null, window)).toBe(true);
  });

  it("keeps an open-ended span that began before the window", () => {
    // Infinity, not null: a freeze held until further notice overlaps every
    // future window, while a null end would read as a point in the past.
    expect(
      overlapsWindow(Date.parse("2026-06-01T00:00:00Z"), Number.POSITIVE_INFINITY, window),
    ).toBe(true);
    expect(overlapsWindow(Date.parse("2026-06-01T00:00:00Z"), null, window)).toBe(false);
  });

  it("drops a span that closed before the window opened", () => {
    expect(
      overlapsWindow(
        Date.parse("2026-06-01T00:00:00Z"),
        Date.parse("2026-07-01T00:00:00Z"),
        window,
      ),
    ).toBe(false);
  });
});

describe("pairSleepWindows", () => {
  it("pairs each stop with the following start", () => {
    expect(
      pairSleepWindows([
        { at: "2026-08-17T19:00:00.000Z", action: "stop" },
        { at: "2026-08-18T07:00:00.000Z", action: "start" },
        { at: "2026-08-18T19:00:00.000Z", action: "stop" },
        { at: "2026-08-19T07:00:00.000Z", action: "start" },
      ]),
    ).toEqual([
      { startsAt: "2026-08-17T19:00:00.000Z", endsAt: "2026-08-18T07:00:00.000Z" },
      { startsAt: "2026-08-18T19:00:00.000Z", endsAt: "2026-08-19T07:00:00.000Z" },
    ]);
  });

  it("ignores a leading start, which belongs to a window that opened earlier", () => {
    expect(
      pairSleepWindows([
        { at: "2026-08-17T07:00:00.000Z", action: "start" },
        { at: "2026-08-17T19:00:00.000Z", action: "stop" },
        { at: "2026-08-18T07:00:00.000Z", action: "start" },
      ]),
    ).toEqual([{ startsAt: "2026-08-17T19:00:00.000Z", endsAt: "2026-08-18T07:00:00.000Z" }]);
  });

  it("reports a trailing stop as open-ended rather than dropping it", () => {
    // The resource really does go down then; the wake is simply past the
    // horizon we asked for. Dropping it would hide scheduled downtime.
    expect(
      pairSleepWindows([
        { at: "2026-08-17T19:00:00.000Z", action: "stop" },
        { at: "2026-08-18T07:00:00.000Z", action: "start" },
        { at: "2026-08-18T19:00:00.000Z", action: "stop" },
      ]),
    ).toEqual([
      { startsAt: "2026-08-17T19:00:00.000Z", endsAt: "2026-08-18T07:00:00.000Z" },
      { startsAt: "2026-08-18T19:00:00.000Z", endsAt: null },
    ]);
  });

  it("returns nothing for an empty transition list", () => {
    expect(pairSleepWindows([])).toEqual([]);
  });
});

describe("calendarDayKey", () => {
  it("uses the reader's zone, not UTC", () => {
    // 22:30 UTC is already tomorrow in Tokyo and still today in New York.
    expect(calendarDayKey("2026-08-17T22:30:00.000Z", "Asia/Tokyo")).toBe("2026-08-18");
    expect(calendarDayKey("2026-08-17T22:30:00.000Z", "America/New_York")).toBe("2026-08-17");
    expect(calendarDayKey("2026-08-17T22:30:00.000Z", "UTC")).toBe("2026-08-17");
  });

  it("returns empty string for an unparseable instant", () => {
    expect(calendarDayKey("not a date", "UTC")).toBe("");
  });
});

describe("groupCalendarEventsByDay", () => {
  it("puts a point event on exactly one day", () => {
    const grouped = groupCalendarEventsByDay(
      [event({ id: "a", startsAt: "2026-08-17T09:00:00.000Z" })],
      "UTC",
    );
    expect([...grouped.keys()]).toEqual(["2026-08-17"]);
  });

  it("occupies every day a span covers", () => {
    const grouped = groupCalendarEventsByDay(
      [
        event({
          id: "freeze",
          kind: "change-freeze",
          startsAt: "2026-08-17T09:00:00.000Z",
          endsAt: "2026-08-20T09:00:00.000Z",
        }),
      ],
      "UTC",
    );
    expect([...grouped.keys()].sort()).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
  });

  it("does not skip or repeat a date across a DST boundary", () => {
    // Europe/London springs forward on 2027-03-28; a fixed 24-hour step lands
    // at 00:30 the day before it should and would emit 03-28 twice.
    const grouped = groupCalendarEventsByDay(
      [
        event({
          id: "freeze",
          kind: "change-freeze",
          startsAt: "2027-03-26T23:30:00.000Z",
          endsAt: "2027-03-30T10:00:00.000Z",
        }),
      ],
      "Europe/London",
    );
    expect([...grouped.keys()].sort()).toEqual([
      "2027-03-26",
      "2027-03-27",
      "2027-03-28",
      "2027-03-29",
      "2027-03-30",
    ]);
  });
});

describe("calendarMonthGrid", () => {
  it("is always six Monday-first weeks", () => {
    const grid = calendarMonthGrid(2026, 8);
    expect(grid).toHaveLength(6);
    expect(grid.every((week) => week.length === 7)).toBe(true);
    // 2026-08-01 is a Saturday, so the grid opens on Monday 2026-07-27.
    expect(grid[0]?.[0]).toBe("2026-07-27");
    expect(grid[5]?.[6]).toBe("2026-09-06");
  });

  it("opens on the first when the month starts on a Monday", () => {
    // 2026-06-01 is a Monday: no leading days from May.
    expect(calendarMonthGrid(2026, 6)[0]?.[0]).toBe("2026-06-01");
  });
});

describe("compareCalendarEvents", () => {
  it("sorts earliest first, then longest span, then by id", () => {
    const later = event({ id: "b", startsAt: "2026-08-18T00:00:00.000Z" });
    const short = event({
      id: "c",
      startsAt: "2026-08-17T00:00:00.000Z",
      endsAt: "2026-08-17T01:00:00.000Z",
    });
    const long = event({
      id: "d",
      startsAt: "2026-08-17T00:00:00.000Z",
      endsAt: "2026-08-19T00:00:00.000Z",
    });
    expect([later, short, long].sort(compareCalendarEvents).map((e) => e.id)).toEqual([
      "d",
      "c",
      "b",
    ]);
  });
});

describe("icsEscapeText", () => {
  it("escapes the backslash before the separators it inserts", () => {
    expect(icsEscapeText("a\\b")).toBe("a\\\\b");
    expect(icsEscapeText("one, two; three")).toBe("one\\, two\\; three");
  });

  it("turns every newline form into the literal \\n", () => {
    expect(icsEscapeText("a\r\nb\nc\rd")).toBe("a\\nb\\nc\\nd");
  });
});

describe("foldIcsLine", () => {
  it("leaves a short line alone", () => {
    expect(foldIcsLine("SUMMARY:hello")).toBe("SUMMARY:hello");
  });

  it("folds at 75 octets with a leading space on continuations", () => {
    const folded = foldIcsLine(`SUMMARY:${"x".repeat(200)}`).split("\r\n");
    expect(folded[0]).toHaveLength(75);
    expect(folded.slice(1).every((line) => line.startsWith(" "))).toBe(true);
    expect(folded.slice(1).every((line) => line.length <= 75)).toBe(true);
    expect(folded.join("\r\n").replace(/\r\n /g, "")).toBe(`SUMMARY:${"x".repeat(200)}`);
  });

  it("counts octets, not characters, and never splits one", () => {
    // "é" is two octets: a character-counted fold would emit an 80-octet line,
    // and splitting the pair would produce bytes no parser can decode.
    const value = `SUMMARY:${"é".repeat(60)}`;
    const encoder = new TextEncoder();
    for (const line of foldIcsLine(value).split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(foldIcsLine(value).replace(/\r\n /g, "")).toBe(value);
  });

  it("keeps an astral character whole", () => {
    const value = `SUMMARY:${"🛠".repeat(30)}`;
    expect(foldIcsLine(value).replace(/\r\n /g, "")).toBe(value);
  });
});

describe("icsTimestamp / icsDate", () => {
  it("emits the compact UTC forms", () => {
    expect(icsTimestamp("2026-08-17T13:45:00.000Z")).toBe("20260817T134500Z");
    expect(icsDate("2026-08-17T13:45:00.000Z")).toBe("20260817");
  });
});

describe("buildIcsCalendar", () => {
  const ics = buildIcsCalendar(
    [
      event({
        id: "freeze:1",
        kind: "change-freeze",
        title: "Release freeze; end of quarter",
        detail: "Declared by Astrid",
        startsAt: "2026-08-17T09:00:00.000Z",
        endsAt: "2026-08-20T09:00:00.000Z",
      }),
      event({
        id: "expiry:cert-1",
        title: "api.example.com certificate expires",
        startsAt: "2026-09-01T00:00:00.000Z",
        allDay: true,
        severity: "critical",
      }),
    ],
    { name: "Infrawrench", now: NOW },
  );

  it("wraps the events in one VCALENDAR", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("BEGIN:VEVENT")).toHaveLength(3);
  });

  it("uses CRLF everywhere", () => {
    // Clients that reject bare LF do it by showing an empty calendar.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("derives the UID from the event's stable id", () => {
    // A UID that changed per render would make every refresh delete and
    // re-create the event, which subscribers see as duplicates.
    expect(ics).toContain("UID:freeze:1@infrawrench.com");
  });

  it("escapes the summary", () => {
    expect(ics).toContain("SUMMARY:Release freeze\\; end of quarter");
  });

  it("gives an all-day event a DATE start and an exclusive next-day end", () => {
    expect(ics).toContain("DTSTART;VALUE=DATE:20260901");
    expect(ics).toContain("DTEND;VALUE=DATE:20260902");
  });

  it("marks spans busy and points free", () => {
    const [, freeze, expiry] = ics.split("BEGIN:VEVENT");
    expect(freeze).toContain("TRANSP:OPAQUE");
    expect(expiry).toContain("TRANSP:TRANSPARENT");
  });

  it("asks clients not to poll harder than hourly", () => {
    expect(ics).toContain("X-PUBLISHED-TTL:PT1H");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
  });

  it("produces a valid document with no events", () => {
    const empty = buildIcsCalendar([], { name: "Empty", now: NOW });
    expect(empty).toContain("BEGIN:VCALENDAR");
    expect(empty).not.toContain("BEGIN:VEVENT");
  });
});
