/**
 * Pipelines' `on.schedule` crons for repositories connected through the
 * GitHub App, fired by the `ci` poller pass as ordinary runs.
 *
 * Runners keep no clock, so something in front of them has to fire
 * schedules. The CI proxy's Cron Trigger does it for repositories registered
 * with it directly, but it never stores a token and its runs bypass the app
 * (no plan check, billing row, GitHub check or CI tab). The app has all of
 * that per run, and an installation token per dispatch, so for its own
 * repositories it fires them itself:
 *
 * 1. Any delivery for a repository registers it (`noteRepository`), and a
 *    push to its default branch asks for a re-read at once.
 * 2. `refreshSchedules` reads the default branch's pipelines with
 *    `on.schedule` through the proxy (`POST /v1/schedules/read`, which stores
 *    nothing), keeping each one's crons and text and the commit they came
 *    from. Hourly while a repository schedules anything, in case a webhook
 *    was lost; weekly otherwise. A repository unreadable for a day is dropped.
 * 3. `fireDueSchedules` matches each stored cron against every minute since
 *    the last pass (catching up at most {@link CATCH_UP_MINUTES} after an
 *    outage: a backlog of stale runs is worse than a missed one) and inserts
 *    a queued run with `event: schedule` and the pipeline's text. The dedupe
 *    key is per repository, file and minute, so overlapping passes insert one.
 *
 * From there a scheduled run is dispatched, admitted to its concurrency
 * groups, followed, billed and shown like a push to the default branch,
 * whose caches it shares. It checks out the commit the pipelines were read
 * from, which is the default branch's head as of the last push the app saw.
 */
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ciCronDue, nextCiCronDue, type CiSchedules } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { ciAccounts, ciRuns, ciSchedules, type CiScheduleEntry } from "../db/schema.js";
import { planAccess } from "../entitlements.js";
import { orgHasFeature } from "../features.js";
import { getInstallationToken } from "../github/app.js";
import { ownerKey, repoKey } from "./events.js";
import { CiProxyError, proxyJson } from "./proxy.js";

type ScheduleRow = typeof ciSchedules.$inferSelect;

const MINUTE_MS = 60_000;
/** Missed minutes a pass still fires after the poller was down. */
export const CATCH_UP_MINUTES = 5;
/** How often a repository that schedules something is read again without a push. */
const READ_EVERY_MS = 60 * MINUTE_MS;
/** How often one that schedules nothing is; a push re-reads it at once anyway. */
const READ_IDLE_MS = 7 * 24 * 60 * MINUTE_MS;
/** After a failed read. */
const READ_RETRY_MS = 15 * MINUTE_MS;
/** How long a read is claimed for before another pass may try. */
const READ_CLAIM_MS = 2 * MINUTE_MS;
/** A repository no read has reached for this long is forgotten. */
const UNREADABLE_FOR_MS = 24 * 60 * MINUTE_MS;
/** Reads per pass; each clones a branch on a runner. */
const READS_PER_PASS = 5;
/** The most scheduled pipelines kept per repository. */
const MAX_PIPELINES = 32;
/** The largest pipeline text kept, in characters; a runner refuses far less. */
const MAX_TEXT = 256 * 1024;
const MAX_CRONS = 16;

/** Registers a repository the app has seen a delivery for; `refreshNow` for a push to its default branch. */
export async function noteRepository(input: {
  organizationId: string;
  installationId: number;
  repoFullName: string;
  defaultBranch: string;
  refreshNow: boolean;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(ciSchedules)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      installationId: input.installationId,
      repoFullName: input.repoFullName,
      defaultBranch: input.defaultBranch,
      refreshAfter: now,
    })
    .onConflictDoUpdate({
      target: [ciSchedules.installationId, ciSchedules.repoFullName],
      set: {
        organizationId: input.organizationId,
        defaultBranch: input.defaultBranch,
        ...(input.refreshNow ? { refreshAfter: now } : {}),
      },
    });
}

/** `POST /v1/schedules/read` as the runner answers it. */
interface ReadReply {
  commit?: unknown;
  pipelines?: unknown;
  problems?: unknown;
}

