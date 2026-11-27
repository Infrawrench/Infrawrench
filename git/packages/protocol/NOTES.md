# `@infrawrench/git-protocol` notes

`git-upload-pack` and `git-receive-pack` over a `RepositoryBackend`. Pure: Web Streams and `Uint8Array`, nothing from `node:*` or `cloudflare:*` outside `test/`. The design every git package shares is in `git/README.md`; the object and pack library underneath is `@infrawrench/git-core`.

## Layout

| File                | Job                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `backend.ts`        | `RepositoryBackend`, `ReceiveHooks`, `ServeRequest`: what storage and the host implement.          |
| `serve.ts`          | `serve(options)`: one conversation, input stream in, output stream out.                            |
| `upload-pack.ts`    | The wire format of fetch: v0/v1 advertisement and negotiation, v2 `ls-refs` and `fetch`.           |
| `fetch.ts`          | What a fetch amounts to: checking wants, the shallow boundary, choosing objects, framing the pack. |
| `receive-pack.ts`   | Push: commands, the pack, validation, hooks, the report.                                           |
| `walk.ts`           | History: which commits to send, shallow cuts, ancestry, every tree and blob behind a commit.       |
| `oid-set.ts`        | Object ids as bytes (`OidSet`, `OidList`), and a tree iterator that allocates nothing per entry.   |
| `connectivity.ts`   | The check a pushed pack must pass before it is stored.                                             |
| `http.ts`           | The parts of smart HTTP every host shares: versions, content types, the `# service=` preamble.     |
| `memory-backend.ts` | A backend in memory, pack-backed like the real one. The tests' server, and a reference.            |

## Using it

```ts
const output = serve({
  backend, // RepositoryBackend
  request: { service: "git-upload-pack", version: 2, statelessRpc: true, advertiseOnly: false },
  input: request.body, // what the client sends
  hooks, // ReceiveHooks, for a push
  stats, // filled in as it goes
  onError, // failures that were not the client's doing
});
```

