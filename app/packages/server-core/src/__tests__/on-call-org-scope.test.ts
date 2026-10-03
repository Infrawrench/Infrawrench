import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * Everyone put on a rotation or a cover must be a member of the org: the
 * listings join `users` by id and return each person's name and email, so a
 * foreign user id would read another org's member back out.
 */
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { createOnCallOverride, createOnCallSchedule } = await import("../on-call/store");

beforeEach(() => {
  pg.reset();
});

const writes = () => pg.queries.filter((q) => q.sql.startsWith("insert"));

describe("on-call org scoping", () => {
  it("refuses a cover for someone outside the org", async () => {
    // getOnCallSchedule: the schedule row (a bare select, so in column
    // order), then its participants.
    pg.queueRows([
      {
        id: "sched-1",
        organizationId: "org-1",
        name: "Primary",
        timezone: "UTC",
        rotationDays: 7,
        handoffTime: "09:00",
        startDate: "2026-08-01",
        enabled: true,
        createdByUserId: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);
    pg.queueRows([]);
    pg.queueRows([]); // the membership check finds nobody

    await expect(
      createOnCallOverride(
        "org-1",
        {
          scheduleId: "sched-1",
          userId: "user-of-another-org",
          startsAt: "2026-08-02T00:00:00.000Z",
          endsAt: "2026-08-03T00:00:00.000Z",
        },
        null,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes()).toHaveLength(0);
    const membership = pg.queries.find((q) => q.sql.includes('from "organization_members"'));
    expect(membership?.params).toEqual(expect.arrayContaining(["org-1", "user-of-another-org"]));
  });

  it("refuses a rotation with a participant outside the org", async () => {
    pg.queueRows([{ userId: "user-1" }]); // only one of the two is a member
    await expect(
      createOnCallSchedule(
        "org-1",
        {
          name: "Primary",
          timezone: "UTC",
          rotationDays: 7,
          handoffTime: "09:00",
          startDate: "2026-08-01",
          participantUserIds: ["user-1", "user-of-another-org"],
        },
        null,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes()).toHaveLength(0);
  });
});