/** The pipelines of a read, as far as they are well formed; anything else is dropped. */
export function scheduleEntries(pipelines: unknown): CiScheduleEntry[] {
  if (!Array.isArray(pipelines)) return [];
  const out: CiScheduleEntry[] = [];
  for (const p of pipelines as unknown[]) {
    if (typeof p !== "object" || p === null) continue;
    const { file, name, cron, text } = p as Record<string, unknown>;
    if (typeof file !== "string" || typeof text !== "string" || text.length > MAX_TEXT) continue;
    if (!Array.isArray(cron)) continue;
    const crons = cron.filter((c): c is string => typeof c === "string").slice(0, MAX_CRONS);
    if (crons.length === 0) continue;
    out.push({ file, name: typeof name === "string" ? name : file, cron: crons, text });
    if (out.length === MAX_PIPELINES) break;
  }
  return out;
}

async function readSchedules(row: ScheduleRow): Promise<void> {
  const now = new Date();
  const failed = async (reason: string) => {
    const lastOk = (row.readOkAt ?? row.createdAt).getTime();
    if (now.getTime() - lastOk > UNREADABLE_FOR_MS) {
      // Deleted, renamed, or the app lost access: stop firing into it.
      await db.delete(ciSchedules).where(eq(ciSchedules.id, row.id));
      return;
    }
    await db
      .update(ciSchedules)
      .set({
        error: reason,
        refreshedAt: now,
        refreshAfter: new Date(now.getTime() + READ_RETRY_MS),
      })
      .where(eq(ciSchedules.id, row.id));
  };

  let token: string;
  try {
    token = await getInstallationToken(row.installationId);
  } catch (err) {
    await failed(`GitHub refused an installation token: ${String(err)}`);
    return;
  }
  let reply: ReadReply;
  try {
    reply = await proxyJson<ReadReply>("/v1/schedules/read", {
      method: "POST",
      body: JSON.stringify({
        repo: `https://github.com/${row.repoFullName}.git`,
        branch: row.defaultBranch,
        "default-branch": row.defaultBranch,
        owner: ownerKey(row.repoFullName),
        "repo-id": repoKey(row.repoFullName),
        token,
      }),
    });
  } catch (err) {
    await failed(err instanceof CiProxyError ? err.message : String(err));
    return;
  }
  const pipelines = scheduleEntries(reply.pipelines);
  const problems = Array.isArray(reply.problems)
    ? reply.problems.filter((p): p is string => typeof p === "string")
    : [];
  await db
    .update(ciSchedules)
    .set({
      sha: typeof reply.commit === "string" ? reply.commit : null,
      pipelines,
      error: problems.length > 0 ? problems.join("; ").slice(0, 4000) : null,
      refreshedAt: now,
      readOkAt: now,
      refreshAfter: new Date(now.getTime() + (pipelines.length > 0 ? READ_EVERY_MS : READ_IDLE_MS)),
    })
    .where(eq(ciSchedules.id, row.id));
}

/** Reads the repositories whose schedules are due a read, a few per pass. */
export async function refreshSchedules(limit = READS_PER_PASS): Promise<void> {
  const now = new Date();
  const due = await db
    .select({ id: ciSchedules.id })
    .from(ciSchedules)
    .where(lte(ciSchedules.refreshAfter, now))
    .orderBy(asc(ciSchedules.refreshAfter))
    .limit(limit);
  for (const { id } of due) {
    // Claimed first, so overlapping passes never read one twice.
    const [row] = await db
      .update(ciSchedules)
      .set({ refreshAfter: new Date(now.getTime() + READ_CLAIM_MS) })
      .where(and(eq(ciSchedules.id, id), lte(ciSchedules.refreshAfter, now)))
      .returning();
    if (!row) continue;
    await readSchedules(row).catch((err) =>
      console.warn(`[ci] reading the schedules of ${row.repoFullName} failed:`, err),
    );
  }
}

/** The minutes a row still has to fire, oldest first, up to and including `minute`. */
export function minutesToFire(firedThrough: Date | null, minute: number): number[] {
  const earliest = minute - (CATCH_UP_MINUTES - 1) * MINUTE_MS;
  const from =
    firedThrough === null ? minute : Math.max(firedThrough.getTime() + MINUTE_MS, earliest);
  const out: number[] = [];
  for (let m = from; m <= minute; m += MINUTE_MS) out.push(m);
  return out;
}

