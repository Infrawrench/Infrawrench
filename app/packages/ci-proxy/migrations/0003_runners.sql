-- The runners runs are placed on, set by `PUT /v1/runners` (the Terraform
-- that provisions the hosts calls it). When this table is empty the proxy
-- falls back to the RUNNERS variable.
CREATE TABLE runners (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
