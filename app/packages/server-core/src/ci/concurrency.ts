/**
 * `concurrency:` groups, enforced here because only the app sees every run
 * of a repository. The runners evaluate a pipeline's group (they parse the
 * pipeline file, `POST /v1/concurrency`) and stop what they are told to
 * (`POST /v1/runs/{id}/cancel`); which run may go is decided here, per
 * repository, under an advisory lock so two dispatchers cannot both admit.
 *
 * A run holds the groups of the pipelines it triggers from the moment it is
 * admitted (queued with its groups read, or running) until it ends. For each
 * group of a new run:
 * - an older run waiting for the group is cancelled: only the newest waits;
 * - an older run holding it has its pipelines in that group cancelled when
 *   the new run's pipeline says `cancel-in-progress`, and otherwise the new
 *   run waits (`pending`) until the group is free;
 * - a newer run already in the group supersedes this one, which is
 *   cancelled: an older commit never displaces or follows a newer one.
 * Groups compare case-insensitively. A fork's pull request has groups of its
 * own (scoped to the pull request), since its pipeline file is the fork's.
 * A run is every pipeline its event
 * triggers, so it waits as a whole while any of its groups is held, and a
 * cancelled older run is cancelled as a whole while it waits; a running one
 * only loses the pipelines of the group, so a deploy in no group carries on.
 */
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { ciRuns, type CiConcurrencyEntry, type CiJobAccess } from "../db/schema.js";
import { upsertCheck } from "./checks.js";
import { proxyFetch } from "./proxy.js";

type CiRunRow = typeof ciRuns.$inferSelect;

/** What admission needs of a run. */
export interface AdmissionRun {
  id: string;
  /**
   * When it was created, in microseconds: two webhooks can land in the same
   * millisecond, and a `Date` would make their order a coin toss.
   */
  createdAtMicros: number;
  status: string;
  concurrency: CiConcurrencyEntry[];
  /**
   * What its group names are prefixed with: nothing for the repository's own
   * branches, and the pull request for a fork's, whose pipeline file is the
   * fork's to write. Approving a fork's commit must not let it cancel, hold
   * up or supersede the repository's own runs by naming their group.
   */
  scope: string;
}

/** The scope of a run's groups (see {@link AdmissionRun.scope}). */
export function groupScope(run: { fromFork: boolean; pullNumber: number | null }): string {
  return run.fromFork ? `fork:pull/${run.pullNumber ?? 0}:` : "";
}

export interface Admission {
  outcome: "admit" | "wait" | "superseded";
  /** For `wait`: a group it waits for and the run holding it. For `superseded`: the newer run. */
  blocker: { group: string; runId: string } | null;
  /** Older runs waiting in one of its groups, cancelled whole. */
  cancelPending: string[];
  /** Older runs holding one of its `cancel-in-progress` groups: the files to cancel in each. */
  cancelPipelines: Array<{ runId: string; files: string[] }>;
}

/** A group's key: groups ignore case, and a fork's are its own. */
export function groupKey(group: string, scope = ""): string {
  return `${scope}${group.toLowerCase()}`;
}

/** The groups a run's pipelines still hold, with whether any of them cancels in progress. */
export function activeGroups(
  entries: readonly CiConcurrencyEntry[],
  scope = "",
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.group === null || entry.cancelled) continue;
    const key = groupKey(entry.group, scope);
    out.set(key, (out.get(key) ?? false) || entry.cancelInProgress);
  }
  return out;
}

function newer(a: AdmissionRun, b: AdmissionRun): boolean {
  return a.createdAtMicros !== b.createdAtMicros
    ? a.createdAtMicros > b.createdAtMicros
    : a.id > b.id;
}

/**
 * `created_at` in microseconds, exactly (it fits a double). Built when asked,
 * not at import, so a module that mocks the schema can still import this one.
 */
