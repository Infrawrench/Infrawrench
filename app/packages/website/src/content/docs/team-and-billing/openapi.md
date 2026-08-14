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

Both runtime endpoints are public — they describe the API surface, not any private data. A running server advertises its own origin as the spec's `server`, so the "try it" panel on `/docs` talks to the deployment you're reading it on.

## Internal routes

A handful of routes exist only so our own clients (and third-party webhook senders) can talk to the server. They carry no stability promise, so they're **excluded from `/docs` and `/openapi.json`**:

| Route                                                  | Why it's internal                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `/api/admin/*`                                         | Platform-operator surface, gated on an email allowlist — 403 for everyone else. |
| `/api/v1/webhooks/*`                                   | Inbound, signature-verified calls from third parties. Never called by you.      |
| `/api/auth/sign-in`, `/api/auth/sign-out`, `/callback` | Browser redirect flow for the session cookie.                                   |
| `/api/v1/sync/*`                                       | Bi-directional resource sync used by the desktop app.                           |
| `/api/org/{orgId}/ws-token`                            | Mints short-lived tokens for our WebSocket gateway.                             |
| `/api/push/*`, `/api/org/{orgId}/push/*`               | Mobile push-notification device registration and preferences.                   |

They're still in the source and in the checked-in `app/packages/web/openapi.json`, tagged with an `x-internal: true` extension — the server strips those operations (and any schemas only they used) before publishing the spec. Build against them at your own risk; they can change or disappear without notice.

![Screenshot of /docs Scalar reference UI showing the Resources tag expanded](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/openapi/docs-resources-tag.png)

## SDK code samples

Every operation on `/docs` carries an `x-codeSamples` entry per [client SDK](./client-sdks.md), so the code panel shows the call the way each generated client actually spells it — `client.accounts.sync({ id })` in TypeScript, `client.Accounts.Sync(ctx, …)` in Go, `client.resources().secretVersions().add(…)` in Java — alongside the generic curl/HTTP snippets. Pick the language in the client selector above the example.

The samples are rendered from the same intermediate representation the SDK generator consumes, so they cannot drift from the published packages: renaming a call in the generator renames it in the docs in the same commit. They exist only on the _served_ spec (`/openapi.json` and `/docs`) — the committed `app/packages/web/openapi.json` stays snippet-free so its diffs show API surface changes rather than re-rendered examples.

![Screenshot of a /docs operation with the client picker open, showing the nine SDK sample entries and the TypeScript sample selected](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/openapi/docs-client-picker-typescript.png)

## Authentication

The published spec advertises a single scheme:

- **`bearerAuth`** — a WorkOS access token (JWT) or an Infrawrench [API key](./api-keys.md). Send it as `Authorization: Bearer <token>`.

```sh
curl https://app.infrawrench.com/api/org/$ORG_ID/accounts \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

The server also accepts the `wos-session` cookie — that's how the web UI authenticates — but the only way to get one is the browser sign-in redirect, which is [internal](#internal-routes). It's left out of the published spec so generated snippets and Scalar's "try it" panel default to bearer auth.

API keys must include the right scope for the operation. Scopes are **permission strings** — the same vocabulary used for [roles](./roles-and-permissions.md). Every operation that requires a permission carries an `x-required-permission` extension naming it, e.g.:

```yaml
post:
  summary: Create an account
  x-required-permission: accounts:write
