# maven.infrawrench.com

The Maven repository the Java SDK (`com.infrawrench:infrawrench-sdk`) is published
to: a Worker in front of the `infrawrench-maven` R2 bucket. Reads are public; writes
need the deploy credentials. `src/index.ts` has the rules.

## Why it exists

Maven Central stopped accepting our releases: we went over its monthly release-size
limit, and since October 1, 2026 it requires a paid Publisher Pro subscription for
generated clients of a commercial product regardless of volume. Versions up to
1.90.0 stay on Central; later ones are here. A consumer with this repository
configured resolves both, because Maven falls through to Central.

The catch is that Central is the only repository Maven checks by default, so Java
users have to add this one to their build. See
`app/packages/website/src/content/docs/team-and-billing/client-sdks.md`.

## Deploying

Pushes to `main` that touch this package deploy it. The first deploy needs the
bucket and the write credentials to exist:

```sh
pnpm --filter @infrawrench/maven-repository exec wrangler r2 bucket create infrawrench-maven

PASSWORD=$(openssl rand -hex 32)
cd app/packages/maven-repository
echo ci | npx wrangler secret put DEPLOY_USERNAME
echo "$PASSWORD" | npx wrangler secret put DEPLOY_PASSWORD
gh secret set MAVEN_REPO_USERNAME --env release --body ci
gh secret set MAVEN_REPO_PASSWORD --env release --body "$PASSWORD"
```

Until `DEPLOY_USERNAME` and `DEPLOY_PASSWORD` are set, every write gets a 401.

## Publishing to Central as well

`.github/workflows/publish-sdks.yml` only attempts Central when the repository
variable `MAVEN_CENTRAL_PUBLISH` is `true`, and a failure there does not fail the
release. Leave it off unless we have Publisher Pro or an exemption.
