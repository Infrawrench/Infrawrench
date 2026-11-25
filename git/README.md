# git.infrawrench.com

A Git forge on Cloudflare: Workers for the edge, a Durable Object per repository for refs and coordination, R2 for packfiles, and the app's Postgres (through Hyperdrive) for everything a forge knows about people and repositories. It is its own site with its own UI, not a part of the app; the app links to it and it links back.

This file is the design every package builds against. Each package's own notes go in its `NOTES.md`; settled decisions move up into this file and KNOWLEDGE.md.

## Packages (`git/packages/*`)

Small packages with one job each, in the spirit of `plugin-architecture/`. The pure ones run anywhere (Web Streams, `Uint8Array`, WebCrypto) and are tested in Node against the real `git` and `ssh` binaries; only `worker` knows it is on Cloudflare.

| Package     | Name                         | Job                                                                                                                                                                                                                                                                                                 | Depends on                         |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `core`      | `@infrawrench/git-core`      | Object model (parse/serialise commit, tree, tag), SHA-1 ids, zlib through `CompressionStream`, pack reading and writing, pack index (v2 `.idx`), delta apply and create, pkt-line, refs and ref-name rules.                                                                                         | nothing                            |
| `ops`       | `@infrawrench/git-ops`       | What a forge does with objects: history walk (log, path-limited log), merge-base, ahead/behind, tree diff with rename detection, line diff (Myers, unified hunks), three-way merge (trees and text, conflicts reported), blame, tar/zip archive streams. Works over `ObjectReader`.                 | core                               |
| `protocol`  | `@infrawrench/git-protocol`  | `git-upload-pack` and `git-receive-pack`, protocol v0/v1/v2 (ls-refs, fetch, shallow/deepen, `filter` later), side-band-64k, report-status(-v2), atomic, push-options; smart HTTP request/response adapters. Works over `RepositoryBackend` + `ReceiveHooks` (`src/backend.ts`).                    | core                               |
| `ssh`       | `@infrawrench/git-ssh`       | An SSH-2 server over any duplex byte stream: curve25519-sha256 kex, ssh-ed25519 (and rsa-sha2/ecdsa) host and user keys, aes256-gcm@openssh.com / aes128-gcm / chacha20-poly1305@openssh.com, publickey auth, `exec` sessions. Knows nothing of git; auth and exec are callbacks (`src/server.ts`). | nothing                            |
| `terraform` | `@infrawrench/git-terraform` | The Terraform HTTP state backend's logic (state versions, lock/unlock semantics, serial and lineage checks), plan JSON summaries, discovering Terraform roots in a tree, the CI pipeline a Terraform workspace runs. Over storage interfaces.                                                       | core                               |
| `contract`  | `@infrawrench/git-contract`  | The JSON API as Effect `HttpApi` definitions and Schemas, the way `@infrawrench/api-contract` is for the app. Imports only `effect`. The SPA and the worker both use it.                                                                                                                            | effect                             |
| `worker`    | `@infrawrench/git-worker`    | The Cloudflare Worker: routing, sessions, `RepoDO` (implements `RepositoryBackend` on DO SQLite + R2), the smart HTTP endpoints, the `connect()` SSH entry, the API handlers, the event queue consumer, the Terraform state DO.                                                                     | all of the above, server-core (db) |
| `web`       | `@infrawrench/git-web`       | The UI: Vite + React + TanStack Router + Tailwind, built to static assets the worker serves.                                                                                                                                                                                                        | contract, ui                       |

Rules that keep it modular:

- A pure package never imports `cloudflare:*`, `node:*` (outside tests) or `worker`.
- Interfaces live with their consumer (`protocol/src/backend.ts`, `ssh/src/server.ts`); the implementer changes with them in the same commit.
- The worker is a composition root: each route, DO and queue consumer is its own module, and `src/index.ts` only wires them.
- Nothing in these packages names a provider plugin; Infrawrench knowledge comes from server-core and the app's API, as elsewhere.

## Identity, namespaces, access

