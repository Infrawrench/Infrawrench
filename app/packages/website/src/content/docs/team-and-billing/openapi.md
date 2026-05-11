---
title: API reference (OpenAPI)
description: How to find, generate, and use the OpenAPI 3.1 spec for the Infrawrench cloud API.
sidebar_order: 6
---

> **Web only.** The desktop app has no public HTTP surface — it talks to plugins directly.

The Infrawrench cloud API is described by an OpenAPI 3.1 document that's **generated from the running server's plugin registry**. Plugin IDs and resource type IDs in the spec are real enums, not free-form strings — if a plugin isn't installed, its ID won't appear.

## Where to find it

| What                  | URL                                                         | Notes                                                                                     |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Interactive reference | [`/docs`](https://app.infrawrench.com/docs)                 | Scalar UI. Browseable, with try-it-out.                                                   |
| Raw spec              | [`/openapi.json`](https://app.infrawrench.com/openapi.json) | OpenAPI 3.1, served directly.                                                             |
| Build artifact        | `app/packages/web/openapi.json`                             | Checked into the repo. Regenerate with `pnpm --filter @infrawrench/web generate:openapi`. |

Both runtime endpoints are public — they describe the API surface, not any private data.

<insert [Screenshot of /docs Scalar reference UI showing the Resources tag expanded] here>

## Authentication

Every operation accepts one of:

- **`sessionCookie`** — the `wos-session` cookie set by `/callback`. Used by browser clients.
- **`bearerAuth`** — a WorkOS access token (JWT) or an Infrawrench [API key](./api-keys.md). Used by scripts and CI.

API keys must include the right scope for the operation. Scopes are **permission strings** — the same vocabulary used for [roles](./roles-and-permissions.md). Every operation that requires a permission carries an `x-required-permission` extension naming it, e.g.:

```yaml
post:
  summary: Create an account
  x-required-permission: accounts:write
```

The `Permission` enum component lists every recognised scope. Granted scopes can use wildcards (`resources:*:read`, `*`). Older keys created with `sync:read` / `sync:write` are migrated automatically the next time they authenticate to `resources:read` / `resources:write`.

## Generating client SDKs

The spec ships with `operationId` for every operation, so any OpenAPI generator works. Examples:

```sh
# TypeScript fetch client (openapi-typescript-codegen)
npx openapi-typescript-codegen --input openapi.json --output ./client --client fetch

# Python (openapi-python-client)
openapi-python-client generate --path openapi.json
```

## Regenerating the spec after a change

The spec is built by walking the plugin registry, so any time you add/remove a plugin or resource type the spec changes. To refresh:

```sh
pnpm --filter @infrawrench/web generate:openapi
```

Commit the resulting `openapi.json` so PR diffs show API surface changes.

## Strictness

- Every request and response body has a Zod schema. Object schemas use `additionalProperties: false` unless they wrap genuinely free-form plugin data (in which case the schema is named `JsonObject` and explicitly opted in to `additionalProperties: true`).
- `pluginId` and `typeId` path parameters are typed as enums of the live plugin / resource-type IDs.
- `resourceId` follows the host's composite shape `pluginId:accountId:externalId` and is regex-validated in the schema.
- Error responses share a single `Error` schema (`{ error: string }`).