function createdAtMicros() {
  return sql<number>`floor(extract(epoch from ${ciRuns.createdAt}) * 1000000)::float8`;
}

const HOLDING = new Set(["queued", "running"]);

/**
 * Whether `self` may go now, given the repository's other admitted and
 * waiting runs. Pure: the caller reads the rows and applies the outcome.
 */
export function decideAdmission(self: AdmissionRun, others: readonly AdmissionRun[]): Admission {
  const mine = activeGroups(self.concurrency, self.scope);
  const shown = (key: string) => key.slice(self.scope.length);
  const admission: Admission = {
    outcome: "admit",
    blocker: null,
    cancelPending: [],
    cancelPipelines: [],
  };
  if (mine.size === 0) return admission;
  const sharing = others
    .filter((o) => o.id !== self.id && (o.status === "pending" || HOLDING.has(o.status)))
    .map((o) => ({ run: o, groups: activeGroups(o.concurrency, o.scope) }))
    .filter(({ groups }) => [...groups.keys()].some((g) => mine.has(g)));

  // A newer run in one of its groups already went ahead or waits: this one
  // would only ever be cancelled by it.
  for (const { run, groups } of sharing) {
    if (!newer(run, self)) continue;
    const group = shown([...groups.keys()].find((g) => mine.has(g)) ?? "");
    return { ...admission, outcome: "superseded", blocker: { group, runId: run.id } };
  }

  for (const { run, groups } of sharing) {
    const shared = [...groups.keys()].filter((g) => mine.has(g));
    if (run.status === "pending") {
      admission.cancelPending.push(run.id);
      continue;
    }
    const cancelled = shared.filter((g) => mine.get(g) === true);
    const waited = shared.filter((g) => mine.get(g) !== true);
    if (cancelled.length > 0) {
      const files = run.concurrency
        .filter(
          (e) =>
            e.group !== null && !e.cancelled && cancelled.includes(groupKey(e.group, run.scope)),
        )
        .map((e) => e.file);
      admission.cancelPipelines.push({ runId: run.id, files });
    }
    if (waited.length > 0 && admission.blocker === null) {
      admission.blocker = { group: shown(waited[0] ?? ""), runId: run.id };
    }
  }
  if (admission.blocker !== null) admission.outcome = "wait";
  return admission;
}

/** The pipelines a run would trigger, with their groups, as the CI proxy's `POST /v1/concurrency` answers. */
interface ResolvedPipelines {
  pipelines?: Array<{
    file?: unknown;
    name?: unknown;
    concurrency?: { group?: unknown; "cancel-in-progress"?: unknown } | null;
    /** Jobs that name something to be lent, or run in the cloud (runners from 0.3.16). */
    jobs?: unknown;
  }>;
}

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * What each job names to be lent and its `cloud:` block, as the runners'
 * answer lists them. Read leniently: anything malformed is left out, and a
 * runner from before lists nothing.
 */
