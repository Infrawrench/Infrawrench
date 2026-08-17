import { describe, expect, it } from "vitest";

import {
  ON_CALL_LIMITS,
  nextOnCall,
  resolveOnCall,
  upcomingOnCallShifts,
  validateOnCallOverride,
  validateOnCallSchedule,
  type OnCallOverride,
  type OnCallSchedule,
} from "../on-call";

function schedule(overrides: Partial<OnCallSchedule> = {}): OnCallSchedule {
  return {
    id: "sched-1",
    name: "Platform",
    timezone: "Europe/London",
    rotationDays: 7,
    handoffTime: "09:00",
    // A Monday.
    startDate: "2026-08-03",
    participants: [
      { userId: "ana", name: "Ana", email: "ana@example.com" },
      { userId: "ben", name: "Ben", email: "ben@example.com" },
      { userId: "cass", name: "Cass", email: "cass@example.com" },
    ],
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function cover(overrides: Partial<OnCallOverride> = {}): OnCallOverride {
  return {
    id: "ov-1",
    scheduleId: "sched-1",
    userId: "dee",
    userName: "Dee",
    startsAt: "2026-08-05T18:00:00.000Z",
    endsAt: "2026-08-06T08:00:00.000Z",
    reason: null,
    createdByUserId: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

const at = (iso: string) => Date.parse(iso);

describe("validateOnCallSchedule", () => {
  const base = {
    name: "Platform",
    timezone: "Europe/London",
    rotationDays: 7,
    handoffTime: "09:00",
    startDate: "2026-08-03",
    participantUserIds: ["ana", "ben"],
  };

  it("accepts a sound schedule", () => {
    expect(validateOnCallSchedule(base)).toBeNull();
  });

  it("rejects an unknown zone and a bad handover time", () => {
    expect(validateOnCallSchedule({ ...base, timezone: "Mars/Olympus" })).toContain("time zone");
    expect(validateOnCallSchedule({ ...base, handoffTime: "9am" })).toContain("HH:MM");
  });

  it("rejects an empty rotation", () => {
    expect(validateOnCallSchedule({ ...base, participantUserIds: [] })).toContain("at least one");
  });

  it("rejects the same person twice", () => {
    // Invisible in a list of names, and it puts one person on call a third of
    // the time in a six-person rotation.
    expect(validateOnCallSchedule({ ...base, participantUserIds: ["ana", "ben", "ana"] })).toBe(
      "Each person may appear in the rotation once.",
    );
  });

  it("bounds the shift length", () => {
    expect(validateOnCallSchedule({ ...base, rotationDays: 0 })).toContain("between");
    expect(
      validateOnCallSchedule({ ...base, rotationDays: ON_CALL_LIMITS.maxRotationDays + 1 }),
    ).toContain("between");
  });
});

describe("resolveOnCall", () => {
  it("puts the first participant on the first shift", () => {
    const shift = resolveOnCall(schedule(), [], at("2026-08-03T10:00:00.000Z"));
    expect(shift?.userId).toBe("ana");
    expect(shift?.source).toBe("rotation");
    expect(shift?.rotationIndex).toBe(0);
  });

  it("hands over at the handover time, not at midnight", () => {
    // 08:00 local on handover Monday is still last week's shift.
    expect(resolveOnCall(schedule(), [], at("2026-08-10T07:00:00.000Z"))?.userId).toBe("ana");
    expect(resolveOnCall(schedule(), [], at("2026-08-10T09:00:00.000Z"))?.userId).toBe("ben");
  });

  it("wraps around the rotation", () => {
    expect(resolveOnCall(schedule(), [], at("2026-08-17T10:00:00.000Z"))?.userId).toBe("cass");
    expect(resolveOnCall(schedule(), [], at("2026-08-24T10:00:00.000Z"))?.userId).toBe("ana");
  });

  it("keeps the handover at 09:00 local across a DST change", () => {
    // Europe/London leaves BST on 2026-10-25. A rotation stepped in fixed
    // 24-hour blocks would drift an hour and hand over at 08:00.
    const shift = resolveOnCall(schedule(), [], at("2026-11-02T10:00:00.000Z"));
    expect(shift).not.toBeNull();
    const startsLocal = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(shift!.startsAt));
    expect(startsLocal).toBe("09:00");
  });

  it("returns nobody before the rotation starts", () => {
    // A rotation does not retroactively cover the past.
    expect(resolveOnCall(schedule(), [], at("2026-07-20T10:00:00.000Z"))).toBeNull();
  });

  it("returns nobody for a disabled schedule", () => {
    // Callers treat null as "this destination contributes nobody" and carry on
    // with the rule's other destinations.
    expect(
      resolveOnCall(schedule({ enabled: false }), [], at("2026-08-05T10:00:00.000Z")),
    ).toBeNull();
  });

  it("returns nobody when the rotation is empty", () => {
    expect(
      resolveOnCall(schedule({ participants: [] }), [], at("2026-08-05T10:00:00.000Z")),
    ).toBeNull();
  });

  it("lets a cover win for exactly its window", () => {
    const overrides = [cover()];
    expect(resolveOnCall(schedule(), overrides, at("2026-08-05T17:59:00.000Z"))?.userId).toBe(
      "ana",
    );
    const covered = resolveOnCall(schedule(), overrides, at("2026-08-05T20:00:00.000Z"));
    expect(covered?.userId).toBe("dee");
    expect(covered?.source).toBe("override");
    expect(resolveOnCall(schedule(), overrides, at("2026-08-06T09:00:00.000Z"))?.userId).toBe(
      "ana",
    );
  });

  it("prefers the most recently started cover when two overlap", () => {
    // Row order must not decide who gets woken up.
    const older = cover({ id: "ov-old", userId: "dee", startsAt: "2026-08-05T12:00:00.000Z" });
    const newer = cover({ id: "ov-new", userId: "eli", startsAt: "2026-08-05T18:00:00.000Z" });
    expect(resolveOnCall(schedule(), [older, newer], at("2026-08-05T19:00:00.000Z"))?.userId).toBe(
      "eli",
    );
    expect(resolveOnCall(schedule(), [newer, older], at("2026-08-05T19:00:00.000Z"))?.userId).toBe(
      "eli",
    );
  });

  it("ignores a cover belonging to a different schedule", () => {
    const foreign = cover({ scheduleId: "other" });
    expect(resolveOnCall(schedule(), [foreign], at("2026-08-05T20:00:00.000Z"))?.userId).toBe(
      "ana",
    );
  });

  it("supports a daily rotation", () => {
    const daily = schedule({ rotationDays: 1 });
    expect(resolveOnCall(daily, [], at("2026-08-03T10:00:00.000Z"))?.userId).toBe("ana");
    expect(resolveOnCall(daily, [], at("2026-08-04T10:00:00.000Z"))?.userId).toBe("ben");
    expect(resolveOnCall(daily, [], at("2026-08-05T10:00:00.000Z"))?.userId).toBe("cass");
  });
});

describe("nextOnCall", () => {
  it("is the next person in the rotation", () => {
    expect(nextOnCall(schedule(), at("2026-08-03T10:00:00.000Z"))?.userId).toBe("ben");
    expect(nextOnCall(schedule(), at("2026-08-17T10:00:00.000Z"))?.userId).toBe("ana");
  });

  it("ignores covers", () => {
    // A cover is somebody standing in for one shift; escalating to "whoever is
    // covering next Tuesday" is not what an escalation means.
    expect(nextOnCall(schedule(), at("2026-08-05T20:00:00.000Z"))?.userId).toBe("ben");
  });

  it("is null for a one-person rotation, so the caller falls back", () => {
    expect(
      nextOnCall(
        schedule({ participants: [{ userId: "ana", name: "Ana", email: null }] }),
        at("2026-08-05T10:00:00.000Z"),
      ),
    ).toBeNull();
  });
});

describe("upcomingOnCallShifts", () => {
  it("lists consecutive shifts in rotation order", () => {
    const shifts = upcomingOnCallShifts(schedule(), at("2026-08-05T10:00:00.000Z"), 4);
    expect(shifts.map((s) => s.userId)).toEqual(["ana", "ben", "cass", "ana"]);
    // Each shift ends where the next begins — no gaps, no overlaps.
    expect(shifts[0]?.endsAt).toBe(shifts[1]?.startsAt);
    expect(shifts[1]?.endsAt).toBe(shifts[2]?.startsAt);
  });

  it("previews from the first shift when the rotation has not started", () => {
    const shifts = upcomingOnCallShifts(schedule(), at("2026-07-01T10:00:00.000Z"), 2);
    expect(shifts).toHaveLength(2);
    expect(shifts[0]?.userId).toBe("ana");
  });

  it("caps the count and returns nothing for a disabled schedule", () => {
    expect(upcomingOnCallShifts(schedule(), at("2026-08-05T10:00:00.000Z"), 5000).length).toBe(
      ON_CALL_LIMITS.maxPreviewShifts,
    );
    expect(
      upcomingOnCallShifts(schedule({ enabled: false }), at("2026-08-05T10:00:00.000Z"), 4),
    ).toEqual([]);
  });
});

describe("validateOnCallOverride", () => {
  const base = {
    userId: "dee",
    startsAt: "2026-08-05T18:00:00.000Z",
    endsAt: "2026-08-06T08:00:00.000Z",
  };

  it("accepts a sound cover", () => {
    expect(validateOnCallOverride(base)).toBeNull();
  });

  it("requires an end after the start", () => {
    expect(validateOnCallOverride({ ...base, endsAt: base.startsAt })).toContain("end after");
  });

  it("refuses a cover longer than the limit", () => {
    expect(validateOnCallOverride({ ...base, endsAt: "2027-08-06T08:00:00.000Z" })).toContain(
      "change the rotation",
    );
  });
});
