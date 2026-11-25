# `@infrawrench/git-terraform`

The Terraform side of git.infrawrench.com, as pure functions over interfaces. This file is the design the worker, the CI integration, the contract and server-core build against; `git/README.md` ("Terraform") is the summary.

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
| `match/`                            | `stateResourceInstances(state)` and `matchStateToInventory(instances, candidates)`: state addresses tied to Infrawrench resource ids.                                                                     |

It imports nothing: no `node:*`, no `cloudflare:*`, no Effect, not even `git-core` yet (the tree is an interface the worker implements over its object reader).

## The flow

1. **A repository gets workspaces.** When the Infrastructure tab opens, and after a push to the default branch, the worker runs `discoverTerraformRoots` over the default branch's tree and offers each root that is not a workspace yet. Creating one stores a `git_terraform_workspaces` row (name suggested from the path, root path, product and version) and the accounts it is linked to (`git_terraform_workspace_accounts`).
2. **A pull request opens or gets a new commit.** The event consumer finds the workspaces the pull request touches: its changed paths are under the workspace's `rootPath` or under a directory the root calls as a local module, transitively (`TerraformDirectory.moduleCalls[].localPath`, read at the head commit). For each it inserts a `git_terraform_runs` row (`kind: plan`, `queued`) and asks server-core to dispatch a CI run with `workspacePipelineYaml({ kind: "plan", ... })` as the run request's `pipeline`. Older plans of the same pull request and workspace become `superseded` (the pipeline's concurrency group cancels them in CI).
3. **The plan job** runs in a Linux machine: installs the pinned release, writes the backend override, `init`, `plan -out`, `show -json`, and posts the JSON to `planUrl`. The worker checks the job token belongs to that run, parses, calls `summarizePlan`, stores the summary and its three totals on the run (`planned`) and drops the document.
4. **The pull request shows it.** The run row is the check: workspace, "2 to add, 1 to change, 2 to destroy", the changes, and the monthly cost change. The cost comes from server-core's existing pull request analysis (`pr-checks/analyze.ts`) over the same diff, limited to the workspace's directories, stored as `cost_delta` (null is not zero, as there).
5. **The pull request merges.** The push to the default branch makes an apply run per touched workspace. With `autoApply` it is dispatched at once; otherwise it is `awaiting_approval` until someone who may approve presses Apply, and only then dispatched. The gate is the dispatch, not anything inside the pipeline.
6. **The apply job** plans again at the merge commit, posts that plan (the apply run keeps its own summary), and applies exactly that plan file. Every state write goes through the backend with `?ID=<lock id>`.
7. **A state version lands.** The store commits it; `onVersion` gives the worker the metadata, which it writes to `git_terraform_state_versions` (with the run, found from the principal `ci:<ci run id>`), mirrors onto the workspace row, and sends as a `terraform.state-version` event.
8. **Resources are linked** by server-core on the gateway (plugins do not exist on the edge): it reads the version's bytes, runs `stateResourceInstances`, builds an `InventoryCandidate` per synced resource of the workspace's organisation from the plugin's own `terraformExport.mapResource` (type and `importId`) and `externalId`, runs `matchStateToInventory`, and replaces the workspace's `git_terraform_managed_resources` rows, unmatched addresses included with a null `resourceId`.
9. **Both sides show it.** The app's resource page reads `git_terraform_managed_resources` by `(organization, resource id)` and says "managed by `<owner>/<repo>` at `<rootPath>`", linking to the workspace. The forge's Infrastructure tab lists what each workspace manages and sums the cost of its linked resource ids. Drift comes from IaC reconciliation: the same state version is registered as an `iac_states` document for the workspace's scope, so the IaC tab's managed, drifted and unmanaged lists work from the newest state with no upload.

## Where each piece runs

| Piece                                     | Where                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock, current version, version catalogue  | A Durable Object per workspace (`idFromName(workspaceId)`), SQLite. It is the truth; Postgres mirrors it.                                       |
| State bytes                               | R2, `terraform/<workspaceId>/states/<versionId>.tfstate`. Written before the DO commits; never overwritten.                                     |
| The backend's HTTP routes, the plan route | The front Worker: resolves the workspace and `repoAccess`, builds a `StateAuth`, hands the request to the DO, which calls `handleStateRequest`. |
| Root discovery                            | The Worker, over the repository DO's objects.                                                                                                   |
| Plans and applies                         | Infrawrench CI, `platform: linux` jobs.                                                                                                         |
| Dispatch, approval, run status            | server-core `ci/` (it owns runs, lending and billing).                                                                                          |
| Linking, cost, drift                      | server-core on the gateway: a poller pass with `runtime: gateway`, or a gateway route the event consumer calls. It needs plugin code.           |
| Workspaces, runs, version metadata, links | Postgres (`server-core/src/db/terraform-schema.ts`, migration `0196_git_terraform`).                                                            |

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

## What the worker has to implement

- **`TerraformStateDO implements StateStore`.** SQLite: `head(version_id, lock_json)`, `versions(id, serial, lineage, ..., r2_key)`. `commit` puts the bytes in R2 under a fresh version id first, then in one synchronous SQLite step checks the expectation (current version id and lock id) and either records the version as head or reports the head as it is; a failed expectation deletes the object it wrote. `acquireLock` and `releaseLock` are single SQLite steps. Nothing awaits between a check and its write.
- **Routes** (not part of the JSON API; Basic auth):
  - `GET|POST|PUT|DELETE|LOCK|UNLOCK /:owner/:repo/terraform/:workspace/state`
  - `POST|PUT|DELETE|LOCK|UNLOCK /:owner/:repo/terraform/:workspace/state/lock`
  - `POST|PUT|DELETE|UNLOCK /:owner/:repo/terraform/:workspace/state/unlock`
  - `POST /:owner/:repo/terraform/:workspace/runs/:runId/plan` (the plan JSON; `204`)
- **`StateAuth` from `repoAccess`.** A state holds every secret the workspace manages, so reading it is not reading the repository: `canRead` and `canWrite` need `write`, `canAdmin` needs `admin`, and a public repository's readers get `403`. A personal access token needs `repo:write`. A job token gets `canRead` and `canWrite` for the workspaces of its own run only, never `canAdmin`. The principal string is `user:<id>`, `token:<id>` or `ci:<ci run id>`.
- **`onVersion`**: insert the `git_terraform_state_versions` row, update the workspace mirror (`current_state_version_id`, `current_serial`), enqueue the event. Mirror the lock (`lock_id`, `lock_info`, `locked_by`, `locked_at`) after each lock and unlock.
- **The plan route**: cap the body (32 MiB), `JSON.parse`, `summarizePlan` (a `PlanFormatError` is a `400`), store, discard. Never store or log the document: it has sensitive values in the clear.
- **A `TreeReader`** over a commit's tree, for discovery.
- **The UI's JSON API** (below), with `restoreVersion`, `unlockState({ lockId: null, force: true })` and `store.versions` behind it.

## What the CI side has to implement

**How Terraform runs on Infrawrench CI today.** A job is a WebAssembly isolate, and Terraform is a native program, so it cannot run in one. It can run in a `platform: linux` job (a micro VM per job, merged as runner 0.3.42), which the generated pipeline uses. The machine image has no Terraform (`ci-runner/images/README.md` lists it as left out) and there is no `builtin:terraform`, so the job downloads the release it is told to from the publisher, checks it against a pinned SHA-256 and keeps it in a `cache:`. That works with nothing changed in the runner, on runners started with `--machines`.

What is missing, smallest first:

1. **Dispatch with an inline pipeline.** The runner's request already takes `pipeline` (a file's text run instead of the repository's); the app has to send it for a workspace run, with the run's `notify`, and the proxy has to place it on a runner that lists `linux` in its platforms.
2. **A job token as a run secret.** `secrets.IW_GIT_JOB_TOKEN`: repository scoped, valid for the run, principal `ci:<ci run id>`. The pipeline uses it as `TF_HTTP_PASSWORD` and to post the plan.
3. **Lending the workspace's accounts.** `connections:` names what is lent; for a workspace run the lent set is its linked accounts, granted by linking them (an admin's act), not by the per-repository CI toggle. Accounts offered in the picker are those whose plugin declares `ciCredential`.
4. **Release pins.** Somebody has to hold `{ product, version, sha256 per architecture }` for the releases a workspace may choose. A small table beside the dispatcher, filled from the publishers' signed checksum lists.
5. **A `builtin:opentofu` (and `builtin:terraform`) tool with `abi: native-gvisor`**, the way `builtin:bun` is: one static Go binary per target, pinned by content hash, published once. A job then is `using: env:bash@5` with `tools: [builtin:opentofu@1.8]` in a gVisor sandbox: no VM, no KVM host, no download at run time, no pin table. This is the proper fix and the only runner change proposed. OpenTofu is MPL-2.0; redistributing HashiCorp's BUSL binary from our store wants a licence check first, which downloading it in the user's own job does not.

