/**
 * What the recording says about who was in the room.
 *
 * The one judgement worth pinning is the "highest role held" rule: somebody
 * who drove for ten seconds of a two-hour session drove that session, and an
 * attribution that quietly demoted them back to "observer" because they handed
 * the keyboard back would be actively misleading to the person reading the
 * tape months later.
 */
import { describe, expect, it } from "vitest";

import type { ParticipantRow } from "@infrawrench/server-core/shared-console/store";

import { recordingParticipantsOf } from "../shared-console/attribution";

function participant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "p-1",
    sharedConsoleId: "share-1",
    userId: "u-1",
    userName: "Priya",
    role: "observer",
    status: "joined",
    driverRequestedAt: null,
    viewportCols: 120,
    viewportRows: 40,
    joinedAt: new Date("2026-08-11T12:00:00Z"),
    lastSeenAt: new Date("2026-08-11T12:05:00Z"),
    leftAt: null,
    ...overrides,
  };
}

describe("recordingParticipantsOf", () => {
  it("is empty for a session nobody joined", () => {
    expect(recordingParticipantsOf([])).toEqual([]);
  });

  it("names everyone with their role and join time", () => {
    const out = recordingParticipantsOf([
      participant({ id: "p-1", userId: "u-1", userName: "Priya", role: "driver" }),
      participant({ id: "p-2", userId: "u-2", userName: "Sam" }),
    ]);
    expect(out).toEqual([
      {
        userId: "u-1",
        userName: "Priya",
        role: "driver",
        joinedAt: "2026-08-11T12:00:00.000Z",
        leftAt: null,
      },
      {
        userId: "u-2",
        userName: "Sam",
        role: "observer",
        joinedAt: "2026-08-11T12:00:00.000Z",
        leftAt: null,
      },
    ]);
  });

  it("remembers that somebody drove, after they hand the keyboard back", () => {
    const before = recordingParticipantsOf([
      participant({ userId: "u-2", userName: "Sam", role: "driver" }),
    ]);
    const after = recordingParticipantsOf(
      [participant({ userId: "u-2", userName: "Sam", role: "observer" })],
      before,
    );
    expect(after[0]?.role).toBe("driver");
  });

  it("does not promote somebody who only ever observed", () => {
    const before = recordingParticipantsOf([participant({ userId: "u-2", role: "observer" })]);
    const after = recordingParticipantsOf(
      [participant({ userId: "u-2", role: "observer" })],
      before,
    );
    expect(after[0]?.role).toBe("observer");
  });

  it("keeps the original join time across updates", () => {
    const before = recordingParticipantsOf([participant({ userId: "u-2" })]);
    const after = recordingParticipantsOf(
      [participant({ userId: "u-2", joinedAt: new Date("2026-08-11T13:00:00Z") })],
      before,
    );
    expect(after[0]?.joinedAt).toBe("2026-08-11T12:00:00.000Z");
  });

  it("records when somebody left", () => {
    const out = recordingParticipantsOf([
      participant({ status: "left", leftAt: new Date("2026-08-11T12:30:00Z") }),
    ]);
    expect(out[0]?.leftAt).toBe("2026-08-11T12:30:00.000Z");
  });

  it("keeps somebody who has since left in the attribution", () => {
    const before = recordingParticipantsOf([participant({ userId: "u-2", userName: "Sam" })]);
    // A later update that no longer lists them must not erase the fact that
    // they were here — the tape is evidence, not a live roster.
    const after = recordingParticipantsOf(
      [participant({ userId: "u-1", userName: "Priya", role: "driver" })],
      before,
    );
    expect(after.map((p) => p.userId).sort()).toEqual(["u-1", "u-2"]);
  });
});