```

The `Permission` enum component lists every recognised scope. Granted scopes can use wildcards (`resources:*:read`, `*`). Older keys created with `sync:read` / `sync:write` are migrated automatically the next time they authenticate to `resources:read` / `resources:write`.

A key's scopes are a ceiling, not a grant: the server intersects them with the current role of the user who created the key, so `x-required-permission` must be satisfied by **both**. See [API keys](./api-keys.md#keys-are-bounded-by-their-owner).

### What a key can reach

Every operation under `/api/org/{orgId}/` accepts an API key, with five exceptions listed below. A key is pinned to the organization it was minted in — presenting it against another org's `{orgId}` is a `403`, whatever the key holds — and it is checked against exactly the same `x-required-permission` a signed-in user is. Widening authentication to keys did not widen authorization: an operation a Member cannot perform in the browser is one a `*`-scoped key held by that Member cannot perform either.

These operations are **closed to API keys** and answer `403` with an explanatory `error`, even for a key scoped `*` held by an Owner:

| Operations                                          | Why                                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All of `/api/org/{orgId}/api-keys`                  | A key that can mint keys can mint a longer-lived one, so revoking it would not end the access. Reads go with it — enumerating an org's credentials is reconnaissance. |
| All of `/api/org/{orgId}/billing`                   | Subscription and payment changes. Every response is a Stripe URL meant for a browser.                                                                                 |
| All of `/api/org/{orgId}/push`                      | Device registration and per-device notification preferences describe a person's phone.                                                                                |
| `POST`/`PUT`/`PATCH`/`DELETE` on `/team`            | Invites, role assignment and member removal manufacture or destroy durable authority for other people. `GET` still works, so automation can inventory members.        |
| `POST`/`PUT`/`PATCH`/`DELETE` on `/access-requests` | Break-glass exists to put a human in the loop. `GET` still works, so a monitor can watch the queue.                                                                   |

Three more surfaces are unreachable because they are not org-scoped at all and never accepted bearer credentials: `/api/profile/*` (password, MFA, email change, session revocation), `/api/orgs` (creating and deleting organizations), and `/api/admin/*`. The account-security operations under `/api/profile` additionally require a recent interactive sign-in, which no bearer principal can satisfy.

### The one unauthenticated route

`GET /api/status/{slug}` takes no credentials at all. It serves a
[public status page](../features/status-pages.md), which exists precisely for callers who have no
account, so it carries no `x-required-permission` and needs no bearer token. Sending one is
pointless and slightly worse than pointless — the endpoint is meant to be anonymous.

Everything else in the spec requires authentication. The slug is the page's only access control, so
treat it like a credential you have chosen to share: an unpublished page and an unknown slug both
answer 404, and the page's owner can revoke a leaked link by rotating the slug.

## Generating client SDKs

There are first-party [client SDKs](./client-sdks.md) for nine languages —
TypeScript, Python, Ruby, Go, Java, C#, PHP, Swift and Rust — generated from
this spec, MIT-licensed, with calls namespaced to match the routes
(`client.accounts.sync({ id })`). Reach for those first. Build them from a
checkout with:

```sh
pnpm --filter @infrawrench/web generate:sdk
```

For a language we don't ship, the spec carries a stable `operationId` on every
operation, so any OpenAPI generator works:

```sh
openapi-generator-cli generate -i openapi.json -g kotlin -o ./client
```

## Regenerating the spec after a change

The spec is built by walking the plugin registry, so any time you add/remove a plugin or resource type the spec changes. To refresh:

```sh
pnpm --filter @infrawrench/web generate:openapi
```

Commit the resulting `openapi.json` so PR diffs show API surface changes. That
command also refreshes the [generated SDKs](./client-sdks.md) if the API
version changed; they're build output and are not committed.

## Strictness

- Every request and response body has a Zod schema. Object schemas use `additionalProperties: false` unless they wrap genuinely free-form plugin data (in which case the schema is named `JsonObject` and explicitly opted in to `additionalProperties: true`).
- `pluginId` and `typeId` path parameters are typed as enums of the live plugin / resource-type IDs.
- `resourceId` follows the host's composite shape `pluginId:accountId:externalId` and is regex-validated in the schema.
- Error responses share a single `Error` schema (`{ error: string }`), except the step-up 403 described below.
- A handful of account-security operations under `/api/profile` return a `ReauthenticationRequired` 403 (`{ error, code: "reauthentication_required" }`) when the caller's sign-in is not recent enough. Branch on `code`, not the message: the request was well-formed and will succeed once the user signs in again. Bearer principals never satisfy this check — these operations are browser-only by design.
