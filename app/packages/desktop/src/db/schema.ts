/**
 * SQLite schema for the desktop app — same tables as the web app
 * but without organization_id (single-user, local).
 *
 * Migrations are run at startup in the Electron main process (electron/main.ts).
 */

export const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    encrypted_credentials TEXT NOT NULL,
    credentials_iv TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plugin_installations (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL UNIQUE,
    package_name TEXT NOT NULL,
    version TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    resource_type_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    external_id TEXT,
    fields_json TEXT NOT NULL DEFAULT '{}',
    outputs_json TEXT NOT NULL DEFAULT '{}',
    parent_resource_id TEXT,
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS resources_plugin_type_idx ON resources(plugin_id, resource_type_id);
  CREATE INDEX IF NOT EXISTS resources_account_idx ON resources(account_id);

  CREATE TABLE IF NOT EXISTS secret_field_states (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    resolution_kind TEXT NOT NULL,
    encrypted_value TEXT,
    value_iv TEXT,
    source_plugin_id TEXT,
    source_resource_type_id TEXT,
    source_resource_id TEXT,
    source_account_id TEXT,
    source_output_key TEXT,
    cached_encrypted_value TEXT,
    cached_value_iv TEXT,
    cached_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(resource_id, field_key)
  );

  CREATE TABLE IF NOT EXISTS associations (
    id TEXT PRIMARY KEY,
    consumer_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    consumer_field_key TEXT NOT NULL,
    provider_resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
    provider_output_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(consumer_resource_id, consumer_field_key)
  );

  CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dashboard_pins (
    id TEXT PRIMARY KEY,
    dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    grid_x INTEGER NOT NULL DEFAULT 0,
    grid_y INTEGER NOT NULL DEFAULT 0,
    grid_w INTEGER NOT NULL DEFAULT 1,
    grid_h INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(dashboard_id, resource_id)
  );
  `,
  // v2 — SSH tunnel configs + named SSH key registry

  `
  CREATE TABLE IF NOT EXISTS ssh_tunnel_configs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    ssh_host TEXT NOT NULL,
    ssh_port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL DEFAULT 'root',
    remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
    remote_port INTEGER NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    private_key_iv TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ssh_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    key_iv TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v3 — Cloud sync state + sync columns for bidirectional sync

  `
  CREATE TABLE IF NOT EXISTS cloud_sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  ALTER TABLE accounts ADD COLUMN cloud_id TEXT;
  ALTER TABLE accounts ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

  ALTER TABLE resources ADD COLUMN cloud_id TEXT;
  ALTER TABLE resources ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE resources ADD COLUMN deleted_at TEXT;

  ALTER TABLE associations ADD COLUMN cloud_id TEXT;
  ALTER TABLE associations ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE associations ADD COLUMN deleted_at TEXT;

  ALTER TABLE dashboards ADD COLUMN cloud_id TEXT;
  ALTER TABLE dashboards ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE dashboards ADD COLUMN deleted_at TEXT;

  ALTER TABLE dashboard_pins ADD COLUMN cloud_id TEXT;
  ALTER TABLE dashboard_pins ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE dashboard_pins ADD COLUMN deleted_at TEXT;
  `,
  // v4 — metric pings (desktop-only native notifications when a metric leaves a range)

  `
  CREATE TABLE IF NOT EXISTS metric_pings (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL,
    resource_type_id TEXT NOT NULL,
    resource_display_name TEXT NOT NULL,
    metric_label TEXT NOT NULL,
    min_value REAL,
    max_value REAL,
    last_alert_at TEXT,
    last_alert_state TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(resource_id, metric_label)
  );
  `,
  // v5 — SSH host-key pins (TOFU). One row per (host, port); we reject the
  // connection if the fingerprint we see at connect time does not match.

  `
  CREATE TABLE IF NOT EXISTS ssh_host_keys (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(host, port)
  );
  `,
];

