import { describe, expect, it } from "vitest";

import { rawTimestampToDate } from "../db/raw-timestamp";

/**
 * Raw-`sql` selections skip drizzle's timestamp mapping, so postgres-js hands
 * back the zoneless wire string. The helper has to read that string as UTC —
 * the way drizzle reads the column itself — not as server-local time, or every
 * aggregate timestamp skews by the host's UTC offset.
 */
describe("rawTimestampToDate", () => {
  it("parses the zoneless postgres wire format as UTC", () => {
    expect(rawTimestampToDate("2026-08-25 16:42:28.855").toISOString()).toBe(
      "2026-08-25T16:42:28.855Z",
    );
    expect(rawTimestampToDate("2026-08-25 16:42:28").toISOString()).toBe(
      "2026-08-25T16:42:28.000Z",
    );
  });

  it("respects an explicit zone when the string carries one", () => {
    expect(rawTimestampToDate("2026-08-25T16:42:28.855Z").toISOString()).toBe(
      "2026-08-25T16:42:28.855Z",
    );
    expect(rawTimestampToDate("2026-08-25 16:42:28+02").toISOString()).toBe(
      "2026-08-25T14:42:28.000Z",
    );
  });

  it("passes a Date through untouched", () => {
    const date = new Date("2026-08-25T16:42:28.855Z");
    expect(rawTimestampToDate(date)).toBe(date);
  });
});
