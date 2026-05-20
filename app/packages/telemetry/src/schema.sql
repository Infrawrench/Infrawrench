CREATE TABLE IF NOT EXISTS telemetry_clients (
  token       TEXT PRIMARY KEY,
  os_version  TEXT,
  arch        TEXT,
  cpu         TEXT,
  ram_bytes   BIGINT,
  first_use   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_use    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
