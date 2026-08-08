/**
 * Shared `routeAlert` result fixtures.
 *
 * Every detector that raises an alert now goes through the one `routeAlert`
 * seam, so every one of their test files needs the same two results: a delivery
 * that reached somebody and one that reached nobody. Kept here rather than
 * copied per file so a change to `AlertRouteResult` is one edit instead of
 * four, and so the four files cannot quietly drift into disagreeing about what
 * a successful delivery looks like.
 *
 * The `vi.mock("../alerts/route")` call itself stays in each test file —
 * Vitest hoists it per module, so it cannot be shared from here.
 */

/** A delivery that reached one Slack channel and one phone. */
export function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // Empty by default: `routeAlert` only fills this when `track: true`. Most
    // detectors call without tracking, so the default fixture matches that
    // shape. Tests that exercise the tracked path pass messages via `over`.
    slackMessages: [],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
export function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

/**
 * The real `alertReached` predicate, for the `vi.mock` factory.
 *
 * Deliberately not a stub: it decides whether a detector keeps its cooldown or
 * rolls its claim back, and a faked one would hide exactly the bug it exists to
 * prevent — a held alert counting as a total failure.
 */
export function alertReachedImpl(
  r: { succeeded?: number; held?: number } | null | undefined,
): boolean {
  return (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0;
}
