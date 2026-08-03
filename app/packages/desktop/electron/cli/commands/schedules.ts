import { orgFetch, resolveOrg, type CliContext } from "../context";
import type { SleepSchedule, SleepScheduleListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, formatMoney, printJson, println, printTable, type Column } from "../output";

function windowSummary(s: SleepSchedule): string {
  const days = formatDays(s.daysOfWeek);
  return `${days} off ${s.stopTime} → on ${s.startTime}`;
}

/**
 * Local copy of client-core's `formatDaysOfWeek`: `cli/format.ts`-adjacent
 * modules stay import-light so the CJS CLI entry doesn't drag ESM resolution
 * quirks in (see the dynamic-import note in KNOWLEDGE's CLI section) — but a
 * type-only client-core import is fine, which is why the wire types above are
 * `with { "resolution-mode": "import" }`.
 */
function formatDays(daysOfWeek: number[]): string {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = [...new Set(daysOfWeek)].filter((d) => d >= 1 && d <= 7);
  days.sort((a, b) => a - b);
  if (days.length === 0) return "no days";
  if (days.length === 7) return "every day";
  const contiguous = days.length >= 2 && days[days.length - 1]! - days[0]! === days.length - 1;
  if (contiguous) return `${labels[days[0]! - 1]}–${labels[days[days.length - 1]! - 1]}`;
  return days.map((d) => labels[d - 1]).join(",");
}

function nextSummary(s: SleepSchedule): string {
  if (s.paused) return c.dim("paused");
  if (!s.nextTransitionAt) return c.dim("—");
  const when = new Date(s.nextTransitionAt).toISOString().replace("T", " ").slice(0, 16);
  return `${s.nextTransitionAction === "stop" ? "off" : "on"} ${when}Z`;
}

function lastSummary(s: SleepSchedule): string {
  if (!s.lastRunStatus) return c.dim("never ran");
  if (s.lastRunStatus === "ok") return c.green(`${s.lastRunAction} ok`);
  if (s.lastRunStatus === "skipped_freeze") return c.yellow("skipped (freeze)");
  return c.red(`failed${s.lastRunError ? `: ${s.lastRunError}` : ""}`);
}

/**
 * `infrawrench schedules` — every sleep/wake schedule in the org with its
 * window, next transition, last outcome and projected monthly saving.
 */
export async function cmdSchedules(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const response = await orgFetch<SleepScheduleListResponse>(org.id, "/schedules");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  if (response.schedules.length === 0) {
    println(
      c.dim(
        "No sleep schedules. Create one from a stoppable resource's Schedule tab (web or desktop) to power non-prod resources off outside working hours.",
      ),
    );
    return;
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
  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${response.schedules.length} schedule${response.schedules.length === 1 ? "" : "s"}`)}${savingsNote}`,
  );
  println();

  const columns: Column<SleepSchedule>[] = [
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
  printTable(response.schedules, columns);
  println();
  println(
    c.dim(
      "Savings are projected from trailing per-resource billing and the weekly off-hours fraction; transitions are skipped during change freezes.",
    ),
  );
}
