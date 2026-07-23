# registry.infrawrench.com — container registry on Cloudflare Workers

A deployment of [Infrawrench/serverless-registry](https://github.com/Infrawrench/serverless-registry) —
our fork of [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry)
(Docker Registry v2 API on a Worker, blobs in R2). It holds the bastion agent
image pushed by `.github/workflows/bastion-deploy.yml`:

- `registry.infrawrench.com/bastion-agent:<commit sha>`
- `registry.infrawrench.com/bastion-agent:latest`

The fork adds one feature over upstream: an `ANONYMOUS_PULL` env var. With it
set to `"true"` (as deployed), **pulls are public** — GET/HEAD requests need no
credentials, so `docker pull registry.infrawrench.com/bastion-agent:latest`
just works. This also makes read-only discovery endpoints (`/v2/_catalog`,
`/v2/<name>/tags/list`) public, so don't push anything secret here. Pushes and
deletes still require basic auth: the CI credentials live in the repo secrets
`REGISTRY_USERNAME` / `REGISTRY_PASSWORD` and in the Worker's `USERNAME` /
`PASSWORD` secrets.

## Deploying / upgrading the Worker

Only `wrangler.jsonc` here is ours; the Worker code lives in the fork
(deployed at fork commit `6d3601c`). To pull in upstream changes, merge
upstream `main` into the fork's `main` (our anonymous-pull commit sits on top),
then redeploy:

```sh
git clone git@github.com:Infrawrench/serverless-registry.git
cp infra/registry/wrangler.jsonc serverless-registry/wrangler.jsonc
cd serverless-registry
pnpm install
pnpm test        # includes the anonymous-pull suite
pnpm run deploy  # wrangler deploy --minify --env production
```

The R2 bucket (`infrawrench-registry`) and the custom domain are created
automatically by wrangler / the route config. Rotating credentials:

```sh
npx wrangler secret put USERNAME --env production
npx wrangler secret put PASSWORD --env production
gh secret set REGISTRY_USERNAME --repo Infrawrench/Infrawrench
gh secret set REGISTRY_PASSWORD --repo Infrawrench/Infrawrench
```

## Limits

- `docker push` works for layers up to 500 MB (Worker request-body chunking
  limit). The bastion image is far below this; for anything bigger, upstream
  ships a chunked-upload tool in its `push/` folder.
- Multi-arch manifests (OCI image index) are supported — CI pushes
  `linux/amd64` + `linux/arm64`.
