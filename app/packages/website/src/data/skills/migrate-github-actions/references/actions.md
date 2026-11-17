# Replacing actions

There are no actions. Each `uses:` step is dropped, becomes workspace or job configuration, or becomes a command in the job's script. When an action is not listed here, read what it runs (its `action.yml` and entry point) and do that in the script: most wrap a CLI that runs in `env:bash-node@24` with `npx` or a pinned global install. Pin every version.

## Setup and checkout

| Action                                    | Replacement                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`                        | Drop it. Every job starts in the commit's files at `/app`. There is no `.git`; see `limits.md` for jobs that need history.                           |
| `actions/setup-node`, `pnpm/action-setup` | `using: env:bash-node@24` (Node 24, `npm`, `pnpm`, `npx`), and `workspace: { deps: [pnpm] }` instead of the install step.                            |
| `oven-sh/setup-bun`                       | `workspace: { deps: [bun] }` installs from `bun.lock`. Jobs run the scripts with `node`; there is no `bun` command, so `bun test` needs a cloud job. |
| `actions/setup-python`                    | `using: env:python@3.13`, and `deps: [pip]` (reads `pylock.toml` or `requirements.txt`; `- pip: { file: requirements/ci.txt }` for another).         |
| `actions/setup-go`                        | `using: env:go@1.27` (1.23 to 1.27), and `deps: [go]` for `go.sum`.                                                                                  |
| `shivammathur/setup-php`                  | `using: env:php@8.4` (8.1 to 8.5), and `deps: [composer]`.                                                                                           |
| `dtolnay/rust-toolchain`, `actions-rs/*`  | Rust does not compile in a job. Make the job a cloud job (`cloud: aws/vm` or similar) and install the toolchain in its script.                       |
| `ruby/setup-ruby`                         | `using: env:ruby@4.0` (or `@3.4`), and `deps: [bundler]` instead of `bundler-cache: true`; see `limits.md` for Rails.                                |
| `actions/setup-java`, `setup-dotnet`      | No environment for these yet. Make the job a cloud job with an `image:` that has the runtime.                                                        |

## Caches and files between jobs

| Action                                                                   | Replacement                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions/cache` for `node_modules`, `~/.npm`, `~/.cache/pip`, `~/go/pkg` | Drop it: `workspace.deps` installs are cached by the runners. Go's build cache is kept on its own.                                                                             |
| `actions/cache` for anything else                                        | `cache: { key, restore-keys, paths }` with `${{ hashFiles('...') }}` in the key. Saved only when the job passes. Pull requests save to a scope the default branch never reads. |
| `actions/cache` for `.turbo` or `.nx`                                    | Drop it and use the task cache instead (`task-cache:`), which skips whole jobs. See `monorepos.md`.                                                                            |
| `actions/upload-artifact` + `download-artifact` between jobs             | `artifacts: [dist]` on the producing job; every job that `needs:` it starts with those files where they were left.                                                             |
| `actions/upload-artifact` for people                                     | `downloads: [report.html]`, or `{ paths, retention: 7d, when: always }`. Text files are masked for secrets; binary files are not, so never put a secret in one.                |

## GitHub itself

Every one of these needs `github-token:` with the permissions it used, and `tools: [builtin:gh@2.104]` for the `gh` command. The token is for the run's own repository, lasts an hour from when the run starts, and is never given to a fork's pull request.

| Action                                                       | Replacement                                                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `softprops/action-gh-release`, `ncipollo/release-action`     | `gh release create "$TAG" dist/* --notes-file NOTES.md` with `github-token: { contents: write }`.                                                                                      |
| `peter-evans/create-pull-request`                            | Clone the repository in the script (the checkout has no `.git`), commit, push a branch and `gh pr create`, with `github-token: { contents: write, pull-requests: write }`.             |
| `actions/github-script`                                      | `gh api ...` in the script, or a Node script reading `GITHUB_TOKEN`.                                                                                                                   |
| `stefanzweifel/git-auto-commit-action` (formatters, codegen) | Make the job a check instead: `changes: fail` fails it when the formatter changes a file. To commit back, clone the repository in the script with `github-token: { contents: write }`. |
| `actions/labeler`, `actions/stale`, issue automation         | These react to events Infrawrench CI does not have. Keep them on GitHub Actions.                                                                                                       |

## Clouds and deployments

Credentials are lent, not stored: an admin turns a connection on for CI under **CI access**, and the job names it. Do not move cloud keys into secrets when a connection can be lent.

| Action                                                                          | Replacement                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws-actions/configure-aws-credentials`                                         | `using: env:aws@1.46` and `connections: [<connection name>]`: the `aws` CLI is signed in with the lent session.                                                                                                                                      |
| `google-github-actions/auth` + `setup-gcloud`                                   | `using: env:gcloud@593` and `connections: [<name>]`: `gcloud` and `bq` use the lent access token.                                                                                                                                                    |
| `azure/login`                                                                   | `using: env:az@2.92` and `connections: [<name>]`: `az` signs in with the lent service principal.                                                                                                                                                     |
| `azure/setup-kubectl`, `azure/k8s-*`, `deliverybot/helm`                        | `tools: [builtin:kubectl@1.37]` and `connections: [<cluster connection>]`, which writes a kubeconfig and sets `KUBECONFIG`. Helm has no builtin: run it in a cloud job.                                                                              |
| `webfactory/ssh-agent`, `appleboy/ssh-action`, `appleboy/scp-action`            | `ssh-keys: [<key name>]` (the key's owner turns on **Use in CI jobs**) or a lent SSH host connection, and `tools: [builtin:ssh@10.6]` (add `builtin:scp@10.6` for `scp`).                                                                            |
| `amondnet/vercel-action`                                                        | `tools: [builtin:vercel@65]`, `VERCEL_TOKEN` from a secret in `env:`, then `vercel deploy --prod --yes`.                                                                                                                                             |
| `cloudflare/wrangler-action`                                                    | `tools: [builtin:wrangler@4]`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `env:`, then `wrangler deploy`.                                                                                                                                 |
| `neondatabase/create-branch-action`                                             | `tools: [builtin:neon@9]`, `NEON_API_KEY` in `env:`, then `neon branches create ...`.                                                                                                                                                                |
| `docker/login-action`, `docker/build-push-action`, `docker/setup-buildx-action` | A build job: `cloud: aws/build` (CodeBuild), `gcp/build` (Cloud Build), `azure/build` (ACR Tasks) or `docker/build` (your own Docker host), with `docker build` and `docker push` in `run:`. Write the image digest to an output for the deploy job. |

## Testing and reporting

| Action                                                | Replacement                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `codecov/codecov-action`                              | Upload with Codecov's CLI in the script (`npx`), `CODECOV_TOKEN` in `env:`.                                                           |
| `dorny/test-reporter`, `mikepenz/action-junit-report` | Keep the JUnit file with `downloads: { paths: [junit.xml], when: always }`. The run page and the GitHub check show each job's result. |
| `microsoft/playwright-github-action`                  | Browsers do not run in a job. Run end-to-end browser tests as a cloud job with an image that has the browsers.                        |
