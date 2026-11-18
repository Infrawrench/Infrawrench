import { describe, expect, it } from "vitest";
import {
  EMPTY_GAME_DAY_SIGNALS,
  computeGameDayReport,
  earliestIso,
  formatGameDayDuration,
  gameDayAbortable,
  gameDayEditable,
  mergeGameDaySignals,
  type GameDay,
} from "../game-days";

const T0 = "2026-11-18T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function day(over: Partial<GameDay> = {}): GameDay {
  return {
    id: "g1",
    name: "Checkout without its cache",
    description: null,
    serviceId: null,
    serviceName: null,
    status: "completed",
    endReason: "time_limit",
    startsAt: T0,
    durationMinutes: 15,
    recoveryTimeoutMinutes: 30,
    freezeDuringRun: false,
    freezeId: null,
    watchedProbes: [{ id: "p1", name: "checkout", status: "up" }],
    watchedSloIds: [],
    armedAt: at(-60),
    armedByUserId: "u1",
    armedByEmail: "a@example.com",
    injectedAt: T0,
    endsAt: at(15),
    endRequestedAt: null,
    undoneAt: at(15),
    recoveredAt: at(17),
    completedAt: at(17),
    lastError: null,
    signals: { ...EMPTY_GAME_DAY_SIGNALS },
    targets: [],
    createdAt: at(-120),
    updatedAt: at(17),
    ...over,
  };
}

describe("computeGameDayReport", () => {
  it("measures detect, page, acknowledge and recover", () => {
    const report = computeGameDayReport(
      day({
        signals: {
          ...EMPTY_GAME_DAY_SIGNALS,
          probeFailedAt: at(1),
          probeDownAt: at(3),
          alertedAt: at(3),
          pagedAt: at(4),
          acknowledgedAt: at(9),
        },
      }),
    );
    expect(report.state).toBe("final");
    expect(report.timeToDetectMs).toBe(60_000);
    expect(report.detectedBy).toBe("probe_failure");
    expect(report.timeToPageMs).toBe(4 * 60_000);
    expect(report.timeToAcknowledgeMs).toBe(5 * 60_000);
    expect(report.timeToRecoverMs).toBe(2 * 60_000);
    expect(report.injectedForMs).toBe(15 * 60_000);
  });

  it("says nothing detected rather than zero", () => {
    const report = computeGameDayReport(day());
    expect(report.timeToDetectMs).toBeNull();
    expect(report.detectedBy).toBeNull();
    expect(report.detectors.every((row) => row.at === null)).toBe(true);
  });

  it("does not count an acknowledgement as detection", () => {
    const report = computeGameDayReport(
      day({ signals: { ...EMPTY_GAME_DAY_SIGNALS, acknowledgedAt: at(2), metricAlertAt: at(6) } }),
    );
    expect(report.detectedBy).toBe("metric_alert");
    expect(report.timeToDetectMs).toBe(6 * 60_000);
  });

  it("marks detectors nothing could fire as unmeasurable", () => {
    const report = computeGameDayReport(day({ watchedProbes: [] }));
    const byName = new Map(report.detectors.map((row) => [row.detector, row.measurable]));
    expect(byName.get("probe_failure")).toBe(false);
    expect(byName.get("slo_burn")).toBe(false);
    expect(byName.get("metric_alert")).toBe(true);
  });

  it("is not run for planned and cancelled game days, and in progress while running", () => {
    expect(computeGameDayReport(day({ status: "planned", injectedAt: null })).state).toBe(
      "not_run",
    );
    expect(computeGameDayReport(day({ status: "cancelled", injectedAt: null })).state).toBe(
      "not_run",
    );
    const running = computeGameDayReport(
      day({ status: "running", undoneAt: null, recoveredAt: null }),
      Date.parse(at(5)),
    );
    expect(running.state).toBe("in_progress");
    expect(running.injectedForMs).toBe(5 * 60_000);
  });
});

describe("signals", () => {
  it("keeps the earliest instant and never moves a recorded one later", () => {
    expect(earliestIso(at(3), at(1))).toBe(at(1));
    expect(earliestIso(null, at(1))).toBe(at(1));
    expect(earliestIso(at(2), null)).toBe(at(2));
    const stored = { ...EMPTY_GAME_DAY_SIGNALS, probeFailedAt: at(2) };
    const merged = mergeGameDaySignals(stored, { probeFailedAt: at(5), pagedAt: at(6) });
    expect(merged.probeFailedAt).toBe(at(2));
    expect(merged.pagedAt).toBe(at(6));
  });
});

describe("status helpers", () => {
  it("only edits planned game days and aborts any that may be live", () => {
    expect(gameDayEditable("planned")).toBe(true);
    expect(gameDayEditable("armed")).toBe(false);
    expect(gameDayAbortable("armed")).toBe(true);
    expect(gameDayAbortable("running")).toBe(true);
    expect(gameDayAbortable("undo_failed")).toBe(true);
    expect(gameDayAbortable("completed")).toBe(false);
  });

  it("formats durations", () => {
    expect(formatGameDayDuration(null)).toBe("-");
    expect(formatGameDayDuration(45_000)).toBe("45 s");
    expect(formatGameDayDuration(200_000)).toBe("3 min 20 s");
    expect(formatGameDayDuration(64 * 60_000)).toBe("1 h 4 min");
  });
});
