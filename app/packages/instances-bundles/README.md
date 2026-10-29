# instances-bundles.infrawrench.com

A Cloudflare Worker that serves the `instances-bundles` R2 bucket to any
Infrawrench user, agent or API key, from the edge cache where it can.

## Contract

```
GET  /<object key>
HEAD /<object key>
Authorization: Bearer <iwk_ API key | agent credential | WorkOS access token>
```

| Status | When                                                                                        |
| ------ | ------------------------------------------------------------------------------------------- |
| `200`  | The object. `ETag`, `Last-Modified`, `Accept-Ranges` and the uploaded `Content-Type`.       |
| `206`  | A `Range` request.                                                                          |
| `304`  | `If-None-Match` / `If-Modified-Since` matched.                                              |
| `401`  | No bearer token, or the API does not recognise it (unknown, revoked, expired, left org).    |
| `404`  | No such key.                                                                                |
| `405`  | Anything but `GET` / `HEAD`. There is no write path; upload with wrangler or the dashboard. |
| `503`  | The Infrawrench API could not be asked. Retry; this is not a verdict on the credential.     |

```sh
curl -fLO https://instances-bundles.infrawrench.com/v1/agent.tar.gz \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY"
```

Every credential the API accepts can read every object. Keep anything that
should be narrower out of this bucket.

## How it works

`src/index.ts` has the request flow. In short: the default entrypoint (not
cached) checks the credential against `GET /api/v1/whoami` over a service
binding to `infrawrench-web`, strips it, and forwards to the `Bundles`
entrypoint, which reads R2 and sits behind
[Workers Caching](https://developers.cloudflare.com/workers/cache/): tiered,
with concurrent misses collapsed, ranges sliced from the cached object, and
expired entries revalidated by ETag. A credential the API accepted is
remembered for 60 seconds per data centre, so revoking a key takes up to a
minute to stop downloads here.

Objects are cached at the edge for 5 minutes (then served stale while they
revalidate) unless they were uploaded with a `Cache-Control` of their own. For
a key whose content never changes, upload it that way:

```sh
pnpm --filter @infrawrench/instances-bundles exec wrangler r2 object put \
  instances-bundles/v1/agent.tar.gz --remote --file agent.tar.gz \
  --content-type application/gzip \
  --cache-control "public, max-age=31536000, immutable"
```

Set the real `--content-type` when you upload. The Worker does not guess one,
because a generic type that disagrees with the key's extension makes the cache
refuse to store it.

## Deploy

```sh
pnpm --filter @infrawrench/instances-bundles test
pnpm --filter @infrawrench/instances-bundles deploy
```

CI (`.github/workflows/instances-bundles-deploy.yml`) redeploys on any push to
`app/packages/instances-bundles/**`. The custom domain, the R2 binding and the
service binding all come from `wrangler.jsonc`. The web Worker has to serve
`/api/v1/whoami` (API 1.85.0) before this one can authenticate anyone.

## Local development

`wrangler dev` needs something answering the `API` binding. Run a stub
`infrawrench-web` alongside it with a second `-c` config, or point at the real
one with `"remote": true` on the binding.
