// Registered schedules and the record of what fired, in D1 (see
// migrations/). `MemoryStore` is the same contract for tests.

import type { D1Database } from "@cloudflare/workers-types/index";

export interface ScheduledPipeline {
  file: string;
  name: string;
  cron: string[];
  /** The pipeline file's text, sent with the run so exactly it runs. */
  text: string;
}

export interface ScheduleRow {
  owner: string;
  repoId: string;
  repo: string;
  branch: string;
  storageQuota: number | null;
  pipelines: ScheduledPipeline[];
  commit: string | null;
  error: string | null;
  refreshedAt: number;
  registeredAt: number;
}

export interface ScheduleStore {
  all(): Promise<ScheduleRow[]>;
  forOwner(owner: string): Promise<ScheduleRow[]>;
  put(row: ScheduleRow): Promise<void>;
  remove(owner: string, repoId: string): Promise<boolean>;
  /** Records that `file` fires in `minute`; false when it already did. */
  claimFire(owner: string, repoId: string, file: string, minute: number): Promise<boolean>;
  settleFire(
    owner: string,
    repoId: string,
    file: string,
    minute: number,
    runId: string | null,
    outcome: string,
  ): Promise<void>;
}

interface DbRow {
  owner: string;
  repo_id: string;
  repo: string;
  branch: string;
  storage_quota: number | null;
  pipelines: string;
  commit_sha: string | null;
  error: string | null;
  refreshed_at: number;
  registered_at: number;
}

function fromDb(r: DbRow): ScheduleRow {
  let pipelines: ScheduledPipeline[] = [];
  try {
    pipelines = JSON.parse(r.pipelines) as ScheduledPipeline[];
  } catch {
    pipelines = [];
  }
  return {
    owner: r.owner,
    repoId: r.repo_id,
    repo: r.repo,
    branch: r.branch,
    storageQuota: r.storage_quota,
    pipelines,
    commit: r.commit_sha,
    error: r.error,
    refreshedAt: r.refreshed_at,
    registeredAt: r.registered_at,
  };
}

export class D1Store implements ScheduleStore {
  constructor(private readonly db: D1Database) {}

  async all(): Promise<ScheduleRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM schedules ORDER BY owner, repo_id")
      .all<DbRow>();
    return results.map(fromDb);
  }

  async forOwner(owner: string): Promise<ScheduleRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM schedules WHERE owner = ? ORDER BY repo_id")
      .bind(owner)
      .all<DbRow>();
    return results.map(fromDb);
  }

  async put(row: ScheduleRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO schedules (owner, repo_id, repo, branch, storage_quota, pipelines, commit_sha, error, refreshed_at, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, repo_id) DO UPDATE SET
           repo = excluded.repo, branch = excluded.branch, storage_quota = excluded.storage_quota,
           pipelines = excluded.pipelines, commit_sha = excluded.commit_sha, error = excluded.error,
           refreshed_at = excluded.refreshed_at`,
      )
      .bind(
        row.owner,
        row.repoId,
        row.repo,
        row.branch,
        row.storageQuota,
        JSON.stringify(row.pipelines),
        row.commit,
        row.error,
        row.refreshedAt,
        row.registeredAt,
      )
      .run();
  }

  async remove(owner: string, repoId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM schedules WHERE owner = ? AND repo_id = ?")
      .bind(owner, repoId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async claimFire(owner: string, repoId: string, file: string, minute: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO schedule_fires (owner, repo_id, file, minute, outcome) VALUES (?, ?, ?, ?, 'pending')",
      )
      .bind(owner, repoId, file, minute)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async settleFire(
    owner: string,
    repoId: string,
    file: string,
    minute: number,
    runId: string | null,
    outcome: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE schedule_fires SET run_id = ?, outcome = ? WHERE owner = ? AND repo_id = ? AND file = ? AND minute = ?",
      )
      .bind(runId, outcome, owner, repoId, file, minute)
      .run();
  }
}

export class MemoryStore implements ScheduleStore {
  rows = new Map<string, ScheduleRow>();
  fires = new Map<string, { runId: string | null; outcome: string }>();

  async all(): Promise<ScheduleRow[]> {
    return [...this.rows.values()];
  }
  async forOwner(owner: string): Promise<ScheduleRow[]> {
    return [...this.rows.values()].filter((r) => r.owner === owner);
  }
  async put(row: ScheduleRow): Promise<void> {
    const key = `${row.owner}/${row.repoId}`;
    const old = this.rows.get(key);
    this.rows.set(key, { ...row, registeredAt: old?.registeredAt ?? row.registeredAt });
  }
  async remove(owner: string, repoId: string): Promise<boolean> {
    return this.rows.delete(`${owner}/${repoId}`);
  }
  async claimFire(owner: string, repoId: string, file: string, minute: number): Promise<boolean> {
    const key = `${owner}/${repoId}/${file}/${minute}`;
    if (this.fires.has(key)) return false;
    this.fires.set(key, { runId: null, outcome: "pending" });
    return true;
  }
  async settleFire(
    owner: string,
    repoId: string,
    file: string,
    minute: number,
    runId: string | null,
    outcome: string,
  ): Promise<void> {
    this.fires.set(`${owner}/${repoId}/${file}/${minute}`, { runId, outcome });
  }
}