export function accessFrom(answer: ResolvedPipelines): CiJobAccess[] {
  const out: CiJobAccess[] = [];
  for (const p of answer.pipelines ?? []) {
    if (typeof p.file !== "string" || !Array.isArray(p.jobs)) continue;
    for (const raw of p.jobs as unknown[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const job = raw as Record<string, unknown>;
      if (typeof job["key"] !== "string") continue;
      const entry: CiJobAccess = { pipeline: p.file, job: job["key"] };
      if (Array.isArray(job["connections"])) {
        const connections = (job["connections"] as unknown[]).flatMap((c) => {
          if (typeof c === "string") return [{ name: c }];
          if (typeof c !== "object" || c === null) return [];
          const { name, namespace } = c as { name?: unknown; namespace?: unknown };
          if (!isString(name)) return [];
          return [isString(namespace) ? { name, namespace } : { name }];
        });
        if (connections.length > 0) entry.connections = connections;
      }
      if (Array.isArray(job["ssh-keys"])) {
        const keys = (job["ssh-keys"] as unknown[]).filter(isString);
        if (keys.length > 0) entry.sshKeys = keys;
      }
      if (typeof job["resources"] === "object" && job["resources"] !== null) {
        const resources: Record<string, string[]> = {};
        for (const [name, outputs] of Object.entries(job["resources"] as Record<string, unknown>)) {
          if (Array.isArray(outputs)) resources[name] = outputs.filter(isString);
        }
        if (Object.keys(resources).length > 0) entry.resources = resources;
      }
      if (Array.isArray(job["env-from"])) {
        const envFrom = (job["env-from"] as unknown[]).filter(isString);
        if (envFrom.length > 0) entry.envFrom = envFrom;
      }
      if (typeof job["cloud"] === "object" && job["cloud"] !== null) {
        const cloud: Record<string, string> = {};
        for (const [k, v] of Object.entries(job["cloud"] as Record<string, unknown>)) {
          if (isString(v)) cloud[k] = v;
        }
        entry.cloud = cloud;
      }
      out.push(entry);
    }
  }
  return out;
}

export function entriesFrom(answer: ResolvedPipelines): CiConcurrencyEntry[] {
  const out: CiConcurrencyEntry[] = [];
  for (const p of answer.pipelines ?? []) {
    if (typeof p.file !== "string") continue;
    const group = p.concurrency?.group;
    out.push({
      file: p.file,
      pipeline: typeof p.name === "string" ? p.name : p.file,
      group: typeof group === "string" && group.length > 0 ? group : null,
      cancelInProgress: p.concurrency?.["cancel-in-progress"] === true,
    });
  }
  return out;
}

/**
 * Asks the runners which pipelines a run triggers and their groups, with the
 * body the run will be dispatched with. `retry` when the pool is busy or
 * unreachable. A runner or proxy from before concurrency answers 404, which
 * reads as no groups; so does a request they cannot resolve, which the run
 * itself will then report.
 */
export async function resolveConcurrency(
  body: Record<string, unknown>,
): Promise<{ entries: CiConcurrencyEntry[]; access: CiJobAccess[] } | { retry: string }> {
  let res: Response;
  try {
    res = await proxyFetch("/v1/concurrency", { method: "POST", body: JSON.stringify(body) });
  } catch (err) {
    return { retry: `The CI proxy did not answer: ${String(err)}` };
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    return { retry: `The runners could not read the pipelines (${res.status}).` };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { entries: [], access: [] };
  }
  const answer = (await res.json().catch(() => ({}))) as ResolvedPipelines;
  return { entries: entriesFrom(answer), access: accessFrom(answer) };
}

/**
 * Tells the runner to cancel a run, or only `files` of it. True once the
 * runner has answered for good (it is stopping it, it has finished, or it
 * cannot cancel), false to try again on the next poll.
 */
export async function sendCancel(proxyRunId: string, files?: string[]): Promise<boolean> {
  try {
    const res = await proxyFetch(`/v1/runs/${encodeURIComponent(proxyRunId)}/cancel`, {
      method: "POST",
      body: JSON.stringify(files ? { pipelines: files } : {}),
    });
    await res.body?.cancel();
    return res.status < 500;
  } catch {
    return false;
  }
}

const CANCELLED_CHECK = (reason: string) =>
  ({ status: "completed", conclusion: "cancelled", title: "Cancelled", summary: reason }) as const;

function lockKey(row: Pick<CiRunRow, "installationId" | "repoFullName">): string {
  return `ci-concurrency:${row.installationId}:${row.repoFullName.toLowerCase()}`;
}

function describe(group: string): string {
  return `concurrency group \`${group}\``;
}

/** What admission changed, for the work done after its transaction. */
interface Applied {
  self: CiRunRow | null;
  outcome: Admission["outcome"] | "gone";
  /** Rows cancelled outright (never started), whose checks say so. */
  cancelled: Array<{ row: CiRunRow; reason: string }>;
  /** Running runs whose newly cancelled pipelines the runner is told about. */
  toCancel: Array<{ id: string; proxyRunId: string; files: string[] }>;
}

/**
 * Decides whether run `id` may go and applies the decision, under the
 * repository's advisory lock: older waiting runs and the older runs' pipelines
 * its `cancel-in-progress` groups name are cancelled, and it is left queued
 * (admitted), made `pending`, or cancelled as superseded. Returns whether it
 * was admitted. `entries` are its pipelines, when it has just read them.
 */
export async function admitRun(
  row: Pick<CiRunRow, "id" | "installationId" | "repoFullName">,
  entries?: CiConcurrencyEntry[],
): Promise<boolean> {
  const applied = await db.transaction(async (tx): Promise<Applied> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(row)}, 0))`);
    const [found] = await tx
      .select({ run: ciRuns, createdAtMicros: createdAtMicros() })
      .from(ciRuns)
      .where(eq(ciRuns.id, row.id))
      .limit(1);
    const current = found?.run;
    if (!current || (current.status !== "queued" && current.status !== "pending")) {
      return { self: current ?? null, outcome: "gone", cancelled: [], toCancel: [] };
    }
    const concurrency = entries ?? current.concurrency ?? [];
    const others = await tx
      .select({ run: ciRuns, createdAtMicros: createdAtMicros() })
      .from(ciRuns)
      .where(
        and(
          eq(ciRuns.installationId, row.installationId),
          sql`lower(${ciRuns.repoFullName}) = ${row.repoFullName.toLowerCase()}`,
          inArray(ciRuns.status, ["queued", "pending", "running"]),
          isNotNull(ciRuns.concurrency),
          ne(ciRuns.id, row.id),
        ),
      );
    const decision = decideAdmission(
      {
        id: current.id,
        createdAtMicros: Number(found.createdAtMicros),
        status: current.status,
        concurrency,
        scope: groupScope(current),
      },
      others.map((o) => ({
        id: o.run.id,
        createdAtMicros: Number(o.createdAtMicros),
        status: o.run.status,
        concurrency: o.run.concurrency ?? [],
        scope: groupScope(o.run),
      })),
    );
    const now = new Date();
    const out: Applied = { self: current, outcome: decision.outcome, cancelled: [], toCancel: [] };

    for (const id of decision.cancelPending) {
      const reason = "A newer run joined its concurrency group, and only the newest waits.";
      const [cancelled] = await tx
        .update(ciRuns)
        .set({ status: "cancelled", statusReason: reason, finishedAt: now, updatedAt: now })
        .where(and(eq(ciRuns.id, id), eq(ciRuns.status, "pending")))
        .returning();
      if (cancelled) out.cancelled.push({ row: cancelled, reason });
    }
    for (const { runId, files } of decision.cancelPipelines) {
      const holder = others.find((o) => o.run.id === runId)?.run;
      if (!holder) continue;
      const next = (holder.concurrency ?? []).map((e) =>
        files.includes(e.file) ? { ...e, cancelled: true, cancelSent: false } : e,
      );
      const reason = `Cancelled by a newer run of its ${describe(
        next.find((e) => files.includes(e.file))?.group ?? "",
      )}.`;
      // Nothing of a run that has not started is left to run.
      if (holder.status === "queued" && next.every((e) => e.cancelled)) {
        const [cancelled] = await tx
          .update(ciRuns)
          .set({
            status: "cancelled",
            statusReason: reason,
            concurrency: next,
            finishedAt: now,
            updatedAt: now,
          })
          .where(and(eq(ciRuns.id, runId), eq(ciRuns.status, "queued")))
          .returning();
        if (cancelled) out.cancelled.push({ row: cancelled, reason });
        continue;
      }
      await tx
        .update(ciRuns)
        .set({ concurrency: next, updatedAt: now })
        .where(eq(ciRuns.id, runId));
      if (holder.status === "running" && holder.proxyRunId) {
        out.toCancel.push({ id: runId, proxyRunId: holder.proxyRunId, files });
      }
    }

    if (decision.outcome === "superseded") {
      const reason = `A newer run of its ${describe(decision.blocker?.group ?? "")} went ahead.`;
      const [self] = await tx
        .update(ciRuns)
        .set({
          status: "cancelled",
          statusReason: reason,
          concurrency,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(ciRuns.id, row.id))
        .returning();
      if (self) out.cancelled.push({ row: self, reason });
      out.self = self ?? null;
    } else if (decision.outcome === "wait") {
      const [self] = await tx
        .update(ciRuns)
        .set({
          status: "pending",
          statusReason: `Waiting for its ${describe(decision.blocker?.group ?? "")}, which an older run holds.`,
          concurrency,
          updatedAt: now,
        })
        .where(eq(ciRuns.id, row.id))
        .returning();
      out.self = self ?? null;
    } else {
      const [self] = await tx
        .update(ciRuns)
        .set({
          status: "queued",
          statusReason: null,
          concurrency,
          nextAttemptAt: current.status === "pending" ? now : current.nextAttemptAt,
          updatedAt: now,
        })
        .where(eq(ciRuns.id, row.id))
        .returning();
      out.self = self ?? null;
    }
    return out;
  });

  for (const { row: cancelled, reason } of applied.cancelled) {
    await upsertCheck(cancelled, CANCELLED_CHECK(reason));
  }
  for (const { id, proxyRunId, files } of applied.toCancel) {
    if (await sendCancel(proxyRunId, files)) await markCancelsSent(id, files);
  }
  if (applied.outcome === "wait" && applied.self) {
    await upsertCheck(applied.self, {
      status: "queued",
      title: "Waiting for its concurrency group",
      summary: applied.self.statusReason ?? "Waiting for an older run of its concurrency group.",
    });
  }
  return applied.outcome === "admit";
}

/** Records that the runner was told to cancel `files` of run `id`. */
async function markCancelsSent(id: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  const list = sql.join(
    files.map((f) => sql`${f}`),
    sql`, `,
  );
  // In SQL, so a concurrent admission marking other entries is not lost.
  await db
    .update(ciRuns)
    .set({
      concurrency: sql`(
        select coalesce(jsonb_agg(
          case when t.e->>'file' in (${list}) then t.e || '{"cancelSent": true}'::jsonb else t.e end
          order by t.ord), '[]'::jsonb)
        from jsonb_array_elements(${ciRuns.concurrency}) with ordinality as t(e, ord))`,
    })
    .where(and(eq(ciRuns.id, id), isNotNull(ciRuns.concurrency)));
}

/**
 * Sends a running run's outstanding cancels again (a proxy that did not
 * answer, a run cancelled before it started), as each poll finds them.
 */
export async function resendCancels(row: CiRunRow): Promise<void> {
  if (row.status !== "running" || !row.proxyRunId) return;
  if (row.cancelRequestedAt && !row.cancelSentAt) {
    if (await sendCancel(row.proxyRunId)) {
      await db.update(ciRuns).set({ cancelSentAt: new Date() }).where(eq(ciRuns.id, row.id));
    }
    return;
  }
  const files = (row.concurrency ?? [])
    .filter((e) => e.cancelled && !e.cancelSent)
    .map((e) => e.file);
  if (files.length > 0 && (await sendCancel(row.proxyRunId, files))) {
    await markCancelsSent(row.id, files);
  }
}

/** Waiting runs, oldest first, to see whether their groups are free. */
export async function pendingRuns(limit: number): Promise<CiRunRow[]> {
  return db
    .select()
    .from(ciRuns)
    .where(eq(ciRuns.status, "pending"))
    .orderBy(ciRuns.createdAt)
    .limit(limit);
}
