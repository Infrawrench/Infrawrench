import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { doraWindow, parseDoraScope, type DoraWindowInput } from "../cli/commands/dora";

const NOW = Date.parse("2026-10-12T12:00:00Z");

const none: DoraWindowInput = {
  from: Option.none(),
  to: Option.none(),
  days: Option.none(),
  last: Option.none(),
};

const window = (over: Partial<DoraWindowInput>) =>
  Effect.runSync(Effect.result(doraWindow({ ...none, ...over }, NOW)));

const scope = (text: string | undefined) => Effect.runSync(Effect.result(parseDoraScope(text)));

describe("dora CLI flags", () => {
  it("defaults to the 30 days ending now", () => {
    expect(Effect.runSync(doraWindow(none, NOW))).toEqual({
      from: "2026-09-12T12:00:00.000Z",
      to: "2026-10-12T12:00:00.000Z",
    });
  });

  it("sizes the window from --last (in days) and honours --from/--to", () => {
    const fromLast = Effect.runSync(doraWindow({ ...none, last: Option.some(14) }, NOW));
    expect(fromLast.from).toBe("2026-09-28T12:00:00.000Z");
    expect(
      Effect.runSync(
        doraWindow(
          { ...none, from: Option.some("2026-10-01"), to: Option.some("2026-10-08") },
          NOW,
        ),
      ),
    ).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" });
    const backwards = window({ from: Option.some("2026-10-08"), to: Option.some("2026-10-01") });
    expect(backwards._tag === "Failure" && backwards.failure.message).toMatch(/before/);
    const tooLong = window({ days: Option.some(400) });
    expect(tooLong._tag === "Failure" && tooLong.failure.message).toBe(
      "The range is at most 366 days",
    );
    const bad = window({ to: Option.some("soon") });
    expect(bad._tag === "Failure" && bad.failure.message).toBe(
      'Invalid --to "soon": use YYYY-MM-DD or an ISO timestamp',
    );
  });

  it("parses --scope into a dimension and value", () => {
    expect(Effect.runSync(parseDoraScope(undefined))).toEqual({});
    expect(Effect.runSync(parseDoraScope("environment=production"))).toEqual({
      dimension: "environment",
      value: "production",
    });
    expect(Effect.runSync(parseDoraScope("owner=user:abc"))).toEqual({
      dimension: "owner",
      value: "user:abc",
    });
    expect(Effect.runSync(parseDoraScope("owner"))).toEqual({ dimension: "owner", value: null });
    const bad = scope("=x");
    expect(bad._tag === "Failure" && bad.failure.message).toBe(
      'Invalid --scope "=x": use <dimension>=<value>',
    );
  });
});