- **The output produces as it is read.** It is a stream over an async generator, so a slow client slows the work instead of filling memory, and cancelling the stream stops the work.
- **A refused request is not a stream error.** The client gets `ERR <message>` (or a side-band error once a pack is under way) and the stream ends cleanly; the transport has already sent its 200. Only a `ProtocolError` or a core `GitError` has its message sent. Anything else is "internal error" to the client and goes to `onError`.
- **`statelessRpc: true`** is smart HTTP: the advertisement is a separate request (`advertiseOnly`), each POST is one round, and the server keeps nothing between them. **`false`** is SSH: one stream carries the advertisement and every round, and for protocol v2 any number of commands.
- **The input is read no further than it has to be.** A push's pack is read up to its own trailer (the backend's `ingestPack` stops there), because over SSH the client keeps the stream open waiting for the report. When the conversation is over the input is cancelled; a host whose stream object tears the connection down on cancel must wrap it (the tests' `socketInput` does).

## What is implemented

**Fetch, v0 and v1.** Capabilities: `multi_ack_detailed side-band side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:<branch> object-format=sha1 agent=infrawrench`. Without `multi_ack_detailed` the plain single-`ACK` protocol is spoken. `multi_ack` (without `_detailed`) and `no-done` are not advertised.

**Fetch, v2.** `ls-refs` (`peel`, `symrefs`, `ref-prefix`, `unborn`), `fetch` (`want`, `have`, `done`, `thin-pack`, `ofs-delta`, `no-progress`, `include-tag`, `shallow`, `deepen`, `deepen-relative`, `deepen-since`, `deepen-not`), `server-option` (accepted and ignored), `object-format=sha1`. Not advertised: `filter`, `ref-in-want`, `sideband-all`, `packfile-uris`, `wait-for-done`, `bundle-uri`.

**Push.** `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1`. v2 has no push, which is git's own behaviour: a client that asked for v2 is answered in v0 (`httpServeRequest` does this) and carries on.

**`filter` is not advertised** because partial clone is not implemented. Advertising it would make clients send filters the server ignores, which is wrong rather than slow.

## Decisions

- **Any commit reachable from a ref may be a want**, not only tips. Infrawrench CI fetches the exact commit of a run after the branch has moved on. A want that is not a tip is checked by walking from the tips, newest first, giving up below the wanted commit's date less a month. Tags, trees and blobs are only accepted as wants when a ref points at them (or a tag peels to them).
- **Negotiation is bounded.** After each round the server asks whether every want already has an ancestor among the common commits (`wantsCovered`), looking at no more than `maxNegotiationCommits` (20 000) commits; running out counts as yes. So the server says `ready` once more haves cannot shrink the pack, or once deciding would cost too much. A premature `ready` only makes the pack larger.
- **Which commits to send** (`selectCommits`): wants and haves are walked together, newest first, and the walk ends when nothing wanted is left. Clocks that run backwards can make it send a commit the client has; that costs bytes and nothing else.
- **Which objects** (`selectObjects`): the trees of the commits the client has right below what is sent (the edges) are marked first, then every tree and blob of the commits being sent that is not marked. Marked objects are also what `packObjects` may use as thin-pack bases.
- **A shallow client's haves are edges** (`shallowEdges`, #1447). An edge is a commit the client has that is a parent of one being sent; its trees and blobs are left out. A shallow fetch stops at its boundary, so the walk never looks at the parents of what it sends and finds no edge: a client that had yesterday's commit and asked for today's at depth 1 was sent every file again. That is every fetch a CI runner makes after its first. The newest 32 of the commits the client names now count as edges whenever the request carries shallow information, which is what git does (`rev-list --objects-edge-aggressive`, passed by upload-pack for a shallow client). It only ever leaves out objects the client holds: a client has the whole tree of any commit it has. A commit a client holds without a ref on it is not named as a have by git, only as `shallow`, and is not used.
- **Trees are read 32 at a time** (`TREES_AT_ONCE` in `walk.ts`). A read is a round trip to an object store in production, and a monorepo has thousands of trees under one commit. The order trees are visited in changes nothing about what is selected.
- **Shallow.** `deepen` is a breadth-first cut; `deepen-since` and `deepen-not` a filtered walk. The client's own shallow commits stop the have side (it does not have their parents) and, in a fetch that does not deepen, the want side too. A commit being unshallowed is passed through: the client has it, so it is not sent, and its parents are.
- **A full clone asks the backend for everything** (`packEverything`) when the client has nothing, is not shallow, and wants every branch and tag. The backend can then answer without any walk, and for a repository that is one pack, with the stored file. **It may only do so while every object it would send is reachable from a branch or a tag**: what a forced push left behind, what only `refs/pull/*` reach and what was copied in from a fork must never go out in a clone. A backend that cannot say so returns null and gets asked for the objects by id.
- **Every object of a pushed pack is checked**, not only what the new tips reach (`ConnectivityCheck`): each commit, tree and tag must name only objects the pack or the repository has. That keeps one invariant true of the whole store, an object that exists has its history, which is what lets every later walk stop at the first object it already knows. Git's own check (walk from the new tips until existing refs are reached) would let a pack bring an object with missing history that a later push could point a ref at.
- **A pack is framed in one copy** (`encodeSideBandRun`): whatever pieces storage hands over, the bytes go once from where they are into a buffer of whole side-band packets. `ServeStats` says how long the objects took to choose (`selectMillis`) and the pack to send (`packMillis`), and `ServeOptions.onEnd` tells the host the conversation is over.
- **`ReceiveHooks.check` gets each update classified**: `kind` (create, update, delete) and `forced` (the new commit does not descend from the old one). Only the protocol and the backend can know that, and the host's policy needs it (protected branches, the push event).
- **A branch can only point at a commit**, a ref can be updated once per push, and the branch `HEAD` names cannot be deleted. Everything else about refs is the backend's compare-and-swap.
- **Ids are bytes** (`OidSet`). A clone of a large repository names every object; a million ids as strings is over 100 MB, as bytes with their table 28 MB.

## The backend contract

`backend.ts` says it in full. The parts that are easy to get wrong:

- `ingestPack` returns a pack that is stored but **not part of the repository**. Its objects are readable through `IngestedPack.reader` only. `updateRefs` publishes it in the same step as the refs that make it reachable, and drops it when no ref moves; `discardPack` drops it when the push is refused earlier.
- `ingestPack` must stop reading at the pack's trailer, and must refuse (with a `GitError`) a pack that fails the connectivity check.
- `updateRefs` is compare-and-swap per ref, all or nothing when `atomic`.
- `packObjects` and `packEverything` are optional. Without them the pack is rebuilt from `read`, every object compressed again, which is correct and slow.
- `listRefs` may fill `peeled`; a tag ref without it is peeled by reading the object on every advertisement.

## Limits

`ServeLimits`: 10 000 wants, 50 000 haves and 10 000 ref updates a request, 20 000 commits looked at to end a negotiation. Every list a client can grow is counted as it is read, not after: also `maxShallows`, `maxDeepenNots`, `maxRefPrefixes` (past it every ref is listed, as git does), `maxArgumentBytes` for one v2 command, `maxCommands` on one stream, `maxPushOptions`, and `maxConversationCommits` for a stateful negotiation as a whole. A packet is at most 65 520 bytes, which the reader enforces.

Memory is the walk's: a `Map` entry per commit visited and 28 bytes per object selected. A fetch that walks a million commits holds about 100 MB of commit nodes, which is past what a Durable Object has; the full-clone path does not walk.

## Tests

`pnpm --filter @infrawrench/git-protocol test` (about two minutes with the monorepo suite, no network). The real `git` talks to this package over a Node HTTP server (stateless) and over a TCP server behind a stand-in for `ssh` (`test/ssh-helper.mjs`, set as `GIT_SSH_COMMAND`, stateful). Where there is no `git` the suites skip with a warning.

- `git.test.ts`, each over HTTP and the stream in v0, v1 and v2: clone (stored pack, and by walking history), shallow clone by depth, date and excluded ref, deepen and unshallow, a shallow clone fetching the next commit at depth 1 (four objects, not the whole tree), fetch with haves the server has never seen (exactly the new objects are sent), fetch of a non-tip commit by id, a want no ref reaches, `ls-remote`, an empty repository. Push over both: create, update, a refused non-fast-forward, force, tags, delete, deleting the current branch, atomic all-or-nothing, a hook that refuses, what the hooks are told, push options, a first push, and a pack that leaves out an object it needs.
- `walk.test.ts`: no git. A tree of 259 directories behind a reader that takes two milliseconds a read: every tree read once, up to 32 at once, the same objects selected; an edge commit's tree left out; a missing tree refused whichever read finds it.
- `monorepo.test.ts`: this repository's history pushed, cloned back, fetched from an older commit, `git fsck` on the results. Prints its timings.

## Measured

Apple M4, Node 24, the in-memory backend, loopback, a busy machine. This repository: about 93 000 objects, a 76 MiB pack.

| Operation                                             | HTTP (stateless) | Stream (stateful) |
| ----------------------------------------------------- | ---------------- | ----------------- |
| Push of the whole history                             | 6.8 s            | 9.0 s             |
| Clone (the stored pack), `git clone` start to finish  | 3.5 s            | 4.0 s             |
| Fetch of the last 50 commits (1 142 objects, rebuilt) | 2.6 s            | 2.1 s             |

The push is the core indexer's speed. The clone is a copy on our side (well under a second); the rest of its time is the client's own `index-pack`. The fetch walks 50 commits and compresses each object again, because the in-memory backend has no `packObjects`. The worker's notes have the same figures through workerd, R2 and a Durable Object.

## Not done

- `filter` (partial clone), `ref-in-want`, `packfile-uris`, `bundle-uri`, `sideband-all`.
- Signed pushes (`push-cert`) are refused.
- No keepalive packets while a fetch chooses its objects or a push is indexed. Over SSH the host sets a long idle timeout instead; over HTTP nothing times out on our side.
- No reachability bitmaps or commit-graph: every fetch that is not a full clone walks commits and reads trees.
- A shallow client's `shallow` lines on a push are read and ignored: the pack is judged against what the repository has, so a push that would make the repository itself shallow is refused as missing objects.
- `multi_ack` without `_detailed`, and `no-done`.
- The repository's own history being shallow is not supported.

## After the security review

- **A shallow line only counts when the wants reach it.** `shallow <id>` with a deepen used to be taken as a commit the client has, and its history was sent: any commit by id, reachable or not. `planShallow` now keeps only shallow commits the wants reach (`reachableAmong`, one walk). `test/reach.test.ts`.
- **Wants that are not tips are checked in one walk**, not one each.
- The limits above. Over SSH there is no request size to stop a client that keeps sending lines.
