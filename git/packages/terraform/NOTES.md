# `@infrawrench/git-terraform`

The Terraform side of git.infrawrench.com, as pure functions over interfaces. This file is the design, and what was built from it: the worker (`../worker/src/terraform/`, `../worker/src/events/terraform.ts`), server-core (`ci/terraform.ts`, `git-terraform/`) and the contract. `git/README.md` ("Terraform") is the summary.

## What is in the package

| Module                              | What it does                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/types.ts`                    | `StateStore`, the storage one workspace's state needs: head (current version and lock), versions, bytes, and changes that apply only if the head is still what the caller decided on (`HeadExpectation`). |
| `state/backend.ts`                  | The semantics: `readState`, `writeState` (lock, lineage and serial checks), `lockState`, `unlockState`, `purgeState`, `restoreVersion`. Outcomes, not HTTP.                                               |
| `state/http.ts`                     | `handleStateRequest(request, store, auth, options)`: Terraform's `http` backend, server side.                                                                                                             |
| `state/memory-store.ts`             | `MemoryStateStore`, the reference implementation and what the tests run Terraform against.                                                                                                                |
| `plan/summary.ts`                   | `summarizePlan(document)`: `terraform show -json <planfile>` reduced to counts, changes, replace reasons, outputs and drift, with attribute names and no values.                                          |
| `roots/hcl.ts`, `roots/discover.ts` | `discoverTerraformRoots(tree)`: which directories are roots, over a `TreeReader`; what each declares (backend, providers, module calls, variables); `suggestWorkspaceName`, `isWorkspaceName`.            |
| `pipeline/generate.ts`              | `workspacePipelineYaml(input)`: the Infrawrench CI pipeline of a plan or an apply; `backendEnvironment`, `backendConfiguration` (the block for someone's own machine).                                    |
| `pipeline/releases.ts`              | `pinnedRelease(product, version)`: the releases a run may download, each with the publisher's SHA-256 per architecture. The first row of a product is its default.                                        |
| `plan/pricing.ts`                   | `planPricingInputs(document)`: what pricing a plan needs of it (types, and plain scalar attributes the plan does not mark sensitive). Unlike a summary it carries values, so it is never stored on a run. |
| `roots/touched.ts`                  | `rootsTouchedBy(roots, changedPaths, directories)`: which workspaces a branch page plans.                                                                                                                 |
| `match/`                            | `stateResourceInstances(state)` and `matchStateToInventory(instances, candidates)`: state addresses tied to Infrawrench resource ids.                                                                     |
| `roots/expr.ts`                     | `evaluate(expression, scope)`: a bounded interpreter of the HCL expressions an estimate needs. Unknown is a value (`UNKNOWN`), never an exception.                                                        |
| `roots/model.ts`                    | `directoryModel(path, files)`: a directory's variables, locals, providers, resources and module calls with their expressions as written; `tfvarsValues`.                                                  |
| `estimate/inputs.ts`                | `configurationPricingInputs(root, models, tfvars)`: every managed resource a root creates, through its local modules, with its count and the attribute values the configuration sets.                     |
| `estimate/estimate.ts`              | `ConfigurationEstimate`, the priced answer the app stores; `compareConfigurationEstimates(before, after)`, a branch's change.                                                                             |
| `scan/scan.ts`, `scan/summary.ts`   | `scanTerraformSnapshot(snapshot)`: discovery and pricing inputs over a snapshot of a commit's Terraform files; `summarizeScan`, what the API keeps of it.                                                 |

It imports nothing: no `node:*`, no `cloudflare:*`, no Effect, not even `git-core` yet (the tree is an interface the worker implements over its object reader).

## The flow

1. **A repository gets workspaces.** The Infrastructure tab lists the roots `discoverTerraformRoots` finds on the default branch; creating a workspace stores a `git_terraform_workspaces` row and the accounts it links (`git_terraform_workspace_accounts`). Linking takes `admin` on the repository and `accounts:read` in the organisation, and is the grant: a workspace's runs are lent those accounts and nothing else.
2. **A branch page opens or gets a new commit.** The Worker (`events/terraform.ts`) reads what the branch page changes and plans the workspaces it touches (`rootsTouchedBy`: a file under the root or under a local module it reaches); when the storage cannot say, every workspace of the base branch. It inserts a `git_terraform_runs` row (`plan`, `queued`) and calls server-core's `startTerraformRun`, which records a `ci_runs` row with `workspacePipelineYaml(...)` as its `pipeline_text` and dispatches it. Plans of older heads become `superseded` (the pipeline's concurrency group cancels them in CI).
   - **A branch proposed from a fork is never planned.** Its run is recorded `skipped` with the reason and nothing is sent. It gets a timeline entry and no commit status.
   - **A personal namespace has the state backend only**: nothing is recorded.
3. **The plan job** runs in a Linux machine: installs the pinned release (the cache holds the checked archive, and the program is unpacked from it into the job's own directory on every run, so nothing a cache held is ever run), writes the backend override, `init`, `plan -out`, `show -json`, and posts the JSON to `planUrl` with its job token. The Worker checks the token is the live run's own, calls `summarizePlan`, hands the summary to server-core (`recordTerraformPlan`) and drops the document. What pricing needs (`planPricingInputs`) is put beside the state in R2.
4. **The branch page shows it.** The run row is the check: the commit status `Infrawrench Terraform / <workspace>` with Terraform's own line ("Plan: 2 to add, 1 to change, 0 to destroy."), a `terraform_run` entry in the timeline, and the run's changes. The monthly cost change is priced from the plan by the gateway's pass (`git-terraform/plan-cost.ts`) and stored as `cost_delta` (null is not zero).
5. **The branch moves.** A push to the workspace's branch records an apply. It is dispatched at once only when the workspace applies on merge and asks for no approval (`initialApplyStatus`); otherwise it is `awaiting_approval` until an admin of the repository or someone with `ci:approve` approves it. The gate is the dispatch: a waiting run has no CI run, and `terraformDispatch` refuses to send one. A newer push replaces an apply still waiting.
6. **The apply job** plans again at the merge commit, posts that plan (the apply run keeps its own summary), and applies exactly that plan file. Every state write goes through the backend with `?ID=<lock id>`.
7. **A state version lands.** The store commits it; the workspace's Durable Object reports its head on the response, and the Worker writes `git_terraform_state_versions` (with the run, found from the job's CI run id) and mirrors the head onto the workspace row.
8. **Resources are linked** by server-core on the gateway (plugins do not exist on the edge): the `git-terraform` poller pass finds workspaces whose current version is not the linked one, reads the state over the backend route with a service token, runs `stateResourceInstances`, builds an `InventoryCandidate` per synced resource from the plugin's own `terraformExport.mapResource` (type and `importId`) and `externalId`, runs `matchStateToInventory`, and replaces the workspace's `git_terraform_managed_resources` rows, unmatched addresses included with a null `resourceId`. A link is redone every six hours, for resources synced since.
9. **Both sides show it.** The app's resource page reads `managedBy` (`GET /iac/resource`) and says "Managed by `<owner>/<repo>` (`<rootPath>`)", linking to the workspace. The forge's Infrastructure tab lists what each workspace manages and what it cost over the last thirty days, read through the caller's cost visibility.

## Scanning, and estimates from configuration

A repository's Infrastructure tab lists every root of the default branch before anything is set up, with what it declares and what it would cost a month. A branch page shows the cost change of the roots it touches that no plan has priced.

1. **One walk, one call.** The repository's Durable Object walks the commit's tree once (`terraformFiles`, beside `languages` in the worker's `queries/content.ts`) and answers a `TerraformSnapshot`: every file `isTerraformScanFile` takes, as text, within `SNAPSHOT_LIMITS` (20,000 directories, 3,000 files, 1 MiB a file, 8 MiB in all; past any of them `truncated`). Discovery used to walk through the reader one directory at a time, a Durable Object call per directory and per file: thousands of calls in one request for a monorepo, and the list was asked of administrators only. While that request was slow or failed, the tab said "No workspaces yet", the same as for a repository with no Terraform. Discovery now runs over the snapshot in memory (`snapshotTreeReader`), and every reader gets the list.
2. **Cached by tree.** The Worker keeps the scan in `git_terraform_scans`, keyed by repository, tree id and `TERRAFORM_SCANNER_VERSION`: a push that changes nothing, and every branch at the same tree, reuse it. Bump the version when the scan's answer for the same files changes.
3. **Static reading only.** `roots/expr.ts` interprets literals, `var.*`, `local.*`, `each.*` and `count.index` of known instances, the operators, indexing, constructors, templates and a fixed list of pure functions (`length`, `toset`, `lookup`, `merge`, `try`, `coalesce`...). A resource's attribute, a data source, `path.*`, a `for` expression, `file()` and any function not on the list are `UNKNOWN`, and unknown spreads. Every evaluation has a step budget (20,000) and a nesting limit (64); a hostile file costs an unknown. Variables come from the caller's arguments (a module call), the root's auto-loaded `.tfvars` (Terraform's own order), then `default`. A `sensitive` variable is always unknown. Attributes named like credentials are dropped before anything is kept, known or not.
4. **Instances.** `count` and `for_each` that evaluate expand into instances (up to 50 each, then folded into one line with the count); instances with the same values are one line (`google_compute_instance.vm["a", "b"]`). A module call multiplies what it contains. An unknown count is `count: null`: the pricer lists it as unpriced and never guesses one. Remote modules are listed as not read.
5. **Pricing is the app's.** The gateway's `git-terraform` pass prices pending scans (`server-core/src/git-terraform/config-cost.ts`): instance-sized types from the instance pricing warehouse's on-demand list prices, other types through a connected account's estimator when the organisation has one, and everything else is classified (`usage`, `free`, `unknown`). It writes `estimates` by root path. **Null is not zero**: `complete` is false while anything that may cost a fixed amount is missing.
6. **A branch page** (`terraform.configurationChange`) compares the roots its changes touch (`rootsTouchedBy` over the head scan's directories) at the merge base and at the head. **A plan wins**: a root whose workspace has a plan of the page's head is left out, so a root never has two numbers on one page.

What is stored is the repository's own text (instance types, sizes): `pricingInputs` is never served, and the summary names attributes and types, never values.

## Where each piece runs

| Piece                                     | Where                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock, current version, version catalogue  | A Durable Object per workspace (`idFromName(workspaceId)`), SQLite. It is the truth; Postgres mirrors it.                                       |
| State bytes                               | R2, `terraform/<workspaceId>/<serial>-<versionId>.tfstate`. Written before the DO commits; never overwritten.                                   |
| A plan's pricing inputs                   | R2, `terraform/<workspaceId>/plans/<runId>.json`, until the app reads them once.                                                                |
| The backend's HTTP routes, the plan route | The front Worker: resolves the workspace and `repoAccess`, builds a `StateAuth`, hands the request to the DO, which calls `handleStateRequest`. |
| Root discovery, the scan                  | The Worker, over one snapshot the repository DO reads (`terraformFiles`); cached in `git_terraform_scans` by tree.                              |
| Estimates from configuration              | server-core on the gateway: the `git-terraform` pass (`config-cost.ts`), from the instance pricing warehouse and connected accounts.            |
| Plans and applies                         | Infrawrench CI, `platform: linux` jobs.                                                                                                         |
| Dispatch, approval, run status            | server-core `ci/` (it owns runs, lending and billing).                                                                                          |
| Linking and pricing                       | server-core on the gateway: the `git-terraform` poller pass (`git-terraform/pass.ts`). It needs plugin code.                                    |
| Workspaces, runs, version metadata, links | Postgres (`server-core/src/db/terraform-schema.ts`, migrations `0197_git_terraform` and `0201_git_terraform_runtime`).                          |

## The HTTP backend, as Terraform speaks it

Checked against the backend's documentation and, in `test/state-terraform.test.ts`, against the binary (1.15.8).

| Request                                                  | Answer                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET state`                                              | `200` with the bytes as stored; `404` only when the workspace has no state.                                                                                                                                                                                                                       |
| `POST state?ID=<lock id>` (or `PUT`: `update_method`)    | `200`. `423` with the holder's lock info when another lock is held or none was named while one is. `409` when the named lock is gone, the lineage differs, or the serial does not follow. `400` for what is not a version 4 state or does not match its `Content-MD5`. `413` past the size limit. |
| `DELETE state`                                           | `200`; `423` while locked. Admin only.                                                                                                                                                                                                                                                            |
| `LOCK state`, `POST state/lock`                          | `200`; `423` with the holder's lock info. The same `ID` again is `200` (a retried request).                                                                                                                                                                                                       |
| `UNLOCK state`, `DELETE state/lock`, `POST state/unlock` | `200`, also when nothing was locked; `409` with the holder's lock info when the body names another lock; `403` when it names none and the caller is not an admin.                                                                                                                                 |
| anything, no valid credential                            | `401` with a Basic challenge.                                                                                                                                                                                                                                                                     |

