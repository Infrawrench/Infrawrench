/**
 * The GitHub check run that shows a CI run on its commit and pull request.
 * Best-effort: an installation without `checks: write` still runs CI, it
 * just shows nothing on GitHub, so failures here are logged, not raised.
 */
import { eq } from "drizzle-orm";
import type { CiEvent } from "@infrawrench/client-core";

import { orgAppUrl } from "../app-url.js";
import { db } from "../db/client.js";
import { ciRuns } from "../db/schema.js";
import { githubInstallationFetch } from "../github/app.js";

/**
 * One check per event: a branch with an open pull request gets a push run
 * and a pull request run for the same commit, and GitHub shows only the
 * newest check of a name. With one name, a push run that matched no
 * pipeline (`on.push` limited to main) finished first and hid the pull
 * request's run, showing "0 job(s) passed" while it was still running.
 */
export function checkName(event: CiEvent): string {
  return `Infrawrench CI / ${eventLabel(event)}`;
}

/** How a check names its event: a scheduled run never stands in for a push's required check. */
export function eventLabel(event: CiEvent): string {
  return event === "pull-request" ? "pull request" : event;
}

type Conclusion = "success" | "failure" | "cancelled" | "action_required" | "neutral" | "skipped";

export interface CheckUpdate {
  status: "queued" | "in_progress" | "completed";
  conclusion?: Conclusion;
  title: string;
  summary: string;
  text?: string;
}

interface CheckTarget {
  id: string;
  event: CiEvent;
  organizationId: string;
  installationId: number;
  repoFullName: string;
  sha: string;
  checkRunId: number | null;
}

/**
 * The most a check's summary or text may take, in UTF-8 bytes. GitHub's
 * limit is 65,535; it refuses more with a 422 and the check keeps whatever
 * it said last. A margin for what the JSON encoding adds.
 */
export const CHECK_TEXT_BYTES = 60_000;

/**
 * `text` cut to fit a check, at the end of a line, with a note of how many
 * lines were left out. A summary is a table, so a cut never splits a row.
 */
export function fitCheckText(text: string, maxBytes = CHECK_TEXT_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const lines = text.split("\n");
  // Room for the note, whatever the count.
  let budget = maxBytes - 200;
  let kept = 0;
  for (const line of lines) {
    const size = encoder.encode(line).length + 1;
    if (size > budget) break;
    budget -= size;
    kept++;
  }
  const left = lines.length - kept;
  return `${lines.slice(0, kept).join("\n")}\n\n_…and ${left} more line(s), cut to fit GitHub's limit: the whole run is on Infrawrench._`;
}

/** GitHub's reason for refusing a request, for the log. */
export async function githubError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`GitHub answered ${res.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
}

/** Creates the run's check, or updates the one it has. */
export async function upsertCheck(run: CheckTarget, update: CheckUpdate): Promise<void> {
  const detailsUrl = orgAppUrl(run.organizationId, `ci/${run.id}`);
  const body: Record<string, unknown> = {
    status: update.status,
    output: {
      title: update.title.slice(0, 255),
      summary: fitCheckText(update.summary),
      ...(update.text ? { text: fitCheckText(update.text) } : {}),
    },
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    ...(update.status === "in_progress" ? { started_at: new Date().toISOString() } : {}),
    ...(update.status === "completed"
      ? { conclusion: update.conclusion ?? "neutral", completed_at: new Date().toISOString() }
      : {}),
  };
  const repo = run.repoFullName.split("/").map(encodeURIComponent).join("/");
  try {
    if (run.checkRunId === null) {
      const res = await githubInstallationFetch(run.installationId, `/repos/${repo}/check-runs`, {
        method: "POST",
        body: JSON.stringify({
          name: checkName(run.event),
          head_sha: run.sha,
          external_id: run.id,
          ...body,
        }),
      });
      if (!res.ok) throw await githubError(res);
      const created = (await res.json()) as { id?: number };
      if (typeof created.id === "number") {
        await db.update(ciRuns).set({ checkRunId: created.id }).where(eq(ciRuns.id, run.id));
        run.checkRunId = created.id;
      }
    } else {
      const res = await githubInstallationFetch(
        run.installationId,
        `/repos/${repo}/check-runs/${run.checkRunId}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      if (!res.ok) throw await githubError(res);
    }
  } catch (err) {
    console.warn(`[ci] could not update the GitHub check for run ${run.id}:`, err);
  }
}