// Workflows: TypeScript automations run in a V8/WASM isolate.
const WORKFLOWS_MIGRATION = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT '{"kind":"manual"}',
  metric_defs TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  cloud_id TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_source TEXT NOT NULL DEFAULT 'manual',
  logs TEXT NOT NULL DEFAULT '[]',
  output TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  cloud_id TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflow_metrics (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'number',
  unit TEXT,
  value TEXT,
  cloud_id TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs(workflow_id);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_metrics_workflow_key_idx ON workflow_metrics(workflow_id, key);
`;

MIGRATIONS.push(WORKFLOWS_MIGRATION);

// Pins a workflow onto a dashboard so its metrics show as a card. Mirrors the
// resource `dashboard_pins` table (incl. cloud-sync columns) but references a
// workflow instead of a resource.
const DASHBOARD_WORKFLOW_PINS_MIGRATION = `
CREATE TABLE IF NOT EXISTS dashboard_workflow_pins (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  grid_x INTEGER NOT NULL DEFAULT 0,
  cloud_id TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dashboard_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS dashboard_workflow_pins_dashboard_idx ON dashboard_workflow_pins(dashboard_id);
`;

MIGRATIONS.push(DASHBOARD_WORKFLOW_PINS_MIGRATION);

// Cooldown state for `infra.page(...)`, one row per (workflow, page key). A
// monitoring cron finds the same problem every tick, so a repeat page under the
// same key is suppressed until its cooldown elapses. Mirrors the cloud's
// `workflow_pages` table; desktop pages are delivered as OS notifications and
// never leave the machine, so there is no cloud-sync column here.
const WORKFLOW_PAGES_MIGRATION = `
CREATE TABLE IF NOT EXISTS workflow_pages (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  last_paged_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workflow_id, key)
);
`;

MIGRATIONS.push(WORKFLOW_PAGES_MIGRATION);

const AGENTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS agent_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  resource_type_id TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT 'codex',
  fields_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  project_name TEXT NOT NULL,
  workspace_name TEXT,
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  resource_type_id TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT 'codex',
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  vm_resource_id TEXT,
  logs_json TEXT NOT NULL DEFAULT '[]',
  setup_plan_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agent_sessions_status_idx ON agent_sessions(status);
`;

MIGRATIONS.push(AGENTS_MIGRATION);

const AGENT_WORKSPACE_NAME_MIGRATION = `
ALTER TABLE agent_sessions ADD COLUMN workspace_name TEXT;
UPDATE agent_sessions
SET workspace_name = project_name
WHERE workspace_name IS NULL OR workspace_name = '';
`;

MIGRATIONS.push(AGENT_WORKSPACE_NAME_MIGRATION);

const AGENT_SETUP_PLAN_MIGRATION = `
ALTER TABLE agent_sessions ADD COLUMN setup_plan_json TEXT NOT NULL DEFAULT '{}';
`;

MIGRATIONS.push(AGENT_SETUP_PLAN_MIGRATION);

// Env vars delivered to the agent VM (static + templated from created
// resources) and the resources .infrawrench/agent.json asked us to create
// for this session, so Delete can clean them up.
const AGENT_REPO_CONFIG_MIGRATION = `
ALTER TABLE agent_sessions ADD COLUMN setup_env_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_sessions ADD COLUMN created_resources_json TEXT NOT NULL DEFAULT '[]';
`;

MIGRATIONS.push(AGENT_REPO_CONFIG_MIGRATION);

// How the session is driven: "terminal" (the tool's CLI attached in an SSH
// tab) or "t3-code" (the T3 Code server drives the same CLI, and is used
// from T3 Code's own client). Orthogonal to `tool` — T3 Code is a control
// surface, not an agent, so a T3 Code session still installs codex or claude.
const AGENT_SURFACE_MIGRATION = `
ALTER TABLE agent_sessions ADD COLUMN surface TEXT NOT NULL DEFAULT 'terminal';
ALTER TABLE agent_settings ADD COLUMN surface TEXT NOT NULL DEFAULT 'terminal';
`;

MIGRATIONS.push(AGENT_SURFACE_MIGRATION);