Known limits, none of them ours to fix here:

- **No approval step inside a pipeline.** Approval is a run that is not dispatched yet. The generated files also list `on.manual`, which the app only lets `ci:approve` start.
- **Jobs reach public addresses only**, so a provider that needs a private endpoint cannot plan.
- **Providers are downloaded on every `init`.** A `cache:` keyed on the root's `.terraform.lock.hcl` with `TF_PLUGIN_CACHE_DIR` would fix it; left out until it is known what `hashFiles` does for a root with no lock file.
- **A fork's pull request is never planned.** A plan runs the repository's code (providers, `external` data sources) with real credentials, and an untrusted run gets neither secrets nor lent connections anyway. The run row should say so rather than fail.
- **Token lifetimes.** A lent GCP access token lasts an hour unless the organisation allows longer.

## API shapes needed from the contract

Paths are under the forge's JSON API; `:workspace` is the name. Times are ISO 8601.

```ts
// GET  /repos/:owner/:repo/terraform/roots?ref=
interface TerraformRootsResponse {
  ref: string;
  truncated: boolean;
  roots: {
    path: string;
    reasons: ("backend" | "provider-block" | "unreferenced")[];
    backend: string | null;
    providers: string[];
    requiredProviders: Record<string, string | null>;
    requiredVersion: string | null;
    variables: { name: string; required: boolean; sensitive: boolean }[];
    workspace: string | null; // the workspace already on this root
    suggestedName: string;
  }[];
}

// GET  /repos/:owner/:repo/terraform/workspaces
// POST /repos/:owner/:repo/terraform/workspaces        (TerraformWorkspaceInput)
// GET|PATCH|DELETE /repos/:owner/:repo/terraform/workspaces/:workspace
interface TerraformWorkspace {
  id: string;
  name: string;
  rootPath: string;
  autoApply: boolean;
  product: "terraform" | "opentofu";
  toolVersion: string | null;
  accounts: { id: string; name: string; pluginId: string }[];
  variables: Record<string, string>;
  secretVariables: Record<string, string>; // variable -> CI secret name
  stateUrl: string;
  backendConfiguration: string; // the HCL block to paste
  lock: { id: string; who: string; operation: string; lockedBy: string; lockedAt: string } | null;
  state: { versionId: string; serial: number; resourceCount: number; createdAt: string } | null;
  latestRun: TerraformRunSummary | null;
  managed: { resources: number; linked: number };
  monthlyCost: { amount: number; currency: string; partial: boolean } | null;
}
interface TerraformWorkspaceInput {
  name: string;
  rootPath: string;
  autoApply?: boolean;
  product?: "terraform" | "opentofu";
  toolVersion?: string | null;
  accountIds?: string[];
  variables?: Record<string, string>;
  secretVariables?: Record<string, string>;
}

// GET  /repos/:owner/:repo/terraform/workspaces/:workspace/runs?cursor=
// GET  /repos/:owner/:repo/pulls/:number/terraform-runs
// GET  /repos/:owner/:repo/terraform/runs/:runId
// POST /repos/:owner/:repo/terraform/workspaces/:workspace/runs   { kind, ref }
// POST /repos/:owner/:repo/terraform/runs/:runId/approve | /cancel
interface TerraformRunSummary {
  id: string;
  workspace: string;
  kind: "plan" | "apply";
  trigger: "pull-request" | "push" | "manual";
  status:
    | "queued"
    | "running"
    | "planned"
    | "awaiting_approval"
    | "applied"
    | "failed"
    | "cancelled"
    | "superseded";
  commitSha: string;
  branch: string | null;
  pullNumber: number | null;
  add: number | null;
  change: number | null;
  destroy: number | null;
  costDelta: TerraformRunCostDelta | null; // server-core/db/terraform-schema.ts
  ciRunId: string | null;
  ciRunUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface TerraformRun extends TerraformRunSummary {
  plan: PlanSummary | null; // this package's type, field for field
  error: string | null;
  approvedBy: { id: string; name: string } | null;
}

// GET  /repos/:owner/:repo/terraform/workspaces/:workspace/state-versions?before=&limit=
// GET  /repos/:owner/:repo/terraform/workspaces/:workspace/state-versions/:id/download
// POST /repos/:owner/:repo/terraform/workspaces/:workspace/state-versions/:id/restore
// POST /repos/:owner/:repo/terraform/workspaces/:workspace/unlock   (admin; force)
interface TerraformStateVersion {
  id: string;
  serial: number;
  lineage: string;
  size: number;
  sha256: string;
  terraformVersion: string | null;
  resourceCount: number;
  createdAt: string;
  createdBy: { kind: "user" | "token" | "ci"; id: string; name: string | null };
  runId: string | null;
  current: boolean;
}

// GET  /repos/:owner/:repo/terraform/workspaces/:workspace/resources
interface TerraformManagedResource {
  address: string;
  terraformType: string;
  provider: string | null;
  label: string | null;
  resource: {
    id: string;
    name: string;
    pluginId: string;
    resourceTypeId: string;
    url: string;
  } | null;
  matchedBy: "import-id" | "external-id" | "identifier" | null;
  monthlyCost: number | null;
}
```