- **Sign-in is WorkOS AuthKit**, the same users as the app (the `users` table), its own redirect (`https://git.infrawrench.com/auth/callback`) and its own sealed, host-only session cookie. First sign-in asks for a username.
- **Namespaces** (`git_namespaces`): a case-insensitive unique slug owned by a user or by an Infrawrench organisation. An organisation's namespace is claimed by someone with `git:admin` in it. Slugs and repository names: `[A-Za-z0-9._-]`, no leading dot or dash, not ending in `.git`, with a reserved list (routes, `api`, `auth`, `explore`, ...).
- **Organisations are Infrawrench organisations.** Membership and roles come from the app (WorkOS memberships, the role/permission system). New permissions in the catalog: `git:read`, `git:write`, `git:admin`. Per-repository collaborators add access for individual users: `read`, `triage`, `write`, `admin`.
- **Visibility**: `public` (anyone, signed in or not, can read and clone) or `private` (only people with access). Forks of a private repository stay private and inside the same owner's reach.
- **Credentials for git**: HTTPS takes Basic auth with a personal access token (`iwg_…`, hashed, scoped `repo:read`/`repo:write`, optional expiry) or an Infrawrench API key (`iwk_…`, the organisation's repositories, its own role). SSH takes the user's git SSH keys (`git_user_keys`, separate from the organisation's server keys) and deploy keys per repository. CI jobs get a short-lived, repository-scoped job token. None of these is ever logged.

Access resolution is one function, `repoAccess(principal, repo) -> none | read | triage | write | admin`, used by HTTP, SSH and the API alike.

## Storage

- **R2 bucket `infrawrench-git`**: `repos/<repoId>/packs/pack-<sha>.pack` and `.idx`. Repositories are keyed by id, never by name, so renames and transfers move nothing.
- **`RepoDO`, one per repository** (`idFromName(repoId)`), SQLite: `refs`, `head`, the pack catalogue, an object index (oid → pack, offset, type, size), push locks, and a small cache of resolved objects. It serialises every ref change, so a push, a merge from the UI and a branch deletion cannot race.
- **Pushes stream.** `ingestPack` writes the incoming pack to R2 as it arrives (multipart) while indexing it, resolving deltas with bounded memory (bases read back by range), and publishes the pack only after it verifies. A Worker request body is capped by the zone's plan (100 MB on Free/Pro), so very large pushes go over SSH, which has no such cap.
- **Repacking** runs from the DO's alarm once a repository has many small packs.
- **Postgres** (server-core `db/git-schema.ts`, migrations through `drizzle-kit generate`): namespaces, repositories, collaborators, keys and tokens, issues, pull requests, reviews and comments, labels, milestones, stars, protected branches, commit statuses, Terraform workspaces and runs.

## Transports

- **Smart HTTP**: `GET /<owner>/<repo>.git/info/refs?service=…`, `POST /<owner>/<repo>.git/git-upload-pack|git-receive-pack`, v2 via `Git-Protocol`. The front Worker resolves the principal and access, then hands the body stream to the repository's DO, which runs `protocol` against its backend and streams the answer back.
- **SSH**: `git@git.infrawrench.com:<owner>/<repo>.git`. A Spectrum application on port 22 forwards TCP to the Worker's `connect(socket)` handler (inbound TCP, public beta; `startTls` is not available on inbound sockets, which SSH does not need). The Worker runs the `ssh` server; `exec` resolves the repository and access the same way HTTP does and opens a bidirectional stream to the DO (`statelessRpc: false`).
- **After a push** the DO sends an event (`{ repoId, actor, updates, at }`) to the `infrawrench-git-events` queue. The consumer updates the repository row, synchronises pull requests, closes issues a commit fixes, and starts CI and Terraform plans.

## The forge

Code (tree, file with highlighting, raw, blame, history, archive download), branches, tags, compare, commits with diffs, issues (labels, milestones, assignees, comments), pull requests (diff, inline review comments, approvals, merge commit / squash / rebase, conflict check, protected branches with required approvals and required checks), stars, forks, explore and search, user and organisation pages, repository settings (rename, transfer, visibility, collaborators, deploy keys, protected branches, delete), personal settings (SSH keys, tokens, username).

## Infrawrench CI

Repositories here run Infrawrench CI the same way GitHub ones do: `.infrawrench/ci/*.yml`, on push and pull request, through `server-core/src/ci/`. A run's source is either a GitHub installation or a git.infrawrench.com repository; the runner fetches the commit over smart HTTP with a job token. Results show as commit statuses and checks in the repository UI (a CI tab per repository, a status on every commit and pull request) and in the app's CI tab, which links to the commit here. Billing is CI's existing outbox.

## Terraform

A repository with Terraform roots gets an Infrastructure tab.

- **Workspaces**: a root directory plus a name, mapped to Infrawrench connected accounts whose credentials a run gets as environment variables (never written to the repository).
- **State**: the HTTP backend at `https://git.infrawrench.com/<owner>/<repo>/terraform/<workspace>/state` (with `lock`/`unlock`), every version kept in R2 and listed in the UI.
- **Plan on pull request, apply on merge** (or on approval), run on Infrawrench CI runners. The pull request shows the plan summary and the monthly cost change (the app's PR cost analysis).
- **Back to the app**: resources in state are matched to the organisation's Infrawrench resources, so the tab shows what each workspace manages and what it costs, the app's resource pages say which repository and path manage a resource, and drift comes from the app's IaC reconciliation.

## Tie-ins with the app

The app does not embed the forge. It links to it: a Git entry in the sidebar opens the organisation's namespace on git.infrawrench.com; resource pages name the repository that manages them; CI runs from repositories here link to their commits; Settings has a Git section (namespace, default visibility, usage). The forge links back to resource pages, costs and CI runs in the app.

Public repositories are free. Private repositories and storage follow the organisation's plan (`planAccess`); storage is sampled and metered through the same outbox pattern CI uses.

## Style

The app's look: `@infrawrench/ui`'s tokens and components, dense layouts, no blurbs. A page has a name and its controls; explanation goes in the docs. The layout follows the familiar forge shape (repository header with tabs, file table, README below).
