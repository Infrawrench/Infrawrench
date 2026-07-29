/**
 * Local deploy history — what `infrawrench deploy` did on this machine.
 *
 * A cloud deploy is recorded in the org (`POST /deployments/runs`) and read
 * back by the Deploy screen. A local one has nowhere to go: the CLI builds with
 * the Docker daemon here and, in `--local` mode, never talks to an org at all.
 * Without this file a local deploy leaves no trace anywhere, so the desktop app
 * had nothing to show and told you to go read your terminal scrollback.
 *
 * Deliberately a JSONL file rather than a row in the local SQLite database:
 * `db.ts` opens read-only whenever the GUI holds the single-instance lock (sql.js
 * rewrites the whole file on every write, so two processes must never both
 * persist). A run recorded from the terminal while the app is open would
 * silently vanish — which is exactly when someone would go look for it. An
 * append to a file of its own is safe from either process.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import type { LocalDeployRun } from "../src/lib/deploy-history-types";

export type { LocalDeployRun };

/**
 * Kept small on purpose: this is a local convenience log, not an audit trail —
 * the org's history is the durable one. Trimming on write means the file never
 * needs a separate maintenance path.
 */
const MAX_ENTRIES = 200;

function historyPath(): string {
  return path.join(app.getPath("userData"), "deploy-history.jsonl");
}

/**
 * Append a run. Best-effort by contract: a deploy that worked must not report
 * as failed because the note about it did not land.
 */
export function recordLocalDeploy(run: LocalDeployRun): void {
  try {
    const file = historyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(run)}\n`, "utf8");
    trim(file);
  } catch {
    // No history is better than a failed deploy command.
  }
}

/** Newest first, which is the order every caller wants. */
export function readLocalDeploys(limit = MAX_ENTRIES): LocalDeployRun[] {
  let raw: string;
  try {
    raw = fs.readFileSync(historyPath(), "utf8");
  } catch {
    return []; // nothing deployed locally yet
  }
  const runs: LocalDeployRun[] = [];
  // Parse per line so one truncated write (a machine that lost power mid-append)
  // costs that entry rather than the whole history.
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line) as LocalDeployRun);
    } catch {
      continue;
    }
  }
  return runs.reverse().slice(0, limit);
}

function trim(file: string): void {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  // Rewrite only once there is real slack, so a busy deploy loop is not
  // rewriting the file on every single run.
  if (lines.length <= MAX_ENTRIES * 2) return;
  fs.writeFileSync(file, `${lines.slice(-MAX_ENTRIES).join("\n")}\n`, "utf8");
}
