/**
 * SQLite schema for the desktop app — same tables as the web app
 * but without organization_id (single-user, local).
 *
 * Migrations are run at startup in the Electron main process (electron/main.ts).
 */

export const MIGRATIONS = [
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
] as const;
