# Moving the monorepo to git.infrawrench.com

How `Infrawrench/Infrawrench` moves from GitHub to the forge, with GitHub kept as a push mirror so its Actions workflows go on running from mirror pushes. Nothing here has been done by the change that added this file: it built the three pieces (push mirrors, the issue importer, the plugingen switch) and this is the order to use them in.

- **Source of truth after cutover**: `https://git.infrawrench.com/Infrawrench/Infrawrench`.
- **GitHub after cutover**: a read-only copy that the forge pushes to. Its 23 workflows keep running, started by the mirror's pushes, by their schedules and by hand.
- **Direction**: forge to GitHub only. Nothing is ever fetched back, so anything pushed to GitHub directly is overwritten by the next mirror run.

The forge repository exists and has the full history (pushed in parts over HTTPS, as the docs' "Push a long history" describes). The steps start from there.

## 0. Before anything: deploy the pieces

1. **Create the new queue before the deploy that binds it.** The Worker now consumes `infrawrench-git-jobs` (mirror runs and issue import steps), and a deploy fails while a queue it names does not exist:

   ```sh
   node infra/git/setup.mjs --only queues
   ```

2. Merge the branch. `web-deploy` applies migration `0214_git_mirrors_and_issue_imports`; `git-deploy` waits for it and deploys the Worker and the UI.
3. Check **Settings > Mirrors** and **Settings > Import** show up for an administrator of a repository on the forge.

`ENCRYPTION_MASTER_KEY` is already one of the Worker's secrets; mirrors and imports seal their tokens with it and need nothing new.

## 1. Check the forge copy is complete

From a clone that still has GitHub as `origin` and the forge as `forge`:

```sh
git fetch origin --prune --tags
git ls-remote --heads --tags origin | sort > /tmp/github-refs
git ls-remote --heads --tags forge  | sort > /tmp/forge-refs
diff /tmp/github-refs /tmp/forge-refs
```

Every difference is a branch or tag the forge lacks or has at another commit. Push what is missing (`git push forge 'refs/remotes/origin/*:refs/heads/*'` for branches, then `git push forge --tags`). **Do not go on while the branches differ**: the first mirror run makes GitHub's branches equal to the forge's, and with the overwrite option on that deletes from GitHub every branch the forge does not have and no pattern excludes.

Branches worth deleting on GitHub first, rather than carrying over: merged feature branches and stale `worktree-agent-*` branches. Every branch pushed to the forge gets a branch page.

## 2. Freeze GitHub

1. Announce the freeze. From now until step 5 nobody merges or pushes on GitHub.
2. Merge or close what is open. Open pull requests are not carried over: push their branches to the forge (step 1 did, if they are branches of this repository), where each has a branch page.
3. Run step 1's comparison once more.

## 3. An identity for the mirror

The mirror pushes with one token. Give it an identity of its own so GitHub's rules can let it through and nobody else.

1. Create a GitHub user for it (for example `infrawrench-mirror`), add it to the `Infrawrench` organisation, and put it in a team of its own (for example `mirror`) with **Write** on the repository. A ruleset's bypass list takes teams, roles and GitHub Apps, not single users, which is why the team.
2. Signed in as that user, create a **fine-grained personal access token**: resource owner `Infrawrench`, only the `Infrawrench` repository, repository permissions **Contents: Read and write**, **Workflows: Read and write** (the repository has workflow files, and GitHub refuses a push that changes one without it) and **Metadata: Read-only**. Choose an expiry and put its date in a calendar: an expired token fails the mirror with "The remote refused the credential".

A GitHub App's installation token would also be accepted by GitHub, but it lasts an hour and a mirror stores one credential, so a personal access token it is.

## 4. Configure the mirror, and test it

On the forge, **Infrawrench/Infrawrench > Settings > Mirrors > Add mirror**:

| Field                | Value                                                      |
| -------------------- | ---------------------------------------------------------- |
| Address              | `https://github.com/Infrawrench/Infrawrench.git`           |
| User name            | `x-access-token`                                           |
| Token                | the token from step 3                                      |
| Exclude              | `refs/tags/**` and `dependabot/**`, one a line (see below) |
| Overwrite and delete | on                                                         |

**Exclude every tag for now (`refs/tags/**`).** The release workflows create their own tags on GitHub after they publish, and read them to know what is already out: `sdk-v*` (`publish-sdks.yml`), `terraform-provider-v*` (`publish-terraform-provider.yml`), `ci-runner-v*` (`ci-runner-release.yml`), `mobile-v*` (`mobile-release.yml`), `infraenv-v*` (`publish-infraenv.yml`), `vscode-v*` (`publish-vscode.yml`) and the desktop's `v*`. A tag made there does not exist on the forge, and a mirror that carries tags with overwrite on would delete it at its next run, after which the workflow would try to publish that version again. Excluded, tags are neither pushed nor deleted: GitHub keeps the ones it has and goes on making its own. Take the pattern out when a release pipeline moves to the forge and tags start there. `dependabot/**` is excluded for the same reason: those branches are made on GitHub.

The first run starts at once. With the two sides equal (step 1) it pushes nothing and shows **In sync**. Then prove a push goes through:

```sh
git switch -c mirror-test forge/main
git commit --allow-empty -m "chore: test the mirror"
git push forge mirror-test
git ls-remote origin refs/heads/mirror-test     # the same commit id, within seconds
git push forge :mirror-test
git ls-remote origin refs/heads/mirror-test     # gone
```

Then a push to `main` on the forge (a real change, or another empty commit) and check on GitHub that the commit arrived with the same id and that the workflows that run on a push to `main` started. `web-deploy`, `git-deploy`, `website-deploy` and the rest deploy from that run exactly as before.

What to know about how it pushes:

- It mirrors the forge's state, not single pushes: each run compares the two sides and pushes the difference, one run at a time, so the later of two pushes always wins.
- Once tags are mirrored (not yet, see above), they go at most three a push, because GitHub starts no workflow for tags that arrive more than three at once.
- A push from the mirror is a push by the token's user, so `github.actor` in a workflow is the mirror's user, not the person who pushed to the forge.
- A workflow that pushes back to this repository on GitHub is writing to the copy. Tags are covered by the exclusion above. The one workflow that pushes commits is `ai-cleanup.yml` (run by hand, `git push` to the branch it ran on): after cutover its push is refused by the ruleset of step 5, so do not run it until it pushes to the forge instead. `publish-sdks.yml` and `publish-terraform-provider.yml` push commits to the satellite repositories, not to this one, and are unaffected.

## 5. Lock GitHub down

1. **Ruleset** (Settings > Rules > Rulesets > New branch ruleset): target all branches, enable **Restrict creations**, **Restrict updates** and **Restrict deletions**, leave **Block force pushes** off for the bypass actor's sake, and put the `mirror` team in the bypass list as **Always**. Add the SDK publisher App to the bypass list only if a workflow still has to push a branch there. Leave tags without a ruleset for now: the release workflows create them with the workflow's own token.
2. **Turn off merging**: in Settings > General clear **Allow merge commits**, **Allow squash merging** and **Allow rebase merging** (GitHub requires one to stay enabled, so leave one and rely on the ruleset: nobody outside the bypass list can update a branch, a merge included). Turn off **Automatically delete head branches**.
3. Put a line at the top of the GitHub repository's description and a pinned issue: the repository is a mirror, changes go to git.infrawrench.com.
4. Remove direct push rights that are no longer needed (teams with Write other than `mirror`).

## 6. Run CI once

Infrawrench CI would otherwise run twice: once for the forge's push and once for the mirror's push to GitHub through the GitHub App.

1. **Stop the GitHub side.** The app has no switch for one GitHub repository: CI runs for every repository the Infrawrench GitHub App can see. On GitHub, open the organisation's **Settings > GitHub Apps > Infrawrench > Configure**, set **Repository access** to **Only select repositories** and leave `Infrawrench/Infrawrench` out. That also ends what else the app does with that repository through the App (pull request checks, filing GitHub issues, opening IaC pull requests there), all of which now belong on the forge.
2. **Check the forge side is on**: **Settings > CI** on the forge repository. It is on by default for an organisation's repositories on a paid plan. Its pipelines are the same `.infrawrench/ci/*.yml` files.
3. **Enter the CI secrets and variables again for the forge.** In the app, **CI > Secrets and variables** holds them per account, and the forge's namespace is an account of its own beside the GitHub one. Values are hidden once saved, so they have to be entered again from their sources (the names are listed under the GitHub account; `list_ci_values` prints them). Do the same for **CI access** (connections, SSH keys and resources lent to jobs): what was lent to the GitHub repository by name has to be lent to `git.infrawrench.com/Infrawrench/Infrawrench`.
4. Push a branch to the forge and check one run appears, from the forge, and none from GitHub.

GitHub Actions workflows that only test (`ci-runner.yml`; `linux-appserver.yml` and the Terraform provider's native checks have since moved to Infrawrench CI) run on pull requests and on pushes. With no pull requests on GitHub their pull request runs stop; their push runs on `main` continue from the mirror. Protected branches on the forge can require the Infrawrench CI checks instead.

## 7. Switch plugingen

1. On the forge, signed in as an account with write access to the repository, create a personal access token (`iwg_`, scope `repo:write`). An organisation API key (`iwk_`) cannot do this: opening issues and editing a branch page need a person.
2. On GitHub, add the secret `PLUGINGEN_FORGE_TOKEN` to the `release` environment, and set the repository variable `PLUGINGEN_TARGET` to `forge`. (`PLUGINGEN_FORGE_URL` and `PLUGINGEN_FORGE_REPOSITORY` default to `https://git.infrawrench.com` and `Infrawrench/Infrawrench`.)
3. Close the watcher's open pull requests and issues on GitHub and delete its `plugingen/*` branches there. The first forge run opens again whatever is still true.
4. Run **plugingen watch** once by hand (Actions > plugingen watch > Run workflow, on `main`) and read its summary.

The workflow stays on GitHub Actions: the mirror carries its file and its schedule. It checks out the mirror's `main` and pushes `plugingen/<plugin>` to the forge, where each branch gets its page; the mirror then copies those branches to GitHub, which is harmless.

## 8. Import the issues

1. On GitHub create a fine-grained token with **Issues: Read-only** and **Metadata: Read-only** on the repository.
2. On the forge: **Settings > Import**, enter `Infrawrench/Infrawrench` and the token, **Start**.
3. It runs in the background, waits out GitHub's rate limit by itself, and can be run again later: a second run brings only what changed.

Numbers: an issue keeps its GitHub number unless a thread on the forge already has it (the branch pages opened when the history was pushed took the first numbers), in which case it gets the next free number and shows "#N on GitHub". New threads on the forge start after GitHub's highest number, so an old `#123` never comes to mean something new. Pull requests are not imported: merged ones are in the history, open ones are branches.

After the import, turn off **Issues** on the GitHub repository (Settings > General > Features) so new ones are filed on the forge.

## 9. Tell contributors

```sh
git remote set-url origin https://git.infrawrench.com/Infrawrench/Infrawrench.git
git fetch origin --prune
```

- Git over HTTPS takes a personal access token from **Settings > Access tokens** on the forge as the password (the docs' "Save the token in Git"). Git over SSH is off on the forge for now.
- A change is a branch pushed to the forge; its page is where it is reviewed and merged. There are no pull requests to open.
- Agents and scripts that use `gh pr`, `gh issue` or the GitHub API against this repository need the forge's API or its MCP server (`https://git.infrawrench.com/mcp`) instead. `CLAUDE.md`'s memory of "commit to main" is unchanged: `main` is the forge's.
- Update anything that names the GitHub clone URL as the place to push: local worktree tooling, `ci-runner` release notes, the README's badges.

## What stays on GitHub for now

| What                                             | Why it stays                                                                                                                                                                                                                                       | What moves it                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| macOS desktop builds and notarisation            | `desktop-build.yml` needs macOS runners and the Apple certificates held in GitHub secrets.                                                                                                                                                         | macOS machines in Infrawrench CI.                          |
| Windows and Linux desktop builds, mobile release | Same workflow family (`desktop-build.yml`, `mobile-release.yml`), EAS and signing secrets, and the release tags on GitHub. The mobile preview build has moved (`.infrawrench/ci/mobile-build.yml`).                                                | With the desktop build.                                    |
| SDK publishing and satellite repositories        | `publish-sdks.yml` mirrors to the Go, Swift and PHP repositories with the SDK publisher GitHub App.                                                                                                                                                | A pipeline that pushes to the satellites with a token.     |
| Terraform Registry mirroring                     | `publish-terraform-provider.yml` pushes to `Infrawrench/terraform-provider-infrawrench`, which the Registry reads.                                                                                                                                 | The Registry only reads GitHub: the satellite stays there. |
| Deploys (web, edge, forge)                       | `web-deploy.yml`, `git-deploy.yml` use GitHub OIDC to AWS and GCP. The website, instances and bastion image deploys have moved (`.infrawrench/ci/*-deploy.yml`).                                                                                   | Lent AWS and GCP connections and the secrets moved over.   |
| CI runner releases and builtins                  | `ci-runner-release*.yml`, `ci-runner-builtins.yml`: signing key and R2 keys in GitHub secrets, native arm64 runners, and the runner should not be the only thing that can ship itself. `ci-runner-hosts.yml` has moved.                            | The same.                                                  |
| Scheduled jobs                                   | `plugingen-watch.yml` and `ai-cleanup.yml` run on GitHub. `aws-bulk-pricing-sync.yml` and `purge-cf-cache.yml` have moved to Infrawrench CI (`on.schedule`, `on.manual`).                                                                          | `on.schedule` in Infrawrench CI.                           |
| Dependabot alerts                                | GitHub reads the mirror's manifests and lockfile. Alerts work on a mirror; version update pull requests do not make sense there, so turn those off (or keep `dependabot/**` excluded and treat its pull requests as notices to redo on the forge). | A scanner on the forge.                                    |
| Secret scanning and push protection              | Runs on the mirror's pushes. A blocked push shows as a refused ref on **Settings > Mirrors**.                                                                                                                                                      |                                                            |

Workflows triggered by `pull_request` no longer run, because pull requests are no longer opened on GitHub. Workflows triggered by `push`, `schedule`, `workflow_dispatch` and tags run as before.

## Secrets

GitHub secrets are write-only: no API or setting shows a value again. Before anything moves off GitHub Actions, each value has to come from where it was first made. These are the names on `Infrawrench/Infrawrench` (27 November 2026, names only) and where each can be read or made again.

### Repository secrets

| Secret                                                                                                                                                              | Used by                                                                                                     | Where the value comes from                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`                                                                                                                                              | `git-deploy`, `web-deploy`, `website-deploy`, `instances-deploy`, `purge-cf-cache`, `aws-bulk-pricing-sync` | Cloudflare dashboard > API tokens: make a new one with the same permissions (a token's value is shown once).                                                                                                 |
| `PROD_DATABASE_URL`                                                                                                                                                 | `web-deploy`, `git-deploy` (migrations, and waiting for them)                                               | Neon console (the `core` project's connection string); also `DATABASE_URL` in AWS Secrets Manager `infrawrench-prod-lambda/app-env` (us-east-2).                                                             |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`                                                                                              | `desktop-build`, `aws-bulk-pricing-sync`                                                                    | Cloudflare dashboard > R2 > API tokens: make a new key pair. The endpoint and bucket are not secret (`infra/README.md`).                                                                                     |
| `IWCI_R2_ACCESS_KEY_ID`, `IWCI_R2_SECRET_ACCESS_KEY`, `IWCI_R2_ACCOUNT_ID`, `IWCI_R2_BUCKET`                                                                        | `ci-runner`, `ci-runner-builtins`, `ci-runner-release`, `ci-runner-release-build`                           | Cloudflare R2, as above; a copy is in `~/.config/iwci` on the release machine.                                                                                                                               |
| `IWCI_RELEASE_SIGNING_KEY`                                                                                                                                          | `ci-runner-release`                                                                                         | `~/.config/iwci` on the release machine. **Exists nowhere else**: back it up, since every runner trusts its public half.                                                                                     |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`                                                                                                          | `desktop-build`, `mobile-build`, `mobile-release`                                                           | Apple ID account page: make a new app-specific password. The team id is on developer.apple.com.                                                                                                              |
| `MACOS_APP_CERTIFICATE_BASE64`, `MACOS_APP_CERTIFICATE_PASSWORD`, `MACOS_INSTALLER_CERTIFICATE_BASE64`, `MACOS_INSTALLER_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD` | `desktop-build`                                                                                             | The Developer ID certificates in the Mac's keychain: export each as `.p12` again with a new password and base64 it. `KEYCHAIN_PASSWORD` is any value.                                                        |
| `APT_KEY`                                                                                                                                                           | `desktop-build` (signing the apt repository)                                                                | The GPG private key on the machine that made it (`gpg --export-secret-keys`). **If it is only in GitHub, it is one for the export below**: a new key means every installed apt source has to trust it again. |
| `EXPO_TOKEN`, `EXPO_ASC_API_KEY_BASE64`, `EXPO_ASC_ISSUER_ID`, `EXPO_ASC_KEY_ID`                                                                                    | `mobile-build`, `mobile-release`                                                                            | expo.dev > Access tokens (new token). App Store Connect > Users and Access > Integrations: the key file downloads once, so make a new key.                                                                   |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`                                                                                                                                  | no workflow reads it today (EAS holds its own copy)                                                         | Google Cloud console > the service account > Keys: add a new JSON key.                                                                                                                                       |
| `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`                                                                                                                            | `bastion-deploy`                                                                                            | The container registry's account: make a new access token.                                                                                                                                                   |
| `PRICING_WAREHOUSE_TOKEN`, `INSTANCES_NOTIFY_SECRET`                                                                                                                | `aws-bulk-pricing-sync`                                                                                     | The pricing warehouse Worker's secret and the instances site's (`wrangler secret put` on each sets a new pair on both ends).                                                                                 |
| `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`                                                                                                                        | `aws-bulk-pricing-sync` (posting)                                                                           | Bluesky > Settings > App passwords: make a new one.                                                                                                                                                          |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`                                                                                              | `aws-bulk-pricing-sync` (posting)                                                                           | The X developer portal: regenerate the keys and tokens of the app.                                                                                                                                           |
| `CLAUDE_ACCESS_TOKEN`, `CLAUDE_REFRESH_TOKEN`, `CLAUDE_EXPIRES_AT`                                                                                                  | `ai-cleanup`                                                                                                | Written by the workflow itself as it refreshes; sign in again to seed new ones.                                                                                                                              |
| `SECRETS_ADMIN_PAT`                                                                                                                                                 | `ai-cleanup` (writes the three above back)                                                                  | GitHub > Developer settings: a new fine-grained token with Secrets: Read and write.                                                                                                                          |

### `production` environment

| Secret                                      | Used by      | Where the value comes from                                                         |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `OCI_CI_KEY`, `OCIR_USERNAME`, `OCIR_TOKEN` | `web-deploy` | Oracle Cloud console: a new API signing key for the CI user, and a new auth token. |

### `release` environment

| Secret                                                                                           | Used by                                                         | Where the value comes from                                                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SDK_PUBLISHER_APP_ID`, `SDK_PUBLISHER_APP_PRIVATE_KEY`                                          | `publish-sdks`, `publish-terraform-provider`, `plugingen-watch` | The GitHub App's settings page: generate a new private key (the old one keeps working until deleted). |
| `CENTRAL_TOKEN_USERNAME`, `CENTRAL_TOKEN_PASSWORD`, `MAVEN_REPO_USERNAME`, `MAVEN_REPO_PASSWORD` | `publish-sdks` (Java)                                           | central.sonatype.com > account > generate a user token.                                               |
| `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`                                                  | `publish-sdks` (Java signing)                                   | The GPG key on the machine that made it. A new key works too once its public half is on a keyserver.  |
| `NUGET_USER`                                                                                     | `publish-sdks` (.NET, trusted publishing)                       | Not a secret in substance: the nuget.org account name.                                                |
| `OVSX_PAT`                                                                                       | `publish-vscode`                                                | open-vsx.org > Settings > Access tokens.                                                              |
| `PLUGINGEN_FORGE_TOKEN` (new, step 7)                                                            | `plugingen-watch`                                               | The forge: Settings > Access tokens.                                                                  |

### Variables

Variables are readable (`gh variable list -R Infrawrench/Infrawrench`), so they can be copied at any time: `APPLE_TEAM_TYPE`, `AR_REGISTRY`, `AWS_LAMBDA_CI_ROLE_ARN`, `AWS_REGION`, `AWS_WEB_DEPLOY_ENABLED`, `AWS_WEB_ECR_REPOSITORY`, `EDGE_DEPLOY_ENABLED`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GIT_DEPLOY_ENABLED`, `LAMBDA_DEPLOY_ENABLED`, `LAMBDA_ECR_REPOSITORY`, `OCIR_REGISTRY`, `OCI_CI_FINGERPRINT`, `OCI_CI_USER`, `OCI_COMPARTMENT`, `OCI_DEPLOY_ENABLED`, `OCI_TENANCY`, `POSTHOG_KEY`, `SOCIAL_POST`, and after step 7 `PLUGINGEN_TARGET`.

The app's own runtime secrets are not in GitHub at all: they are the `app_env` map in `infra/terraform/terraform.tfvars`, written to AWS Secrets Manager `infrawrench-prod-lambda/app-env` and `edge-env` (us-east-2), which the deploy workflows read through OIDC.

### Secrets that exist only in GitHub: a one-off encrypted export

Most values above can be made again at their source, which is better than copying them: a new value is a rotation. For the few that cannot (a signing key nobody kept, `APT_KEY`, `MAVEN_GPG_PRIVATE_KEY`), a workflow can hand them over without ever showing them. **This describes it; nothing in the repository runs it.**

1. On your own machine make a key pair and keep the private half off GitHub: `age-keygen -o export.key` prints a public key (`age1...`).
2. Add a workflow by hand on a branch of the GitHub repository (never on `main`, never merged), triggered only by `workflow_dispatch`, with `permissions: {}`, in the environment that holds the secrets. Its one job writes each wanted secret to a file through `env:` (never interpolated into the script: `printf '%s' "$APT_KEY" > apt_key`), encrypts the files to the public key (`tar c . | age -r age1... > secrets.tar.age`), and uploads only `secrets.tar.age` with `actions/upload-artifact` and `retention-days: 1`. The public key is written in the workflow file itself; nothing secret is.
3. Run it once, download the artifact, decrypt it on your machine (`age -d -i export.key secrets.tar.age | tar x`), and put the values where they are going.
4. Delete the artifact (`gh api -X DELETE repos/Infrawrench/Infrawrench/actions/artifacts/<id>`), the workflow run (`gh run delete <id>`), the branch and `export.key`.

Why it is safe enough: the log only ever holds the names, GitHub masks the values if a step prints one, the artifact is unreadable without the private key, and it exists for a day at most. Why it is still a last resort: for an hour a file with production keys exists on a runner, and whoever can run workflows on that branch can change what the job does. Do it once, alone, with the ruleset from step 5 already in place, and rotate anything that can be rotated afterwards.

## Rolling back

GitHub has everything the forge has, so going back is quick at any point.

1. **Stop the mirror**: Settings > Mirrors > **Turn off** (keeps the settings) or **Remove**.
2. **Bring GitHub up to date by hand** if the mirror was failing when you stopped: `git push github 'refs/remotes/forge/*:refs/heads/*' --tags` from a current clone.
3. **Unlock GitHub**: disable the two rulesets, turn merging and Issues back on.
4. **CI**: turn Infrawrench CI on for the GitHub repository in the app and off on the forge repository.
5. **plugingen**: set `PLUGINGEN_TARGET` to `github` (or delete the variable). Close what it opened on the forge.
6. **Issues**: issues filed on the forge since the import are not copied back by anything. File them on GitHub by hand, or leave the forge's issues readable and link to them.
7. **Contributors**: `git remote set-url origin git@github.com:Infrawrench/Infrawrench.git`.

Nothing is lost on the forge by rolling back: the repository, its branch pages and its imported issues stay, and the mirror can be turned on again later. Commits made on GitHub after a rollback have to be pushed to the forge before the mirror is turned on again, or the mirror will overwrite them.
