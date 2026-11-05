---
title: API reference (OpenAPI)
description: Find and use the OpenAPI 3.1 spec for the Infrawrench cloud API, including authentication, API key limits and SDK samples.
sidebar_order: 6
---

> **Web only.** The desktop app has no public HTTP API.

The Infrawrench cloud API is described by an OpenAPI 3.1 document. Plugin IDs and resource type IDs in the spec are real enums, not free-form strings. If a plugin isn't installed, its ID won't appear.

## Where to find it

| What                  | URL                                                         | Notes                                   |
| --------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Interactive reference | [`/docs`](https://app.infrawrench.com/docs)                 | Scalar UI. Browseable, with try-it-out. |
| Raw spec              | [`/openapi.json`](https://app.infrawrench.com/openapi.json) | OpenAPI 3.1, served directly.           |

Both are public. They describe the API, not any private data. The "try it" panel on `/docs` talks to the deployment you're reading it on.

![Screenshot of /docs Scalar reference UI showing the Resources tag expanded](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/openapi/docs-resources-tag.png)

## Internal routes

A few routes exist only for Infrawrench's own clients and for third-party webhook senders. They carry no stability promise, so they're **left out of `/docs` and `/openapi.json`**:

| Route                                                  | What it's for                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `/api/admin/*`                                         | Platform operators only. Returns 403 for everyone else.                     |
| `/api/v1/webhooks/*`                                   | Inbound, signature-verified calls from third parties. You never call these. |
| `/api/auth/sign-in`, `/api/auth/sign-out`, `/callback` | Browser sign-in redirects.                                                  |
| `/api/v1/sync/*`                                       | Resource sync used by the desktop app.                                      |
| `/api/org/{orgId}/ws-token`                            | Short-lived tokens for live updates in the app.                             |
| `/api/push/*`, `/api/org/{orgId}/push/*`               | Mobile push-notification device registration and preferences.               |

If you build against them anyway, expect them to change or disappear without notice.

## SDK code samples

Every operation on `/docs` shows a code sample for each [client SDK](./client-sdks.md), spelled the way that client spells it: `client.accounts.sync({ id })` in TypeScript, `client.Accounts.Sync(ctx, …)` in Go, `client.resources().secretVersions().add(…)` in Java. Generic curl and HTTP snippets are there too. Pick the language in the client selector above the example.

The samples always match the published packages.

![Screenshot of a /docs operation with the client picker open, showing the nine SDK sample entries and the TypeScript sample selected](https://agent-assets.infrawrench.com/docs-screenshots/team-and-billing/openapi/docs-client-picker-typescript.png)

## Authenticate

The spec uses one scheme:

- **`bearerAuth`**: a WorkOS access token (JWT), an Infrawrench [API key](./api-keys.md) (`iwk_`), or an [agent credential](../features/agent-auth.md) (`iwa_`). Send it as `Authorization: Bearer <token>`.

```sh
curl https://app.infrawrench.com/api/org/$ORG_ID/accounts \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

The [instance pricing SQL API](./instance-pricing-api.md) (`/api/v1/instance-pricing/*`, formerly `/api/v1/aws-pricing/*`) works the same way: any of the three credentials, no scope, no organization in the path.

### Check a credential

Call `GET /api/v1/whoami` to check a credential or find out whose it is. It accepts all three kinds and needs no scope and no organization in the path. It returns `userId`, `organizationId` and `principal` (`user`, `api_key` or `agent`). A `401` means the credential is unknown, revoked or expired, or its owner has left the organization.

```sh
curl https://app.infrawrench.com/api/v1/whoami \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

### Agent links and agent registration

Linked platforms call the `/api/agent-link` routes with a link credential (`iwl_`), listed as the **`agentLinkCredential`** scheme. It reaches only the link and the agents it made. The device flow that hands it out, `POST /api/agent-links/requests` and `POST /api/agent-links/requests/token`, takes no authentication and is rate limited per source address. See [agent links](../features/agent-links.md).

The three `/api/agent/*` registration routes are the other exception. `POST /api/agent/identity` takes no authentication at all, since it's how a client with no credentials gets one. It's rate limited per source address instead. See [agent authentication](../features/agent-auth.md).

The web UI signs in with a `wos-session` cookie. You can only get one through the browser sign-in, so it isn't in the published spec. Use bearer auth.

### Scopes

API keys need the right scope for each operation. Scopes are **permission strings**, the same ones used for [roles](./roles-and-permissions.md). Every operation that needs a permission names it in an `x-required-permission` extension, for example:

```yaml
post:
  summary: Create an account
  x-required-permission: accounts:write
```

The `Permission` enum component lists every recognised scope. Granted scopes can use wildcards (`resources:*:read`, `*`). Older keys created with `sync:read` / `sync:write` are switched to `resources:read` / `resources:write` automatically the next time they're used.

A key's scopes are a ceiling, not a grant. The key can only do what both its scopes and the current role of the user who created it allow. See [API keys](./api-keys.md#keys-are-bounded-by-their-owner).

### What a key can reach

Every operation under `/api/org/{orgId}/` accepts an API key, with the exceptions below. A key only works in the organization it was created in. Using it against another org's `{orgId}` returns `403`, whatever scopes it holds. A key is checked against the same `x-required-permission` as a signed-in user, so anything a Member can't do in the browser, a `*`-scoped key held by that Member can't do either.

These operations are **closed to API keys** and return `403` with an explanatory `error`, even for a `*` key held by an Owner:

| Operations                                          | Why                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| All of `/api/org/{orgId}/api-keys`                  | A key that could create keys could create a longer-lived one, so revoking it wouldn't end the access. |
| All of `/api/org/{orgId}/billing`                   | Subscription and payment changes, and the purchase measurement a checkout carries. For browsers only. |
| All of `/api/org/{orgId}/push`                      | Device registration and notification preferences describe a person's phone.                           |
| `POST`/`PUT`/`PATCH`/`DELETE` on `/team`            | Invites, role changes and member removal. `GET` still works, so automation can list members.          |
| `POST`/`PUT`/`PATCH`/`DELETE` on `/access-requests` | Break-glass access needs a human in the loop. `GET` still works, so a monitor can watch the queue.    |

Three more areas never accept bearer credentials at all: `/api/profile/*` (password, MFA, email change, session revocation), `/api/orgs` (creating and deleting organizations), and `/api/admin/*`. The account-security operations under `/api/profile` also need a recent interactive sign-in.

### The one public route

`GET /api/status/{slug}` takes no credentials. It serves a [public status page](../features/status-pages.md), which is meant for people with no account, so don't send a bearer token to it.

Everything else in the spec needs authentication. The slug is the page's only access control, so treat it like a credential you've chosen to share. An unpublished page and an unknown slug both return 404, and the page's owner can revoke a leaked link by rotating the slug.

## Client SDKs

There are [client SDKs](./client-sdks.md) for nine languages: TypeScript, Python, Ruby, Go, Java, C#, PHP, Swift and Rust. They're MIT-licensed, with calls named to match the routes (`client.accounts.sync({ id })`). Use those first. To build them from a checkout:

```sh
pnpm --filter @infrawrench/web generate:sdk
```

For any other language, every operation has a stable `operationId`, so any OpenAPI generator works:

```sh
openapi-generator-cli generate -i openapi.json -g kotlin -o ./client
```

## Self-hosting: refresh the spec

The spec reflects the plugins and resource types your server has installed. After adding or removing one, regenerate it:

```sh
pnpm --filter @infrawrench/web generate:openapi
```

## Request and response rules

- Object schemas reject unknown fields, except where they hold free-form plugin data (those schemas are named `JsonObject`).
- `pluginId` and `typeId` path parameters only accept installed plugin and resource type IDs.
- `resourceId` has the shape `pluginId:accountId:externalId`.
- Errors share one `Error` schema (`{ error: string }`), except the re-authentication 403 below.
- Some account-security operations under `/api/profile` return a `ReauthenticationRequired` 403 (`{ error, code: "reauthentication_required" }`) when your sign-in isn't recent enough. Branch on `code`, not the message. The request will succeed once the user signs in again. These operations only work in the browser.
