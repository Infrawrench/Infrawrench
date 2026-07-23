# registry.infrawrench.com — container registry on Cloudflare Workers

A deployment of [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry)
(Docker Registry v2 API on a Worker, blobs in R2). It holds the bastion agent
image pushed by `.github/workflows/bastion-deploy.yml`:

- `registry.infrawrench.com/bastion-agent:<commit sha>`
- `registry.infrawrench.com/bastion-agent:latest`

All access — push **and** pull — requires basic auth. The CI credentials live
in the repo secrets `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` and in the
Worker's `USERNAME` / `PASSWORD` secrets. serverless-registry also supports
pull-only credentials via `READONLY_USERNAME` / `READONLY_PASSWORD` Worker
secrets if something ever needs pull access without push rights.

## Deploying / upgrading the Worker

The Worker code is upstream's, unmodified; only `wrangler.jsonc` here is ours.
Deployed at upstream commit `5f97b0ec60179337d01e5f69df944bef088396c9`.

```sh
git clone https://github.com/cloudflare/serverless-registry.git
cp infra/registry/wrangler.jsonc serverless-registry/wrangler.jsonc
cd serverless-registry
pnpm install
pnpm run deploy   # wrangler deploy --minify --env production
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
