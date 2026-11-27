import { describe, expect, test } from "vitest";
import { dayKey, formatBytes, groupConsecutive, relativeTime } from "../format";
import { formatLineHash, inRange, parseLineHash, selectLine } from "../lines";

describe("parseLineHash", () => {
  test("one line and a range", () => {
    expect(parseLineHash("#L10")).toEqual({ start: 10, end: 10 });
    expect(parseLineHash("#L10-L20")).toEqual({ start: 10, end: 20 });
    expect(parseLineHash("L10-20")).toEqual({ start: 10, end: 20 });
  });

  test("a range written backwards is put in order", () => {
    expect(parseLineHash("#L20-L10")).toEqual({ start: 10, end: 20 });
  });

  test("anything else is no selection", () => {
    for (const hash of ["", "#", "#readme", "#L", "#L0", "#L1-", "#L1-L2-L3", "#diff-L3"]) {
      expect(parseLineHash(hash)).toBeNull();
    }
  });

  test("round-trips with formatLineHash", () => {
    expect(formatLineHash({ start: 7, end: 7 })).toBe("L7");
    expect(formatLineHash({ start: 7, end: 9 })).toBe("L7-L9");
    expect(parseLineHash(`#${formatLineHash({ start: 7, end: 9 })}`)).toEqual({ start: 7, end: 9 });
  });
});

describe("selectLine", () => {
  test("a click selects one line, and clicking it again clears it", () => {
    expect(selectLine(null, 5, false)).toEqual({ start: 5, end: 5 });
    expect(selectLine({ start: 5, end: 5 }, 5, false)).toBeNull();
    expect(selectLine({ start: 5, end: 9 }, 5, false)).toEqual({ start: 5, end: 5 });
  });

  test("a shift-click extends from the selection's start", () => {
    expect(selectLine({ start: 5, end: 5 }, 9, true)).toEqual({ start: 5, end: 9 });
    expect(selectLine({ start: 5, end: 9 }, 7, true)).toEqual({ start: 5, end: 7 });
  });

  test("a shift-click above the selection keeps its end", () => {
    expect(selectLine({ start: 5, end: 9 }, 2, true)).toEqual({ start: 2, end: 9 });
  });

  test("a shift-click with nothing selected selects the line", () => {
    expect(selectLine(null, 4, true)).toEqual({ start: 4, end: 4 });
  });

  test("inRange", () => {
    expect(inRange({ start: 2, end: 4 }, 3)).toBe(true);
    expect(inRange({ start: 2, end: 4 }, 5)).toBe(false);
    expect(inRange(null, 1)).toBe(false);
  });
});

describe("format", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");

  test("relativeTime", () => {
    expect(relativeTime("2026-11-25T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-11-25T11:13:00Z", now)).toBe("47 minutes ago");
    expect(relativeTime("2026-11-25T07:00:00Z", now)).toBe("5 hours ago");
    expect(relativeTime("2026-11-24T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-11-09T12:00:00Z", now)).toBe("16 days ago");
    expect(relativeTime("2026-08-20T12:00:00Z", now)).toBe("3 months ago");
    expect(relativeTime("2024-08-20T12:00:00Z", now)).toMatch(/2024/);
  });

  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(2447)).toBe("2.39 KB");
    expect(formatBytes(48_213_504)).toBe("46.0 MB");
  });

  test("groupConsecutive keeps order and splits on a change of key", () => {
    const items = ["2026-11-25T10:00:00", "2026-11-25T08:00:00", "2026-11-24T23:00:00"];
    expect(groupConsecutive(items, dayKey).map((group) => group.items.length)).toEqual([2, 1]);
  });
});
