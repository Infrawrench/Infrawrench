// Fails when a Vitest run skipped a test it was not told it may skip.
//
//   node no-skips.mjs <report.json>... [--allow <file>]...
//
// The forge's suites (git/packages/*) drive real programs: `git`, `ssh`,
// `ssh-keygen`, `unzip`, `terraform`, workerd, a Postgres. So that a
// contributor without one of them can still run the rest, each suite skips
// itself when its program is missing. In CI that kindness is a hole: a
// machine that lost `ssh` would report every SSH test as skipped and the job
// as passed. This reads the run's JSON report (`--reporter=json
// --outputFile=...`) and fails on any skipped or todo test, so a missing
// program fails the job that was supposed to prove something with it.
//
// `--allow <file>` names a test file, relative to the directory the report
// was written from, whose skips are deliberate there: the suites that need
// this repository's whole history (a CI checkout is one commit) and the
// benchmarks that only run when asked for. The list is in the pipeline, next
// to the job, so adding to it is a visible decision.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const reports = [];
const allowed = new Set();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--allow") allowed.add(args[++i]);
  else reports.push(args[i]);
}
if (reports.length === 0) {
  console.error("usage: no-skips.mjs <report.json>... [--allow <file>]...");
  process.exit(2);
}

const SKIPPED = new Set(["skipped", "pending", "todo", "disabled"]);
const problems = [];
const used = new Set();
let ran = 0;

for (const path of reports) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  // Vitest's JSON reporter writes absolute file names; the report sits in the
  // package's directory (or is read from it), which is what `--allow` is relative to.
  const base = resolve(process.cwd());
  for (const file of report.testResults ?? []) {
    const name = relative(base, file.name);
    const skipped = (file.assertionResults ?? []).filter((t) => SKIPPED.has(t.status));
    ran += (file.assertionResults ?? []).length - skipped.length;
    if (skipped.length === 0) continue;
    if (allowed.has(name)) {
      used.add(name);
      continue;
    }
    problems.push(
      `${name}: ${skipped.length} skipped, such as "${skipped[0].fullName ?? skipped[0].title}"`,
    );
  }
}

// An allowance nothing needed is a suite that now runs here, or a file that
// moved: either way the list is wrong, and a wrong list is how a skip hides.
for (const name of allowed) {
  if (!used.has(name)) problems.push(`${name}: allowed to skip, but skipped nothing`);
}

if (ran === 0) problems.push("no test ran at all");

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) with skipped tests`);
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    "\nA suite skips itself when the program it drives is missing (git, ssh, ssh-keygen, unzip, terraform) or its opt-in variable is unset. In CI every one of them must run: install the program in the job, or, for a suite that cannot run on a CI checkout, name its file with --allow in the pipeline.",
  );
  process.exit(1);
}
console.log(
  `no skipped tests (${ran} ran${allowed.size > 0 ? `, ${allowed.size} file(s) allowed to skip` : ""})`,
);
