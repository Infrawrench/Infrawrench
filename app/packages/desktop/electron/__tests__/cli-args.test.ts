import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Option } from "effect";

// `cli/args` reaches `cli/context` for CliError, which pulls the Electron app
// object and the plugin host at import time. None of it runs here.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseLastDays } from "../cli/args";
import { resolveDayWindow } from "../cli/effect/range-flags";
import { type FeedbackFlags, feedbackRequest, isIsoDay } from "../cli/commands/anomaly-feedback";

describe("parseLastDays", () => {
  it("converts days, weeks and months", () => {
    expect(parseLastDays("7d")).toBe(7);
    expect(parseLastDays("2w")).toBe(14);
    expect(parseLastDays("3m")).toBe(90);
  });

  it("rejects an hour span — these commands are day-granular", () => {
    expect(() => parseLastDays("6h")).toThrow(/Invalid --last/);
  });
});

describe("resolveDayWindow", () => {
  const window = (days: number | undefined, last: number | undefined) =>
    Effect.runSyncExit(
      resolveDayWindow(
        { days: Option.fromUndefinedOr(days), last: Option.fromUndefinedOr(last) },
        30,
        90,
      ),
    );

  it("falls back to the caller's default", () => {
    expect(window(undefined, undefined)).toEqual(Exit.succeed(30));
  });

  it("prefers an explicit --days over --last", () => {
    expect(window(7, 30)).toEqual(Exit.succeed(7));
  });

  it("converts --last", () => {
    expect(window(undefined, 14)).toEqual(Exit.succeed(14));
  });

  it("refuses a window the endpoint would reject, before the round trip", () => {
    const refused = window(120, undefined);
    expect(Exit.isFailure(refused) && String(refused.cause)).toMatch(/at most 90 days/);
  });
});

describe("costs --anomalies feedback flags", () => {
  const flags = (over: Partial<FeedbackFlags>): FeedbackFlags => ({
    expected: false,
    unexpected: false,
    clear: false,
    reason: Option.none(),
    note: Option.none(),
    recurrence: Option.none(),
    expires: Option.none(),
    explain: false,
    ...over,
  });
  const build = (over: Partial<FeedbackFlags>) => Effect.runSyncExit(feedbackRequest(flags(over)));

  it("builds a full expected verdict with a suppression", () => {
    expect(
      build({
        expected: true,
        reason: Option.some("planned_launch"),
        note: Option.some("  launch week  "),
        explain: true,
        recurrence: Option.some("weekly"),
        expires: Option.some("2026-12-31"),
      }),
    ).toEqual(
      Exit.succeed({
        clear: false,
        input: {
          verdict: "expected",
          reason: "planned_launch",
          note: "launch week",
          explain: true,
          suppress: { recurrence: "weekly", expiresOn: "2026-12-31" },
        },
      }),
    );
  });

  it("builds a bare unexpected verdict and a clear", () => {
    expect(build({ unexpected: true })).toEqual(
      Exit.succeed({ clear: false, input: { verdict: "unexpected" } }),
    );
    expect(build({ clear: true })).toEqual(Exit.succeed({ clear: true }));
  });

  it.each([
    [{}, /--expected .* or --unexpected/],
    [{ expected: true, unexpected: true }, /mutually exclusive/],
    [{ clear: true, expected: true }, /--clear withdraws/],
    [{ expected: true, reason: Option.some("vibes") }, /--reason must be one of/],
    [{ unexpected: true, recurrence: Option.some("weekly") }, /only makes sense for an --expected/],
    [{ expected: true, recurrence: Option.some("daily") }, /--recurrence must be one of/],
    [{ expected: true, expires: Option.some("2026-12-31") }, /add --recurrence/],
    [
      { expected: true, recurrence: Option.some("one_off"), expires: Option.some("2026-02-30") },
      /YYYY-MM-DD/,
    ],
    [{ expected: true, explain: true }, /add --note/],
    [{ expected: true, note: Option.some("x".repeat(501)) }, /at most 500/],
  ])("rejects %j with exit code 2", (over: Partial<FeedbackFlags>, message) => {
    const error = Effect.runSync(Effect.flip(feedbackRequest(flags(over))));
    expect(error.message).toMatch(message);
    expect(error.exitCode).toBe(2);
  });

  it("validates real calendar days", () => {
    expect(isIsoDay("2024-02-29")).toBe(true);
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("2026-1-01")).toBe(false);
  });
});
