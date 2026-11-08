import type { SleepScheduleListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, formatMoney, type Column } from "../output";
import { printRemediation, Remediation } from "../remediation";

const PATH = "/schedules";

const Schedules = wire<SleepScheduleListResponse>()(
  Schema.Struct({
    schedules: Schema.Array(
      Schema.Struct({
        resourceName: Schema.String,
        accountName: Schema.String,
        daysOfWeek: Schema.Array(Schema.Finite),
        stopTime: Schema.String,
        startTime: Schema.String,
        timezone: Schema.String,
        paused: Schema.Boolean,
        nextTransitionAt: Schema.NullOr(Schema.String),
        nextTransitionAction: Schema.NullOr(Schema.String),
        lastRunAction: Schema.NullOr(Schema.String),
        lastRunStatus: Schema.NullOr(Schema.String),
        lastRunError: Schema.NullOr(Schema.String),
        projectedMonthlySaving: Schema.NullOr(Schema.Finite),
        currency: Schema.NullOr(Schema.String),
        remediation: Schema.optional(Remediation),
      }),
    ),
  }),
);
type Schedule = (typeof Schedules.Type)["schedules"][number];

function windowSummary(s: Schedule): string {
  const days = formatDays(s.daysOfWeek);
  return `${days} off ${s.stopTime} → on ${s.startTime}`;
}

/**
 * Local copy of client-core's `formatDaysOfWeek`: `cli/format.ts`-adjacent
 * modules stay import-light so the CJS CLI entry doesn't drag ESM resolution
 * quirks in (see the dynamic-import note in KNOWLEDGE's CLI section), but a
 * type-only client-core import is fine, which is why the wire types above are
 * `with { "resolution-mode": "import" }`.
 */
function formatDays(daysOfWeek: ReadonlyArray<number>): string {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = [...new Set(daysOfWeek)].filter((d) => d >= 1 && d <= 7);
  days.sort((a, b) => a - b);
  if (days.length === 0) return "no days";
  if (days.length === 7) return "every day";
  const contiguous = days.length >= 2 && days[days.length - 1]! - days[0]! === days.length - 1;
  if (contiguous) return `${labels[days[0]! - 1]}–${labels[days[days.length - 1]! - 1]}`;
  return days.map((d) => labels[d - 1]).join(",");
}

function nextSummary(s: Schedule): string {
  if (s.paused) return c.dim("paused");
  if (!s.nextTransitionAt) return c.dim("—");
  const when = new Date(s.nextTransitionAt).toISOString().replace("T", " ").slice(0, 16);
  return `${s.nextTransitionAction === "stop" ? "off" : "on"} ${when}Z`;
}

function lastSummary(s: Schedule): string {
  if (!s.lastRunStatus) return c.dim("never ran");
  if (s.lastRunStatus === "ok") return c.green(`${s.lastRunAction} ok`);
  if (s.lastRunStatus === "skipped_freeze") return c.yellow("skipped (freeze)");
  return c.red(`failed${s.lastRunError ? `: ${s.lastRunError}` : ""}`);
}

/**
 * `infrawrench schedules`: every sleep/wake schedule in the org with its
 * window, next transition, last outcome and projected monthly saving.
 */
export const schedules = Command.make(
  "schedules",
  {},
  Effect.fn("schedules")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
    }
    const response = yield* decodeBody(Schedules, PATH)(body);

    if (response.schedules.length === 0) {
      return yield* Print.line(
        c.dim(
          "No sleep schedules. Create one from a stoppable resource's Schedule tab (web or desktop) to power non-prod resources off outside working hours.",
        ),
      );
    }

    const savingByCurrency = new Map<string, number>();
    for (const s of response.schedules) {
      if (!s.paused && s.projectedMonthlySaving != null && s.currency) {
        savingByCurrency.set(
          s.currency,
          (savingByCurrency.get(s.currency) ?? 0) + s.projectedMonthlySaving,
        );
      }
    }
    const savingsNote =
      savingByCurrency.size > 0
        ? "  " +
          c.dim(
            `· projected saving ${[...savingByCurrency.entries()]
              .map(([currency, amount]) => `${formatMoney(amount, currency)}/mo`)
              .join(" + ")}`,
          )
        : "";
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(`· ${response.schedules.length} schedule${response.schedules.length === 1 ? "" : "s"}`)}${savingsNote}`,
    );
    yield* Print.line();

    const columns: Column<Schedule>[] = [
      { header: "resource", value: (s) => s.resourceName },
      { header: "account", value: (s) => c.dim(s.accountName) },
      { header: "window", value: (s) => windowSummary(s) },
      { header: "tz", value: (s) => c.dim(s.timezone) },
      { header: "next", value: (s) => nextSummary(s) },
      { header: "last run", value: (s) => lastSummary(s) },
      {
        header: "saves",
        value: (s) =>
          s.projectedMonthlySaving != null && s.currency
            ? `${formatMoney(s.projectedMonthlySaving, s.currency)}/mo`
            : c.dim("—"),
        align: "right",
      },
    ];
    yield* Print.table(response.schedules, columns);
    // Manual stop/start for each scheduled resource: for pausing a schedule and
    // doing it by hand, or reproducing the window from your own cron.
    yield* Effect.sync(() =>
      printRemediation(response.schedules.map((s) => ({ ...s, displayName: s.resourceName }))),
    );
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Savings are projected from trailing per-resource billing and the weekly off-hours fraction; transitions are skipped during change freezes.",
      ),
    );
  }),
).pipe(
  Command.withDescription("Sleep/wake schedules: windows, next transitions and projected savings"),
);