Things the binary taught us:

- **A read that is refused must never be `404` or `204`.** Terraform takes both for "no state yet" and plans to create everything. Refusals are `401` and `403`; a head whose bytes are missing throws (a `500`), it does not read as empty.
- **`terraform force-unlock <id>` sends no body.** The id the user typed never reaches the backend, so an unlock with no lock info is a forced one and takes admin access. A run's own unlock carries the lock info it locked with.
- **`-lock-timeout` works off the `423`.** The client retries the lock until the timeout and then prints the lock info from our answer (the holder's `ID` and `Who`).
- **Every write carries `Content-MD5`.** It is checked (`util/md5.ts`; WebCrypto has no MD5).
- **Serial rules.** Same lineage and a higher serial is a new version. The same serial with the same bytes is the same request again (`200`, no version). The same serial with other bytes, a lower serial, or another lineage is `409`. `terraform state push -force` of an older state is therefore refused; going back is `restoreVersion`, which writes the old document as a new version with the next serial and changes no other byte.
- **`LOCK` and `UNLOCK` are served**, and so are `POST` and `DELETE` on `state/lock`, which is what jobs and the shown configuration use, since not every proxy passes WebDAV methods. Whether Cloudflare's edge passes `LOCK` to a Worker is not something this package depends on.

## What the worker implements

- **`TerraformStateDO`** (`worker/src/terraform/state-do.ts`) over `WorkspaceStateStore` (`state-store.ts`), which is this package's `StateStore`. SQLite: `meta` (the workspace id, the current version id, the lock) and `versions`. `commit` puts the bytes in R2 under a fresh version id first, then in one synchronous SQLite transaction checks the expectation (current version id and lock id) and either records the version as head or reports the head as it is; a commit that loses deletes the object it wrote. `acquireLock` and `releaseLock` are single synchronous steps. Nothing awaits between a check and its write. The object never opens Postgres: every answer to a change carries the head in an internal header, which the front Worker mirrors and removes.
- **Routes** (not part of the JSON API; Basic auth, or Bearer for a job token), in `worker/src/terraform/route.ts`:
  - `GET|POST|PUT|DELETE|LOCK|UNLOCK /:owner/:repo/terraform/:workspace/state`
  - `POST|PUT|DELETE|LOCK|UNLOCK /:owner/:repo/terraform/:workspace/state/lock`
  - `POST|PUT|DELETE|UNLOCK /:owner/:repo/terraform/:workspace/state/unlock`
  - `POST /:owner/:repo/terraform/:workspace/runs/:runId/plan` (the plan JSON from the run's own job; `204`)
  - `GET /:owner/:repo/terraform/:workspace/runs/:runId/plan` (the pricing inputs, for the app's service token, once)
- **`StateAuth` from `repoAccess`** (`worker/src/terraform/access.ts`, `decideStateAuth`). It has four answers: `canRead`, `canLock` (lock, and unlock with the lock's id), `canWrite` and `canAdmin` (delete, and unlock without naming the lock). People need `admin` on the repository for any of them: `write` is every member of an organisation, and reading a state is reading the credentials Terraform created, as writing one decides what the next apply destroys. Everyone else gets `403`, a public repository's readers included. A personal access token works for an administrator, needs `repo:write` and never administers. A job token must name the workspace (its `workspace` claim) and its run must be live; a plan's (`read`) gets `canRead` and `canLock`, an apply's (`write`) `canWrite` as well, neither `canAdmin`, and a token without the claim is refused. The app's service token (`SERVICE_TOKEN_PURPOSE`) names its workspace too, reads and nothing else. An archived repository's state is read, not changed. The routes take `Authorization` only, never the session cookie. The principal string is `user:<id>`, `token:<id>`, `api-key:<id>`, `ci:<ci run id>` or `service:infrawrench`.
- **Who gets what answer.** No valid credential is a `401` with a Basic challenge whatever the path names; a credential that may not, a missing repository and a missing workspace are all the same `403`. Never `404` or `204` for a refusal.
- **The JSON API** (`worker/src/api/handlers/automation.ts`), with `restoreVersion` and the forced unlock behind it through `stateClient`.

## What the CI side implements

**How Terraform runs on Infrawrench CI today.** A job is a WebAssembly isolate, and Terraform is a native program, so it cannot run in one. It runs in a `platform: linux` job (a micro VM per job), which the generated pipeline uses. The machine image has no Terraform and there is no `builtin:terraform`, so the job downloads the release it is told to from the publisher, checks it against a pinned SHA-256 (`pipeline/releases.ts`) and keeps it in a `cache:`. That works with nothing changed in the runner, on runners started with `--machines`.

Built, in `server-core/src/ci/terraform.ts` and the three hooks it has in CI:

1. **Dispatch with an inline pipeline.** `terraformCiRun` makes the `ci_runs` values, with the generated text as `pipeline_text` and `terraform_run_id` set; the ordinary dispatcher sends it, with its `platforms` for the proxy to place it by.
2. **A job token as a run secret.** `terraformDispatch` mints `IW_GIT_JOB_TOKEN` when the run is sent: bound to the run's workspace (the `workspace` claim), `read` for a plan and `write` for an apply, two hours, its `run` claim the CI run's id. It goes in the request's `secrets` (which the proxy passes through, over a stored secret of the same name, and the runner masks) and is never stored. The pipeline uses it as `TF_HTTP_PASSWORD` and to post the plan, and that is all it is good for: the forge refuses it for a clone, a push, a raw file and the API. Before it mints one for a branch page's run, `terraformDispatch` reads the branch page's head repository again and refuses a head that is not the base repository's.
3. **Lending the workspace's accounts.** The pipeline's `connections:` names the linked accounts; `lend.ts` lends an account the run's workspace links without the per-connection CI opt-in (`LendingRun.linkedAccounts`), audited with who linked it.
4. **Status.** `status.ts` hands a Terraform run's check updates to `reportTerraformCheck`, which moves the run's row and writes `Infrawrench Terraform / <workspace>`.

**A `builtin:opentofu` (and `builtin:terraform`) tool with `abi: native-gvisor`** would remove the virtual machine, the download at run time and the pin table: one static Go binary per target, pinned by content hash and published once, the way `builtin:bun` is. A job then is `using: env:bash@5` with `tools: [builtin:opentofu@1.13]` in a gVisor sandbox. It is the proper fix and was not built here. OpenTofu is MPL-2.0; redistributing HashiCorp's BUSL binary from our store wants a licence check first, which downloading it in the user's own job does not.

**What each linked account's Terraform provider gets.** A lent connection sets the variables its plugin's `lendCiCredential` chooses: the provider's CLI's, and the Terraform provider's own where the two differ. Checked against each Terraform provider's documentation, and its source where the documentation is silent (November 2026); the fix for a gap belongs in that plugin's `lendCiCredential`, never in a list here:

| Plugin              | Terraform provider                       | As lent                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| aws                 | `hashicorp/aws`                          | Works (`AWS_*`). The session is from `GetSessionToken`, so IAM calls fail and `aws_iam_*` resources do not apply.                                                                                                                                                                                                                       |
| azure               | `hashicorp/azurerm`                      | Works (`ARM_*`).                                                                                                                                                                                                                                                                                                                        |
| gcp                 | `hashicorp/google`                       | Works for the token (`GOOGLE_OAUTH_ACCESS_TOKEN`) and the project (`GOOGLE_CLOUD_PROJECT`). No region is lent: a connection has none. The token lasts an hour unless the organisation allows longer.                                                                                                                                    |
| neon                | `kislerdm/neon`                          | Works (`NEON_API_KEY`).                                                                                                                                                                                                                                                                                                                 |
| cloudflare          | `cloudflare/cloudflare`                  | The token works (`CLOUDFLARE_API_TOKEN`). The provider does not read `CLOUDFLARE_ACCOUNT_ID`: `account_id` is set per resource.                                                                                                                                                                                                         |
| postgres            | `cyrilgdn/postgresql`                    | Works (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`). The provider has no default of its own for `sslrootcert`, but leaves it to its driver (lib/pq) when unset, which reads the lent `PGSSLROOTCERT` (read in the source, not run). `superuser` defaults to true: a connection that is not one sets it false. |
| kubernetes          | `hashicorp/kubernetes`, `hashicorp/helm` | Works: `KUBE_CONFIG_PATH`, which the providers read, names the same file as `KUBECONFIG`, which they do not.                                                                                                                                                                                                                            |
| vercel              | `vercel/vercel`                          | The token works: `VERCEL_API_TOKEN`, which the provider reads, beside `VERCEL_TOKEN` (the CLI's). The provider has no variable for `team`.                                                                                                                                                                                              |
| mysql               | `petoju/mysql`                           | Works (`MYSQL_ENDPOINT`, `MYSQL_USERNAME`, `MYSQL_PASSWORD`). `tls` keeps the provider's default (`false`), since a connection string does not say. A private CA is named by `MYSQL_TLS_CA_CERT`, which an empty `custom_tls {}` block picks up.                                                                                        |
| mongodb, redis, ssh | none                                     | Not a Terraform provider's credentials: no HashiCorp or vendor provider takes a MongoDB or Redis connection string or an SSH host (the vendors' providers are for their hosted services' APIs).                                                                                                                                         |

No gap is left where a provider reads a variable. What a provider has no variable for (a Vercel `team`, a Cloudflare `account_id`) or a connection does not know (a GCP region, whether a MySQL server wants `tls`) is written in the configuration, and a workspace can feed it from a secret variable (`secretVariables`: a Terraform variable read from a CI secret).

Known limits:

- **No approval step inside a pipeline.** Approval is a run that is not dispatched yet.
- **Jobs reach public addresses only**, so a provider that needs a private endpoint cannot plan.
- **Providers are downloaded on every `init`.** A `cache:` keyed on the root's `.terraform.lock.hcl` with `TF_PLUGIN_CACHE_DIR` would fix it; left out until it is known what `hashFiles` does for a root with no lock file.
- **Token lifetimes.** The job token lasts two hours; a lent GCP access token an hour unless the organisation allows longer.
- **A run's output is the CI run's log.** `terraform plan` and `apply` print attribute values that are not marked sensitive, so on the forge a workspace run's output takes `write` on the repository (`ci.getRun`, `ci.runLog`); the run, its jobs and the plan's summary are for every reader.

## The API

The contract is the reference (`../contract/src/groups/automation.ts`, `schemas/terraform.ts`); the shapes this file used to propose are there, renamed in places (`operation` for `kind`, `applyRequiresApproval` for the inverse of `autoApply`, `errored` and `discarded` for `failed` and `superseded`). Added with the runtime:

- `GET /repos/:owner/:repo/terraform/accounts`: the organisation's connected accounts, for the picker. Empty for a personal namespace and for a caller without `accounts:read`.
- `POST /repos/:owner/:repo/terraform/workspaces/:workspace/runs` `{ operation, ref? }`: a run by hand.
- `GET .../state-versions/:versionId/download` and `POST .../state-versions/:versionId/restore`, both `admin`.
- `POST /repos/:owner/:repo/terraform/runs/:runId/approve` takes `read` at the gate and decides in the handler: an admin of the repository, or `ci:approve` in the organisation. `viewerCanApprove` on a waiting run says which the caller is.
- Run status `skipped`; the timeline item `terraform_run`; `matchedResourceCount` on a workspace.

In the app's API, `GET /iac/resource?resourceId=` answers `managedBy: { repository, rootPath, workspace, address, url }[]` (API `1.129.0`); a workspace of a private repository is listed only for a caller with `git:read` or more in the organisation (API `1.130.1`).

## Matching, and what plugins have to declare

Nothing new is needed for matching. What a state entry must look like to be a given resource is already declared by each plugin's `terraformExport.mapResource` (the Terraform type and the `importId`), and that is what server-core feeds the matcher; the package names no provider and has no table of plugin ids. The rules are IaC reconciliation's, so the forge and the IaC tab agree: import id, then external id, qualified by Terraform type; without a type, only an identifier exactly one state entry has. A plugin with no `terraformExport` still matches that last way, and gains typed matching the day it gains export support.

One manifest field would be worth adding, for the account picker rather than the matcher:

- **`terraformExport.providerSources?: string[]`** (for example `["hashicorp/aws"]` on the AWS plugin). A root's `required_providers` then says which connected accounts could run it, so creating a workspace can offer the right accounts first and warn when a required provider has no linked account. Without it the picker lists every account whose plugin declares `ciCredential`.

And one thing to check per plugin, which belongs in its `lendCiCredential`: that the variables it lends are the ones its Terraform provider reads (AWS, Google and Azure are documented as doing so; the others were written for their CLIs).

## Decisions worth knowing

- **Roots.** The brief's rule counted `required_providers` as a sign of a root. Modules pin providers as often as roots do, so it is recorded and decides nothing; the order is backend, then "called as a local module", then a `provider` block, then a `modules/` directory, then "declares anything to run". A module with a legacy `provider` block of its own stays a module when something calls it.
- **The pipeline is never committed.** It is generated per run and sent as the request's `pipeline`, so a workspace's settings take effect at once and a repository cannot edit its own apply. The script is a constant; every workspace value reaches it through `env:`, so none can become shell.
- **The backend override.** The job writes `infrawrench_backend_override.tf` with `backend "http" {}`, which replaces whatever backend the root declares (tested with a root declaring `local`). A root with a `cloud` block is not handled and not tested: Terraform does not take a configuration with both a `cloud` and a `backend` block.
- **Summaries have no values.** A plan document has sensitive values in the clear. The summary names attributes, says which are sensitive or unknown, and keeps counts; tests assert the fixtures' secret strings are absent.
- **Bounds.** State 32 MiB (configurable), lock info 64 KiB, a posted plan 16 MiB (it is parsed in the front Worker), plan lists 2000 resources, 500 outputs, 64 attributes each, state instances 20 000, discovery 5000 directories, depth 12, 1 MiB per file, a scan's snapshot as above, pricing inputs 2000 resources and 200 module instances per root. Past each one the result says so (`omitted`, `truncated`) instead of failing. IaC reconciliation's own parser stops at 8 MiB, so a larger state is stored and linked but not registered for drift.

## Decided since

- **Who approves an apply:** an admin of the repository, or anyone with `ci:approve` in the organisation that owns it.
- **Forks:** never planned. The run row is `skipped` with the reason, not failed.
- **Personal namespaces:** the state backend only. No linked accounts, no runs.
- **What is applied:** the apply plans again at the merge commit, posts that plan and applies that plan file. Carrying the branch page's plan file between runs would mean storing a file full of secrets.
- **Cost per run** is priced from the plan (`git-terraform/plan-cost.ts`), not from the HCL diff: modules and `for_each` are already expanded there.
- **Cost visibility:** the forge's cost figures go through `resolveCostVisibility` for the caller, on top of `costs:read`.

## Not built

1. **Drift.** The state is not registered as an `iac_states` document, so the app's IaC tab does not classify drift from a workspace's state, and `driftedCount` and `drift` are null.
2. **`builtin:opentofu`** (above).
3. **Sweeping.** A removed workspace's state versions stay in R2 (the contract promises thirty days; nothing deletes them after). A plan's pricing inputs are deleted when the app reads them, which it does for every plan within a pass or two; if the gateway's pass is not running they wait.
4. **Plans of branches with no branch page** start by hand only.
5. **`terraformExport.providerSources`** on plugin manifests (below), for offering the right accounts first.
6. **Does Cloudflare's edge pass `LOCK` and `UNLOCK` to a Worker?** workerd does (`worker/test/e2e/terraform.test.ts`). Everything generated uses `POST` and `DELETE` either way.
