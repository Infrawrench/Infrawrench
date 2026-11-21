// Opt-in startup timing for the CLI. `INFRAWRENCH_CLI_TIMING=1 infrawrench …`
// prints, on stderr just before the process exits, when each startup phase
// finished and how long it took. Off by default; when off, `markPhase` is one
// boolean check, so the marks can stay in shared code (db.ts, main-utils.ts,
// cloud-tokens.ts) that the GUI runs too.
//
// Times are milliseconds since Node started in this process
// (`performance.timeOrigin`). What happens before that (dyld, the Electron
// framework, Chromium's own startup) is invisible from in here: set the
// variable to the launch time in epoch milliseconds instead of `1` (a
// benchmark wrapper can) and the report adds a "launch → node" line.
//
// No imports and no import-time side effects: `cloud-tokens.ts` and `db.ts`
// import this and must stay free of them (the CLI depends on that).

const setting = process.env.INFRAWRENCH_CLI_TIMING ?? "";
const enabled = setting !== "" && setting !== "0";

interface Mark {
  readonly name: string;
  readonly at: number;
}

const marks: Mark[] = [];
const seen = new Set<string>();

/** Whether `INFRAWRENCH_CLI_TIMING` asked for a report. */
export function timingEnabled(): boolean {
  return enabled;
}

/** Record that `name` finished now. A name already recorded is ignored. */
export function markPhase(name: string): void {
  if (!enabled || seen.has(name)) return;
  seen.add(name);
  marks.push({ name, at: performance.now() });
}

/** The report, one phase per line; empty when timing is off. */
export function formatTimingReport(): string {
  if (!enabled) return "";
  const lines = ["infrawrench startup timing (ms since node start)"];
  const launch = Number(setting);
  if (Number.isFinite(launch) && launch > 1e12) {
    lines.push(`  ${"launch → node".padEnd(28)} ${(performance.timeOrigin - launch).toFixed(1)}`);
  }
  let previous = 0;
  for (const { name, at } of marks) {
    lines.push(`  ${name.padEnd(28)} ${at.toFixed(1).padStart(8)}  +${(at - previous).toFixed(1)}`);
    previous = at;
  }
  return lines.join("\n");
}

/** Write the report to stderr when timing is on. */
export function reportTiming(): void {
  if (!enabled) return;
  try {
    process.stderr.write(`${formatTimingReport()}\n`);
  } catch {
    // stderr is gone (the terminal closed): nothing to report to.
  }
}
