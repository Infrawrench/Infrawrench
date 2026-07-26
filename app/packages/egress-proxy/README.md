# egress.infrawrench.com — the workflow egress proxy

A one-endpoint Cloudflare Worker that makes a workflow's `fetch()` requests on
its behalf. It exists for a single reason: **workflow code must not make HTTP
requests from inside the Kubernetes cluster it runs in.**

The isolate runs in the `web` and `poller` pods on GKE. From there, a request to
`http://10.x.x.x/` reaches other pods, and one to `http://169.254.169.254/`
reaches the node's metadata server — which hands out the node service account's
credentials to anything that asks. Validating URLs in the pod doesn't close
that: the check and the socket are in the same place, so a hostname that
resolves to a private address (or a redirect to one) after the check passes
defeats it.

So the request is made from somewhere with no route to any of it. This Worker
runs on Cloudflare's edge — a different network, a different cloud, no VPC
peering to the GCP project. Cloudflare's own fetch cannot reach private address
space at all, so even a check that missed something lands nowhere.

The checks in `src/index.ts` are therefore the first line of defence rather than
the only one, which is what lets them be strict: private and loopback IP
literals, cluster DNS suffixes (`.svc`, `.cluster.local`, `.internal`), bare
single-label hostnames, non-HTTP schemes, and **every redirect hop re-validated**
rather than trusted because the first hop passed.

## Contract

```
POST /fetch
Authorization: Bearer <PROXY_TOKEN>

{ "url", "method", "headers", "bodyBase64"?, "timeoutMs", "maxBytes", "redirect" }
```

```jsonc
// 200
{ "response": { "status", "statusText", "url", "headers", "bodyBase64", "redirected" } }
// 4xx/5xx
{ "error": { "code": "blocked_host", "message": "…" } }
```

The caller is `server-core/src/workflows/fetch.ts`; the request is
`WorkflowFetchRequest` from `@infrawrench/workflow-runtime`, already validated
there. This Worker validates again anyway — anyone holding the token can call
it, so it can't assume a well-behaved caller.

`GET /health` needs no token, so uptime checks don't have to hold the secret.

A response body larger than `maxBytes` is an **error**, not a truncation: half a
JSON document that parses is worse than a failure the author can see.

## Deploy

```sh
pnpm --filter @infrawrench/egress-proxy exec wrangler secret put PROXY_TOKEN
pnpm --filter @infrawrench/egress-proxy deploy
```

CI (`.github/workflows/egress-proxy-deploy.yml`) redeploys on any push to
`app/packages/egress-proxy/**`. The custom domain comes from `wrangler.jsonc`.

The same token goes into the cluster as `WORKFLOW_FETCH_PROXY_TOKEN` (see
`infra/terraform/terraform.tfvars.example`) alongside
`WORKFLOW_FETCH_PROXY_URL=https://egress.infrawrench.com`. **Rotate both
together** — until the pods have the new value they'll get 401s, which surface
to workflow authors as `fetch() failed: Bad or missing proxy token.`

Without those two variables the cloud refuses `fetch()` outright rather than
falling back to an in-pod request. That's deliberate: a deployment that hasn't
stood up a proxy gets no outbound HTTP from workflows, not a quieter version of
the problem this Worker exists to solve.

## Not a general-purpose proxy

Don't reuse it for server-side HTTP the app itself makes (provider APIs, Slack,
Twilio). Those calls are ours, they're already scoped by credentials we control,
and routing them through a public Worker would add a hop, a shared rate limit,
and a second place to debug.
