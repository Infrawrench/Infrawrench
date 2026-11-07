import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkPlugins, EXIT_USAGE, exitCodeFor, type CheckReport } from "./check.js";
import { discoverPlugins, loadConfig } from "./config.js";
import { failureOf } from "./errors.js";
import { createFetcher } from "./fetching.js";
import { generatePlugin } from "./generate.js";
import { writeGenerated } from "./output.js";
import { mapLimit } from "./pool.js";
import { oneLine } from "./text.js";
import { createGitPort } from "./watch/git.js";
import { gitHubCli } from "./watch/github.js";
import { renderSummary, runWatch, type WatchEntry } from "./watch/index.js";
import { createTypecheck } from "./watch/typecheck.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CONCURRENCY = 4;

const USAGE = `Usage: plugingen <command>

  generate <plugin>... | --all     Regenerate src/api-types*.gen.ts from each plugin's plugingen.json.
  check [<plugin>...] [--json]     Regenerate in memory and compare with what is committed. No writes.
                                   Exit 0: up to date. 1: the vendor changed the types. 2: could not check.
  watch [--apply]                  Decide what to do about each plugin and print it. With --apply, do it:
                                   open or update pull requests and issues on GitHub.

Options: --all, --json, --concurrency <n> (default ${DEFAULT_CONCURRENCY}), --apply
`;

function printCheck(report: CheckReport): void {
  switch (report.status) {
    case "up-to-date":
      console.log(`${report.plugin}: up to date`);
      break;
    case "changed":
      console.log(`${report.plugin}: changed: ${report.reason}`);
      for (const operation of report.operations ?? []) console.log(`  ${operation}`);
      break;
    case "could-not-check":
      console.log(
        `${report.plugin}: could not check${report.transient ? " (transient)" : ""}: ${report.reason}`,
      );
      break;
  }
}

async function runGenerate(plugins: readonly string[], concurrency: number): Promise<number> {
  const fetchText = createFetcher();
  const failed = await mapLimit(plugins, concurrency, async (plugin) => {
    try {
      // Everything is generated before anything is written, so one plugin's documents
      // never end up half from today and half from an earlier run.
      const files = await generatePlugin(loadConfig(ROOT, plugin), fetchText, { silent: false });
      for (const file of files) {
        writeGenerated(ROOT, plugin, file.fileName, file.text);
        console.log(
          `${plugin}/${file.fileName}: ${file.operations} operations, ${Buffer.byteLength(file.text)} bytes`,
        );
      }
      return false;
    } catch (error) {
      console.error(`${plugin}: ${failureOf(error).message}`);
      return true;
    }
  });
  return failed.some(Boolean) ? 1 : 0;
}

/**
 * Vendor text reaches the log through error messages, and an Actions runner executes
 * `::command::` lines it finds there. This turns all of that off until the token, which
 * a document cannot know, is printed again.
 */
async function withoutWorkflowCommands<T>(body: () => Promise<T>): Promise<T> {
  if (!process.env["GITHUB_ACTIONS"]) return body();
  const token = randomUUID();
  console.log(`::stop-commands::${token}`);
  try {
    return await body();
  } finally {
    console.log(`::${token}::`);
  }
}

async function runCheck(
  plugins: readonly string[],
  concurrency: number,
  json: boolean,
): Promise<number> {
  const outcomes = await withoutWorkflowCommands(() =>
    checkPlugins(ROOT, plugins, createFetcher(), concurrency),
  );
  const reports = outcomes.map((outcome) => outcome.report);
  if (json) console.log(JSON.stringify(reports, null, 2));
  else for (const report of reports) printCheck(report);
  return exitCodeFor(reports);
}

function annotate(level: "warning" | "error", message: string): void {
  if (!process.env["GITHUB_ACTIONS"]) return;
  const escaped = oneLine(message, 1000).replaceAll("%", "%25");
  console.log(`::${level}::${escaped}`);
}

function printEntry(entry: WatchEntry): void {
  const lines = [
    ...entry.actions,
    ...(entry.warning ? [`warning, no action taken: ${entry.warning}`] : []),
    ...(entry.error ? [`error: ${entry.error}`] : []),
  ];
  console.log(`${entry.plugin}: ${entry.status}`);
  for (const line of lines.length > 0 ? lines : ["nothing to do"]) console.log(`  ${line}`);
}

async function runWatchCommand(apply: boolean, concurrency: number): Promise<number> {
  const entries = await withoutWorkflowCommands(async () => {
    console.log(apply ? "plugingen watch" : "plugingen watch: dry run, nothing will be changed");
    const outcomes = await checkPlugins(ROOT, discoverPlugins(ROOT), createFetcher(), concurrency);
    return runWatch(
      outcomes,
      { github: gitHubCli, git: createGitPort(ROOT), typecheck: createTypecheck(ROOT) },
      { apply },
    );
  });
  for (const entry of entries) {
    printEntry(entry);
    if (entry.warning) annotate("warning", `${entry.plugin}: ${entry.warning}`);
    if (entry.error) annotate("error", `${entry.plugin}: ${entry.error}`);
  }
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) fs.appendFileSync(summaryPath, renderSummary(entries, apply));
  // A vendor being down is not this job failing; not being able to act is.
  return entries.some((entry) => entry.error) ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        all: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        concurrency: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  const [command, ...names] = positionals;
  if (values.help || command === "help") {
    console.log(USAGE);
    return 0;
  }
  const concurrency = Number(values.concurrency ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`--concurrency must be a positive integer\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const plugins = values.all ? discoverPlugins(ROOT) : names;

  try {
    switch (command) {
      case "generate":
        if (plugins.length === 0) {
          console.error(USAGE);
          return EXIT_USAGE;
        }
        return await runGenerate(plugins, concurrency);
      case "check":
        return await runCheck(
          plugins.length > 0 ? plugins : discoverPlugins(ROOT),
          concurrency,
          values.json,
        );
      case "watch":
        return await runWatchCommand(values.apply, concurrency);
      default:
        console.error(USAGE);
        return EXIT_USAGE;
    }
  } catch (error) {
    console.error(oneLine(failureOf(error).message, 2000));
    annotate("error", failureOf(error).message);
    return 1;
  }
}
