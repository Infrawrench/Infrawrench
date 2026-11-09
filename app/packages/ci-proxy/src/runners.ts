// The runner list, kept in D1 so the hosts Terraform provisions can be
// added and removed without redeploying the Worker. Replaced whole by
// `PUT /v1/runners`.

import type { D1Database } from "@cloudflare/workers-types/index";
import type { RunnerEntry } from "./pool";

export interface RunnerList {
  list(): Promise<RunnerEntry[]>;
  replace(runners: RunnerEntry[], now: number): Promise<void>;
}

export class D1RunnerList implements RunnerList {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<RunnerEntry[]> {
    const { results } = await this.db
      .prepare("SELECT name, url FROM runners ORDER BY name")
      .all<RunnerEntry>();
    return results;
  }

  async replace(runners: RunnerEntry[], now: number): Promise<void> {
    // One batch, so readers never see a half-replaced list.
    await this.db.batch([
      this.db.prepare("DELETE FROM runners"),
      ...runners.map((r) =>
        this.db
          .prepare("INSERT INTO runners (name, url, updated_at) VALUES (?, ?, ?)")
          .bind(r.name, r.url, now),
      ),
    ]);
  }
}

export class MemoryRunnerList implements RunnerList {
  runners: RunnerEntry[] = [];

  async list(): Promise<RunnerEntry[]> {
    return [...this.runners].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async replace(runners: RunnerEntry[]): Promise<void> {
    this.runners = [...runners];
  }
}
