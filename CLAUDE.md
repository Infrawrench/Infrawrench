Plugins should have all their logic encapsulated within them. The base should be as generic as possible, and then each plugin should handle everything. We don't want the electron code to have platform specific stuff. Update KNOWLEDGE.md as the project grows.

All code must be formatted with Prettier. Run `pnpm format` to format the entire project, or `pnpm format:check` to verify. The config is in `.prettierrc` at the root.

When you make changes to content that isn't specific to either web or desktop, make sure to implement on the other. Prefer sharing code where it makes sense to do so.

When you make code for providers remember that the user shouldn't have to know the API. If it needs a resource or a slug of some kind, add a picker. Also remember this replaces the cloud dash by in large and is not a replacement to it. If you add something, think about how the user can edit it if possible. Look online to verify API's, assume your memory is wrong. Make sure to include all possible metrics/side tools where possible. When you want a logo SVG, please also look online. You aren't good at freestyling logos.

## Documentation

User-facing docs live in `app/packages/website/src/content/docs/`, organized by section:

- `getting-started/` — install, sign-up, first account
- `core-concepts/` — resources, accounts, output references, secret rerolls, desktop vs web
- `features/` — per-feature pages (SSH, SQL editor, KV console, dashboards, etc.)
- `plugins/` — one page per provider plugin
- `team-and-billing/` — org-level concerns (invites, roles, billing, audit log, SSH keys, API keys)

Each doc is a markdown file with frontmatter:

```yaml
---
title: Page title
description: One-line summary used for the doc index card and meta description.
sidebar_order: 3 # optional; lower numbers come first within a section
---
```

Internal links use relative paths with `.md` extensions (e.g. `[Add an account](./add-first-account.md)`, `[SSH](../features/ssh-terminal.md)`). The build strips `.md` so they resolve to the routed URLs.

When you change behavior the user can see, update the docs in the same change:

- **New plugin** — add `app/packages/website/src/content/docs/plugins/<plugin-id>.md`. Cover the auth method (PAT, OAuth, kubeconfig…), what resources it lists, and any quirks.
- **New feature or significant UX change** — update or add a page under `features/`.
- **Auth / cloud-sync / billing change** — update the relevant page under `getting-started/`, `core-concepts/`, or `team-and-billing/`.
- **Renamed UI string or moved menu item** — search docs for the old string (`grep -r "<old name>" app/packages/website/src/content/docs`) and update.
- **HTTP API change** (new/changed/removed route, new auth scope, changed request/response shape) — update the matching Zod schema in `app/packages/web/src/api/openapi/paths/`, run `pnpm --filter @infrawrench/web generate:openapi` to refresh `openapi.json`, and update `app/packages/website/src/content/docs/team-and-billing/openapi.md` if the change affects auth, scopes, generation workflow, or anything else covered there.

Screenshots are referenced inline as a one-line shorthand:

```
<insert [Brief description of the screenshot needed] here>
```

The build replaces these with a styled "Screenshot needed" placeholder. Put each `<insert ... here>` on its own line and describe what should be captured (which screen, what state, which data is highlighted). Don't fabricate images or commit binary screenshots without being asked — leave the placeholder so a human can capture the real thing.

After any docs change, verify the site still builds:

```
pnpm --filter @infrawrench/website build
```

### IMPORTANT: list new screenshots at the end of every response that touches docs

When you finish a response that adds or modifies docs, end the response with a clearly delimited section listing every screenshot placeholder you added or changed. Use this exact format so the user can scan it at a glance:

```
## 📸 Screenshots needed

- `app/packages/website/src/content/docs/<path>.md` — <description copied from the placeholder>
- `app/packages/website/src/content/docs/<path>.md` — <description copied from the placeholder>
```

NEVER EVER EVER add this into files.

Rules:

- **Always include this section, even if zero new screenshots were added** — in that case write `_None — no new screenshot placeholders in this change._` so the user knows you checked.
- Only list placeholders you **added or modified** in this change, not pre-existing ones in untouched files.
- One bullet per placeholder, in document order. If a single doc page has several, list them all.
- Quote the description verbatim from inside the `[ ]` brackets.
- Put this section at the very end of your response, after any other summary, so it is the last thing the user sees.
