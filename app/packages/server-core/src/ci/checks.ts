/**
 * The GitHub check run that shows a CI run on its commit and pull request.
 * Best-effort: an installation without `checks: write` still runs CI, it
 * just shows nothing on GitHub, so failures here are logged, not raised.
 */
import { eq } from "drizzle-orm";

import { orgAppUrl } from "../app-url.js";
import { db } from "../db/client.js";
import { ciRuns } from "../db/schema.js";
import { githubInstallationFetch } from "../github/app.js";

export const CHECK_NAME = "Infrawrench CI";

type Conclusion = "success" | "failure" | "cancelled" | "action_required" | "neutral";

export interface CheckUpdate {
  status: "queued" | "in_progress" | "completed";
  conclusion?: Conclusion;
  title: string;
  summary: string;
  text?: string;
}

interface CheckTarget {
  id: string;
  organizationId: string;
  installationId: number;
  repoFullName: string;
  sha: string;
  checkRunId: number | null;
}

/** Creates the run's check, or updates the one it has. */
export async function upsertCheck(run: CheckTarget, update: CheckUpdate): Promise<void> {
  const detailsUrl = orgAppUrl(run.organizationId, `ci/${run.id}`);
  const body: Record<string, unknown> = {
    status: update.status,
    output: {
      title: update.title.slice(0, 255),
      summary: update.summary.slice(0, 65_000),
      ...(update.text ? { text: update.text.slice(0, 65_000) } : {}),
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
        body: JSON.stringify({ name: CHECK_NAME, head_sha: run.sha, external_id: run.id, ...body }),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
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
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    }
  } catch (err) {
    console.warn(`[ci] could not update the GitHub check for run ${run.id}:`, err);
  }
}
