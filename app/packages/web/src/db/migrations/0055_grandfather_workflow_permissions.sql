-- Data migration (no schema change): grandfather pre-split dashboard grants
-- onto the dedicated workflow permissions.
--
-- Workflows had no permissions of their own until the release this migration
-- ships with: the workflow routes, the workflow MCP tools and the approve/deny
-- endpoints all checked `dashboards:read` / `dashboards:write`. Every grant
-- stored before this deploy was therefore, in practice, also a grant of
-- workflow access. Two tables store such grants verbatim and would silently
-- lose it: custom role rows (`roles.permissions`) and API-key scopes
-- (`api_keys.scopes`). System roles resolve from code and need nothing.
--
-- Doing it here, once, rather than expanding at request time is the point:
-- "was this grant written before the split?" is knowable exactly at deploy
-- time and only guessable afterwards. After this runs there is no timestamp
-- heuristic anywhere, and a grant written tomorrow means exactly what it says
-- — including a custom role that deliberately withholds `workflows:approve`
-- from the people who may edit workflows, which is the whole point of the
-- split.
--
-- Wildcards are honoured, never rewritten. Per `hasPermission` in
-- `server-core/src/permissions/catalog.ts`, an entry matches a two-segment
-- permission `a:b` only if it is `*`, `*:*`, `a:*`, `*:b`, or the literal
-- `a:b` — that enumeration is exhaustive, and it is what the IN lists below
-- spell out. Consequences: a row holding `*` already matches every workflow
-- permission and is left untouched; a row holding `dashboards:*` keeps its
-- wildcard and gains the three explicit workflow entries beside it. Nothing is
-- ever removed, and nothing is appended that the row already matches, so every
-- statement is idempotent.
UPDATE "roles"
SET "permissions" = "permissions" || '["workflows:read"]'::jsonb
WHERE "is_system" = false
	AND jsonb_typeof("permissions") = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("permissions") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:read', '*:write', 'dashboards:*', 'dashboards:read', 'dashboards:write')
	)
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("permissions") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:read', 'workflows:*', 'workflows:read')
	);--> statement-breakpoint
UPDATE "roles"
SET "permissions" = "permissions" || '["workflows:write"]'::jsonb
WHERE "is_system" = false
	AND jsonb_typeof("permissions") = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("permissions") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:write', 'dashboards:*', 'dashboards:write')
	)
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("permissions") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:write', 'workflows:*', 'workflows:write')
	);--> statement-breakpoint
-- Deciding an approval request used to take `dashboards:write`, so the same
-- grant carries `workflows:approve` too.
UPDATE "roles"
SET "permissions" = "permissions" || '["workflows:approve"]'::jsonb
WHERE "is_system" = false
	AND jsonb_typeof("permissions") = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("permissions") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:write', 'dashboards:*', 'dashboards:write')
	)
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("permissions") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:approve', 'workflows:*', 'workflows:approve')
	);--> statement-breakpoint
-- Revoked keys are skipped: they can never authenticate again, so expanding
-- them would only make a dead row read as holding scopes nobody ticked.
UPDATE "api_keys"
SET "scopes" = "scopes" || '["workflows:read"]'::jsonb
WHERE "revoked_at" IS NULL
	AND jsonb_typeof("scopes") = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("scopes") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:read', '*:write', 'dashboards:*', 'dashboards:read', 'dashboards:write')
	)
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("scopes") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:read', 'workflows:*', 'workflows:read')
	);--> statement-breakpoint
UPDATE "api_keys"
SET "scopes" = "scopes" || '["workflows:write"]'::jsonb
WHERE "revoked_at" IS NULL
	AND jsonb_typeof("scopes") = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("scopes") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:write', 'dashboards:*', 'dashboards:write')
	)
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("scopes") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:write', 'workflows:*', 'workflows:write')
	);--> statement-breakpoint
UPDATE "api_keys"
SET "scopes" = "scopes" || '["workflows:approve"]'::jsonb
WHERE "revoked_at" IS NULL
	AND jsonb_typeof("scopes") = 'array'
	AND EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("scopes") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:write', 'dashboards:*', 'dashboards:write')
	)
	AND NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements_text("scopes") AS g(entry)
		WHERE g.entry IN ('*', '*:*', '*:approve', 'workflows:*', 'workflows:approve')
	);