Between the worker and server-core (queue events or internal routes, whichever the forge settles on):

```ts
// worker -> server-core
type TerraformEvent =
  | { type: "terraform.plan-wanted"; runId: string } // dispatch a plan or apply run's CI run
  | { type: "terraform.state-version"; workspaceId: string; versionId: string; r2Key: string };

// server-core -> worker: nothing new. It reads the state object for linking
// (an internal `GET /internal/terraform/state-versions/:id` with the service
// credential, or R2's S3 API) and writes Postgres.
```

And in the app's API, on the endpoint the resource page already has (`GET /iac/resource?resourceId=`), a new field (an `API_VERSION` minor bump):

```ts
managedBy: {
  repository: string;
  rootPath: string;
  workspace: string;
  address: string;
  url: string;
}
[];
```

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
- **Bounds.** State 32 MiB (configurable), lock info 64 KiB, plan lists 2000 resources, 500 outputs, 64 attributes each, state instances 20 000, discovery 5000 directories, depth 12, 1 MiB per file. Past each one the result says so (`omitted`, `truncated`) instead of failing. IaC reconciliation's own parser stops at 8 MiB, so a larger state is stored and linked but not registered for drift.

## Open questions

1. Does Cloudflare's edge pass `LOCK` and `UNLOCK` to a Worker? If not, only `terraform` configured by hand with the default methods is affected; everything we generate uses `POST` and `DELETE`.
2. Who may approve an apply: `git:admin` on the repository, `ci:approve` in the organisation, or both?
3. Should a workspace's plans also run on pushes to branches with no pull request? The pipeline allows it (`on.manual`); nothing starts one yet.
4. The apply plans again at the merge commit rather than applying the plan the pull request showed. Carrying a plan file between runs means storing a file full of secrets; the apply run stores its own summary instead, so what was applied is on record. Is that enough, or should an approval show the fresh plan before the apply (two runs: plan on push, then apply on approval)?
5. Cost per run is the HCL analysis today (modules not expanded, `for_each` unpriced). Pricing from the plan JSON's `after` values before it is dropped would be more exact; it needs a server-core function next to `pr-checks/analyze.ts`.
6. Cost visibility: the forge showing a workspace's cost is a new reader of cost data and has to go through the organisation's cost scoping.
7. Personal namespaces: a workspace there has state and runs but no organisation, so no accounts and no links. Is that offered at all?
8. Migration number `0196` will collide with the forge's own schema migration; whichever lands second regenerates.
