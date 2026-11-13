import { describe, expect, it, vi } from "vitest";

// `schedules.ts` imports the database client and the GitHub App at load; the
// helpers tested here touch neither.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { CATCH_UP_MINUTES, dueRuns, minutesToFire, scheduleEntries } = await import("../schedules");

const at = (iso: string) => Date.parse(`${iso}:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);

describe("minutesToFire", () => {
  it("fires only the current minute the first time", () => {
    expect(minutesToFire(null, at("2026-11-12T03:00")).map(iso)).toEqual(["2026-11-12T03:00"]);
  });

  it("fires every minute since the last pass, and nothing twice", () => {
    expect(
      minutesToFire(new Date(at("2026-11-12T02:58")), at("2026-11-12T03:00")).map(iso),
    ).toEqual(["2026-11-12T02:59", "2026-11-12T03:00"]);
    expect(minutesToFire(new Date(at("2026-11-12T03:00")), at("2026-11-12T03:00"))).toEqual([]);
  });

  it("catches up a few minutes after an outage, not hours", () => {
    const minutes = minutesToFire(new Date(at("2026-11-12T01:00")), at("2026-11-12T03:00"));
    expect(minutes).toHaveLength(CATCH_UP_MINUTES);
    expect(iso(minutes[minutes.length - 1] ?? 0)).toBe("2026-11-12T03:00");
  });
});

describe("dueRuns", () => {
  const nightly = { file: "nightly.yml", name: "Nightly", cron: ["0 3 * * *"], text: "n" };
  const quarter = { file: "q.yml", name: "Q", cron: ["*/15 * * * *"], text: "q" };

  it("starts each pipeline on the minutes its crons fall on", () => {
    const due = dueRuns(
      [nightly, quarter],
      [at("2026-11-12T02:59"), at("2026-11-12T03:00"), at("2026-11-12T03:01")],
    );
    expect(due.map((d) => `${d.pipeline.file}@${iso(d.minute)}`)).toEqual([
      "nightly.yml@2026-11-12T03:00",
      "q.yml@2026-11-12T03:00",
    ]);
  });

  it("never fires an expression it cannot read", () => {
    expect(dueRuns([{ ...nightly, cron: ["every night"] }], [at("2026-11-12T03:00")])).toEqual([]);
  });
});

describe("scheduleEntries", () => {
  it("keeps well-formed pipelines and drops the rest", () => {
    expect(
      scheduleEntries([
        { file: "a.yml", name: "A", cron: ["0 3 * * *", 7], text: "name: A", concurrency: null },
        { file: "b.yml", cron: ["@daily"], text: "name: B" },
        { file: "c.yml", name: "C", cron: [], text: "name: C" },
        { file: "d.yml", name: "D", cron: "0 3 * * *", text: "name: D" },
        { name: "E", cron: ["0 3 * * *"], text: "name: E" },
        null,
      ]),
    ).toEqual([
      { file: "a.yml", name: "A", cron: ["0 3 * * *"], text: "name: A" },
      { file: "b.yml", name: "b.yml", cron: ["@daily"], text: "name: B" },
    ]);
    expect(scheduleEntries(undefined)).toEqual([]);
  });
});
