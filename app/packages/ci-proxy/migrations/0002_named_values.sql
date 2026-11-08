-- Secrets and variables for runs, by organisation (repo_id = '') or by
-- repository. A secret's value is AES-GCM sealed with the Worker's
-- SECRETS_KEY (`v1.<iv>.<ciphertext>`, base64), bound to its kind, owner,
-- repository and name; a variable's value is stored as written.
CREATE TABLE named_values (
  kind TEXT NOT NULL CHECK (kind IN ('secret', 'var')),
  owner TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, owner, repo_id, name)
);
