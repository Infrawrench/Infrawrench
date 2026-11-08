-- Repositories whose `on.schedule` pipelines the proxy fires, and what a
-- runner last read from their default branch.
CREATE TABLE schedules (
  owner TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  storage_quota INTEGER,
  -- JSON array of { file, name, cron: [..], text } from the runner.
  pipelines TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT,
  error TEXT,
  refreshed_at INTEGER NOT NULL,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo_id)
);

-- One row per scheduled pipeline per minute it fired. The primary key is
-- what keeps a duplicate Cron Trigger invocation from firing it twice.
CREATE TABLE schedule_fires (
  owner TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  file TEXT NOT NULL,
  minute INTEGER NOT NULL,
  run_id TEXT,
  outcome TEXT NOT NULL,
  PRIMARY KEY (owner, repo_id, file, minute)
);