/** The runs a schedule row's pipelines start over `minutes`, in time order. */
export function dueRuns(
  pipelines: readonly CiScheduleEntry[],
  minutes: readonly number[],
): Array<{ pipeline: CiScheduleEntry; minute: number }> {
  return minutes.flatMap((minute) =>
    pipelines
      .filter((p) => ciCronDue(p.cron, new Date(minute)))
      .map((pipeline) => ({ pipeline, minute })),
  );
}

/**
 * Queues every scheduled pipeline due since the last pass. Only for
 * organizations that still run CI for the account, have it turned on and
 * pay for it; the others' minutes pass without a run (and without a failed
 * check every minute).
 */
export async function fireDueSchedules(now = new Date()): Promise<number> {
  const minute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const rows = await db
    .select({ schedule: ciSchedules })
    .from(ciSchedules)
    .innerJoin(
      ciAccounts,
      and(
        eq(ciAccounts.installationId, ciSchedules.installationId),
        eq(ciAccounts.organizationId, ciSchedules.organizationId),
      ),
    )
    .where(
      and(
        sql`${ciSchedules.sha} IS NOT NULL`,
        sql`jsonb_array_length(${ciSchedules.pipelines}) > 0`,
        or(isNull(ciSchedules.firedThrough), lt(ciSchedules.firedThrough, new Date(minute))),
      ),
    );

  const allowed = new Map<string, Promise<boolean>>();
  const mayRun = (organizationId: string) => {
    let answer = allowed.get(organizationId);
    if (!answer) {
      answer = (async () =>
        (await orgHasFeature(organizationId, "ci")) && (await planAccess(organizationId)).paid)();
      allowed.set(organizationId, answer);
    }
    return answer;
  };

  let queued = 0;
  for (const { schedule: row } of rows) {
    const sha = row.sha;
    if (sha === null) continue;
    if (await mayRun(row.organizationId)) {
      for (const { pipeline, minute: at } of dueRuns(
        row.pipelines,
        minutesToFire(row.firedThrough, minute),
      )) {
        const [inserted] = await db
          .insert(ciRuns)
          .values({
            id: crypto.randomUUID(),
            organizationId: row.organizationId,
            installationId: row.installationId,
            repoFullName: row.repoFullName,
            ownerKey: ownerKey(row.repoFullName),
            repoKey: repoKey(row.repoFullName),
            event: "schedule",
            pipelineFile: pipeline.file,
            pipelineText: pipeline.text,
            // The default branch's cache scope, as a push to it.
            branch: row.defaultBranch,
            headRef: row.defaultBranch,
            defaultBranch: row.defaultBranch,
            sha,
            status: "queued",
            dedupeKey: `schedule:${row.installationId}:${row.repoFullName.toLowerCase()}:${pipeline.file}:${new Date(at).toISOString()}`,
          })
          .onConflictDoNothing()
          .returning({ id: ciRuns.id });
        if (inserted) queued++;
      }
    }
    await db
      .update(ciSchedules)
      .set({ firedThrough: new Date(minute) })
      .where(
        and(
          eq(ciSchedules.id, row.id),
          or(isNull(ciSchedules.firedThrough), lt(ciSchedules.firedThrough, new Date(minute))),
        ),
      );
  }
  return queued;
}

/** The organization's repositories with scheduled pipelines, and those whose last read failed. */
export async function listCiSchedules(
  organizationId: string,
  now = new Date(),
): Promise<CiSchedules> {
  const rows = await db
    .select({ schedule: ciSchedules })
    .from(ciSchedules)
    .innerJoin(
      ciAccounts,
      and(
        eq(ciAccounts.installationId, ciSchedules.installationId),
        eq(ciAccounts.organizationId, ciSchedules.organizationId),
      ),
    )
    .where(eq(ciSchedules.organizationId, organizationId))
    .orderBy(asc(ciSchedules.repoFullName));
  return {
    schedules: rows
      .map(({ schedule: r }) => r)
      .filter((r) => r.pipelines.length > 0 || r.error !== null)
      .map((r) => ({
        installationId: r.installationId,
        repoFullName: r.repoFullName,
        defaultBranch: r.defaultBranch,
        sha: r.sha,
        pipelines: r.pipelines.map((p) => ({
          file: p.file,
          name: p.name,
          cron: p.cron,
          nextRunAt: nextCiCronDue(p.cron, now)?.toISOString() ?? null,
        })),
        refreshedAt: r.refreshedAt?.toISOString() ?? null,
        error: r.error,
      })),
  };
}
